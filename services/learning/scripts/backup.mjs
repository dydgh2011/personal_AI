#!/usr/bin/env node
// Backs up the learning database OUT of its Docker volume, into data/backups/learning/.
//
//   node services/learning/scripts/backup.mjs          (keeps the newest 14 backups)
//
// Online and consistent (SQLite backup API inside the running container), integrity-checked,
// then copied to the host. Never touches the live database file.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const container = process.env.LEARNING_CONTAINER ?? 'personal_ai-learning-1';
const dir = join(root, 'data', 'backups', 'learning');
const keep = Number(process.env.LEARNING_BACKUP_KEEP ?? 14);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const name = `learning-${stamp}.db`;
const inVolume = `/var/lib/learning/${name}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

mkdirSync(dir, { recursive: true });
try {
  const out = docker('exec', container, 'node', 'dist/backup.js', 'backup', '/var/lib/learning/learning.db', inVolume).trim().split('\n').at(-1);
  const result = JSON.parse(out);
  if (!result.ok) throw new Error(`backup failed integrity check: ${out}`);
  docker('cp', `${container}:${inVolume}`, join(dir, name));
  console.log(JSON.stringify({ ok: true, file: join(dir, name), schema: result.schema, integrity: result.integrity }));
} finally {
  try {
    docker('exec', container, 'rm', '-f', inVolume);
  } catch {
    // container gone: nothing to clean up
  }
}
const backups = readdirSync(dir).filter((f) => /^learning-.*\.db$/.test(f)).sort();
for (const old of backups.slice(0, Math.max(0, backups.length - keep))) rmSync(join(dir, old));
