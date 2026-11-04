import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

function load(trusted: string) {
  process.env.DASHBOARD_TRUSTED_PROXIES = trusted;
  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve('../server-entry.cjs')];
  return require('../server-entry.cjs') as { sanitize: (req: unknown) => void };
}
const req = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers: { ...headers } });

describe('server-entry sanitize', () => {
  it('ignores client-supplied forwarded headers from an untrusted peer', () => {
    const { sanitize } = load('');
    const r = req('::ffff:172.21.0.1', { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8', 'x-forwarded-host': 'evil.example', forwarded: 'for=9.9.9.9', 'x-pai-client-ip': '8.8.8.8' });
    sanitize(r);
    expect(r.headers).toEqual({ 'x-pai-client-ip': '172.21.0.1' });
  });
  it('uses the entry appended by a trusted proxy', () => {
    const { sanitize } = load('10.0.0.2');
    const r = req('10.0.0.2', { 'x-forwarded-for': 'spoofed, 100.64.1.7', 'x-forwarded-host': 'dash.tailnet' });
    sanitize(r);
    expect(r.headers['x-pai-client-ip']).toBe('100.64.1.7');
    expect(r.headers['x-forwarded-host']).toBe('dash.tailnet');
  });
});
