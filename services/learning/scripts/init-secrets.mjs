#!/usr/bin/env node
// Provisions the AI Learning OS credentials.
//
//   node services/learning/scripts/init-secrets.mjs
//
// - secrets/learning.env: LEARNING_DASHBOARD_TOKEN (read by the learning service) and commented
//   placeholders for the AI settings the owner fills in later.
// - secrets/learning-dashboard.token: the same token, mounted only into the Admin Dashboard.
// - secrets/learning-ai.key: empty placeholder for the AI provider key (owner adds it later).
// - secrets/learning-broker.key and secrets/learning-planner.key: separate service credentials.
// Never prints values; never overwrites existing files.
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const secrets = join(fileURLToPath(new URL('../../../', import.meta.url)), 'secrets');
const envFile = join(secrets, 'learning.env');
const tokenFile = join(secrets, 'learning-dashboard.token');
const keyFile = join(secrets, 'learning-ai.key');

if (!existsSync(secrets)) {
  console.error(`${secrets} not found`);
  process.exit(1);
}
const hasEnv = existsSync(envFile);
const hasToken = existsSync(tokenFile);
if (hasEnv !== hasToken) {
  console.error('learning credentials are only partly configured (learning.env and learning-dashboard.token disagree); fix by hand.');
  process.exit(1);
}
if (!hasEnv) {
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
  writeFileSync(envFile, [
    '# AI Learning OS service',
    `LEARNING_DASHBOARD_TOKEN=${token}`,
    '',
    '# AI drafts stay disabled until all of these are set (then recreate the learning service):',
    '# LEARNING_AI_PROVIDER=gemini',
    '# LEARNING_AI_MODEL=',
    '# LEARNING_AI_MONTHLY_BUDGET_USD=',
    '# LEARNING_AI_INPUT_USD_PER_MTOK=',
    '# LEARNING_AI_OUTPUT_USD_PER_MTOK=',
    '# The key itself goes into secrets/learning-ai.key (one line).',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  console.log(`created ${envFile} and ${tokenFile}`);
} else {
  console.log('learning token already configured');
}
if (!existsSync(keyFile)) {
  writeFileSync(keyFile, '', { mode: 0o600, flag: 'wx' });
  console.log(`created empty ${keyFile} (add the AI provider key later)`);
}
for (const name of ['learning-broker.key', 'learning-planner.key']) {
  const path = join(secrets, name);
  if (existsSync(path)) continue;
  writeFileSync(path, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`created ${name}`);
}
