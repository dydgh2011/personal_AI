import { createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Session } from './session-store';

/** scrypt$N$r$p$saltB64$hashB64 */
export function hashPassword(password: string, salt = randomBytes(16)): string {
  const N = 16384, r = 8, p = 1;
  const hash = scryptSync(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, expected] = parts;
  const want = Buffer.from(expected, 'base64');
  const got = scryptSync(password, Buffer.from(salt, 'base64'), want.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return got.length === want.length && timingSafeEqual(got, want);
}

export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

// Sessions live in session-store.ts (persistent on the dashboard volume); re-exported here.
export { SessionStore, type Session, type SessionOptions } from './session-store';

/** Failed login attempts per key (ip, user) in a sliding window. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly max = 5, private readonly windowMs = 15 * 60_000, private readonly now: () => number = Date.now) {}

  blocked(keys: string[]): number {
    const t = this.now();
    let retry = 0;
    for (const key of keys) {
      const recent = (this.failures.get(key) ?? []).filter((f) => t - f < this.windowMs);
      this.failures.set(key, recent);
      if (recent.length >= this.max) retry = Math.max(retry, Math.ceil((recent[0] + this.windowMs - t) / 1000));
    }
    return retry;
  }

  fail(keys: string[]): void {
    for (const key of keys) this.failures.set(key, [...(this.failures.get(key) ?? []), this.now()]);
  }

  reset(keys: string[]): void {
    for (const key of keys) this.failures.delete(key);
  }
}

/**
 * Device cookies (OWASP "device cookie" lockout pattern). Behind Docker port mapping every
 * browser on the host has the same address, so address-based lockout alone would let any local
 * process lock the owner out. A browser that has logged in before carries a signed device cookie;
 * its failures are counted per device, separate from the shared "untrusted" buckets.
 */
export interface DeviceClaim {
  user: string;
  nonce: string;
  expires: number;
}

export function deviceKey(material: string): Buffer {
  return Buffer.from(hkdfSync('sha256', material, 'personal-ai-dashboard', 'device-cookie-v1', 32));
}

export function signDevice(key: Buffer, user: string, now: number, ttlMs: number, nonce = randomBytes(16).toString('base64url')): string {
  const body = Buffer.from(JSON.stringify({ user, nonce, expires: now + ttlMs } satisfies DeviceClaim)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

export function verifyDevice(key: Buffer, cookie: string | undefined, user: string, now: number): DeviceClaim | null {
  if (!cookie || cookie.length > 512) return null;
  const [body, mac, extra] = cookie.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const want = createHmac('sha256', key).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DeviceClaim;
    if (typeof claim.nonce !== 'string' || typeof claim.expires !== 'number') return null;
    return claim.user === user && claim.expires > now ? claim : null;
  } catch {
    return null;
  }
}

/** Limiter buckets for one login attempt: a known device only counts against itself. */
export function loginBuckets(device: DeviceClaim | null, ip: string, user: string): string[] {
  return device ? [`device:${device.nonce}`] : [`ip:${ip}`, `untrusted-user:${user}`];
}

/**
 * CSRF: the per-session token from the form must match, and the request must come from this
 * origin (Origin / Sec-Fetch-Site), so a cross-site form post cannot act with the admin's cookie.
 */
export function csrfValid(session: Session, token: unknown, headers: Headers): boolean {
  return csrfFailure(session, token, headers) === null;
}

/** Why a state-changing request fails the CSRF check (null = it passes). Never includes token values. */
export function csrfFailure(session: Session, token: unknown, headers: Headers): 'missing_token' | 'bad_token' | 'cross_site' | 'bad_origin' | null {
  if (typeof token !== 'string' || token === '') return 'missing_token';
  if (!safeEqual(token, session.csrf)) return 'bad_token';
  const site = headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return 'cross_site';
  const origin = headers.get('origin');
  if (origin === 'null') {
    // Browsers send "Origin: null" when the page's referrer policy hides the origin (and from
    // sandboxed / opaque contexts). Accept it only when the browser itself vouches that the request
    // is same-origin; an opaque cross-site context sends Sec-Fetch-Site: cross-site.
    return site === 'same-origin' ? null : 'bad_origin';
  }
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return 'bad_origin';
    } catch {
      return 'bad_origin';
    }
  }
  return null;
}
