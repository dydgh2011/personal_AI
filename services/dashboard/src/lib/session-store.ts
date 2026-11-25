import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * Server-side admin sessions. Only the random id travels in the HttpOnly cookie; this store keeps
 * the rest, in memory and (optionally) in a small file on the dashboard's writable volume so a
 * container restart does not log the owner out.
 *
 * What is on disk (and nothing else):
 *   { v, binding, sessions: [{ h, user, createdAt, lastSeen }] }
 * - `h` is HMAC-SHA256(key, cookie value). The cookie value itself is never written, and `h`
 *   cannot be turned back into it, so a copy of the file cannot be replayed as a cookie.
 * - The CSRF token is not stored either: it is HMAC(key, "csrf" + cookie value), recomputed on use.
 * - `key` derives (HKDF) from the binding secret: the admin password hash + admin user + an optional
 *   epoch. Changing any of them changes the key and the `binding` fingerprint, so every stored and
 *   in-memory session stops matching and is dropped.
 *
 * Rules kept from the in-memory store: idle timeout and absolute lifetime checked on every use,
 * logout removes the session. A missing, corrupt or unreadable file means "no sessions".
 */

export interface Session {
  id: string;
  user: string;
  csrf: string;
  createdAt: number;
  lastSeen: number;
}

export interface SessionOptions {
  idleMs: number;
  absoluteMs: number;
  /** Where to persist sessions. Omit for memory-only. */
  file?: string;
  /**
   * Material the session key derives from (admin hash, user, epoch). Required for persistence:
   * without it a random per-process key is used and nothing is written. May throw when the
   * material is unavailable; sessions then count as invalid until it is back.
   */
  secret?: () => string;
  /** How stale the persisted lastSeen may get before it is rewritten (default 60 s). */
  flushMs?: number;
  /** Periodic prune of expired sessions (default off; the server enables it). */
  pruneEveryMs?: number;
  /** Diagnostics only; messages never contain secrets, ids or hashes. */
  log?: (message: string) => void;
}

interface Entry {
  user: string;
  createdAt: number;
  lastSeen: number;
  /** lastSeen as last written to disk (0 = not written). */
  persistedSeen: number;
}

const FORMAT = 1;
const MAX_FILE_BYTES = 1_000_000;
const CLOCK_SKEW_MS = 60_000;

export class SessionStore {
  private readonly entries = new Map<string, Entry>();
  private key: Buffer | null = null;
  private keyMaterialHash = '';
  private loaded = false;
  private readonly flushMs: number;
  private readonly persist: boolean;
  private readonly log: (message: string) => void;

  constructor(private readonly options: SessionOptions, private readonly now: () => number = Date.now) {
    this.persist = Boolean(options.file && options.secret);
    this.flushMs = Math.max(0, Math.min(options.flushMs ?? 60_000, options.idleMs / 2));
    this.log = options.log ?? ((m) => console.warn(`sessions: ${m}`));
    if (!options.secret) {
      this.key = randomBytes(32);
      this.loaded = true;
    }
    if (options.pruneEveryMs && options.pruneEveryMs > 0) {
      setInterval(() => this.prune(), options.pruneEveryMs).unref?.();
    }
  }

  create(user: string): Session {
    const key = this.ready(true)!;
    const t = this.now();
    const id = randomBytes(32).toString('base64url');
    this.dropExpired(t);
    this.entries.set(this.idHash(key, id), { user, createdAt: t, lastSeen: t, persistedSeen: 0 });
    this.save();
    return { id, user, csrf: this.csrfFor(key, id), createdAt: t, lastSeen: t };
  }

  get(id: string | undefined): Session | null {
    if (!id || id.length > 256) return null;
    const key = this.ready(false);
    if (!key) return null;
    const h = this.idHash(key, id);
    const entry = this.entries.get(h);
    if (!entry) return null;
    const t = this.now();
    if (this.expired(entry, t)) {
      this.entries.delete(h);
      this.save();
      return null;
    }
    entry.lastSeen = t;
    // Throttled: the file's lastSeen lags by at most flushMs. After a restart that can only make
    // the idle timeout hit earlier, never later.
    if (this.persist && t - entry.persistedSeen >= this.flushMs) this.save();
    return { id, user: entry.user, csrf: this.csrfFor(key, id), createdAt: entry.createdAt, lastSeen: entry.lastSeen };
  }

  destroy(id: string | undefined): void {
    if (!id || id.length > 256) return;
    const key = this.ready(false);
    if (!key) return;
    if (this.entries.delete(this.idHash(key, id))) this.save();
  }

  /** Remove expired sessions (also runs on load and, when configured, on a timer). */
  prune(): void {
    if (!this.ready(false)) return;
    if (this.dropExpired(this.now())) this.save();
  }

  /** Number of live entries (tests, health). */
  get size(): number {
    return this.entries.size;
  }

  // ---- internals

  private expired(entry: Entry, t: number): boolean {
    return t - entry.lastSeen > this.options.idleMs || t - entry.createdAt > this.options.absoluteMs;
  }

  private dropExpired(t: number): boolean {
    let removed = false;
    for (const [h, entry] of this.entries) {
      if (this.expired(entry, t)) {
        this.entries.delete(h);
        removed = true;
      }
    }
    return removed;
  }

  private idHash(key: Buffer, id: string): string {
    return createHmac('sha256', key).update('session-id\0').update(id).digest('base64url');
  }

  private csrfFor(key: Buffer, id: string): string {
    return createHmac('sha256', key).update('csrf\0').update(id).digest('base64url');
  }

  private binding(key: Buffer): string {
    return createHmac('sha256', key).update('binding\0v1').digest('base64url');
  }

  /**
   * The current key, loading the file on first use and dropping every session when the secret
   * material changed. `strict` rethrows when the material is unavailable (login must fail loudly).
   */
  private ready(strict: boolean): Buffer | null {
    if (!this.options.secret) return this.key;
    let material: string;
    try {
      material = this.options.secret();
    } catch (error) {
      if (strict) throw error;
      return null;
    }
    const fingerprint = createHash('sha256').update(material).digest('base64url');
    if (this.key && fingerprint === this.keyMaterialHash) return this.key;

    const rotated = this.key !== null;
    this.key = Buffer.from(hkdfSync('sha256', material, 'personal-ai-dashboard', 'session-store-v1', 32));
    this.keyMaterialHash = fingerprint;
    if (rotated) {
      // Password hash / admin user / epoch changed while running: everyone logs in again.
      this.entries.clear();
      this.log('session key changed; all sessions were invalidated');
      this.save();
    } else if (!this.loaded) {
      this.load(this.key);
    }
    this.loaded = true;
    return this.key;
  }

  private load(key: Buffer): void {
    if (!this.persist) return;
    const file = this.options.file!;
    let raw: string;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) throw new Error('file too large');
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`session file unreadable, starting with no sessions (${(error as Error).message})`);
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      this.log('session file is not valid JSON, starting with no sessions');
      return;
    }
    const doc = data as { v?: unknown; binding?: unknown; sessions?: unknown };
    if (!doc || typeof doc !== 'object' || doc.v !== FORMAT || !Array.isArray(doc.sessions)) {
      this.log('session file has an unknown format, starting with no sessions');
      return;
    }
    if (doc.binding !== this.binding(key)) {
      this.log('session file belongs to another password/user/epoch; all stored sessions were invalidated');
      this.save();
      return;
    }
    const t = this.now();
    let dropped = 0;
    for (const item of doc.sessions as unknown[]) {
      const s = item as { h?: unknown; user?: unknown; createdAt?: unknown; lastSeen?: unknown };
      const valid =
        s && typeof s === 'object' &&
        typeof s.h === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s.h) &&
        typeof s.user === 'string' && s.user.length > 0 && s.user.length <= 64 &&
        Number.isFinite(s.createdAt) && Number.isFinite(s.lastSeen) &&
        (s.lastSeen as number) >= (s.createdAt as number) &&
        (s.lastSeen as number) <= t + CLOCK_SKEW_MS;
      if (!valid) {
        dropped++;
        continue;
      }
      const entry: Entry = { user: s.user as string, createdAt: s.createdAt as number, lastSeen: Math.min(s.lastSeen as number, t), persistedSeen: s.lastSeen as number };
      if (this.expired(entry, t)) {
        dropped++;
        continue;
      }
      this.entries.set(s.h as string, entry);
    }
    if (dropped > 0) this.save();
  }

  /** Atomic owner-only write (temp file + rename). Failures keep sessions in memory only. */
  private save(): void {
    if (!this.persist || !this.key) return;
    const file = this.options.file!;
    const sessions = [...this.entries].map(([h, e]) => ({ h, user: e.user, createdAt: e.createdAt, lastSeen: e.lastSeen }));
    const body = JSON.stringify({ v: FORMAT, binding: this.binding(this.key), sessions });
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    let fd: number | null = null;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      fd = openSync(tmp, 'wx', 0o600);
      writeSync(fd, body);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, file);
      for (const e of this.entries.values()) e.persistedSeen = e.lastSeen;
    } catch (error) {
      this.log(`session file write failed, sessions kept in memory only (${(error as Error).message})`);
      if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(tmp); } catch { /* never created */ }
    }
  }
}
