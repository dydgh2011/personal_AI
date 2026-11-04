import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'dash-'));
const tokenFile = join(dir, 'token');
let lib: typeof import('@/lib/controller');
let routes: typeof import('@/lib/routes');

beforeAll(async () => {
  process.env.CONTROLLER_URL = 'http://controller.test:3000/';
  process.env.CONTROLLER_TOKEN_FILE = tokenFile;
  process.env.DASHBOARD_AUDIT_LOG = join(dir, 'audit.log');
  lib = await import('@/lib/controller');
  routes = await import('@/lib/routes');
});

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('controller client', () => {
  it('fails closed when the token secret is missing', async () => {
    const fetch = stubFetch(200, {});
    await expect(lib.controller.task('x')).rejects.toMatchObject({ message: 'Dashboard controller token is not configured', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends the bearer token server-side and the approver header', async () => {
    writeFileSync(tokenFile, 'tok-' + 'x'.repeat(40) + '\n');
    const fetch = stubFetch(200, { status: 'approved' });
    await lib.controller.decide('id-1', 'approve', 'a'.repeat(40), 'ok', 'owner');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://controller.test:3000/tasks/id-1/approve');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-' + 'x'.repeat(40));
    expect(headers['X-Approver']).toBe('owner');
    expect(JSON.parse(String(init.body))).toEqual({ headSha: 'a'.repeat(40), reason: 'ok' });
  });

  it('maps 409 and other errors to ControllerError with the controller message', async () => {
    writeFileSync(tokenFile, 'tok');
    stubFetch(409, { message: 'The review of abc is already approved', statusCode: 409 });
    await expect(lib.controller.decide('id', 'approve', 'a'.repeat(40), undefined, 'owner')).rejects.toMatchObject({ status: 409, message: 'The review of abc is already approved' });
    stubFetch(400, { message: ['headSha must be 40 chars', 'x'] });
    await expect(lib.controller.task('id')).rejects.toMatchObject({ status: 400, message: 'headSha must be 40 chars; x' });
    stubFetch(502, '<html>bad gateway</html>');
    await expect(lib.controller.task('id')).rejects.toMatchObject({ status: 502, message: 'Controller error 502' });
  });

  it('reports an unreachable controller without leaking details', async () => {
    writeFileSync(tokenFile, 'tok');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('getaddrinfo ENOTFOUND controller'); }));
    await expect(lib.controller.systemStatus()).rejects.toMatchObject({ status: null, message: 'Controller unreachable' });
  });

  it('filters list queries', async () => {
    writeFileSync(tokenFile, 'tok');
    const fetch = stubFetch(200, { items: [], total: 0, limit: 50, offset: 0 });
    await lib.controller.tasks({ agent: 'codex', projectId: 'hello-world', status: undefined });
    expect(fetch.mock.calls[0][0]).toBe('http://controller.test:3000/tasks?agent=codex&projectId=hello-world');
  });
});

describe('back()', () => {
  it('only redirects to same-site relative paths', () => {
    expect(routes.back('/reviews/1', { kind: 'ok', text: 'done & ok' }).headers.get('location')).toBe('/reviews/1?ok=done%20%26%20ok');
    expect(routes.back('/reviews/1?confirm=approve', { kind: 'error', text: 'x' }).headers.get('location')).toBe('/reviews/1?confirm=approve&error=x');
    expect(routes.back('//evil.example').headers.get('location')).toBe('/');
    expect(routes.back('https://evil.example').headers.get('location')).toBe('/');
    expect(routes.back('/\\evil.example').headers.get('location')).toBe('/');
    expect(routes.back('/').status).toBe(303);
  });
});
