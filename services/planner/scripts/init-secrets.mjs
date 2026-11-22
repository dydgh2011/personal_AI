#!/usr/bin/env node
// Prepares the planner's secrets (never prints a secret, never overwrites an existing file):
//   secrets/planner-broker.key        key hermes-broker sends to the planner as X-Planner-Key (generated)
//   secrets/notifier-planner.key      key the planner sends to the notifier as X-Notifier-Key (generated)
//   secrets/google-oauth-client.json  NOT created here: the "Desktop app" OAuth client downloaded from Google Cloud
//
//   node services/planner/scripts/init-secrets.mjs
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const secrets = join(root, 'secrets');

for (const name of ['planner-broker.key', 'notifier-planner.key']) {
  const file = join(secrets, name);
  if (existsSync(file)) console.log(`${file} already exists; kept`);
  else {
    writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
    console.log(`created ${file}`);
  }
}

const client = join(secrets, 'google-oauth-client.json');
if (!existsSync(client)) console.log(`TODO: save the Google "Desktop app" OAuth client JSON as ${client}`);
else {
  try {
    const installed = JSON.parse(readFileSync(client, 'utf8')).installed;
    console.log(installed?.client_id && installed?.client_secret ? `${client} looks like a Desktop app client` : `${client} is not a Desktop app client (no "installed" key)`);
  } catch {
    console.log(`${client} is not valid JSON`);
  }
}
