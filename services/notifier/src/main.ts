import { readFileSync } from 'node:fs';
import { createNotifier, type Logger } from './notifier.js';
import { FileStore } from './store.js';

const logger: Logger = {
  info: (msg, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, ...fields })),
  warn: (msg, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, ...fields })),
};

// Only real Discord webhooks: the URL comes from a secret file, but a wrong value must not
// turn the notifier into a way to send data anywhere else.
const WEBHOOK_PATTERN = /^https:\/\/(?:discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,200}$/;

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
  if (!value) throw new Error(`${what} (${file}) is empty`);
  return value;
}

function main(): void {
  const webhookUrl = secret(process.env.NOTIFIER_WEBHOOK_FILE || '/run/secrets/discord_webhook', 'the Discord webhook URL');
  if (!WEBHOOK_PATTERN.test(webhookUrl)) throw new Error('The webhook file must contain one Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>)');

  const mention = process.env.DISCORD_MENTION_USER_ID?.trim() || null;
  if (mention !== null && !/^\d{5,25}$/.test(mention)) throw new Error('DISCORD_MENTION_USER_ID must be a numeric Discord user id');

  // NOTIFIER_CLIENTS = name=/path/to/key[,name2=/path2]
  const clients = (process.env.NOTIFIER_CLIENTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, file] = entry.split('=');
      if (!name || !/^[a-z][a-z0-9-]{1,40}$/.test(name) || !file) throw new Error(`Invalid NOTIFIER_CLIENTS entry "${entry}"`);
      const key = secret(file, `the key for ${name}`);
      if (key.length < 32 || /\s/.test(key)) throw new Error(`The key for ${name} must be at least 32 characters without spaces`);
      return { name, key };
    });
  if (!clients.length) throw new Error('NOTIFIER_CLIENTS must name at least one caller');

  const dashboardUrl = (process.env.NOTIFIER_DASHBOARD_URL || 'http://127.0.0.1:8710').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(dashboardUrl)) throw new Error('NOTIFIER_DASHBOARD_URL must be an http(s) URL');

  const store = new FileStore(process.env.NOTIFIER_STATE_FILE || '/var/lib/notifier/sent.json');
  const port = int('PORT', 8090, 1, 65535);
  const server = createNotifier(
    {
      webhookUrl,
      mentionUserId: mention,
      clients,
      perMinute: int('NOTIFIER_MAX_PER_MINUTE', 20, 1, 120),
      upstreamTimeoutMs: int('NOTIFIER_UPSTREAM_TIMEOUT_SECONDS', 10, 1, 60) * 1000,
      dashboardUrl,
    },
    store,
    logger,
  );
  server.listen(port, '0.0.0.0', () =>
    logger.info('Notifier listening', { port, clients: clients.map((c) => c.name), mention: mention !== null }),
  );
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

try {
  main();
} catch (error) {
  logger.warn((error as Error).message);
  process.exit(1);
}
