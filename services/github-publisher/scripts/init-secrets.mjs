#!/usr/bin/env node
// Provisions the GitHub Publisher's controller token.
//
//   node services/github-publisher/scripts/init-secrets.mjs
//
// - Appends CONTROLLER_PUBLISHER_TOKEN to secrets/controller.env (publisher role: claim publication
//   requests and report results, nothing else) and writes the same value to
//   secrets/publisher-controller.token, mounted only into the publisher container.
// - Never prints the token and never changes existing values.
// - No GitHub credential is created: Phase E-2A is dry-run only.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const controllerEnv = join(repoRoot, 'secrets', 'controller.env');
const tokenFile = join(repoRoot, 'secrets', 'publisher-controller.token');

if (!existsSync(controllerEnv)) {
  console.error(`${controllerEnv} not found; run services/controller/scripts/init-secrets.mjs first`);
  process.exit(1);
}
const env = readFileSync(controllerEnv, 'utf8');
const hasEnv = /^CONTROLLER_PUBLISHER_TOKEN=/m.test(env);
if (hasEnv && existsSync(tokenFile)) {
  console.log('publisher token already configured');
  process.exit(0);
}
if (hasEnv || existsSync(tokenFile)) {
  console.error('publisher token is only half configured (controller.env and publisher-controller.token disagree); fix it by hand.');
  process.exit(1);
}
const token = randomBytes(32).toString('base64url');
writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
appendFileSync(controllerEnv, `${env.endsWith('\n') ? '' : '\n'}# GitHub Publisher (publisher role: claim publication requests, report results)\nCONTROLLER_PUBLISHER_TOKEN=${token}\n`);
console.log(`created ${tokenFile}`);
console.log(`added CONTROLLER_PUBLISHER_TOKEN to ${controllerEnv} (recreate the controller to load it)`);
