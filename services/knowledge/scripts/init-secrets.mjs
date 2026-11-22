#!/usr/bin/env node
// Prepares the knowledge service's secrets (never prints them, never overwrites an existing file):
//   secrets/knowledge-broker.key     key hermes-broker sends to the knowledge service as X-Knowledge-Key
//   secrets/knowledge-operator.key   key of the operator CLI (scripts/kb.mjs) and the importer;
//                                    accepted only while compose.knowledge-operator.yaml is in use
//
//   node services/knowledge/scripts/init-secrets.mjs
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
for (const name of ['knowledge-broker.key', 'knowledge-operator.key']) {
  const file = join(root, 'secrets', name);
  if (existsSync(file)) console.log(`${file} already exists; kept`);
  else {
    writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
    console.log(`created ${file}`);
  }
}
