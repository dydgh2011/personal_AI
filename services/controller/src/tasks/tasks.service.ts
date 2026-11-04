import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { creatorOf, type AdminPrincipal, type TaskActor, type WorkerPrincipal } from '../auth/principal.js';
import { Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { ProjectsService } from '../projects/projects.service.js';
import type { CreateTaskDto } from './dto/create-task.dto.js';
import type { ListTasksQuery } from './dto/list-tasks.query.js';
import { TRANSITIONS, type TransitionName } from './task-state.js';
import type { Task } from './task.model.js';
import { TaskRepository, type TaskPatch } from './task.repository.js';

/** Prefix of the error recorded on tasks failed by lease expiry, so clients can recognise them. */
export const LEASE_EXPIRED_PREFIX = 'lease_expired:';

const ADMIN: AdminPrincipal = { role: 'admin' };

export interface CreateResult {
  task: Task;
  /** true when an earlier request with the same Idempotency-Key already created this task. */
  replayed: boolean;
}

export type CancelOutcome = 'canceled' | 'cancel_requested' | 'cancel_already_requested';

export interface CancelResult {
  outcome: CancelOutcome;
  message: string;
  task: Task;
}

export interface TaskListResponse {
  items: Task[];
  total: number;
  limit: number;
  offset: number;
}

const CANCEL_MESSAGES: Record<CancelOutcome, string> = {
  canceled: 'Task was canceled before it started.',
  cancel_requested:
    'Cancellation requested. The worker has not yet confirmed that execution stopped.',
  cancel_already_requested:
    'Cancellation was already requested. The worker has not yet confirmed that execution stopped.',
};

/** Owns every task state change; controllers never touch the repository directly. */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly repository: TaskRepository,
    private readonly projects: ProjectsService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(dto: CreateTaskDto, actor: TaskActor = ADMIN): Promise<Task> {
    const task = await this.repository.create(this.newTask(dto, actor, null));
    this.logger.log(`Task ${task.id} queued for ${task.agent} by ${task.createdBy}`);
    return task;
  }

  /**
   * Like create(), but a repeat of the same request (same creator and key within
   * the idempotency window) returns the task created the first time. Reusing a
   * key for a different request is a conflict.
   */
  async createIdempotent(dto: CreateTaskDto, actor: TaskActor, idempotencyKey: string): Promise<CreateResult> {
    const candidate = this.newTask(dto, actor, idempotencyKey);
    const since = new Date(this.clock.now().getTime() - this.config.idempotencyWindowSeconds * 1000).toISOString();
    const { task, created } = await this.repository.createIdempotent({ ...candidate, idempotencyKey }, since);
    if (created) {
      this.logger.log(`Task ${task.id} queued for ${task.agent} by ${task.createdBy}`);
      return { task, replayed: false };
    }
    if (task.agent !== candidate.agent || task.projectId !== candidate.projectId || task.instruction !== candidate.instruction) {
      throw new ConflictException('This Idempotency-Key was already used for a different task');
    }
    this.logger.log(`Task ${task.id}: duplicate request by ${task.createdBy} returned the existing task`);
    return { task, replayed: true };
  }

  private newTask(dto: CreateTaskDto, actor: TaskActor, idempotencyKey: string | null): Task {
    const projectId = dto.projectId ?? null;
    if (actor.role === 'delegator' && projectId === null) {
      throw new BadRequestException('projectId is required');
    }
    if (projectId !== null) this.projects.assertTaskAllowed(projectId, dto.agent);

    const now = this.now();
    return {
      id: randomUUID(),
      agent: dto.agent,
      projectId,
      instruction: dto.instruction,
      status: 'queued',
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      cancelRequestedAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
      attempt: 0,
      createdBy: creatorOf(actor),
      idempotencyKey,
    };
  }

  /** A delegator only ever sees the tasks it created. */
  async list(query: ListTasksQuery, actor: TaskActor = ADMIN): Promise<TaskListResponse> {
    const filter = actor.role === 'admin' ? query : { ...query, createdBy: creatorOf(actor) };
    const page = await this.repository.list(filter);
    return { ...page, limit: query.limit, offset: query.offset };
  }

  /** Tasks another creator owns are reported as missing to a delegator, not as forbidden. */
  async get(id: string, actor: TaskActor = ADMIN): Promise<Task> {
    const task = await this.repository.findById(id);
    if (!task || (actor.role !== 'admin' && task.createdBy !== creatorOf(actor))) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    return task;
  }

  /**
   * Queued tasks are canceled immediately. Running tasks only move to
   * cancel_requested: stopping the process is the worker's job, and it reports
   * back through acknowledgeCancel().
   */
  async cancel(id: string, actor: TaskActor = ADMIN): Promise<CancelResult> {
    // Retry if the task changes state between the read and the conditional write
    // (e.g. a worker claims it at the same moment).
    for (let attempt = 0; attempt < 3; attempt++) {
      const task = await this.get(id, actor);
      const now = this.now();
      let updated: Task | null;
      let outcome: CancelOutcome;

      switch (task.status) {
        case 'queued':
          outcome = 'canceled';
          updated = await this.repository.update(
            id,
            { from: TRANSITIONS.cancelQueued.from },
            { status: TRANSITIONS.cancelQueued.to, cancelRequestedAt: now, completedAt: now, updatedAt: now },
          );
          break;
        case 'running':
          outcome = 'cancel_requested';
          updated = await this.repository.update(
            id,
            { from: TRANSITIONS.requestCancel.from },
            { status: TRANSITIONS.requestCancel.to, cancelRequestedAt: now, updatedAt: now },
          );
          break;
        case 'cancel_requested':
          return this.cancelResult('cancel_already_requested', task);
        default:
          throw new ConflictException(`Task ${id} is already ${task.status} and cannot be canceled`);
      }

      if (updated) {
        this.logger.log(`Task ${id}: cancel -> ${updated.status}`);
        return this.cancelResult(outcome, updated);
      }
    }
    throw new ConflictException(`Task ${id} changed concurrently; retry the request`);
  }

  // ---- Worker-facing operations -------------------------------------------

  async claimNext(worker: WorkerPrincipal): Promise<Task | null> {
    const now = this.clock.now();
    const task = await this.repository.claimNext({
      agent: worker.agent,
      workerId: worker.workerId,
      now: now.toISOString(),
      leaseExpiresAt: this.leaseFrom(now),
    });
    if (task) this.logger.log(`Task ${task.id} claimed by ${worker.workerId} (attempt ${task.attempt})`);
    return task;
  }

  /** Renews the worker's lease. The returned task tells the worker whether a cancel was requested. */
  async heartbeat(worker: WorkerPrincipal, id: string): Promise<Task> {
    const now = this.clock.now();
    return this.applyWorkerTransition(worker, id, 'heartbeat', {
      leaseExpiresAt: this.leaseFrom(now),
      updatedAt: now.toISOString(),
    });
  }

  async complete(worker: WorkerPrincipal, id: string, result: string): Promise<Task> {
    const now = this.now();
    return this.applyWorkerTransition(worker, id, 'complete', {
      status: TRANSITIONS.complete.to,
      result,
      completedAt: now,
      leaseExpiresAt: null,
      updatedAt: now,
    });
  }

  async fail(worker: WorkerPrincipal, id: string, error: string): Promise<Task> {
    const now = this.now();
    return this.applyWorkerTransition(worker, id, 'fail', {
      status: TRANSITIONS.fail.to,
      error,
      completedAt: now,
      leaseExpiresAt: null,
      updatedAt: now,
    });
  }

  /** Called by the worker once it has actually stopped executing a cancel_requested task. */
  async acknowledgeCancel(worker: WorkerPrincipal, id: string): Promise<Task> {
    const now = this.now();
    return this.applyWorkerTransition(worker, id, 'acknowledgeCancel', {
      status: TRANSITIONS.acknowledgeCancel.to,
      completedAt: now,
      leaseExpiresAt: null,
      updatedAt: now,
    });
  }

  /**
   * Fails every claimed task whose lease ran out (the worker stopped sending
   * heartbeats). Such tasks are deliberately not re-queued: a coding task that
   * half-ran may have left changes behind and must be inspected first.
   */
  async expireLeases(): Promise<Task[]> {
    const expired = await this.repository.expireLeases({
      now: this.now(),
      error: `${LEASE_EXPIRED_PREFIX} the worker stopped renewing its lease before reporting a result. ` +
        'The task was not retried automatically; inspect the worker workspace before re-queuing it.',
    });
    for (const task of expired) {
      this.logger.warn(`Task ${task.id}: lease of ${task.claimedBy} expired -> failed`);
    }
    return expired;
  }

  private async applyWorkerTransition(
    worker: WorkerPrincipal,
    id: string,
    transition: TransitionName,
    patch: TaskPatch,
  ): Promise<Task> {
    const now = patch.updatedAt;
    const updated = await this.repository.update(
      id,
      {
        from: TRANSITIONS[transition].from,
        agent: worker.agent,
        claimedBy: worker.workerId,
        leaseActiveAt: now,
      },
      patch,
    );
    if (updated) {
      if (patch.status) this.logger.log(`Task ${id}: ${transition} -> ${updated.status} by ${worker.workerId}`);
      return updated;
    }

    // Work out why the conditional update did not apply.
    const task = await this.repository.findById(id);
    if (!task || task.agent !== worker.agent) {
      // Workers cannot see tasks of other agents, so they get the same answer as for a missing task.
      throw new NotFoundException(`Task ${id} not found`);
    }
    if (task.claimedBy !== worker.workerId) {
      throw new ConflictException(`Task ${id} is not claimed by ${worker.workerId}`);
    }
    if ((TRANSITIONS[transition].from as readonly string[]).includes(task.status)) {
      // Status and owner match, so the only failed precondition is the lease.
      throw new ConflictException(`Lease for task ${id} expired at ${task.leaseExpiresAt}; the worker no longer owns it`);
    }
    throw new ConflictException(`Cannot ${transition} task ${id} in status ${task.status}`);
  }

  private cancelResult(outcome: CancelOutcome, task: Task): CancelResult {
    return { outcome, message: CANCEL_MESSAGES[outcome], task };
  }

  private leaseFrom(now: Date): string {
    return new Date(now.getTime() + this.config.leaseSeconds * 1000).toISOString();
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}
