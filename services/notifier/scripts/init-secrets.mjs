#!/usr/bin/env node
// Prepares the notifier's secrets (never prints a secret, never overwrites an existing file):
//   secrets/notifier-broker.key   key hermes-broker sends as X-Notifier-Key (generated)
//   secrets/notifier.env          DISCORD_MENTION_USER_ID (taken from Hermes' Discord home channel if found)
//   secrets/discord-webhook.url   NOT created here: the owner pastes the Discord webhook URL into it
//
//   node services/notifier/scripts/init-secrets.mjs
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const secrets = join(root, 'secrets');

const keyFile = join(secrets, 'notifier-broker.key');
if (existsSync(keyFile)) console.log(`${keyFile} already exists; kept`);
else {
  writeFileSync(keyFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`created ${keyFile}`);
}

const envFile = join(secrets, 'notifier.env');
if (existsSync(envFile)) console.log(`${envFile} already exists; kept`);
else {
  let userId = '';
  try {
    const config = readFileSync(join(root, 'data', 'hermes', 'config.yaml'), 'utf8');
    const discord = config.slice(config.search(/^ {2}discord:\s*$/m));
    userId = /^\s+user_id:\s*'?(\d{5,25})'?\s*$/m.exec(discord)?.[1] ?? '';
  } catch {
    // no Hermes config: leave empty
  }
  writeFileSync(envFile, `# Discord user mentioned in notifications (numeric id; empty = no mention)\nDISCORD_MENTION_USER_ID=${userId}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`created ${envFile} (mention user id ${userId ? 'taken from Hermes Discord home channel' : 'empty'})`);
}

const webhookFile = join(secrets, 'discord-webhook.url');
if (existsSync(webhookFile) && readFileSync(webhookFile, 'utf8').trim()) console.log(`${webhookFile} is filled`);
else console.log(`TODO: create ${webhookFile} with the Discord webhook URL (one line)`);
