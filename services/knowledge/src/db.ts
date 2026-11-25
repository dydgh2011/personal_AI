import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';

/** bge-m3. The vector table is created with this size; another model needs a new migration and re-embedding. */
export const EMBED_DIMENSIONS = 1024;

/**
 * SQLite schema of the knowledge store. One file in the service's own volume.
 * Migrations are append-only: add a new entry, never edit an applied one.
 *
 * Layers (see README):
 *   0 raw_items   originals exactly as received (chat turns, documents, notes); never changed
 *   1 activities  the timeline of what the owner did
 *   2 pages       one wiki page per subject, with facts (sourced, dated) and links
 *   3 page "me"   the owner's profile; the index of pages is computed
 * search_items/search_fts and embeddings serve keyword + semantic search over all layers.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE raw_items (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,                       -- chat | document | note | import | system | school
    kind TEXT NOT NULL,                         -- e.g. discord-turn, pdf, docx, chatgpt-conversation
    title TEXT,
    occurred_at TEXT NOT NULL,                  -- ISO time the original happened (or arrived)
    received_at TEXT NOT NULL,
    external_id TEXT,                           -- caller's id for de-duplication (e.g. a chat turn id)
    sha256 TEXT,                                -- of the original bytes (documents) or the text
    content_type TEXT,
    size INTEGER NOT NULL,
    blob TEXT,                                  -- file name of the stored original in the blob folder
    text TEXT NOT NULL,                         -- the original text, or the text extracted from the file
    meta TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX raw_external ON raw_items(source, external_id) WHERE external_id IS NOT NULL;
  CREATE UNIQUE INDEX raw_document_sha ON raw_items(sha256) WHERE source = 'document';
  CREATE INDEX raw_occurred ON raw_items(occurred_at);
  -- Originals are immutable: no update, no delete (fix mistakes with a new note).
  CREATE TRIGGER raw_items_no_update BEFORE UPDATE ON raw_items BEGIN SELECT RAISE(ABORT, 'raw items are immutable'); END;
  CREATE TRIGGER raw_items_no_delete BEFORE DELETE ON raw_items BEGIN SELECT RAISE(ABORT, 'raw items are immutable'); END;

  CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    type TEXT NOT NULL,                         -- me | course | topic | goal | project | person | habit | place | org | other
    summary TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '[]',         -- JSON array of other names
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE facts (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES pages(id),
    text TEXT NOT NULL,
    observed_on TEXT,                           -- local YYYY-MM-DD the fact was true/said
    source_raw_id TEXT REFERENCES raw_items(id),
    source_note TEXT,                           -- e.g. "owner said in Discord"
    status TEXT NOT NULL DEFAULT 'active',      -- active | superseded | removed
    superseded_by TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX facts_page ON facts(page_id, status);
  CREATE TABLE links (
    from_page TEXT NOT NULL REFERENCES pages(id),
    to_page TEXT NOT NULL REFERENCES pages(id),
    relation TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_page, to_page, relation)
  );
  CREATE TABLE activities (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,                   -- local YYYY-MM-DD or YYYY-MM-DDTHH:MM
    minutes INTEGER,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    outcome TEXT,
    feeling TEXT,
    source_raw_id TEXT REFERENCES raw_items(id),
    status TEXT NOT NULL DEFAULT 'active',      -- active | removed
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX activities_started ON activities(started_at);
  CREATE TABLE activity_pages (
    activity_id TEXT NOT NULL REFERENCES activities(id),
    page_id TEXT NOT NULL REFERENCES pages(id),
    PRIMARY KEY (activity_id, page_id)
  );

  -- Every change: who, what, before and after.
  CREATE TABLE change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    detail TEXT NOT NULL
  );

  -- Search: one row per searchable piece (a raw chunk, a page, a fact, an activity).
  CREATE TABLE search_items (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,                         -- raw | page | fact | activity
    ref_id TEXT NOT NULL,
    part INTEGER NOT NULL DEFAULT 0,
    page_id TEXT,
    date TEXT,
    text TEXT NOT NULL,
    embedding BLOB,                             -- Float32 vector (null = not embedded yet)
    embed_model TEXT,
    embed_failed_at TEXT
  );
  CREATE UNIQUE INDEX search_ref ON search_items(kind, ref_id, part);
  CREATE INDEX search_unembedded ON search_items(rowid) WHERE embedding IS NULL;
  CREATE VIRTUAL TABLE search_fts USING fts5(text, content='search_items', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER search_ai AFTER INSERT ON search_items BEGIN
    INSERT INTO search_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER search_ad AFTER DELETE ON search_items BEGIN
    INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER search_au AFTER UPDATE OF text ON search_items BEGIN
    INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO search_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  `,
  // 2: vectors move to sqlite-vec (int8, KNN in C); controlled permanent deletion of originals;
  //    one stored original per file content across documents and imports.
  `
  CREATE VIRTUAL TABLE vec_items USING vec0(embedding int8[${EMBED_DIMENSIONS}] distance_metric=cosine);
  INSERT INTO vec_items(rowid, embedding)
    SELECT rowid, vec_quantize_int8(vec_f32(embedding), 'unit') FROM search_items WHERE embedding IS NOT NULL AND length(embedding) = ${EMBED_DIMENSIONS * 4};
  UPDATE search_items SET embed_model = NULL WHERE embedding IS NOT NULL AND length(embedding) != ${EMBED_DIMENSIONS * 4};
  DROP INDEX search_unembedded;
  ALTER TABLE search_items DROP COLUMN embedding;
  CREATE INDEX search_unembedded ON search_items(rowid) WHERE embed_model IS NULL;

  -- Originals stay immutable; a permanent delete ("purge", owner's request) is possible only for an id
  -- the purge code put in purge_allow inside the same transaction.
  CREATE TABLE purge_allow (id TEXT PRIMARY KEY);
  DROP TRIGGER raw_items_no_delete;
  CREATE TRIGGER raw_items_no_delete BEFORE DELETE ON raw_items
    WHEN NOT EXISTS (SELECT 1 FROM purge_allow WHERE id = old.id)
    BEGIN SELECT RAISE(ABORT, 'raw items are immutable (only a purge can delete one)'); END;

  DROP INDEX raw_document_sha;
  CREATE UNIQUE INDEX raw_blob_sha ON raw_items(sha256) WHERE blob IS NOT NULL;
  CREATE INDEX raw_source_kind ON raw_items(source, kind);
  `,
  // 3: an optional kind per fact (score, mistake, exam, ...; FACT_KINDS in knowledge.ts) so code picks
  //    facts by kind instead of matching words. NULL = untyped: every existing fact stays valid as it is.
  `
  ALTER TABLE facts ADD COLUMN kind TEXT;
  CREATE INDEX facts_kind ON facts(kind, status) WHERE kind IS NOT NULL;
  `,
  // 4: derived media text and retry state. Purging the original also removes this row.
  `
  CREATE TABLE media_extractions (
    raw_id TEXT PRIMARY KEY REFERENCES raw_items(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('complete', 'empty', 'failed')),
    method TEXT NOT NULL CHECK (method IN ('ocr', 'transcription')),
    text TEXT NOT NULL DEFAULT '',
    code TEXT,
    attempts INTEGER NOT NULL,
    retry_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX raw_media_pending ON raw_items(received_at, id) WHERE blob IS NOT NULL AND text = '';
  CREATE INDEX facts_observed_active ON facts(observed_on) WHERE status = 'active';
  `,
];

export interface OpenOptions {
  /** sqlite-vec loadable extension (default: the one installed with the sqlite-vec package). */
  vecExtension?: string;
  /** WAL (default) on a Docker volume; DELETE on a host bind mount. */
  journalMode?: 'WAL' | 'DELETE';
  /** Tests: stop after this many migrations (to build an older database and upgrade it). */
  upTo?: number;
}

export function openDatabase(file: string, options: OpenOptions = {}): DatabaseSync {
  const db = new DatabaseSync(file, { allowExtension: true });
  db.loadExtension(options.vecExtension ?? getLoadablePath());
  db.exec(`PRAGMA journal_mode = ${options.journalMode ?? 'WAL'}; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  for (; version < Math.min(MIGRATIONS.length, options.upTo ?? MIGRATIONS.length); version++) {
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
