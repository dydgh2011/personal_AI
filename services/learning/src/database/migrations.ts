import type { Database } from 'better-sqlite3';

/**
 * Learning Service schema. Owned by this service only (no other service reads or writes it).
 * Approved roadmap versions are immutable: there is no UPDATE path for roadmap_versions,
 * roadmap_nodes or prerequisite_edges; restoring creates a new version.
 */
export const MIGRATIONS: readonly string[] = [
  // v1: L1 - domains, ideas, goals, versioned roadmaps, AI proposals, AI usage, audit.
  `
  CREATE TABLE domains (
    id          TEXT PRIMARY KEY,
    parent_id   TEXT REFERENCES domains (id),
    title       TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL CHECK (status IN ('exploring', 'planned', 'active', 'paused', 'maintaining', 'archived')),
    priority    INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  ) STRICT;

  CREATE TABLE ideas (
    id          TEXT PRIMARY KEY,
    text        TEXT NOT NULL,
    domain_ids  TEXT NOT NULL DEFAULT '[]',
    project_ids TEXT NOT NULL DEFAULT '[]',
    priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
    state       TEXT NOT NULL DEFAULT 'inbox' CHECK (state IN ('inbox', 'triaged', 'promoted', 'archived')),
    source      TEXT NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'hermes', 'import')),
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_ideas_state ON ideas (state, created_at);

  CREATE TABLE goals (
    id           TEXT PRIMARY KEY,
    domain_id    TEXT NOT NULL REFERENCES domains (id),
    title        TEXT NOT NULL,
    target       TEXT,
    target_level INTEGER CHECK (target_level BETWEEN 0 AND 4),
    constraints  TEXT NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL CHECK (status IN ('active', 'paused', 'achieved', 'abandoned')),
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  ) STRICT;

  CREATE TABLE roadmaps (
    id                 TEXT PRIMARY KEY,
    goal_id            TEXT NOT NULL REFERENCES goals (id),
    title              TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    current_version_id TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  ) STRICT;

  CREATE TABLE roadmap_versions (
    id           TEXT PRIMARY KEY,
    roadmap_id   TEXT NOT NULL REFERENCES roadmaps (id),
    version      INTEGER NOT NULL CHECK (version >= 1),
    content      TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    proposal_id  TEXT NOT NULL,
    approved_by  TEXT NOT NULL,
    approved_at  TEXT NOT NULL,
    UNIQUE (roadmap_id, version)
  ) STRICT;

  CREATE TABLE skills (
    id             TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL UNIQUE,
    display_name   TEXT NOT NULL,
    created_at     TEXT NOT NULL
  ) STRICT;

  CREATE TABLE roadmap_nodes (
    version_id       TEXT NOT NULL REFERENCES roadmap_versions (id),
    key              TEXT NOT NULL,
    type             TEXT NOT NULL CHECK (type IN ('stage', 'topic', 'skill', 'milestone')),
    title            TEXT NOT NULL,
    parent_key       TEXT,
    estimate_minutes INTEGER,
    skill_id         TEXT REFERENCES skills (id),
    PRIMARY KEY (version_id, key)
  ) STRICT;

  CREATE TABLE prerequisite_edges (
    version_id TEXT NOT NULL REFERENCES roadmap_versions (id),
    from_key   TEXT NOT NULL,
    to_key     TEXT NOT NULL,
    PRIMARY KEY (version_id, from_key, to_key)
  ) STRICT;

  CREATE TABLE ai_proposals (
    id                 TEXT PRIMARY KEY,
    roadmap_id         TEXT NOT NULL REFERENCES roadmaps (id),
    source             TEXT NOT NULL CHECK (source IN ('ai', 'user', 'restore', 'import')),
    base_version_id    TEXT,
    state              TEXT NOT NULL CHECK (state IN ('invalid', 'awaiting_user_approval', 'applied', 'rejected')),
    payload            TEXT NOT NULL,
    validation_errors  TEXT NOT NULL DEFAULT '[]',
    input              TEXT,
    provider           TEXT,
    model              TEXT,
    prompt_version     TEXT,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    cost_usd           REAL,
    created_by         TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    decided_by         TEXT,
    decided_at         TEXT,
    applied_version_id TEXT
  ) STRICT;
  CREATE INDEX idx_proposals_roadmap ON ai_proposals (roadmap_id, created_at);

  CREATE TABLE ai_calls (
    id             TEXT PRIMARY KEY,
    at             TEXT NOT NULL,
    month          TEXT NOT NULL,
    provider       TEXT NOT NULL,
    model          TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    purpose        TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('ok', 'error')),
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    cost_usd       REAL NOT NULL DEFAULT 0,
    error          TEXT
  ) STRICT;
  CREATE INDEX idx_ai_calls_month ON ai_calls (month);

  CREATE TABLE audit_events (
    id          TEXT PRIMARY KEY,
    at          TEXT NOT NULL,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    detail_hash TEXT
  ) STRICT;
  CREATE INDEX idx_audit_entity ON audit_events (entity_type, entity_id);
  `,
];

export function migrate(db: Database): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema version ${current} is newer than this service supports (${MIGRATIONS.length})`);
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    }).immediate();
  }
  return MIGRATIONS.length;
}
