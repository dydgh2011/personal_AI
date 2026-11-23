import { readFileSync } from 'node:fs';
import { CLIENT_RIGHTS, type ClientDef, type ProviderId } from './config.js';
import { createGateway, type LlmEvent, type Logger } from './gateway.js';
import { Store } from './store.js';

const logger: Logger = {
  info: (msg, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, ...fields })),
  warn: (msg, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, ...fields })),
};

function readSecret(file: string, what: string, optional = false): string | null {
  let value: string;
  try {
    value = readFileSync(file, 'utf8').trim();
  } catch {
    if (optional) return null;
    throw new Error(`Cannot read ${what} (${file})`);
  }
  if (!value) {
    if (optional) return null;
    throw new Error(`${what} (${file}) is empty`);
  }
  if (/\s/.test(value)) throw new Error(`${what} (${file}) must be one line without spaces`);
  return value;
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const v = Number(raw);
  if (!(v >= min && v <= max)) throw new Error(`${name} must be a number between ${min} and ${max}`);
  return v;
}

function main(): void {
  // LLM_CLIENTS = name=/path/to/key[,name2=/path2]; rights per name come from config.ts.
  const clients: ClientDef[] = (process.env.LLM_CLIENTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, file] = entry.split('=');
      if (!name || !Object.hasOwn(CLIENT_RIGHTS, name) || !file) throw new Error(`Invalid LLM_CLIENTS entry "${entry}" (known callers: ${Object.keys(CLIENT_RIGHTS).join(', ')})`);
      const key = readSecret(file, `the key for ${name}`)!;
      if (key.length < 32) throw new Error(`The key for ${name} must be at least 32 characters`);
      return { name, key, ...CLIENT_RIGHTS[name] };
    });
  if (!clients.length) throw new Error('LLM_CLIENTS must name at least one caller');

  const keyFiles: Record<ProviderId, string> = {
    'openai-public': process.env.LLM_OPENAI_PUBLIC_KEY_FILE || '/run/secrets/openai_public',
    'openai-private': process.env.LLM_OPENAI_PRIVATE_KEY_FILE || '/run/secrets/openai_private',
    gemini: process.env.LLM_GEMINI_KEY_FILE || '/run/secrets/gemini',
    groq: process.env.LLM_GROQ_KEY_FILE || '/run/secrets/groq',
  };
  const providerKeys: Partial<Record<ProviderId, string>> = {};
  for (const [id, file] of Object.entries(keyFiles) as Array<[ProviderId, string]>) {
    const key = readSecret(file, `the ${id} API key`, true);
    if (key) providerKeys[id] = key;
  }
  if (!Object.keys(providerKeys).length) throw new Error('No provider API key found');

  const notifierUrl = process.env.NOTIFIER_URL?.trim().replace(/\/+$/, '') || null;
  const notifierKey = notifierUrl ? readSecret(process.env.NOTIFIER_KEY_FILE || '/run/secrets/notifier_key', 'the notifier key') : null;
  const notify = async (event: LlmEvent, key: string) => {
    if (!notifierUrl || !notifierKey) return;
    const res = await fetch(`${notifierUrl}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Notifier-Key': notifierKey },
      body: JSON.stringify({ type: 'llm', key: key.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 160), llm: event }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`notifier answered ${res.status}`);
  };

  const store = new Store(process.env.LLM_DB_FILE || '/var/lib/llm-gateway/gateway.db');
  const port = num('PORT', 8094, 1, 65535);
  const server = createGateway({
    clients,
    providerKeys,
    store,
    logger,
    notify,
    paidDailyCapUsd: num('LLM_PAID_DAILY_CAP_USD', 0.3, 0, 20),
    headersTimeoutMs: num('LLM_HEADERS_TIMEOUT_SECONDS', 90, 5, 600) * 1000,
    idleTimeoutMs: num('LLM_IDLE_TIMEOUT_SECONDS', 120, 5, 900) * 1000,
    maxRetryWaitMs: num('LLM_MAX_RETRY_WAIT_SECONDS', 20, 0, 60) * 1000,
  });
  server.listen(port, '0.0.0.0', () =>
    logger.info('LLM gateway listening', { port, clients: clients.map((c) => c.name), providers: Object.keys(providerKeys), notifier: !!notifierUrl }),
  );
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: (err as Error).message }));
  process.exit(1);
}
