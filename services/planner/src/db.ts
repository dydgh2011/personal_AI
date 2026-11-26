import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite schema of the planner. One file in the planner's own volume; nothing else mounts it.
 * Migrations are append-only: add a new entry, never edit an applied one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT,
    kind TEXT NOT NULL DEFAULT 'task',          -- task | study | habit
    priority INTEGER NOT NULL DEFAULT 2,        -- 1 high, 2 normal, 3 low
    estimate_minutes INTEGER NOT NULL,
    done_minutes INTEGER NOT NULL DEFAULT 0,
    deadline TEXT,                              -- local YYYY-MM-DD (due by the end of that day)
    earliest TEXT,                              -- local YYYY-MM-DD: do not plan before
    status TEXT NOT NULL DEFAULT 'open',        -- open | done | archived
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE plans (
    date TEXT PRIMARY KEY,                      -- local YYYY-MM-DD
    status TEXT NOT NULL,                       -- draft | confirmed
    generated_at TEXT,
    confirmed_at TEXT,
    unscheduled TEXT NOT NULL DEFAULT '[]',     -- JSON: deadline work that did not fit when drafted
    updated_at TEXT NOT NULL
  );
  CREATE TABLE blocks (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    start TEXT NOT NULL,                        -- local HH:MM
    end TEXT NOT NULL,
    title TEXT NOT NULL,
    todo_id TEXT,
    origin TEXT NOT NULL,                       -- auto | manual
    removed INTEGER NOT NULL DEFAULT 0,         -- 1: delete from the calendar on the next confirm
    google_event_id TEXT,
    synced_date TEXT,
    synced_start TEXT,
    synced_end TEXT,
    synced_title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX blocks_date ON blocks(date);
  -- Every change, who made it and the details: the raw record of what happened.
  CREATE TABLE change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,                        -- hermes | system | calendar
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    detail TEXT NOT NULL
  );
  CREATE TABLE jobs (key TEXT PRIMARY KEY, ran_at TEXT NOT NULL);
  CREATE TABLE reminders (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- Google OAuth tokens (secret): never returned by the API, never logged.
  CREATE TABLE google_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    refresh_token TEXT NOT NULL,
    access_token TEXT,
    access_expires_at INTEGER,
    scope TEXT,
    connected_at TEXT NOT NULL
  );
  CREATE TABLE oauth_pending (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `,
  // 2: one managed calendar ("Kelly") instead of the primary calendar; colour categories;
  //    deadline markers; one-time import from the owner's other calendars.
  `
  ALTER TABLE blocks ADD COLUMN category TEXT NOT NULL DEFAULT 'task';
  ALTER TABLE todos ADD COLUMN deadline_event_id TEXT;
  ALTER TABLE todos ADD COLUMN deadline_synced TEXT;          -- "date|title" last written to the calendar
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE import_candidates (
    n INTEGER PRIMARY KEY,                     -- number shown to the owner
    source_calendar TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    event TEXT NOT NULL,                       -- JSON: the source event (title, timing, recurrence, location)
    suggested_category TEXT NOT NULL,
    imported_event_id TEXT,
    scanned_at TEXT NOT NULL
  );
  CREATE TABLE imported (source_event_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, imported_at TEXT NOT NULL);
  `,
  // 3: the old calendars are reference information only (never copied as they are); fixed events
  //    are rebuilt with the owner through proposals (drafts the owner picks from).
  `
  CREATE TABLE reference_events (
    source_calendar TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    title TEXT NOT NULL,
    timing TEXT NOT NULL,                      -- JSON, local time
    recurrence TEXT,                           -- JSON RRULE/EXDATE lines
    location TEXT,
    description TEXT,
    raw TEXT NOT NULL,                         -- JSON: the event as read from Google
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (source_calendar, source_event_id)
  );
  CREATE TABLE proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,      -- shown as A, B, ... Z, AA
    title TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL,                      -- draft | applied | discarded
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE proposal_items (
    proposal_id INTEGER NOT NULL REFERENCES proposals(id),
    n INTEGER NOT NULL,
    spec TEXT NOT NULL,                        -- JSON: event_add fields, validated
    event_id TEXT,                             -- set once written to the Kelly calendar
    PRIMARY KEY (proposal_id, n)
  );
  `,
  // 4: one all-day "시험(이날): ..." marker per exam/quiz event (owner request 2026-11-25).
  `
  CREATE TABLE exam_markers (
    source_event_id TEXT PRIMARY KEY,          -- the timed exam/quiz event in the Kelly calendar
    marker_event_id TEXT NOT NULL,             -- the all-day marker event
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    synced TEXT NOT NULL,                      -- "date|title|format" last written
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 5: what really happened with planned items (2026-11-26, Kelly's main purpose: fit plans to the owner's real
  //    pace). Never updated: a correction is a new row pointing at the one it corrects.
  `
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_kind TEXT NOT NULL,                   -- event | block | other
    item_id TEXT,                              -- calendar event id or block id
    todo_id TEXT,                              -- the todo of the block, if any
    title TEXT NOT NULL,
    category TEXT,
    course TEXT,                               -- course code from the title (STA256, CSC207, ...)
    date TEXT NOT NULL,                        -- local YYYY-MM-DD of the planned item
    planned_start TEXT,
    planned_end TEXT,
    planned_minutes INTEGER,
    actual_start TEXT,
    actual_end TEXT,
    minutes INTEGER,                           -- minutes it really took
    status TEXT NOT NULL,                      -- done | partial | skipped | late
    percent INTEGER,                           -- how much got done (0-100)
    note TEXT,                                 -- the owner's reason or note
    corrects INTEGER REFERENCES reports(id),   -- a correction of an earlier report
    todo_minutes INTEGER NOT NULL DEFAULT 0,   -- minutes this report counts on its todo
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX reports_date ON reports(date);
  CREATE INDEX reports_item ON reports(item_id);
  `,
];

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  for (; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
