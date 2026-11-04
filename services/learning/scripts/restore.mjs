#!/usr/bin/env node
// Restores the learning database from a backup made by backup.mjs.
//
//   node services/learning/scripts/restore.mjs data/backups/learning/learning-<stamp>.db
//
// Stops the learning service, checks the backup's integrity, replaces the database in the volume
// (WAL files removed), starts the service again and waits for it to be healthy. Other services are
// not touched.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('usage: restore.mjs <backup file>');
  process.exit(2);
}
const container = process.env.LEARNING_CONTAINER ?? 'personal_ai-learning-1';
const volume = process.env.LEARNING_VOLUME ?? 'personal_ai_learning-data';
const image = process.env.LEARNING_IMAGE ?? 'personal_ai-learning:local';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

docker('stop', container);
try {
  const out = docker('run', '--rm', '--user', 'node', '--network', 'none',
    '-v', `${volume}:/var/lib/learning`, '-v', `${resolve(dirname(file))}:/restore:ro`,
    '--entrypoint', 'node', image, 'dist/backup.js', 'restore', `/restore/${basename(file)}`, '/var/lib/learning/learning.db').trim().split('\n').at(-1);
  console.log(out);
  if (!JSON.parse(out).ok) process.exitCode = 1;
} finally {
  docker('start', container);
}
for (let i = 0; i < 30; i++) {
  const health = docker('inspect', '-f', '{{.State.Health.Status}}', container).trim();
  if (health === 'healthy') {
    console.log(JSON.stringify({ restarted: true, health }));
    process.exit(process.exitCode ?? 0);
  }
  await sleep(2000);
}
console.error('learning service did not become healthy after restore');
process.exit(1);
