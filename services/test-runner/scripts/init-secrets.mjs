#!/usr/bin/env node
// Provisions the test runner's credentials.
//
//   node services/test-runner/scripts/init-secrets.mjs
//
// - CONTROLLER_TEST_RUNNER_TOKEN appended to secrets/controller.env (test-runner role: claim test
//   runs, report results).
// - secrets/test-runner.env: that token plus TEST_EVIDENCE_KEY, loaded as environment variables of
//   the runner's root process only (test commands run as another uid and get a clean environment,
//   and /proc/<pid>/environ of another uid is not readable).
// - secrets/test-evidence.key: the same evidence key, mounted into the GitHub Publisher, which
//   verifies the runner's HMAC signatures. The controller never gets this key.
// Never prints values; never overwrites existing ones.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const secrets = join(fileURLToPath(new URL('../../../', import.meta.url)), 'secrets');
const controllerEnv = join(secrets, 'controller.env');
const runnerEnv = join(secrets, 'test-runner.env');
const keyFile = join(secrets, 'test-evidence.key');

if (!existsSync(controllerEnv)) {
  console.error(`${controllerEnv} not found; run services/controller/scripts/init-secrets.mjs first`);
  process.exit(1);
}
const env = readFileSync(controllerEnv, 'utf8');
const hasToken = /^CONTROLLER_TEST_RUNNER_TOKEN=/m.test(env);
const present = [hasToken, existsSync(runnerEnv), existsSync(keyFile)];
if (present.every(Boolean)) {
  console.log('test runner credentials already configured');
  process.exit(0);
}
if (present.some(Boolean)) {
  console.error('test runner credentials are only partly configured (controller.env, test-runner.env, test-evidence.key); fix by hand.');
  process.exit(1);
}
const token = randomBytes(32).toString('base64url');
const key = randomBytes(32).toString('hex');
writeFileSync(runnerEnv, `TEST_RUNNER_CONTROLLER_TOKEN=${token}\nTEST_EVIDENCE_KEY=${key}\n`, { mode: 0o600, flag: 'wx' });
writeFileSync(keyFile, `${key}\n`, { mode: 0o600, flag: 'wx' });
appendFileSync(controllerEnv, `${env.endsWith('\n') ? '' : '\n'}# Isolated test runner (test-runner role: claim test runs, report results)\nCONTROLLER_TEST_RUNNER_TOKEN=${token}\n`);
console.log(`created ${runnerEnv} and ${keyFile}`);
console.log(`added CONTROLLER_TEST_RUNNER_TOKEN to ${controllerEnv} (recreate the controller to load it)`);
