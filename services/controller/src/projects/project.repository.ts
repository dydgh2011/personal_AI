import { Inject, Injectable } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import type { AgentType } from '../tasks/task.model.js';
import type { AuthMode, Project, ProjectSource, SyncStatus, TestCommand, Visibility } from './project.model.js';

interface ProjectRow {
  id: string;
  source: ProjectSource;
  github_repository_id: number | null;
  full_name: string | null;
  remote_url: string | null;
  default_branch: string;
  visibility: Visibility | null;
  allowed_agents: string;
  enabled: number;
  allow_code_changes: number;
  auth_mode: AuthMode;
  description: string | null;
  sync_status: SyncStatus;
  last_fetched_at: string | null;
  cached_head_sha: string | null;
  last_sync_error: string | null;
  /** JSON TestCommand[] (schema v6). Not written on insert: new projects start with none. */
  test_commands?: string;
  created_at: string;
  updated_at: string;
}

/** Fields an admin may change after registration. */
export type ProjectPatch = Partial<
  Pick<
    Project,
    | 'enabled'
    | 'allowCodeChanges'
    | 'allowedAgents'
    | 'defaultBranch'
    | 'description'
    | 'syncStatus'
    | 'lastFetchedAt'
    | 'cachedHeadSha'
    | 'lastSyncError'
    | 'testCommands'
  >
> & { updatedAt: string };

const PATCH_COLUMNS: Record<keyof ProjectPatch, string> = {
  enabled: 'enabled',
  allowCodeChanges: 'allow_code_changes',
  allowedAgents: 'allowed_agents',
  defaultBranch: 'default_branch',
  description: 'description',
  syncStatus: 'sync_status',
  lastFetchedAt: 'last_fetched_at',
  cachedHeadSha: 'cached_head_sha',
  lastSyncError: 'last_sync_error',
  testCommands: 'test_commands',
  updatedAt: 'updated_at',
};

export class DuplicateProjectError extends Error {}

@Injectable()
export class ProjectRepository {
  private readonly insertStmt;
  private readonly findStmt;
  private readonly listStmt;
  private readonly duplicateStmt;

  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO projects (id, source, github_repository_id, full_name, remote_url, default_branch, visibility,
        allowed_agents, enabled, allow_code_changes, auth_mode, description, sync_status, last_fetched_at,
        cached_head_sha, last_sync_error, created_at, updated_at)
      VALUES (@id, @source, @github_repository_id, @full_name, @remote_url, @default_branch, @visibility,
        @allowed_agents, @enabled, @allow_code_changes, @auth_mode, @description, @sync_status, @last_fetched_at,
        @cached_head_sha, @last_sync_error, @created_at, @updated_at)
      RETURNING *`);
    this.findStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
    this.listStmt = db.prepare('SELECT * FROM projects ORDER BY id');
    this.duplicateStmt = db.prepare(`
      SELECT id FROM projects
       WHERE id = @id
          OR (@full_name IS NOT NULL AND lower(full_name) = lower(@full_name))
          OR (@github_repository_id IS NOT NULL AND github_repository_id = @github_repository_id)
       LIMIT 1`);
  }

  /** Inserts the project, or throws DuplicateProjectError naming the existing project. */
  create(project: Project): Project {
    return this.db
      .transaction((): Project => {
        const row = toRow(project);
        const existing = this.duplicateStmt.get(row) as { id: string } | undefined;
        if (existing) throw new DuplicateProjectError(existing.id);
        return toProject(this.insertStmt.get(row) as ProjectRow);
      })
      .immediate();
  }

  /** Inserts only if no project with this id exists. Returns true when inserted. */
  createIfMissing(project: Project): boolean {
    return this.db
      .transaction((): boolean => {
        if (this.findStmt.get(project.id)) return false;
        this.insertStmt.get(toRow(project));
        return true;
      })
      .immediate();
  }

  /** Number of tasks per status in this project (task history stays in the tasks table). */
  taskCounts(id: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM tasks WHERE project_id = ? GROUP BY status')
      .all(id) as { status: string; count: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  }

  findById(id: string): Project | null {
    const row = this.findStmt.get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  list(): Project[] {
    return (this.listStmt.all() as ProjectRow[]).map(toProject);
  }

  update(id: string, patch: ProjectPatch): Project | null {
    const params: Record<string, unknown> = { id };
    const keys = (Object.keys(patch) as (keyof ProjectPatch)[]).filter((key) => patch[key] !== undefined);
    const assignments = keys.map((key) => {
      const value = patch[key];
      params[`set_${key}`] =
        key === 'allowedAgents' || key === 'testCommands' ? JSON.stringify(value) : typeof value === 'boolean' ? Number(value) : value;
      return `${PATCH_COLUMNS[key]} = @set_${key}`;
    });
    const row = this.db
      .prepare(`UPDATE projects SET ${assignments.join(', ')} WHERE id = @id RETURNING *`)
      .get(params) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    source: row.source,
    githubRepositoryId: row.github_repository_id,
    fullName: row.full_name,
    remoteUrl: row.remote_url,
    defaultBranch: row.default_branch,
    visibility: row.visibility,
    allowedAgents: JSON.parse(row.allowed_agents) as AgentType[],
    enabled: row.enabled === 1,
    allowCodeChanges: row.allow_code_changes === 1,
    authMode: row.auth_mode,
    description: row.description,
    syncStatus: row.sync_status,
    lastFetchedAt: row.last_fetched_at,
    cachedHeadSha: row.cached_head_sha,
    lastSyncError: row.last_sync_error,
    testCommands: row.test_commands ? (JSON.parse(row.test_commands) as TestCommand[]) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(p: Project): ProjectRow {
  return {
    id: p.id,
    source: p.source,
    github_repository_id: p.githubRepositoryId,
    full_name: p.fullName,
    remote_url: p.remoteUrl,
    default_branch: p.defaultBranch,
    visibility: p.visibility,
    allowed_agents: JSON.stringify(p.allowedAgents),
    enabled: p.enabled ? 1 : 0,
    allow_code_changes: p.allowCodeChanges ? 1 : 0,
    auth_mode: p.authMode,
    description: p.description,
    sync_status: p.syncStatus,
    last_fetched_at: p.lastFetchedAt,
    cached_head_sha: p.cachedHeadSha,
    last_sync_error: p.lastSyncError,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}
