import type { Database } from 'better-sqlite3';

/**
 * Ordered schema migrations. The index + 1 is stored in `PRAGMA user_version`;
 * append new entries, never edit applied ones.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE tasks (
    id                  TEXT PRIMARY KEY,
    agent               TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
    project_id          TEXT,
    instruction         TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN
                          ('queued', 'running', 'completed', 'failed', 'cancel_requested', 'canceled')),
    result              TEXT,
    error               TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    started_at          TEXT,
    completed_at        TEXT,
    cancel_requested_at TEXT,
    claimed_by          TEXT,
    lease_expires_at    TEXT,
    attempt             INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE INDEX idx_tasks_queue ON tasks (agent, status, created_at);
  CREATE INDEX idx_tasks_created ON tasks (created_at);
  `,
  // v2: who created a task (delegators only see their own) and request idempotency.
  // Additive only; tasks from before v2 could only have been created with the admin token.
  `
  ALTER TABLE tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT 'admin';
  ALTER TABLE tasks ADD COLUMN idempotency_key TEXT;

  CREATE INDEX idx_tasks_creator ON tasks (created_by, created_at);
  CREATE INDEX idx_tasks_idempotency ON tasks (created_by, idempotency_key, created_at)
    WHERE idempotency_key IS NOT NULL;
  `,
  // v3: central project registry. Rows for CONTROLLER_PROJECT_IDS are added at startup
  // (ProjectsService), so existing tasks keep pointing at registered projects.
  `
  CREATE TABLE projects (
    id                   TEXT PRIMARY KEY,
    source               TEXT NOT NULL CHECK (source IN ('local', 'github')),
    github_repository_id INTEGER,
    full_name            TEXT,
    remote_url           TEXT,
    default_branch       TEXT NOT NULL,
    visibility           TEXT CHECK (visibility IS NULL OR visibility IN ('public', 'private', 'internal')),
    allowed_agents       TEXT NOT NULL,
    enabled              INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    allow_code_changes   INTEGER NOT NULL CHECK (allow_code_changes IN (0, 1)),
    auth_mode            TEXT NOT NULL CHECK (auth_mode IN ('none', 'token', 'github_app')),
    description          TEXT,
    sync_status          TEXT NOT NULL CHECK (sync_status IN ('not_synced', 'synced', 'error')),
    last_fetched_at      TEXT,
    cached_head_sha      TEXT,
    last_sync_error      TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    CHECK ((source = 'github') = (full_name IS NOT NULL))
  ) STRICT;

  CREATE UNIQUE INDEX idx_projects_github_id ON projects (github_repository_id) WHERE github_repository_id IS NOT NULL;
  CREATE UNIQUE INDEX idx_projects_full_name ON projects (lower(full_name)) WHERE full_name IS NOT NULL;
  `,
  // v4: reviews. One row per (task, head commit); a decision is only valid for that exact commit.
  `
  CREATE TABLE reviews (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL REFERENCES tasks (id),
    project_id    TEXT NOT NULL,
    agent         TEXT NOT NULL,
    base_sha      TEXT NOT NULL CHECK (length(base_sha) = 40),
    head_sha      TEXT NOT NULL CHECK (length(head_sha) = 40),
    head_tree     TEXT,
    status        TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'approved', 'rejected', 'invalidated')),
    decided_by    TEXT,
    decided_at    TEXT,
    reason        TEXT,
    invalidated_reason TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (task_id, head_sha),
    -- decided_* stay set when an approved review is later invalidated (history is kept)
    CHECK (status NOT IN ('approved', 'rejected') OR (decided_at IS NOT NULL AND decided_by IS NOT NULL))
  ) STRICT;

  CREATE INDEX idx_reviews_status ON reviews (status, created_at);
  `,
  // v5: publications. A request (by an admin) to validate / publish one approved review, handled
  // by the GitHub Publisher. Only one request per review can be in flight, and a review can be
  // published at most once - enforced by the database, so restarts cannot cause a double publish.
  `
  CREATE TABLE publications (
    id               TEXT PRIMARY KEY,
    task_id          TEXT NOT NULL REFERENCES tasks (id),
    review_id        TEXT NOT NULL REFERENCES reviews (id),
    head_sha         TEXT NOT NULL CHECK (length(head_sha) = 40),
    mode             TEXT NOT NULL CHECK (mode IN ('dry-run', 'publish')),
    status           TEXT NOT NULL CHECK (status IN ('pending', 'validating', 'ready', 'failed', 'published', 'pr_created')),
    requested_by     TEXT NOT NULL,
    requested_at     TEXT NOT NULL,
    claimed_by       TEXT,
    claimed_at       TEXT,
    lease_expires_at TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    completed_at     TEXT,
    result           TEXT,
    updated_at       TEXT NOT NULL,
    CHECK (mode = 'publish' OR status NOT IN ('published', 'pr_created'))
  ) STRICT;

  CREATE UNIQUE INDEX idx_publications_one_active ON publications (review_id) WHERE status IN ('pending', 'validating');
  CREATE UNIQUE INDEX idx_publications_one_published ON publications (review_id) WHERE status IN ('published', 'pr_created');
  CREATE INDEX idx_publications_queue ON publications (status, requested_at);
  CREATE INDEX idx_publications_task ON publications (task_id, requested_at);
  `,
  // v6: test evidence and publish authorization (Phase E-2B).
  // - projects.test_commands: admin-approved verification commands (JSON).
  // - test_validations: one run of those commands by the isolated test runner on one exact commit.
  //   Results are evidence signed by the runner; the controller cannot mark a run passed itself.
  // - publish_authorizations: the owner's separate "publish this" decision, bound to the review,
  //   commit, repository and test run; expires; single use.
  `
  ALTER TABLE projects ADD COLUMN test_commands TEXT NOT NULL DEFAULT '[]';

  CREATE TABLE test_validations (
    id                 TEXT PRIMARY KEY,
    task_id            TEXT NOT NULL REFERENCES tasks (id),
    project_id         TEXT NOT NULL,
    base_sha           TEXT NOT NULL CHECK (length(base_sha) = 40),
    commit_sha         TEXT NOT NULL CHECK (length(commit_sha) = 40),
    status             TEXT NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed', 'skipped', 'aborted')),
    commands           TEXT NOT NULL,
    results            TEXT,
    requested_by       TEXT NOT NULL,
    requested_at       TEXT NOT NULL,
    claimed_by         TEXT,
    started_at         TEXT,
    lease_expires_at   TEXT,
    attempts           INTEGER NOT NULL DEFAULT 0,
    completed_at       TEXT,
    evidence           TEXT,
    evidence_hash      TEXT,
    evidence_signature TEXT,
    error              TEXT,
    updated_at         TEXT NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX idx_test_validations_active ON test_validations (task_id, commit_sha) WHERE status IN ('pending', 'running');
  CREATE INDEX idx_test_validations_queue ON test_validations (status, requested_at);
  CREATE INDEX idx_test_validations_task ON test_validations (task_id, requested_at);

  CREATE TABLE publish_authorizations (
    id                 TEXT PRIMARY KEY,
    task_id            TEXT NOT NULL REFERENCES tasks (id),
    review_id          TEXT NOT NULL REFERENCES reviews (id),
    project_id         TEXT NOT NULL,
    repository_id      INTEGER NOT NULL,
    head_sha           TEXT NOT NULL CHECK (length(head_sha) = 40),
    test_validation_id TEXT NOT NULL REFERENCES test_validations (id),
    dry_run_id         TEXT NOT NULL REFERENCES publications (id),
    authorized_by      TEXT NOT NULL,
    authorized_at      TEXT NOT NULL,
    expires_at         TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('active', 'used', 'expired', 'revoked')),
    used_at            TEXT,
    publication_id     TEXT REFERENCES publications (id),
    idempotency_key    TEXT NOT NULL UNIQUE,
    updated_at         TEXT NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX idx_publish_authorizations_active ON publish_authorizations (review_id) WHERE status = 'active';

  ALTER TABLE publications ADD COLUMN authorization_id TEXT REFERENCES publish_authorizations (id);
  ALTER TABLE publications ADD COLUMN idempotency_key TEXT;
  CREATE UNIQUE INDEX idx_publications_idempotency ON publications (idempotency_key) WHERE idempotency_key IS NOT NULL;
  `,
];

export function migrate(db: Database): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema version ${current} is newer than this controller supports (${MIGRATIONS.length})`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    }).immediate();
  }
  return MIGRATIONS.length;
}
