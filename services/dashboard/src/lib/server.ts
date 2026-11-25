import 'server-only';
import { appendFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LoginLimiter, SessionStore, type Session } from './security';

export const SESSION_COOKIE = 'pai_session';

const env = (name: string, fallback: string) => process.env[name]?.trim() || fallback;
export const settings = {
  controllerUrl: env('CONTROLLER_URL', 'http://controller:3000').replace(/\/+$/, ''),
  controllerTokenFile: env('CONTROLLER_TOKEN_FILE', '/run/secrets/controller_token'),
  adminUser: env('DASHBOARD_ADMIN_USER', 'owner'),
  adminHashFile: env('DASHBOARD_ADMIN_HASH_FILE', '/run/secrets/admin_password_hash'),
  auditLog: env('DASHBOARD_AUDIT_LOG', '/var/lib/dashboard/audit.log'),
  cookieSecure: env('DASHBOARD_COOKIE_SECURE', 'false') === 'true',
  idleMinutes: Number(env('DASHBOARD_SESSION_IDLE_MINUTES', '30')),
  absoluteHours: Number(env('DASHBOARD_SESSION_ABSOLUTE_HOURS', '8')),
  // Sessions survive restarts in this file on the dashboard-data volume ("none" = memory only).
  sessionFile: env('DASHBOARD_SESSION_FILE', '/var/lib/dashboard/sessions.json'),
  // Change this value (any text) to log every browser out, like a password change does.
  sessionEpoch: env('DASHBOARD_SESSION_EPOCH', ''),
};

/**
 * Key material for the session store: the admin password hash, the admin user and the epoch.
 * Changing any of them invalidates every stored session. Re-read at most every 5 s so a rotated
 * hash file takes effect without a restart; never logged.
 */
let bindingCache: { at: number; value: string } | undefined;
function sessionBinding(): string {
  const t = Date.now();
  if (!bindingCache || t - bindingCache.at > 5_000) {
    bindingCache = { at: t, value: ['v1', readSecret(settings.adminHashFile), settings.adminUser, settings.sessionEpoch].join('\n') };
  }
  return bindingCache.value;
}

// One store per server process, shared by every route and page bundle.
const g = globalThis as unknown as { __paiSessions?: SessionStore; __paiLimiter?: LoginLimiter };
export const sessions = (g.__paiSessions ??= new SessionStore({
  idleMs: settings.idleMinutes * 60_000,
  absoluteMs: settings.absoluteHours * 3_600_000,
  file: settings.sessionFile === 'none' ? undefined : settings.sessionFile,
  secret: sessionBinding,
  flushMs: 60_000,
  pruneEveryMs: 5 * 60_000,
}));
export const limiter = (g.__paiLimiter ??= new LoginLimiter());

export function readSecret(path: string): string {
  return readFileSync(path, 'utf8').trim();
}

export async function currentSession(): Promise<Session | null> {
  return sessions.get((await cookies()).get(SESSION_COOKIE)?.value);
}

/** For pages: the session, or a redirect to /login. */
export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect('/login');
  return session;
}

/**
 * Client address as decided by server-entry.cjs from the TCP peer (forwarded headers count only
 * from DASHBOARD_TRUSTED_PROXIES). X-Forwarded-For itself is never read here.
 */
export async function clientIp(): Promise<string> {
  return (await headers()).get('x-pai-client-ip') || 'unknown';
}

export const DEVICE_COOKIE = 'pai_device';
export const DEVICE_TTL_MS = 30 * 24 * 3_600_000;

/** Append-only JSON lines. Never contains passwords, tokens or diff contents. */
export async function audit(event: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  console.log(`audit ${line}`);
  try {
    await mkdir(dirname(settings.auditLog), { recursive: true });
    await appendFile(settings.auditLog, line + '\n');
  } catch (error) {
    console.error(`audit log write failed: ${(error as Error).message}`);
  }
}
