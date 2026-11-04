import type { AgentType, Task, TaskStatus } from './task.model.js';

export interface TaskListFilter {
  status?: TaskStatus;
  agent?: AgentType;
  createdBy?: string;
  projectId?: string;
  limit: number;
  offset: number;
}

export interface TaskListPage {
  items: Task[];
  total: number;
}

/** Fields that may change after a task is created. */
export type TaskPatch = Partial<
  Pick<
    Task,
    | 'status'
    | 'result'
    | 'error'
    | 'completedAt'
    | 'cancelRequestedAt'
    | 'leaseExpiresAt'
  >
> & { updatedAt: string };

/** Preconditions an update must satisfy; the update is a no-op otherwise. */
export interface UpdateCondition {
  from: readonly TaskStatus[];
  agent?: AgentType;
  claimedBy?: string;
  /** Only match if the task's lease is still valid at this ISO time. */
  leaseActiveAt?: string;
}

export interface ExpireLeasesRequest {
  now: string;
  error: string;
}

export interface IdempotentCreateResult {
  task: Task;
  /** false when an existing task with the same creator and idempotency key was returned. */
  created: boolean;
}

export interface ClaimRequest {
  agent: AgentType;
  workerId: string;
  now: string;
  leaseExpiresAt: string;
}

export interface StatusCount {
  agent: AgentType;
  status: TaskStatus;
  count: number;
}

/**
 * Persistence boundary for tasks. Methods are async so a networked database
 * (e.g. PostgreSQL) can implement the same contract. Every mutating method
 * must be atomic: either all preconditions hold and the change is written,
 * or nothing changes and `null` is returned.
 */
export abstract class TaskRepository {
  abstract create(task: Task): Promise<Task>;
  /**
   * Atomically returns the newest task with the same creator and idempotency key
   * created at or after `since`, or inserts `task` if there is none.
   */
  abstract createIdempotent(task: Task & { idempotencyKey: string }, since: string): Promise<IdempotentCreateResult>;
  abstract findById(id: string): Promise<Task | null>;
  abstract list(filter: TaskListFilter): Promise<TaskListPage>;
  /** Atomically moves the oldest queued task for `agent` to running and assigns it. */
  abstract claimNext(request: ClaimRequest): Promise<Task | null>;
  /** Compare-and-set update guarded by `condition`. */
  abstract update(id: string, condition: UpdateCondition, patch: TaskPatch): Promise<Task | null>;
  /** Atomically fails every claimed task whose lease expired at or before `now`. */
  abstract expireLeases(request: ExpireLeasesRequest): Promise<Task[]>;
  abstract countByAgentAndStatus(): Promise<StatusCount[]>;
  /** Throws if the storage backend is not usable. */
  abstract ping(): Promise<void>;
}
