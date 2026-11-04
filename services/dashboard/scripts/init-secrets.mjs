#!/usr/bin/env node
// Provisions the Admin Dashboard's secrets in an existing secrets/ directory.
//
//   node services/dashboard/scripts/init-secrets.mjs              # first-time setup
//   node services/dashboard/scripts/init-secrets.mjs set-password # new admin password (from stdin)
//
// - Appends CONTROLLER_DASHBOARD_TOKEN to secrets/controller.env and writes the same value to
//   secrets/dashboard-controller.token (mounted only into the dashboard container). It is a
//   separate admin credential, so it can be revoked without touching the main admin token.
// - Writes secrets/dashboard-admin.hash (scrypt hash, mounted into the dashboard) and, for a
//   generated password, secrets/dashboard-admin.password (plaintext for the owner; never mounted).
// - Never prints secret values and never overwrites existing ones (set-password replaces only the hash).
import { randomBytes, scryptSync } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const secretsDir = join(repoRoot, 'secrets');
const controllerEnv = join(secretsDir, 'controller.env');
const tokenFile = join(secretsDir, 'dashboard-controller.token');
const hashFile = join(secretsDir, 'dashboard-admin.hash');
const passwordFile = join(secretsDir, 'dashboard-admin.password');

/** Same format as src/lib/security.ts hashPassword: scrypt$N$r$p$salt$hash */
function hashPassword(password) {
  const N = 16384, r = 8, p = 1;
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function ensureToken() {
  if (!existsSync(controllerEnv)) {
    console.error(`${controllerEnv} not found; run services/controller/scripts/init-secrets.mjs first`);
    process.exit(1);
  }
  const env = readFileSync(controllerEnv, 'utf8');
  const hasEnv = /^CONTROLLER_DASHBOARD_TOKEN=/m.test(env);
  if (hasEnv && existsSync(tokenFile)) return console.log('dashboard controller token already configured');
  if (hasEnv || existsSync(tokenFile)) {
    console.error('dashboard token is only half configured (controller.env and dashboard-controller.token disagree); fix it by hand.');
    process.exit(1);
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
  const separator = env.endsWith('\n') ? '' : '\n';
  appendFileSync(controllerEnv, `${separator}# Admin token used only by the Admin Dashboard (decisions recorded as dashboard:<user>)\nCONTROLLER_DASHBOARD_TOKEN=${token}\n`);
  console.log(`created ${tokenFile}`);
  console.log(`added CONTROLLER_DASHBOARD_TOKEN to ${controllerEnv} (recreate the controller to load it)`);
}

function ensurePassword() {
  if (existsSync(hashFile)) return console.log('dashboard admin password hash already configured');
  const password = randomBytes(18).toString('base64url');
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600, flag: 'wx' });
  writeFileSync(hashFile, `${hashPassword(password)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`created ${hashFile}`);
  console.log(`generated admin password in ${passwordFile} (read it locally, then you may delete the file)`);
}

async function setPassword() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (password.length < 12) {
    console.error('password must be at least 12 characters (read from stdin)');
    process.exit(1);
  }
  writeFileSync(hashFile, `${hashPassword(password)}\n`, { mode: 0o600 });
  if (existsSync(passwordFile)) rmSync(passwordFile);
  console.log(`updated ${hashFile} (restart the dashboard; existing sessions end on restart)`);
}

if (process.argv[2] === 'set-password') await setPassword();
else {
  ensureToken();
  ensurePassword();
}
