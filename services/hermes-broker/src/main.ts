import { readFileSync } from 'node:fs';
import { createBroker, type Logger } from './broker.js';

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
    },
    logger,
  );
  server.listen(port, '0.0.0.0', () => logger.info('Broker listening', { port, controller: controllerUrl, clientKey: clientKey !== null }));
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
