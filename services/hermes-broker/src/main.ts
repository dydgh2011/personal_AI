import { readFileSync } from 'node:fs';
import { createBroker, type Logger } from './broker.js';
import { createWatcher, type Watcher } from './watcher.js';

const logger: Logger = {
  info: (msg, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, ...fields })),
  warn: (msg, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, ...fields })),
};

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

/** Optional planner upstream (compose.planner.yaml): PLANNER_URL + PLANNER_KEY_FILE. */
function plannerConfig(): { url: string; key: string } | null {
  const url = process.env.PLANNER_URL?.trim().replace(/\/+$/, '');
  if (!url) return null;
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error('PLANNER_URL must be an http(s) URL');
  const file = process.env.PLANNER_KEY_FILE || '/run/secrets/planner_key';
  let key: string;
  try {
    key = readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`Cannot read the planner key file ${file}`);
  }
  if (key.length < 32 || /\s/.test(key)) throw new Error('The planner key must be at least 32 characters');
  return { url, key };
}

function main(): void {
  const tokenFile = process.env.BROKER_TOKEN_FILE || '/run/secrets/controller_token';
  let token: string;
  try {
    token = readFileSync(tokenFile, 'utf8').trim();
  } catch {
    throw new Error(`Cannot read the controller token file ${tokenFile}`);
  }
  if (token.length < 32 || /\s/.test(token)) throw new Error(`${tokenFile} does not contain a valid token`);
  const controllerUrl = (process.env.CONTROLLER_URL || 'http://controller:3000').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(controllerUrl)) throw new Error('CONTROLLER_URL must be an http(s) URL');
  const port = int('PORT', 8080, 1, 65535);
  let clientKey: string | null = null;
  if (process.env.BROKER_CLIENT_KEY_FILE) {
    try {
      clientKey = readFileSync(process.env.BROKER_CLIENT_KEY_FILE, 'utf8').trim();
    } catch {
      throw new Error(`Cannot read the client key file ${process.env.BROKER_CLIENT_KEY_FILE}`);
    }
    if (clientKey.length < 32 || /\s/.test(clientKey)) throw new Error('The broker client key must be at least 32 characters');
  }

  const server = createBroker(
    {
      controllerUrl,
      token,
      submitPerMinute: int('BROKER_SUBMIT_PER_MINUTE', 5, 1, 1000),
      submitPerHour: int('BROKER_SUBMIT_PER_HOUR', 30, 1, 10000),
      upstreamTimeoutMs: int('BROKER_UPSTREAM_TIMEOUT_SECONDS', 15, 1, 120) * 1000,
      clientKey,
      planner: plannerConfig(),
      plannerWritesPerMinute: int('BROKER_PLANNER_WRITES_PER_MINUTE', 30, 1, 1000),
    },
    logger,
  );
  server.listen(port, '0.0.0.0', () => logger.info('Broker listening', { port, controller: controllerUrl, clientKey: clientKey !== null }));

  // Optional: report finished Hermes tasks to the notifier (compose.notifier.yaml).
  let watcher: Watcher | null = null;
  const notifierUrl = process.env.NOTIFIER_URL?.trim().replace(/\/+$/, '');
  if (notifierUrl) {
    if (!/^https?:\/\/[^\s/]+/.test(notifierUrl)) throw new Error('NOTIFIER_URL must be an http(s) URL');
    const keyFile = process.env.NOTIFIER_KEY_FILE || '/run/secrets/notifier_key';
    let notifierKey: string;
    try {
      notifierKey = readFileSync(keyFile, 'utf8').trim();
    } catch {
      throw new Error(`Cannot read the notifier key file ${keyFile}`);
    }
    if (notifierKey.length < 32 || /\s/.test(notifierKey)) throw new Error('The notifier key must be at least 32 characters');
    watcher = createWatcher(
      {
        controllerUrl,
        token,
        notifierUrl,
        notifierKey,
        intervalMs: int('WATCH_INTERVAL_SECONDS', 15, 5, 3600) * 1000,
        lookbackMs: int('WATCH_LOOKBACK_MINUTES', 120, 1, 10080) * 60_000,
        hostWorkspaces: (process.env.BROKER_HOST_WORKSPACES ?? '').trim().replace(/[\\/]+$/, ''),
        timeoutMs: int('BROKER_UPSTREAM_TIMEOUT_SECONDS', 15, 1, 120) * 1000,
      },
      logger,
    );
    logger.info('Task watcher started', { notifier: notifierUrl });
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      watcher?.stop();
      server.close(() => process.exit(0));
    });
  }
}

try {
  main();
} catch (error) {
  logger.warn((error as Error).message);
  process.exit(1);
}
