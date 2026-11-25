import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';
import { openDatabase } from './sqlite-database.js';

describe('schema migrations', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'controller-migrate-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('upgrades a v1 database in place, keeping every task and attributing it to admin', () => {
    const path = join(dir, 'controller.db');
    const v1 = new BetterSqlite3(path);
    v1.exec(MIGRATIONS[0]);
    v1.pragma('user_version = 1');
    v1.prepare(
      `INSERT INTO tasks (id, agent, project_id, instruction, status, result, created_at, updated_at, attempt)
       VALUES ('00000000-0000-4000-8000-000000000001', 'claude', 'sandbox', 'old task', 'completed', '{"ok":true}',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`,
    ).run();
    v1.close();

    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT * FROM tasks').all()).toEqual([
      expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000001',
        instruction: 'old task',
        status: 'completed',
        result: '{"ok":true}',
        created_by: 'admin',
        idempotency_key: null,
      }),
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 });
    db.close();

    // Re-opening is a no-op.
    const again = openDatabase(path);
    expect(again.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
    again.close();
  });

  it('adds the projects table to a v2 database without touching tasks', () => {
    const path = join(dir, 'v2.db');
    const v2 = new BetterSqlite3(path);
    v2.exec(MIGRATIONS[0]);
    v2.exec(MIGRATIONS[1]);
    v2.pragma('user_version = 2');
    v2.prepare(
      `INSERT INTO tasks (id, agent, project_id, instruction, status, created_at, updated_at, attempt, created_by)
       VALUES ('00000000-0000-4000-8000-000000000002', 'codex', 'sandbox', 'v2 task', 'queued',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, 'delegator:hermes')`,
    ).run();
    v2.close();

    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT id, created_by, status FROM tasks').all()).toEqual([
      { id: '00000000-0000-4000-8000-000000000002', created_by: 'delegator:hermes', status: 'queued' },
    ]);
    const insert = db.prepare(`INSERT INTO projects (id, source, full_name, default_branch, allowed_agents, enabled,
      allow_code_changes, auth_mode, sync_status, created_at, updated_at)
      VALUES (?, ?, ?, 'main', '["claude"]', 1, 0, 'none', 'not_synced', 'now', 'now')`);
    insert.run('a', 'github', 'Owner/Repo');
    expect(() => insert.run('b', 'github', 'owner/repo')).toThrow(/UNIQUE/);
    expect(() => insert.run('c', 'local', 'x/y')).toThrow(/CHECK/);
    db.close();
  });
  it('v7 adds agent settings to existing projects with "nothing configured" defaults', () => {
    const path = join(dir, 'v6.db');
    const v6 = new BetterSqlite3(path);
    for (const sql of MIGRATIONS.slice(0, 6)) v6.exec(sql);
    v6.pragma('user_version = 6');
    v6.prepare(`INSERT INTO projects (id, source, full_name, default_branch, allowed_agents, enabled,
      allow_code_changes, auth_mode, sync_status, test_commands, created_at, updated_at)
      VALUES ('hello', 'github', 'o/r', 'main', '["claude"]', 1, 1, 'none', 'synced', '[{"name":"t","argv":["npm","test"],"timeoutSeconds":60}]', 'now', 'now')`).run();
    v6.close();

    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    const row = db.prepare('SELECT * FROM projects').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      id: 'hello',
      enabled: 1,
      test_commands: '[{"name":"t","argv":["npm","test"],"timeoutSeconds":60}]',
      commit_author: null,
      commit_style: '{"mode":"off","guide":null}',
      agent_instructions: '{"rules":"","forbiddenPaths":[]}',
    });
    db.close();
  });
});
