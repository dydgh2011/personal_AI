#!/usr/bin/env node
// Adds Hermes' restricted (delegator) controller token to an existing secrets/ directory.
//
//   node services/controller/scripts/add-hermes-token.mjs
//
// - Appends CONTROLLER_HERMES_TOKEN to secrets/controller.env (read by the controller).
// - Writes the same value to secrets/hermes-controller.token, which compose mounts
//   read-only into the Hermes container. Hermes never gets the admin token.
// - Never prints the token and never changes existing values: if either side is
//   already present it stops without writing anything.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const secretsDir = process.argv[2] ?? join(repoRoot, 'secrets');
const controllerEnv = join(secretsDir, 'controller.env');
const tokenFile = join(secretsDir, 'hermes-controller.token');

if (!existsSync(controllerEnv)) {
  console.error(`${controllerEnv} not found; run init-secrets.mjs first`);
  process.exit(1);
}
const env = readFileSync(controllerEnv, 'utf8');
const hasEnv = /^CONTROLLER_HERMES_TOKEN=/m.test(env);
if (hasEnv || existsSync(tokenFile)) {
  console.error(
    hasEnv && existsSync(tokenFile)
      ? 'Hermes token already configured; nothing to do.'
      : 'Hermes token is only half configured (controller.env and hermes-controller.token disagree); fix it by hand.',
  );
  process.exit(hasEnv && existsSync(tokenFile) ? 0 : 1);
}

const token = randomBytes(32).toString('base64url');
writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
const separator = env.endsWith('\n') ? '' : '\n';
appendFileSync(controllerEnv, `${separator}# Restricted delegator token for Hermes (create/view/cancel its own tasks)\nCONTROLLER_HERMES_TOKEN=${token}\n`);
console.log(`created ${tokenFile}`);
console.log(`added CONTROLLER_HERMES_TOKEN to ${controllerEnv}`);
