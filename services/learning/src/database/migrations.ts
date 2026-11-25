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

  // v2: L2 - rubrics (immutable versions), milestones (user-fixed vs suggested deadlines),
  // assignments (definition versions), submissions (immutable revisions + stored files, never
  // executed), evaluations (+ evidence; failures kept), skill mastery (self vs verified), gaps.
  // Triggers make the "immutable" rules hold even against a future code bug.
  `
  CREATE TRIGGER roadmap_versions_immutable BEFORE UPDATE ON roadmap_versions
  BEGIN SELECT RAISE(ABORT, 'roadmap versions are immutable'); END;
  CREATE TRIGGER roadmap_versions_no_delete BEFORE DELETE ON roadmap_versions
  BEGIN SELECT RAISE(ABORT, 'roadmap versions are immutable'); END;

  CREATE TABLE rubrics (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  ) STRICT;

  CREATE TABLE rubric_versions (
    id            TEXT PRIMARY KEY,
    rubric_id     TEXT NOT NULL REFERENCES rubrics (id),
    version       INTEGER NOT NULL CHECK (version >= 1),
    criteria      TEXT NOT NULL,
    passing_score REAL NOT NULL CHECK (passing_score >= 0),
    max_score     REAL NOT NULL CHECK (max_score > 0),
    content_hash  TEXT NOT NULL CHECK (length(content_hash) = 64),
    created_by    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (rubric_id, version)
  ) STRICT;
  CREATE TRIGGER rubric_versions_immutable BEFORE UPDATE ON rubric_versions
  BEGIN SELECT RAISE(ABORT, 'rubric versions are immutable'); END;
  CREATE TRIGGER rubric_versions_no_delete BEFORE DELETE ON rubric_versions
  BEGIN SELECT RAISE(ABORT, 'rubric versions are immutable'); END;

  CREATE TABLE milestones (
    id                        TEXT PRIMARY KEY,
    roadmap_id                TEXT NOT NULL REFERENCES roadmaps (id),
    node_key                  TEXT,
    title                     TEXT NOT NULL,
    description               TEXT,
    passing_criteria          TEXT,
    rubric_version_id         TEXT REFERENCES rubric_versions (id),
    skill_ids                 TEXT NOT NULL DEFAULT '[]',
    weight                    INTEGER NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 100),
    status                    TEXT NOT NULL CHECK (status IN ('planned', 'active', 'completed', 'archived')),
    fixed_deadline            TEXT,
    fixed_deadline_set_by     TEXT,
    fixed_deadline_set_at     TEXT,
    suggested_deadline        TEXT,
    suggested_deadline_source TEXT CHECK (suggested_deadline_source IN ('ai', 'planner')),
    suggested_deadline_reason TEXT,
    suggested_at              TEXT,
    created_by                TEXT NOT NULL,
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_milestones_roadmap ON milestones (roadmap_id, created_at);

  CREATE TABLE assignments (
    id                 TEXT PRIMARY KEY,
    milestone_id       TEXT NOT NULL REFERENCES milestones (id),
    title              TEXT NOT NULL,
    kind               TEXT NOT NULL CHECK (kind IN ('text', 'file', 'code', 'photo', 'experiment')),
    instructions       TEXT NOT NULL,
    rubric_version_id  TEXT REFERENCES rubric_versions (id),
    definition_version INTEGER NOT NULL DEFAULT 1 CHECK (definition_version >= 1),
    status             TEXT NOT NULL CHECK (status IN ('planned', 'available', 'submitted', 'evaluated', 'passed', 'revision_required', 'archived')),
    decided_by         TEXT,
    decided_at         TEXT,
    decision_evaluation_id TEXT,
    created_by         TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_assignments_milestone ON assignments (milestone_id, created_at);

  CREATE TABLE assignment_definitions (
    assignment_id     TEXT NOT NULL REFERENCES assignments (id),
    version           INTEGER NOT NULL CHECK (version >= 1),
    title             TEXT NOT NULL,
    kind              TEXT NOT NULL,
    instructions      TEXT NOT NULL,
    rubric_version_id TEXT,
    created_by        TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    PRIMARY KEY (assignment_id, version)
  ) STRICT;
  CREATE TRIGGER assignment_definitions_immutable BEFORE UPDATE ON assignment_definitions
  BEGIN SELECT RAISE(ABORT, 'assignment definitions are immutable'); END;

  CREATE TABLE submissions (
    id                 TEXT PRIMARY KEY,
    assignment_id      TEXT NOT NULL REFERENCES assignments (id),
    revision           INTEGER NOT NULL CHECK (revision >= 1),
    definition_version INTEGER NOT NULL,
    body               TEXT,
    note               TEXT,
    content_hash       TEXT NOT NULL CHECK (length(content_hash) = 64),
    submitted_by       TEXT NOT NULL,
    submitted_at       TEXT NOT NULL,
    UNIQUE (assignment_id, revision)
  ) STRICT;
  CREATE TRIGGER submissions_immutable BEFORE UPDATE ON submissions
  BEGIN SELECT RAISE(ABORT, 'submissions are immutable'); END;
  CREATE TRIGGER submissions_no_delete BEFORE DELETE ON submissions
  BEGIN SELECT RAISE(ABORT, 'submissions are immutable'); END;

  CREATE TABLE submission_files (
    id            TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES submissions (id),
    position      INTEGER NOT NULL,
    name          TEXT NOT NULL,
    media_type    TEXT NOT NULL,
    category      TEXT NOT NULL CHECK (category IN ('text', 'image', 'pdf')),
    size          INTEGER NOT NULL CHECK (size >= 0),
    sha256        TEXT NOT NULL CHECK (length(sha256) = 64),
    content       BLOB NOT NULL,
    UNIQUE (submission_id, position)
  ) STRICT;
  CREATE TRIGGER submission_files_immutable BEFORE UPDATE ON submission_files
  BEGIN SELECT RAISE(ABORT, 'submission files are immutable'); END;
  CREATE TRIGGER submission_files_no_delete BEFORE DELETE ON submission_files
  BEGIN SELECT RAISE(ABORT, 'submission files are immutable'); END;

  CREATE TABLE evaluations (
    id                TEXT PRIMARY KEY,
    submission_id     TEXT NOT NULL REFERENCES submissions (id),
    rubric_version_id TEXT REFERENCES rubric_versions (id),
    evaluator_type    TEXT NOT NULL CHECK (evaluator_type IN ('ai', 'owner')),
    evaluator         TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
    outcome           TEXT CHECK (outcome IN ('meets_rubric', 'below_rubric', 'inconclusive')),
    scores            TEXT NOT NULL DEFAULT '[]',
    total_score       REAL,
    max_score         REAL,
    feedback          TEXT,
    confidence        REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    limitations       TEXT NOT NULL DEFAULT '[]',
    suggestions       TEXT NOT NULL DEFAULT '{}',
    error_code        TEXT,
    error_message     TEXT,
    provider          TEXT,
    model             TEXT,
    prompt_version    TEXT,
    input_tokens      INTEGER,
    output_tokens     INTEGER,
    cost_usd          REAL,
    requested_by      TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    completed_at      TEXT
  ) STRICT;
  CREATE INDEX idx_evaluations_submission ON evaluations (submission_id, created_at);
  CREATE INDEX idx_evaluations_created ON evaluations (created_at);
  -- Only a pending evaluation may change (once, to completed or failed); results are history.
  CREATE TRIGGER evaluations_final BEFORE UPDATE ON evaluations WHEN OLD.status <> 'pending'
  BEGIN SELECT RAISE(ABORT, 'finished evaluations are immutable'); END;
  CREATE TRIGGER evaluations_no_delete BEFORE DELETE ON evaluations
  BEGIN SELECT RAISE(ABORT, 'evaluations are kept as history'); END;

  CREATE TABLE evaluation_evidence (
    id            TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL REFERENCES evaluations (id),
    type          TEXT NOT NULL CHECK (type IN ('criterion_score', 'excerpt', 'owner_check', 'reference')),
    criterion     TEXT,
    source_ref    TEXT NOT NULL,
    excerpt       TEXT,
    hash          TEXT CHECK (hash IS NULL OR length(hash) = 64),
    verified      INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
    score         REAL,
    note          TEXT,
    limitations   TEXT,
    created_at    TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_evidence_evaluation ON evaluation_evidence (evaluation_id);
  CREATE TRIGGER evaluation_evidence_immutable BEFORE UPDATE ON evaluation_evidence
  BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;
  CREATE TRIGGER evaluation_evidence_no_delete BEFORE DELETE ON evaluation_evidence
  BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;

  -- Self-assessment and verified level are separate columns and never derived from each other.
  CREATE TABLE skill_mastery (
    skill_id               TEXT PRIMARY KEY REFERENCES skills (id),
    self_level             INTEGER CHECK (self_level BETWEEN 0 AND 4),
    self_note              TEXT,
    self_assessed_at       TEXT,
    verified_level         INTEGER CHECK (verified_level BETWEEN 0 AND 4),
    verified_evaluation_id TEXT REFERENCES evaluations (id),
    verified_by            TEXT,
    verified_at            TEXT,
    confidence             REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    updated_at             TEXT NOT NULL
  ) STRICT;

  CREATE TABLE mastery_events (
    id            TEXT PRIMARY KEY,
    skill_id      TEXT NOT NULL REFERENCES skills (id),
    kind          TEXT NOT NULL CHECK (kind IN ('self', 'verified')),
    level         INTEGER NOT NULL CHECK (level BETWEEN 0 AND 4),
    evaluation_id TEXT REFERENCES evaluations (id),
    note          TEXT,
    actor         TEXT NOT NULL,
    at            TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_mastery_events_skill ON mastery_events (skill_id, at);
  CREATE TRIGGER mastery_events_immutable BEFORE UPDATE ON mastery_events
  BEGIN SELECT RAISE(ABORT, 'mastery history is append-only'); END;

  CREATE TABLE gaps (
    id            TEXT PRIMARY KEY,
    skill_id      TEXT REFERENCES skills (id),
    title         TEXT NOT NULL,
    description   TEXT,
    source        TEXT NOT NULL CHECK (source IN ('owner', 'ai')),
    evaluation_id TEXT REFERENCES evaluations (id),
    status        TEXT NOT NULL CHECK (status IN ('suggested', 'open', 'addressed', 'dismissed')),
    created_by    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_gaps_status ON gaps (status, created_at);
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
