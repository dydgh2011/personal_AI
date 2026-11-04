#!/usr/bin/env node
// Creates secrets/hermes-broker-client.key: the key the Hermes plugin sends as X-Broker-Key.
//
//   node services/hermes-broker/scripts/add-client-key.mjs
//
// Mounted (compose secret) into hermes-broker and into Hermes, where only the
// personal_ai_task plugin reads it. Never printed; an existing file is never overwritten.
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const secretsDir = process.argv[2] ?? join(fileURLToPath(new URL('../../../', import.meta.url)), 'secrets');
const file = join(secretsDir, 'hermes-broker-client.key');
if (existsSync(file)) {
  console.log(`${file} already exists; nothing to do`);
  process.exit(0);
}
writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
console.log(`created ${file}`);
