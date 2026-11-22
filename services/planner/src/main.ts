import { existsSync, readFileSync } from 'node:fs';
import { createApi, createOAuthServer } from './api.js';
import { GoogleConnection } from './connection.js';
import { openDatabase } from './db.js';
import { parseClientFile, type OAuthClient } from './google.js';
import { Jobs } from './jobs.js';
import { notifierClient, type Notify } from './notify.js';
import { Planner } from './planner.js';

const logger = {
  info: (msg: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, ...fields })),
  warn: (msg: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, ...fields })),
};

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function secret(file: string, what: string): string {
  let value: string;
  try {
    value = readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`Cannot read ${what} (${file})`);
  }
  if (value.length < 32 || /\s/.test(value)) throw new Error(`${what} (${file}) must be at least 32 characters without spaces`);
  return value;
}

function main(): void {
  const timeZone = process.env.PLANNER_TIME_ZONE?.trim() || 'America/Toronto';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`PLANNER_TIME_ZONE "${timeZone}" is not a valid IANA time zone`);
  }

  // PLANNER_CLIENTS = name=/path/to/key[,name2=/path2]
  const clients = (process.env.PLANNER_CLIENTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, file] = entry.split('=');
      if (!name || !/^[a-z][a-z0-9-]{1,40}$/.test(name) || !file) throw new Error(`Invalid PLANNER_CLIENTS entry "${entry}"`);
      return { name, key: secret(file, `the key for ${name}`) };
    });
  if (!clients.length) throw new Error('PLANNER_CLIENTS must name at least one caller');

  const notifierUrl = (process.env.NOTIFIER_URL ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(notifierUrl)) throw new Error('NOTIFIER_URL must be an http(s) URL');
  const notify: Notify = notifierClient(notifierUrl, secret(process.env.NOTIFIER_KEY_FILE || '/run/secrets/notifier_key', 'the notifier key'));

  // Google OAuth client: optional, so the planner runs (without calendar) before it is set up.
  const clientFile = process.env.GOOGLE_OAUTH_CLIENT_FILE || '/run/secrets/google_oauth_client';
  let oauthClient: OAuthClient | null = null;
  if (existsSync(clientFile)) oauthClient = parseClientFile(readFileSync(clientFile, 'utf8'));
  else logger.warn('No Google OAuth client file: calendar features are off', { file: clientFile });

  const oauthPort = int('OAUTH_PORT', 8720, 1, 65535);
  const redirectUri = process.env.PLANNER_REDIRECT_URI?.trim() || `http://127.0.0.1:${oauthPort}/oauth/callback`;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/oauth\/callback$/.test(redirectUri)) {
    throw new Error('PLANNER_REDIRECT_URI must be http://127.0.0.1:<port>/oauth/callback (Google allows loopback redirects for desktop clients)');
  }

  const db = openDatabase(process.env.PLANNER_DB_FILE || '/var/lib/planner/planner.db');
  const google = new GoogleConnection(db, oauthClient, redirectUri, timeZone);
  const planner = new Planner(db, google, timeZone);

  const port = int('PORT', 8091, 1, 65535);
  const api = createApi(planner, notify, clients, logger);
  api.listen(port, '0.0.0.0', () => logger.info('Planner API listening', { port, timeZone, clients: clients.map((c) => c.name), calendar: google.status() }));
  const oauth = createOAuthServer(planner, notify, logger);
  oauth.listen(oauthPort, '0.0.0.0', () => logger.info('OAuth callback listening', { port: oauthPort, redirectUri }));

  const jobs = new Jobs(db, planner, notify, logger);
  if ((process.env.PLANNER_JOBS ?? 'on') !== 'off') jobs.start(int('JOBS_INTERVAL_SECONDS', 30, 5, 600) * 1000);
  else logger.warn('Scheduled jobs are off (PLANNER_JOBS=off)');

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      jobs.stop();
      oauth.close();
      api.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}

try {
  main();
} catch (error) {
  logger.warn((error as Error).message);
  process.exit(1);
}
