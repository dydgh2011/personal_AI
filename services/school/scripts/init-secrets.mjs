#!/usr/bin/env node
// Prepares the school service's secrets. Never prints a secret value.
//
//   node services/school/scripts/init-secrets.mjs                      service keys only
//   node services/school/scripts/init-secrets.mjs --import <.env>      + the owner's school credentials
//        (QUERCUS_TOKEN, QUERCUS_TOKEN_EXPIRES, PIAZZA_*, GMAIL_*, UOFT_EMAIL) into secrets/school.env
//        (only these keys are copied; an existing school.env is replaced only with --replace)
//
// Service keys (random): secrets/school-broker.key (hermes-broker -> school),
//   secrets/knowledge-school.key (school -> knowledge), secrets/notifier-school.key (school -> notifier).
// The LLM gateway key secrets/llm-school.key comes from services/llm-gateway/scripts/init-secrets.mjs.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const secrets = join(root, 'secrets');
const args = process.argv.slice(2);
const replace = args.includes('--replace');
const i = args.indexOf('--import');
const source = i >= 0 ? args[i + 1] : null;
const KEYS = ['QUERCUS_TOKEN', 'QUERCUS_TOKEN_EXPIRES', 'PIAZZA_EMAIL', 'PIAZZA_PASSWORD', 'PIAZZA_CLASS_IDS', 'GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD', 'UOFT_EMAIL'];

for (const name of ['school-broker.key', 'knowledge-school.key', 'notifier-school.key']) {
  const file = join(secrets, name);
  if (existsSync(file)) console.log(`${name}: already exists; kept`);
  else {
    writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
    console.log(`${name}: created`);
  }
}

if (source) {
  const target = join(secrets, 'school.env');
  if (existsSync(target) && !replace) {
    console.log('school.env: already exists; kept (use --replace to overwrite)');
  } else {
    const found = {};
    for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
      if (m && KEYS.includes(m[1]) && m[2].trim()) found[m[1]] = m[2].trim();
    }
    const out = ['# School connector credentials (read only by the school container). Never commit.'];
    for (const k of KEYS) if (found[k] !== undefined) out.push(`${k}=${found[k]}`);
    writeFileSync(target, `${out.join('\n')}\n`, { mode: 0o600 });
    console.log(`school.env: written with ${KEYS.filter((k) => found[k] !== undefined).join(', ')}`);
    const missing = KEYS.filter((k) => found[k] === undefined);
    if (missing.length) console.log(`school.env: not in the source (set them if needed): ${missing.join(', ')}`);
  }
}
