#!/usr/bin/env node
// Prepares the LLM gateway's secrets. Never prints a secret, never overwrites a file unless --replace.
//
//   node services/llm-gateway/scripts/init-secrets.mjs                  caller keys only
//   node services/llm-gateway/scripts/init-secrets.mjs --import <file>  + provider keys from a
//        "name=value" file (public-processing, private-assistant, groq) and GEMINI_API_KEY from
//        secrets/hermes.env
//   ... --replace     overwrite provider key files (after rotating a key)
//
// Caller keys (random):    secrets/llm-hermes.key, llm-learning.key, llm-school.key, llm-dashboard.key,
//                          secrets/notifier-llm.key (gateway -> notifier)
//                          secrets/llm-hermes.env  (LLM_GATEWAY_KEY=<hermes key>, read by Hermes' config)
// Provider keys (gateway only): secrets/llm-openai-public.key, llm-openai-private.key, llm-gemini.key, llm-groq.key
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const secrets = join(root, 'secrets');
const args = process.argv.slice(2);
const replace = args.includes('--replace');
const importIdx = args.indexOf('--import');
const importFile = importIdx >= 0 ? args[importIdx + 1] : null;

function write(name, value, overwrite = false) {
  const file = join(secrets, name);
  if (existsSync(file) && !overwrite) {
    console.log(`${name}: already exists; kept`);
    return;
  }
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  console.log(`${name}: written (${value.length} chars)`);
}

for (const name of ['llm-hermes.key', 'llm-learning.key', 'llm-school.key', 'llm-dashboard.key', 'notifier-llm.key']) {
  write(name, randomBytes(32).toString('base64url'));
}
const hermesKey = readFileSync(join(secrets, 'llm-hermes.key'), 'utf8').trim();
write('llm-hermes.env', `LLM_GATEWAY_KEY=${hermesKey}`, true);

if (importFile) {
  const pairs = Object.fromEntries(
    readFileSync(importFile, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
  const map = { 'public-processing': 'llm-openai-public.key', 'private-assistant': 'llm-openai-private.key', groq: 'llm-groq.key' };
  for (const [src, dest] of Object.entries(map)) {
    if (!pairs[src]) console.log(`${src}: not in ${importFile}; skipped`);
    else write(dest, pairs[src], replace);
  }
  const env = existsSync(join(secrets, 'hermes.env')) ? readFileSync(join(secrets, 'hermes.env'), 'utf8') : '';
  const gem = /^GEMINI_API_KEY=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (gem) write('llm-gemini.key', gem, replace);
  else console.log('GEMINI_API_KEY: not found in secrets/hermes.env; skipped');
}
