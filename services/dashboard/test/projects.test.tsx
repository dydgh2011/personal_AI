import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { changedSettings, latestStyleAnalysis, parseSettingsForm, settingsSummary, type SettingsPatch } from '@/lib/project-settings';
import type { Project, Task } from '@/lib/types';

// Route handlers and pages read the session cookie through next/headers.
const cookie: { value: string | undefined } = { value: undefined };
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'pai_session' && cookie.value ? { value: cookie.value } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error('notFound'); },
}));

const dir = mkdtempSync(join(tmpdir(), 'dash-projects-'));
const auditFile = join(dir, 'audit.log');
let server: typeof import('@/lib/server');
let route: typeof import('@/app/api/projects/[id]/settings/route');
let page: typeof import('@/app/(admin)/projects/[id]/page');

beforeAll(async () => {
  process.env.CONTROLLER_URL = 'http://controller.test:3000';
  process.env.CONTROLLER_TOKEN_FILE = join(dir, 'token');
  process.env.DASHBOARD_AUDIT_LOG = auditFile;
  writeFileSync(join(dir, 'token'), 'tok');
  server = await import('@/lib/server');
  route = await import('@/app/api/projects/[id]/settings/route');
  page = await import('@/app/(admin)/projects/[id]/page');
});

afterEach(() => {
  vi.unstubAllGlobals();
  cookie.value = undefined;
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const base = { styleMode: 'off', styleGuide: '', rules: '', forbiddenPaths: '', authorName: '', authorEmail: '' };

const project = (over: Partial<Project> = {}): Project => ({
  id: 'hello', source: 'github', fullName: 'octocat/Hello-World', defaultBranch: 'master', visibility: 'public', allowedAgents: ['claude'],
  enabled: true, allowCodeChanges: true, authMode: 'none', syncStatus: 'synced', lastFetchedAt: null, cachedHeadSha: 'a'.repeat(40),
  lastSyncError: null, description: null, commitAuthor: null, commitStyle: { mode: 'off', guide: null },
  agentInstructions: { rules: '', forbiddenPaths: [] }, ...over,
});

describe('settings form', () => {
  it('builds the controller patch, normalising CRLF and ignoring blank lines, comments and duplicates', () => {
    const r = parseSettingsForm(form({
      ...base, styleMode: 'manual', styleGuide: ' feat: lower-case ', rules: 'Strict TS.\r\nNo deps.\r\n',
      forbiddenPaths: 'secrets/\r\n\r\n# keys\r\n*.pem\r\nsecrets/\r\n', authorName: 'Dev', authorEmail: 'dev@example.com',
    }));
    expect(r).toEqual({ patch: {
      commitAuthor: { name: 'Dev', email: 'dev@example.com' },
      commitStyle: { mode: 'manual', guide: 'feat: lower-case' },
      agentInstructions: { rules: 'Strict TS.\nNo deps.', forbiddenPaths: ['secrets/', '*.pem'] },
    } });
    expect(parseSettingsForm(form(base))).toEqual({ patch: {
      commitAuthor: null, commitStyle: { mode: 'off', guide: null }, agentInstructions: { rules: '', forbiddenPaths: [] },
    } });
  });

  it.each([
    [{ authorName: 'Dev' }, /both a name and an e-mail/],
    [{ authorName: 'Dev <x>', authorEmail: 'a@example.com' }, /no < or >/],
    [{ authorName: 'Dev', authorEmail: 'nope' }, /not a valid address/],
    [{ styleMode: 'copy' }, /Choose a commit style mode/],
    [{ styleMode: 'manual', styleGuide: '  ' }, /needs a guide/],
    [{ rules: 'x'.repeat(4001) }, /at most 4000/],
    [{ forbiddenPaths: '/etc/passwd' }, /not a relative path pattern/],
    [{ forbiddenPaths: 'a/../b' }, /not a relative path pattern/],
    [{ forbiddenPaths: 'a\\b' }, /not a relative path pattern/],
    [{ forbiddenPaths: Array.from({ length: 51 }, (_, i) => `p${i}`).join('\n') }, /At most 50/],
  ])('rejects %o', (fields, message) => {
    const r = parseSettingsForm(form({ ...base, ...fields }));
    expect('error' in r && r.error).toMatch(message);
  });

  it('names changed settings without values, and summarises a project', () => {
    const patch: SettingsPatch = { commitAuthor: { name: 'a', email: 'a@example.com' }, commitStyle: { mode: 'auto', guide: null }, agentInstructions: { rules: '', forbiddenPaths: ['x/'] } };
    expect(changedSettings(project(), patch)).toEqual(['commitAuthor', 'commitStyle', 'forbiddenPaths']);
    expect(changedSettings(project({ ...patch }), patch)).toEqual([]);
    expect(settingsSummary(project({ ...patch }))).toBe('style auto · 1 forbidden · author (stored)');
    expect(settingsSummary(project())).toBe('-');
  });

  it('finds the newest commit-style analysis in worker reports', () => {
    const report = (analysis: unknown) => JSON.stringify({ format: 'agent-worker/v1', workspace: { commitStyle: analysis } });
    const task = (id: string, result: string | null): Task => ({ id, agent: 'claude', projectId: 'hello', instruction: '', status: 'completed', result, error: null, createdAt: '2026-11-24T00:00:00Z', startedAt: null, completedAt: '2026-11-24T01:00:00Z', claimedBy: null, attempt: 1 });
    const analysis = { sampleSize: 9, conventional: 1, types: ['feat'], language: 'english', medianLength: 30, examples: ['feat: x'], guide: 'Use Conventional Commits.' };
    expect(latestStyleAnalysis([task('a', 'plain text'), task('b', report(undefined)), task('c', report(analysis))])).toMatchObject({ taskId: 'c', analysis });
    expect(latestStyleAnalysis([task('a', null)])).toBeNull();
  });
});

describe('POST /api/projects/:id/settings', () => {
  const post = (id: string, fields: Record<string, string>, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) =>
    route.POST(new Request(`http://dash.test/api/projects/${id}/settings`, { method: 'POST', body: form(fields), headers }), { params: Promise.resolve({ id }) });

  const stubController = (current: Project) => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'GET') return new Response(JSON.stringify(current), { status: 200 });
      return new Response(JSON.stringify({ ...current, ...JSON.parse(String(init.body)) }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  const auditLines = () => { try { return readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };

  it('saves through the controller admin PATCH and audits names, not values', async () => {
    const session = server.sessions.create('owner');
    cookie.value = session.id;
    const fetch = stubController(project());
    const res = await post('hello', {
      ...base, csrf: session.csrf, styleMode: 'auto', rules: 'No deps.', forbiddenPaths: 'secrets/', authorName: 'Dev', authorEmail: 'dev@example.com',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/projects\/hello\?ok=Saved/);
    const patch = fetch.mock.calls.find(([, init]) => (init as RequestInit).method === 'PATCH')!;
    expect(patch[0]).toBe('http://controller.test:3000/projects/hello');
    expect((patch[1] as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({
      commitAuthor: { name: 'Dev', email: 'dev@example.com' },
      commitStyle: { mode: 'auto', guide: null },
      agentInstructions: { rules: 'No deps.', forbiddenPaths: ['secrets/'] },
    });
    const entry = auditLines().at(-1);
    expect(entry).toMatchObject({ event: 'project.settings', user: 'owner', projectId: 'hello', changed: ['commitAuthor', 'commitStyle', 'rules', 'forbiddenPaths'], forbiddenPaths: 1 });
    expect(JSON.stringify(entry)).not.toMatch(/dev@example\.com|No deps|secrets\//);
  });

  it('changes nothing without a valid CSRF token, a session or valid input', async () => {
    const fetch = stubController(project());
    // no session
    let res = await post('hello', { ...base, csrf: 'x' });
    expect(res.headers.get('x-pai-rejected')).toBe('session');
    // wrong token
    const session = server.sessions.create('owner');
    cookie.value = session.id;
    res = await post('hello', { ...base, csrf: 'forged' });
    expect(res.headers.get('x-pai-rejected')).toBe('csrf:bad_token');
    // cross-site
    res = await post('hello', { ...base, csrf: session.csrf }, { 'sec-fetch-site': 'cross-site' });
    expect(res.headers.get('x-pai-rejected')).toBe('csrf:cross_site');
    // invalid input and invalid id
    res = await post('hello', { ...base, csrf: session.csrf, forbiddenPaths: '../x' });
    expect(res.headers.get('x-pai-rejected')).toBe('input');
    res = await post('..', { ...base, csrf: session.csrf });
    expect(res.headers.get('location')).toMatch(/^\/projects\?error=Invalid%20project%20id/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the controller refusal and audits the failure', async () => {
    const session = server.sessions.create('owner');
    cookie.value = session.id;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => init.method === 'GET'
      ? new Response(JSON.stringify(project()), { status: 200 })
      : new Response(JSON.stringify({ message: ['agentInstructions.forbiddenPaths contains duplicates'] }), { status: 400 })));
    const res = await post('hello', { ...base, csrf: session.csrf, rules: 'x' });
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('error=agentInstructions.forbiddenPaths contains duplicates');
    expect(auditLines().at(-1)).toMatchObject({ event: 'project.settings.failed', projectId: 'hello', status: 400 });
  });
});

describe('project page', () => {
  it('renders the settings form with CSRF, the POLICY B note, and repository text as escaped data', async () => {
    const session = server.sessions.create('owner');
    cookie.value = session.id;
    const current = project({ agentInstructions: { rules: '<script>alert(1)</script>', forbiddenPaths: ['secrets/', '*.pem'] }, commitStyle: { mode: 'auto', guide: null } });
    const tasks = [{ id: '11111111-1111-4111-8111-111111111111', agent: 'claude', projectId: 'hello', instruction: '', status: 'completed', createdAt: '2026-11-24T00:00:00Z', startedAt: null, completedAt: '2026-11-24T00:00:00Z', claimedBy: null, attempt: 1, error: null,
      result: JSON.stringify({ format: 'agent-worker/v1', workspace: { commitStyle: { sampleSize: 7, conventional: 0, types: [], language: 'english', medianLength: 20, guide: 'Write the subject in English.', examples: ['<img src=x onerror=alert(1)>'] } } }) }];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('/tasks') ? { items: tasks, total: 1, limit: 25, offset: 0 } : current), { status: 200 })));
    const html = renderToStaticMarkup(await page.default({ params: Promise.resolve({ id: 'hello' }), searchParams: Promise.resolve({}) }));
    expect(html).toContain('action="/api/projects/hello/settings"');
    expect(html).toContain(`name="csrf" value="${session.csrf}"`);
    expect(html).toContain('POLICY B');
    expect(html).toContain('name="styleMode" checked="" value="auto"');
    expect(html).toContain('secrets/\n*.pem');
    expect(html).toContain('Write the subject in English.');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('does not offer saving against a controller without agent settings', async () => {
    const session = server.sessions.create('owner');
    cookie.value = session.id;
    const { commitStyle: _s, agentInstructions: _a, commitAuthor: _c, ...old } = project();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('/tasks') ? { items: [], total: 0, limit: 25, offset: 0 } : old), { status: 200 })));
    const html = renderToStaticMarkup(await page.default({ params: Promise.resolve({ id: 'hello' }), searchParams: Promise.resolve({}) }));
    expect(html).toContain('registry before v7');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save settings/);
  });
});
