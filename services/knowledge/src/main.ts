import { readFileSync } from 'node:fs';
import { createApi } from './api.js';
import { openDatabase } from './db.js';
import { EmbedError, ollamaEmbedder } from './embed.js';
import { Knowledge } from './knowledge.js';

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
  const timeZone = process.env.KNOWLEDGE_TIME_ZONE?.trim() || 'America/Toronto';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`KNOWLEDGE_TIME_ZONE "${timeZone}" is not a valid IANA time zone`);
  }
  // KNOWLEDGE_CLIENTS = name=/path/to/key[,name2=/path2]; compose overlays add callers in
  // KNOWLEDGE_CLIENTS_<NAME> so they do not overwrite each other's lists.
  const clientLists = Object.keys(process.env)
    .filter((k) => /^KNOWLEDGE_CLIENTS(_[A-Z0-9]+)?$/.test(k))
    .sort()
    .map((k) => process.env[k] ?? '');
  const clients = clientLists
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, file] = entry.split('=');
      if (!name || !/^[a-z][a-z0-9-]{1,40}$/.test(name) || !file) throw new Error(`Invalid KNOWLEDGE_CLIENTS entry "${entry}"`);
      return { name, key: secret(file, `the key for ${name}`) };
    });
  if (!clients.length) throw new Error('KNOWLEDGE_CLIENTS must name at least one caller');

  const ollamaUrl = process.env.OLLAMA_URL?.trim().replace(/\/+$/, '');
  if (ollamaUrl && !/^https?:\/\/[^\s/]+/.test(ollamaUrl)) throw new Error('OLLAMA_URL must be an http(s) URL');
  const model = process.env.EMBED_MODEL?.trim() || 'bge-m3';
  const embedder = ollamaUrl ? ollamaEmbedder(ollamaUrl, model) : null;

  const journal = (process.env.KNOWLEDGE_DB_JOURNAL ?? 'WAL').toUpperCase();
  if (journal !== 'WAL' && journal !== 'DELETE') throw new Error('KNOWLEDGE_DB_JOURNAL must be WAL or DELETE');
  const db = openDatabase(process.env.KNOWLEDGE_DB_FILE || '/var/lib/knowledge/knowledge.db', { journalMode: journal });
  const kb = new Knowledge(db, {
    timeZone,
    blobDir: process.env.KNOWLEDGE_BLOB_DIR || '/var/lib/knowledge/blobs',
    documentsDir: process.env.KNOWLEDGE_DOCUMENTS_DIR?.trim() || null,
    embedder,
  });

  const port = int('PORT', 8092, 1, 65535);
  createApi(kb, clients, logger).listen(port, '0.0.0.0', () =>
    logger.info('Knowledge API listening', { port, timeZone, clients: clients.map((c) => c.name), ...kb.stats() }),
  );

  // Background embedding: new items get a vector within seconds; when Ollama is off, keyword search still works.
  if (embedder) {
    const interval = int('EMBED_INTERVAL_SECONDS', 10, 1, 3600) * 1000;
    let lastWarning = 0;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        for (let n = 0; n < 50 && (await kb.embedPending(32)) > 0; n++);
      } catch (error) {
        if (Date.now() - lastWarning > 10 * 60_000) {
          lastWarning = Date.now();
          logger.warn('Embedding paused', { error: (error as Error).message, unreachable: error instanceof EmbedError && error.unreachable });
        }
      } finally {
        running = false;
      }
    };
    setInterval(() => void tick(), interval).unref();
    void tick();
  }
}

main();
