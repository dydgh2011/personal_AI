#!/usr/bin/env node
// Replaces Hermes' delegator token (used by hermes-broker) with a new random value.
//
//   node services/controller/scripts/rotate-hermes-token.mjs
//   docker compose -f compose.yaml -f compose.workers.yaml -f compose.controller.yaml up -d --no-deps controller hermes-broker
//
// Rewrites only the CONTROLLER_HERMES_TOKEN line of secrets/controller.env and
// secrets/hermes-controller.token; every other line is kept byte for byte.
// Never prints the token. Run it whenever the token may have been exposed.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const secretsDir = process.argv[2] ?? join(repoRoot, 'secrets');
const controllerEnv = join(secretsDir, 'controller.env');
const tokenFile = join(secretsDir, 'hermes-controller.token');

if (!existsSync(controllerEnv) || !existsSync(tokenFile)) {
  console.error('controller.env or hermes-controller.token is missing; use add-hermes-token.mjs first');
  process.exit(1);
}
const env = readFileSync(controllerEnv, 'utf8');
const lines = env.split(/(?<=\n)/);
const index = lines.findIndex((line) => /^CONTROLLER_HERMES_TOKEN=/.test(line));
if (index < 0 || lines.filter((line) => /^CONTROLLER_HERMES_TOKEN=/.test(line)).length !== 1) {
  console.error('controller.env must contain exactly one CONTROLLER_HERMES_TOKEN line');
  process.exit(1);
}

const token = randomBytes(32).toString('base64url');
const eol = lines[index].endsWith('\r\n') ? '\r\n' : lines[index].endsWith('\n') ? '\n' : '';
lines[index] = `CONTROLLER_HERMES_TOKEN=${token}${eol}`;
// Write both files via a temporary name so a crash never leaves a half-written file.
for (const [file, content] of [[controllerEnv, lines.join('')], [tokenFile, `${token}\n`]]) {
  writeFileSync(`${file}.tmp`, content, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
console.log('rotated CONTROLLER_HERMES_TOKEN (controller.env + hermes-controller.token); recreate controller and hermes-broker');
