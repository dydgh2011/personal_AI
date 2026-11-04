import BetterSqlite3 from 'better-sqlite3';
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';

/**
 * Backup / restore of the learning database, run inside the learning image:
 *   node dist/backup.js backup  <db> <target>    online copy (sqlite backup API) + integrity check
 *   node dist/backup.js restore <source> <db>    only while the service is stopped
 * Prints one JSON line. Used by services/learning/scripts/{backup,restore}.mjs.
 */
async function main(): Promise<number> {
  const [mode, from, to] = process.argv.slice(2);
  const print = (v: unknown) => process.stdout.write(JSON.stringify(v) + '\n');
  const check = (path: string) => {
    const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
    try {
      return { integrity: db.pragma('integrity_check', { simple: true }) as string, schema: db.pragma('user_version', { simple: true }) as number };
    } finally {
      db.close();
    }
  };
  if (mode === 'backup' && from && to) {
    const db = new BetterSqlite3(from, { readonly: true, fileMustExist: true });
    await db.backup(to);
    db.close();
    // A standalone file (no -wal/-shm needed), so it can be opened from read-only media later.
    const copy = new BetterSqlite3(to);
    copy.pragma('journal_mode = DELETE');
    copy.close();
    const result = check(to);
    print({ ok: result.integrity === 'ok', ...result, file: to });
    return result.integrity === 'ok' ? 0 : 1;
  }
  if (mode === 'restore' && from && to) {
    // Work on a copy inside the (writable) data volume: the source may be on read-only media.
    const incoming = `${to}.incoming`;
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(incoming + suffix)) rmSync(incoming + suffix);
    copyFileSync(from, incoming);
    const result = check(incoming);
    if (result.integrity !== 'ok') {
      rmSync(incoming, { force: true });
      print({ ok: false, error: 'backup failed integrity_check', ...result });
      return 1;
    }
    const tmp = `${to}.restoring`;
    const src = new BetterSqlite3(incoming, { fileMustExist: true });
    await src.backup(tmp);
    src.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(incoming + suffix)) rmSync(incoming + suffix);
    for (const suffix of ['-wal', '-shm']) if (existsSync(to + suffix)) rmSync(to + suffix);
    renameSync(tmp, to);
    print({ ok: true, ...check(to), restoredFrom: from });
    return 0;
  }
  print({ ok: false, error: 'usage: backup.js backup <db> <target> | restore <source> <db>' });
  return 2;
}

process.exitCode = await main();
