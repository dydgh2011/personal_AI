import { readFileSync } from 'node:fs';

export interface ClientKey {
  name: string;
  key: string;
}

/** A key file: at least 32 characters, no spaces. */
export function readKey(file: string, what: string): string {
  let value: string;
  try {
    value = readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`Cannot read ${what} (${file})`);
  }
  if (value.length < 32 || /\s/.test(value)) throw new Error(`${what} (${file}) must be at least 32 characters without spaces`);
  return value;
}

/**
 * Callers from KNOWLEDGE_CLIENTS = name=/path/to/key[,name2=/path2]; compose overlays add callers in
 * KNOWLEDGE_CLIENTS_<NAME> so they do not overwrite each other's lists.
 * `name?=/path` marks an optional caller: when its key file cannot be read (not created yet) the caller is
 * left out (no access) and the service still starts; a key file that exists but is invalid still stops it.
 */
export function parseClients(
  env: Record<string, string | undefined>,
  read: (file: string, what: string) => string = readKey,
): { clients: ClientKey[]; skipped: Array<{ name: string; reason: string }> } {
  const lists = Object.keys(env)
    .filter((k) => /^KNOWLEDGE_CLIENTS(_[A-Z0-9]+)?$/.test(k))
    .sort()
    .map((k) => env[k] ?? '');
  const clients: ClientKey[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const entry of lists.join(',').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z][a-z0-9-]{1,40})(\?)?=(\S+)$/.exec(entry);
    if (!m) throw new Error(`Invalid KNOWLEDGE_CLIENTS entry "${entry}"`);
    const [, name, optional, file] = m;
    let key: string;
    try {
      key = read(file, `the key for ${name}`);
    } catch (error) {
      if (optional && /^Cannot read/.test((error as Error).message)) {
        skipped.push({ name, reason: (error as Error).message });
        continue;
      }
      throw error;
    }
    clients.push({ name, key });
  }
  if (!clients.length) throw new Error('KNOWLEDGE_CLIENTS must name at least one caller');
  return { clients, skipped };
}
