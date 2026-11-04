import { describe, expect, it } from 'vitest';
import { csrfFailure, csrfValid, deviceKey, hashPassword, LoginLimiter, loginBuckets, SessionStore, signDevice, verifyDevice, verifyPassword } from '@/lib/security';

describe('password hashing', () => {
  it('verifies the right password only', () => {
    const hash = hashPassword('correct horse');
    expect(hash.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(verifyPassword('correct horse', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
  });
  it('rejects malformed hashes', () => {
    expect(verifyPassword('x', 'plain-text')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
  });
});

describe('SessionStore', () => {
  it('expires after idle and absolute limits', () => {
    let t = 0;
    const store = new SessionStore({ idleMs: 100, absoluteMs: 250 }, () => t);
    const s = store.create('owner');
    expect(s.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.csrf).not.toBe(s.id);
    t = 90;
    expect(store.get(s.id)?.user).toBe('owner');
    t = 180;
    expect(store.get(s.id)?.user).toBe('owner'); // idle reset at 90
    t = 260;
    expect(store.get(s.id)).toBeNull(); // absolute limit
    const s2 = store.create('owner');
    t = 400;
    expect(store.get(s2.id)).toBeNull(); // idle limit
  });
  it('destroys sessions on logout and ignores unknown ids', () => {
    const store = new SessionStore({ idleMs: 1e6, absoluteMs: 1e6 });
    const s = store.create('owner');
    store.destroy(s.id);
    expect(store.get(s.id)).toBeNull();
    expect(store.get(undefined)).toBeNull();
    expect(store.get('forged')).toBeNull();
  });
});

describe('LoginLimiter', () => {
  it('blocks after 5 failures in the window and resets on success', () => {
    let t = 0;
    const l = new LoginLimiter(5, 1000, () => t);
    const keys = ['ip:1', 'user:owner'];
    for (let i = 0; i < 5; i++) {
      expect(l.blocked(keys)).toBe(0);
      l.fail(keys);
    }
    expect(l.blocked(keys)).toBe(1);
    expect(l.blocked(['ip:2', 'user:owner'])).toBeGreaterThan(0); // same user from another ip
    t = 1001;
    expect(l.blocked(keys)).toBe(0);
    l.fail(keys);
    l.reset(keys);
    expect(l.blocked(keys)).toBe(0);
  });
});

describe('csrfValid', () => {
  const store = new SessionStore({ idleMs: 1e6, absoluteMs: 1e6 });
  const s = store.create('owner');
  const h = (o: Record<string, string>) => new Headers(o);
  it('accepts a same-origin post with the session token', () => {
    expect(csrfValid(s, s.csrf, h({ origin: 'http://127.0.0.1:8710', host: '127.0.0.1:8710', 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });
  it('rejects missing or wrong tokens', () => {
    expect(csrfValid(s, null, h({}))).toBe(false);
    expect(csrfValid(s, 'x'.repeat(43), h({}))).toBe(false);
  });
  it('rejects cross-site requests even with the token', () => {
    expect(csrfValid(s, s.csrf, h({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(csrfValid(s, s.csrf, h({ origin: 'http://evil.example', host: '127.0.0.1:8710' }))).toBe(false);
    expect(csrfValid(s, s.csrf, h({ origin: 'null', host: '127.0.0.1:8710' }))).toBe(false);
  });
});

describe('device cookies', () => {
  const key = deviceKey('scrypt$16384$8$1$salt$hash');
  it('round-trips for the same user until expiry', () => {
    const cookie = signDevice(key, 'owner', 1000, 500, 'n1');
    expect(verifyDevice(key, cookie, 'owner', 1200)).toMatchObject({ user: 'owner', nonce: 'n1' });
    expect(verifyDevice(key, cookie, 'owner', 1600)).toBeNull(); // expired
    expect(verifyDevice(key, cookie, 'other', 1200)).toBeNull(); // bound to the user
  });
  it('rejects forged, tampered or foreign-key cookies', () => {
    const cookie = signDevice(key, 'owner', 0, 1e9);
    const [body, mac] = cookie.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ user: 'owner', nonce: 'x', expires: 9e12 })).toString('base64url');
    expect(verifyDevice(key, `${forgedBody}.${mac}`, 'owner', 1)).toBeNull();
    expect(verifyDevice(key, `${body}.${mac.slice(0, -2)}AA`, 'owner', 1)).toBeNull();
    expect(verifyDevice(deviceKey('another password hash'), cookie, 'owner', 1)).toBeNull();
    expect(verifyDevice(key, 'garbage', 'owner', 1)).toBeNull();
    expect(verifyDevice(key, undefined, 'owner', 1)).toBeNull();
  });
  it('a local attacker cannot lock out a known device', () => {
    const limiter = new LoginLimiter(5, 1000, () => 0);
    const attacker = loginBuckets(null, '172.21.0.1', 'owner');
    for (let i = 0; i < 10; i++) limiter.fail(attacker);
    expect(limiter.blocked(attacker)).toBeGreaterThan(0);
    // same address (Docker gateway), but the owner's browser has a device cookie
    const owner = loginBuckets({ user: 'owner', nonce: 'n1', expires: 1 }, '172.21.0.1', 'owner');
    expect(limiter.blocked(owner)).toBe(0);
    // a new browser without a device cookie is still limited
    expect(limiter.blocked(loginBuckets(null, '10.0.0.9', 'owner'))).toBeGreaterThan(0);
  });
});

describe('csrfFailure (real browser headers)', () => {
  const store = new SessionStore({ idleMs: 1e6, absoluteMs: 1e6 });
  const s = store.create('owner');
  const h = (o: Record<string, string>) => new Headers(o);
  it('accepts what Edge/Chrome send for a same-origin form post', () => {
    // Referrer-Policy: same-origin -> real Origin
    expect(csrfFailure(s, s.csrf, h({ origin: 'http://127.0.0.1:8710', host: '127.0.0.1:8710', 'sec-fetch-site': 'same-origin' }))).toBeNull();
    // the original bug: no-referrer policy -> "Origin: null" on a same-origin form post
    expect(csrfFailure(s, s.csrf, h({ origin: 'null', host: '127.0.0.1:8710', 'sec-fetch-site': 'same-origin' }))).toBeNull();
    // forwarded host from a trusted proxy (server-entry keeps it only for DASHBOARD_TRUSTED_PROXIES)
    expect(csrfFailure(s, s.csrf, h({ origin: 'https://dash.tailnet', host: 'dashboard:3000', 'x-forwarded-host': 'dash.tailnet', 'sec-fetch-site': 'same-origin' }))).toBeNull();
  });
  it('still rejects missing / wrong tokens and forged origins', () => {
    expect(csrfFailure(s, null, h({ 'sec-fetch-site': 'same-origin' }))).toBe('missing_token');
    expect(csrfFailure(s, '', h({ 'sec-fetch-site': 'same-origin' }))).toBe('missing_token');
    expect(csrfFailure(s, 'x'.repeat(43), h({ 'sec-fetch-site': 'same-origin' }))).toBe('bad_token');
    expect(csrfFailure(s, s.csrf, h({ origin: 'http://evil.example', host: '127.0.0.1:8710', 'sec-fetch-site': 'cross-site' }))).toBe('cross_site');
    expect(csrfFailure(s, s.csrf, h({ origin: 'http://evil.example', host: '127.0.0.1:8710' }))).toBe('bad_origin');
    // opaque origins (sandboxed iframe, data: URL) are not vouched for by the browser
    expect(csrfFailure(s, s.csrf, h({ origin: 'null', host: '127.0.0.1:8710', 'sec-fetch-site': 'cross-site' }))).toBe('cross_site');
    expect(csrfFailure(s, s.csrf, h({ origin: 'null', host: '127.0.0.1:8710' }))).toBe('bad_origin');
    expect(csrfFailure(s, s.csrf, h({ origin: 'null', host: '127.0.0.1:8710', 'sec-fetch-site': 'same-site' }))).toBe('cross_site');
  });
});
