import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, type SessionOptions } from '@/lib/session-store';

const IDLE = 30 * 60_000;
const ABSOLUTE = 8 * 3_600_000;
const FLUSH = 60_000;
const HASH = 'scrypt$16384$8$1$c2FsdA==$aGFzaA=='; // stand-in for the admin password hash file

let dir: string;
let file: string;
let t: number;
let secret: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pai-sessions-'));
  file = join(dir, 'sessions.json');
  t = 1_700_000_000_000;
  secret = `v1\n${HASH}\nowner\n`;
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fresh store instance = what a restarted / rebuilt container gets. */
function boot(extra: Partial<SessionOptions> = {}): SessionStore {
  return new SessionStore(
    { idleMs: IDLE, absoluteMs: ABSOLUTE, file, secret: () => secret, flushMs: FLUSH, log: (m) => logs.push(m), ...extra },
    () => t,
  );
}
const onDisk = () => JSON.parse(readFileSync(file, 'utf8')) as { v: number; binding: string; sessions: { h: string; user: string; createdAt: number; lastSeen: number }[] };

describe('persistent SessionStore', () => {
  it('survives a restart: a new instance reading the file accepts the same cookie and CSRF token', () => {
    const before = boot();
    const s = before.create('owner');
    t += 5 * 60_000;
    const after = boot();
    const again = after.get(s.id);
    expect(again?.user).toBe('owner');
    expect(again?.id).toBe(s.id);
    expect(again?.csrf).toBe(s.csrf); // forms rendered before the restart still post
    expect(again?.createdAt).toBe(s.createdAt);
    expect(after.get('forged-cookie-value')).toBeNull();
  });

  it('never writes the raw session id or CSRF token to disk, only an HMAC of the id', () => {
    const store = boot();
    const s = store.create('owner');
    store.get(s.id);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(s.id);
    expect(text).not.toContain(s.csrf);
    expect(text).not.toContain(HASH);
    const doc = onDisk();
    expect(Object.keys(doc).sort()).toEqual(['binding', 'sessions', 'v']);
    expect(doc.sessions).toHaveLength(1);
    expect(Object.keys(doc.sessions[0]).sort()).toEqual(['createdAt', 'h', 'lastSeen', 'user']);
    expect(doc.sessions[0].h).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(doc.sessions[0].h).not.toBe(s.id);
    // Putting the stored hash in the cookie gets nothing.
    expect(boot().get(doc.sessions[0].h)).toBeNull();
  });

  it('writes atomically with owner-only permissions and leaves no temp files', () => {
    const store = boot();
    store.create('owner');
    store.create('owner');
    expect(readdirSync(dir)).toEqual(['sessions.json']);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('enforces the idle timeout after a restart', () => {
    const s = boot().create('owner');
    t += IDLE - 1000;
    expect(boot().get(s.id)?.user).toBe('owner'); // within idle: ok, and lastSeen is persisted
    t += IDLE - 1000;
    expect(boot().get(s.id)?.user).toBe('owner'); // idle counts from the last use, not from login
    t += IDLE + 1;
    expect(boot().get(s.id)).toBeNull();
  });

  it('throttles lastSeen writes but never lets the idle timeout run longer than configured', () => {
    const store = boot();
    const s = store.create('owner');
    const created = s.createdAt;
    t += 10_000;
    expect(store.get(s.id)).not.toBeNull();
    expect(onDisk().sessions[0].lastSeen).toBe(created); // 10 s < flush interval: no disk write
    t += FLUSH;
    store.get(s.id);
    expect(onDisk().sessions[0].lastSeen).toBe(t); // flushed
    const flushedAt = t;
    t += 30_000;
    store.get(s.id); // in memory only
    // Restart: the file is at most FLUSH behind, so the session ends at most FLUSH early, never late.
    t = flushedAt + IDLE + 1;
    expect(boot().get(s.id)).toBeNull();
  });

  it('enforces the absolute lifetime after a restart even with constant activity', () => {
    const s = boot().create('owner');
    for (let i = 0; i < 16; i++) {
      t += 29 * 60_000;
      expect(boot().get(s.id)?.user).toBe('owner');
    }
    t += 29 * 60_000; // 17 * 29 min > 8 h
    expect(boot().get(s.id)).toBeNull();
  });

  it('prunes expired sessions on load and on prune()', () => {
    const store = boot();
    const old = store.create('owner');
    t += IDLE / 2;
    const fresh = store.create('owner');
    t += IDLE / 2 + 1; // `old` is now idle-expired, `fresh` is not
    const restarted = boot();
    expect(restarted.get(fresh.id)?.user).toBe('owner');
    expect(onDisk().sessions).toHaveLength(1);
    t += IDLE + 1;
    restarted.prune();
    expect(onDisk().sessions).toHaveLength(0);
    expect(restarted.get(old.id)).toBeNull();
  });

  it('logout removes the session from disk', () => {
    const store = boot();
    const s = store.create('owner');
    const other = store.create('owner');
    store.destroy(s.id);
    expect(onDisk().sessions).toHaveLength(1);
    const after = boot();
    expect(after.get(s.id)).toBeNull();
    expect(after.get(other.id)?.user).toBe('owner');
    store.destroy(undefined);
    store.destroy('unknown');
  });

  it('treats a corrupt file as "no sessions" and recovers on the next login', () => {
    const s = boot().create('owner');
    for (const junk of ['{"v":1,"sessions":[', '\u0000\u0001binary', '[]', '{"v":2,"binding":"x","sessions":[]}', '']) {
      writeFileSync(file, junk);
      const store = boot();
      expect(store.get(s.id)).toBeNull();
      const fresh = store.create('owner');
      expect(boot().get(fresh.id)?.user).toBe('owner');
    }
    expect(logs.some((m) => m.includes('not valid JSON'))).toBe(true);
  });

  it('drops malformed records but keeps valid ones', () => {
    const store = boot();
    const s = store.create('owner');
    const doc = onDisk();
    doc.sessions.push(
      { h: 'short', user: 'owner', createdAt: t, lastSeen: t },
      { h: 'A'.repeat(43), user: 'owner', createdAt: t, lastSeen: t + 10 * 3_600_000 }, // lastSeen in the future
      { h: 'B'.repeat(43), user: '', createdAt: t, lastSeen: t },
      { h: 'C'.repeat(43), user: 'owner', createdAt: t, lastSeen: t - 1 }, // lastSeen before createdAt
    );
    writeFileSync(file, JSON.stringify(doc));
    const after = boot();
    expect(after.get(s.id)?.user).toBe('owner');
    expect(after.size).toBe(1);
    expect(onDisk().sessions).toHaveLength(1);
  });

  it('does not crash when the file cannot be read or written', () => {
    mkdirSync(file); // a directory where the file should be: read and rename both fail
    const store = boot();
    const s = store.create('owner');
    expect(store.get(s.id)?.user).toBe('owner'); // works in memory
    store.destroy(s.id);
    expect(store.get(s.id)).toBeNull();
    expect(logs.some((m) => m.includes('write failed'))).toBe(true);
    expect(readdirSync(dir)).toEqual(['sessions.json']); // no temp files left behind
  });

  it('a changed admin password hash invalidates every stored session', () => {
    const s = boot().create('owner');
    secret = `v1\nscrypt$16384$8$1$bmV3$bmV3aGFzaA==\nowner\n`;
    const after = boot();
    expect(after.get(s.id)).toBeNull();
    expect(onDisk().sessions).toHaveLength(0); // the old records are gone from the file
    secret = `v1\n${HASH}\nowner\n`; // even rolling back does not resurrect them
    expect(boot().get(s.id)).toBeNull();
  });

  it('a password change while running logs everyone out without a restart', () => {
    const store = boot();
    const s = store.create('owner');
    expect(store.get(s.id)).not.toBeNull();
    secret = `v1\nscrypt$16384$8$1$bmV3$bmV3aGFzaA==\nowner\n`;
    expect(store.get(s.id)).toBeNull();
    expect(store.size).toBe(0);
    expect(onDisk().sessions).toHaveLength(0);
    expect(logs.join('\n')).not.toContain('scrypt'); // log lines never carry the secret
  });

  it('a changed session epoch or admin user also invalidates stored sessions', () => {
    const s = boot().create('owner');
    secret = `v1\n${HASH}\nowner\nrotated-2026-11-24`;
    expect(boot().get(s.id)).toBeNull();
    secret = `v1\n${HASH}\nowner\n`;
    const s2 = boot().create('owner');
    secret = `v1\n${HASH}\nsomeone-else\n`;
    expect(boot().get(s2.id)).toBeNull();
  });

  it('refuses sessions while the password hash is unavailable, and login fails loudly', () => {
    const s = boot().create('owner');
    const store = boot({ secret: () => { throw new Error('ENOENT'); } });
    expect(store.get(s.id)).toBeNull();
    expect(() => store.create('owner')).toThrow();
    expect(onDisk().sessions).toHaveLength(1); // nothing destroyed: back once the secret is back
    expect(boot().get(s.id)?.user).toBe('owner');
  });

  it('memory-only mode (no file) writes nothing', () => {
    const store = new SessionStore({ idleMs: IDLE, absoluteMs: ABSOLUTE }, () => t);
    const s = store.create('owner');
    expect(store.get(s.id)?.csrf).toBe(s.csrf);
    expect(readdirSync(dir)).toEqual([]);
  });
});
