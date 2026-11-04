import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { migrate } from './migrations.js';

/**
 * Opens the learning database with settings suited to a single long-running
 * process that must not lose acknowledged writes:
 * - WAL so reads never block the writer
 * - synchronous=FULL so a committed state change survives power loss
 * - busy_timeout so a second connection (e.g. a backup) waits instead of failing
 */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
