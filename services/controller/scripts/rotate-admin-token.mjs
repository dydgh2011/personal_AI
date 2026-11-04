#!/usr/bin/env node
// Replaces the controller ADMIN token with a new random value.
//
//   node services/controller/scripts/rotate-admin-token.mjs
//   docker compose -f compose.yaml -f compose.workers.yaml -f compose.controller.yaml up -d --no-deps controller
//
// Rewrites only the CONTROLLER_ADMIN_TOKEN line of secrets/controller.env (host scripts read it
// from there). Every copy elsewhere, e.g. the unused legacy secrets/hermes.controller.env, stops
// working. Never prints the token.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const secretsDir = process.argv[2] ?? join(repoRoot, 'secrets');
const controllerEnv = join(secretsDir, 'controller.env');

if (!existsSync(controllerEnv)) {
  console.error('controller.env is missing');
  process.exit(1);
}
const env = readFileSync(controllerEnv, 'utf8');
const lines = env.split(/(?<=\n)/);
const index = lines.findIndex((line) => /^CONTROLLER_ADMIN_TOKEN=/.test(line));
if (index < 0 || lines.filter((line) => /^CONTROLLER_ADMIN_TOKEN=/.test(line)).length !== 1) {
  console.error('controller.env must contain exactly one CONTROLLER_ADMIN_TOKEN line');
  process.exit(1);
}

const token = randomBytes(32).toString('base64url');
const eol = lines[index].endsWith('\r\n') ? '\r\n' : lines[index].endsWith('\n') ? '\n' : '';
lines[index] = `CONTROLLER_ADMIN_TOKEN=${token}${eol}`;
// Write both files via a temporary name so a crash never leaves a half-written file.
for (const [file, content] of [[controllerEnv, lines.join('')]]) {
  writeFileSync(`${file}.tmp`, content, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
console.log('rotated CONTROLLER_ADMIN_TOKEN in controller.env; recreate the controller');
