import { Inject, Injectable } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { TRANSITIONS } from './task-state.js';
import type { AgentType, Task, TaskStatus } from './task.model.js';
import {
  TaskRepository,
  type ClaimRequest,
  type ExpireLeasesRequest,
  type IdempotentCreateResult,
  type StatusCount,
  type TaskListFilter,
  type TaskListPage,
  type TaskPatch,
  type UpdateCondition,
} from './task.repository.js';

interface TaskRow {
  id: string;
  agent: AgentType;
  project_id: string | null;
  instruction: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancel_requested_at: string | null;
  claimed_by: string | null;
  lease_expires_at: string | null;
  attempt: number;
  created_by: string;
  idempotency_key: string | null;
}

/** Patch field -> column. Only these columns can ever appear in a dynamic UPDATE. */
const PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  status: 'status',
  result: 'result',
  error: 'error',
  completedAt: 'completed_at',
  cancelRequestedAt: 'cancel_requested_at',
  leaseExpiresAt: 'lease_expires_at',
  updatedAt: 'updated_at',
};

/**
 * SQLite implementation. better-sqlite3 is synchronous and every mutation is
 * a single `UPDATE ... WHERE <preconditions> RETURNING *` statement, so each
 * one is atomic even with several connections on the same file: SQLite
 * serialises writers, and the WHERE clause is re-evaluated under the write lock.
 */
@Injectable()
export class SqliteTaskRepository extends TaskRepository {
  private readonly insertStmt;
  private readonly findStmt;
  private readonly findIdempotentStmt;
  private readonly claimStmt;
  private readonly expireStmt;
  private readonly countStmt;

  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database) {
    super();
    this.insertStmt = db.prepare(`
      INSERT INTO tasks (id, agent, project_id, instruction, status, result, error,
        created_at, updated_at, started_at, completed_at, cancel_requested_at,
        claimed_by, lease_expires_at, attempt, created_by, idempotency_key)
      VALUES (@id, @agent, @project_id, @instruction, @status, @result, @error,
        @created_at, @updated_at, @started_at, @completed_at, @cancel_requested_at,
        @claimed_by, @lease_expires_at, @attempt, @created_by, @idempotency_key)
      RETURNING *`);
    this.findStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
    this.findIdempotentStmt = db.prepare(`
      SELECT * FROM tasks
       WHERE created_by = @created_by AND idempotency_key = @idempotency_key AND created_at >= @since
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`);
    this.claimStmt = db.prepare(`
      UPDATE tasks
         SET status = @to,
             claimed_by = @workerId,
             started_at = @now,
             updated_at = @now,
             lease_expires_at = @leaseExpiresAt,
             attempt = attempt + 1
       WHERE id = (SELECT id FROM tasks
                    WHERE agent = @agent AND status = @from
                    ORDER BY created_at, rowid
                    LIMIT 1)
         AND status = @from
      RETURNING *`);
    const expireFrom = TRANSITIONS.expireLease.from;
    this.expireStmt = db.prepare(`
      UPDATE tasks
         SET status = @to,
             error = @error,
             completed_at = @now,
             updated_at = @now,
             lease_expires_at = NULL
       WHERE status IN (${expireFrom.map((_, i) => `@from_${i}`).join(', ')})
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= @now
      RETURNING *`);
    this.countStmt = db.prepare(
      'SELECT agent, status, COUNT(*) AS count FROM tasks GROUP BY agent, status',
    );
  }

  async create(task: Task): Promise<Task> {
    return toTask(this.insertStmt.get(toRow(task)) as TaskRow);
  }

  async createIdempotent(task: Task & { idempotencyKey: string }, since: string): Promise<IdempotentCreateResult> {
    // Lookup and insert in one IMMEDIATE transaction: concurrent duplicates serialise on the write lock.
    return this.db
      .transaction((): IdempotentCreateResult => {
        const existing = this.findIdempotentStmt.get({
          created_by: task.createdBy,
          idempotency_key: task.idempotencyKey,
          since,
        }) as TaskRow | undefined;
        if (existing) return { task: toTask(existing), created: false };
        return { task: toTask(this.insertStmt.get(toRow(task)) as TaskRow), created: true };
      })
      .immediate();
  }

  async findById(id: string): Promise<Task | null> {
    const row = this.findStmt.get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  async list(filter: TaskListFilter): Promise<TaskListPage> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: filter.limit, offset: filter.offset };
    if (filter.status) {
      clauses.push('status = @status');
      params.status = filter.status;
    }
    if (filter.agent) {
      clauses.push('agent = @agent');
      params.agent = filter.agent;
    }
    if (filter.projectId) {
      clauses.push('project_id = @projectId');
      params.projectId = filter.projectId;
    }
    if (filter.createdBy) {
      clauses.push('created_by = @createdBy');
      params.createdBy = filter.createdBy;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC, rowid DESC LIMIT @limit OFFSET @offset`)
      .all(params) as TaskRow[];
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM tasks ${where}`)
      .get(withoutPaging(params)) as { total: number };

    return { items: rows.map(toTask), total };
  }

  async claimNext(request: ClaimRequest): Promise<Task | null> {
    const row = this.claimStmt.get({
      ...request,
      from: TRANSITIONS.claim.from[0],
      to: TRANSITIONS.claim.to,
    }) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  async update(id: string, condition: UpdateCondition, patch: TaskPatch): Promise<Task | null> {
    if (condition.from.length === 0) return null;

    const params: Record<string, unknown> = { id };
    const keys = (Object.keys(patch) as (keyof TaskPatch)[]).filter((key) => patch[key] !== undefined);
    const assignments = keys.map((key) => {
      params[`set_${key}`] = patch[key];
      return `${PATCH_COLUMNS[key]} = @set_${key}`;
    });
    const fromPlaceholders = condition.from.map((status, i) => {
      params[`from_${i}`] = status;
      return `@from_${i}`;
    });
    const clauses = ['id = @id', `status IN (${fromPlaceholders.join(', ')})`];
    if (condition.agent !== undefined) {
      clauses.push('agent = @agent');
      params.agent = condition.agent;
    }
    if (condition.claimedBy !== undefined) {
      clauses.push('claimed_by = @claimedBy');
      params.claimedBy = condition.claimedBy;
    }
    if (condition.leaseActiveAt !== undefined) {
      clauses.push('lease_expires_at > @leaseActiveAt');
      params.leaseActiveAt = condition.leaseActiveAt;
    }

    const row = this.db
      .prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE ${clauses.join(' AND ')} RETURNING *`)
      .get(params) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  async expireLeases(request: ExpireLeasesRequest): Promise<Task[]> {
    const params: Record<string, unknown> = { ...request, to: TRANSITIONS.expireLease.to };
    TRANSITIONS.expireLease.from.forEach((status, i) => (params[`from_${i}`] = status));
    return (this.expireStmt.all(params) as TaskRow[]).map(toTask);
  }

  async countByAgentAndStatus(): Promise<StatusCount[]> {
    return this.countStmt.all() as StatusCount[];
  }

  async ping(): Promise<void> {
    this.db.prepare('SELECT 1').get();
  }
}

function withoutPaging(params: Record<string, unknown>): Record<string, unknown> {
  const { limit: _limit, offset: _offset, ...rest } = params;
  return rest;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    agent: row.agent,
    projectId: row.project_id,
    instruction: row.instruction,
    status: row.status,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelRequestedAt: row.cancel_requested_at,
    claimedBy: row.claimed_by,
    leaseExpiresAt: row.lease_expires_at,
    attempt: row.attempt,
    createdBy: row.created_by,
    idempotencyKey: row.idempotency_key,
  };
}

function toRow(task: Task): TaskRow {
  return {
    id: task.id,
    agent: task.agent,
    project_id: task.projectId,
    instruction: task.instruction,
    status: task.status,
    result: task.result,
    error: task.error,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    started_at: task.startedAt,
    completed_at: task.completedAt,
    cancel_requested_at: task.cancelRequestedAt,
    claimed_by: task.claimedBy,
    lease_expires_at: task.leaseExpiresAt,
    attempt: task.attempt,
    created_by: task.createdBy,
    idempotency_key: task.idempotencyKey,
  };
}
