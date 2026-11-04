import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { TestRunnerPrincipal } from '../auth/principal.js';
import { Clock } from '../common/clock.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import type { Project, TestCommand } from '../projects/project.model.js';
import { ProjectsService } from '../projects/projects.service.js';
import { reportedDiff, ReviewsService } from '../reviews/reviews.service.js';
import type { Task } from '../tasks/task.model.js';
import { TasksService } from '../tasks/tasks.service.js';

export type TestStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'aborted';
export const FINAL_TEST_STATUSES: readonly TestStatus[] = ['passed', 'failed', 'skipped', 'aborted'];

/** One command's outcome as observed by the runner (process exit code, not anything an agent said). */
export interface TestCommandResult {
  name: string;
  argv: string[];
  status: 'passed' | 'failed' | 'skipped' | 'aborted';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  outputBytes: number;
  outputSha256: string;
  outputTail: string;
}

export interface TestValidation {
  id: string;
  taskId: string;
  projectId: string;
  baseSha: string;
  commitSha: string;
  status: TestStatus;
  /** The admin-approved commands as they were when the run was requested. */
  commands: TestCommand[];
  results: TestCommandResult[] | null;
  requestedBy: string;
  requestedAt: string;
  claimedBy: string | null;
  startedAt: string | null;
  attempts: number;
  completedAt: string | null;
  /** Canonical JSON written and HMAC-signed by the runner; the publisher verifies the signature. */
  evidence: string | null;
  evidenceHash: string | null;
  evidenceSignature: string | null;
  error: string | null;
  updatedAt: string;
}

interface Row {
  id: string; task_id: string; project_id: string; base_sha: string; commit_sha: string; status: TestStatus; commands: string;
  results: string | null; requested_by: string; requested_at: string; claimed_by: string | null; started_at: string | null;
  lease_expires_at: string | null; attempts: number; completed_at: string | null; evidence: string | null;
  evidence_hash: string | null; evidence_signature: string | null; error: string | null; updated_at: string;
}

export interface TestRunJob {
  validation: TestValidation;
  task: { id: string; agent: string; projectId: string; status: string };
  baseSha: string;
  commitSha: string;
  /** Tree the reviewer approved/was shown; the runner records the tree it actually tested. */
  headTree: string | null;
}

export interface TestResultInput {
  status: TestStatus;
  results: TestCommandResult[];
  evidence: string;
  evidenceHash: string;
  evidenceSignature: string;
  error?: string;
}

const MAX_ATTEMPTS = 2;
const SHA256 = /^[0-9a-f]{64}$/;

/** Conflict with a stable machine-readable code (the dashboard and publisher show the code). */
export function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, code, message });
}

/**
 * Test evidence for publishing (POLICY A: no reported, passing test run on the exact commit, no
 * publication). Runs are executed by the isolated test runner; the controller only queues them and
 * stores what the runner reports. It never creates a passing result itself and never reuses a run
 * for another commit.
 */
@Injectable()
export class TestValidationsService {
  private readonly logger = new Logger(TestValidationsService.name);

  constructor(
    @Inject(SQLITE_CONNECTION) private readonly db: Database,
    private readonly tasks: TasksService,
    private readonly reviews: ReviewsService,
    private readonly projects: ProjectsService,
    private readonly clock: Clock,
  ) {}

  /** Queues a run of the project's approved commands on the task's current commit. */
  async request(taskId: string, headSha: string, requestedBy: string): Promise<TestValidation> {
    const task = await this.tasks.get(taskId);
    const diff = reportedDiff(task);
    if (!diff) throw new NotFoundException(`Task ${taskId} has no reviewable commit to test`);
    if (diff.headCommit !== headSha) throw conflict('TEST_COMMIT_MISMATCH', `headSha does not match the task commit (${diff.headCommit})`);
    const project = this.project(task);
    if (!project || project.testCommands.length === 0) {
      throw conflict('TEST_COMMANDS_NOT_CONFIGURED', `Project ${task.projectId} has no approved test commands (PATCH /projects/:id testCommands)`);
    }
    this.reviews.ensureForTask(task);
    const now = this.clock.now().toISOString();
    const id = randomUUID();
    try {
      this.db.prepare(`
        INSERT INTO test_validations (id, task_id, project_id, base_sha, commit_sha, status, commands, requested_by, requested_at, updated_at)
        VALUES (@id, @task, @project, @base, @head, 'pending', @commands, @by, @now, @now)`).run({
        id, task: taskId, project: project.id, base: diff.baseCommit, head: headSha, commands: JSON.stringify(project.testCommands), by: requestedBy, now,
      });
    } catch (error) {
      if (/UNIQUE constraint failed/.test((error as Error).message)) throw conflict('TEST_ALREADY_RUNNING', 'A test run for this commit is already queued or running');
      throw error;
    }
    this.logger.log(`Task ${taskId}: test run queued for ${headSha.slice(0, 12)} by ${requestedBy}`);
    return this.byId(id)!;
  }

  /** Called when a worker completes a task: queue tests if the project has any. Never throws. */
  async requestForCompletedTask(task: Task): Promise<void> {
    const diff = reportedDiff(task);
    const project = this.project(task);
    if (!diff || !project || project.source !== 'github' || project.testCommands.length === 0) return;
    await this.request(task.id, diff.headCommit, 'controller:auto').catch((error) => {
      this.logger.warn(`Task ${task.id}: could not queue tests: ${(error as Error).message}`);
    });
  }

  list(taskId: string): TestValidation[] {
    return (this.db.prepare('SELECT * FROM test_validations WHERE task_id = ? ORDER BY requested_at, rowid').all(taskId) as Row[]).map(toValidation);
  }

  /** Newest run for this exact commit (runs for other commits are never considered). */
  latestFor(taskId: string, commitSha: string): TestValidation | null {
    const row = this.db.prepare('SELECT * FROM test_validations WHERE task_id = ? AND commit_sha = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1')
      .get(taskId, commitSha) as Row | undefined;
    return row ? toValidation(row) : null;
  }

  byId(id: string): TestValidation | null {
    const row = this.db.prepare('SELECT * FROM test_validations WHERE id = ?').get(id) as Row | undefined;
    return row ? toValidation(row) : null;
  }

  async claim(runner: TestRunnerPrincipal): Promise<TestRunJob | null> {
    const now = this.clock.now();
    const iso = now.toISOString();
    const row = this.db.transaction(() => {
      // A run whose runner died twice is aborted, never retried forever or assumed to pass.
      this.db.prepare(`
        UPDATE test_validations SET status = 'aborted', completed_at = @now, updated_at = @now, lease_expires_at = NULL,
               error = 'test runner did not finish after ' || attempts || ' attempts'
         WHERE status = 'running' AND lease_expires_at < @now AND attempts >= @max`).run({ now: iso, max: MAX_ATTEMPTS });
      const next = this.db.prepare(`
        SELECT * FROM test_validations
         WHERE status = 'pending' OR (status = 'running' AND lease_expires_at < @now)
         ORDER BY requested_at, rowid LIMIT 1`).get({ now: iso }) as Row | undefined;
      if (!next) return null;
      const commands = JSON.parse(next.commands) as TestCommand[];
      const leaseMs = (commands.reduce((sum, c) => sum + c.timeoutSeconds, 0) + 300) * 1000;
      return this.db.prepare(`
        UPDATE test_validations SET status = 'running', claimed_by = @by, started_at = @now, lease_expires_at = @lease,
               attempts = attempts + 1, updated_at = @now
         WHERE id = @id RETURNING *`).get({ id: next.id, by: runner.runnerId, now: iso, lease: new Date(now.getTime() + leaseMs).toISOString() }) as Row;
    }).immediate();
    if (!row) return null;
    const validation = toValidation(row);
    const task = await this.tasks.get(validation.taskId);
    const review = this.reviews.latest(task.id);
    return {
      validation,
      task: { id: task.id, agent: task.agent, projectId: validation.projectId, status: task.status },
      baseSha: validation.baseSha,
      commitSha: validation.commitSha,
      headTree: review && review.headSha === validation.commitSha ? review.headTree : reportedDiff(task)?.headTree ?? null,
    };
  }

  /**
   * Stores the runner's result. The overall status is recomputed from the per-command process results;
   * the controller can lower a claimed "passed" but never raise anything to passed.
   */
  complete(runner: TestRunnerPrincipal, id: string, input: TestResultInput): TestValidation {
    const current = this.byId(id);
    if (!current) throw new NotFoundException(`Test validation ${id} not found`);
    if (current.status !== 'running' || current.claimedBy !== runner.runnerId) {
      throw conflict('TEST_NOT_RUNNING', `Test validation ${id} is ${current.status}, not running for this runner`);
    }
    const problems: string[] = [];
    let evidence: Record<string, unknown> | null = null;
    if (input.evidence.length > 256 * 1024 || !SHA256.test(input.evidenceHash) || !/^[0-9a-f]{64}$/.test(input.evidenceSignature)) {
      problems.push('evidence is malformed');
    } else if (createHash('sha256').update(input.evidence).digest('hex') !== input.evidenceHash) {
      problems.push('evidence hash does not match');
    } else {
      try {
        evidence = JSON.parse(input.evidence);
      } catch {
        problems.push('evidence is not JSON');
      }
    }
    if (evidence && (evidence.validationId !== id || evidence.taskId !== current.taskId || evidence.commitSha !== current.commitSha || evidence.projectId !== current.projectId)) {
      problems.push('evidence describes another run or commit');
    }
    const results = Array.isArray(input.results) ? input.results.slice(0, current.commands.length) : [];
    const derived = deriveStatus(current.commands, results);
    if (evidence && evidence.status !== derived) problems.push(`evidence status ${String(evidence.status)} does not match the command results (${derived})`);
    const status: TestStatus = problems.length ? (derived === 'passed' ? 'failed' : derived) : derived;
    const now = this.clock.now().toISOString();
    const row = this.db.prepare(`
      UPDATE test_validations SET status = @status, results = @results, evidence = @evidence, evidence_hash = @hash,
             evidence_signature = @signature, error = @error, completed_at = @now, lease_expires_at = NULL, updated_at = @now
       WHERE id = @id AND status = 'running' RETURNING *`).get({
      id, status, results: JSON.stringify(results.map(clip)), evidence: input.evidence.slice(0, 256 * 1024),
      hash: input.evidenceHash, signature: input.evidenceSignature,
      error: [...problems, input.error].filter(Boolean).join('; ').slice(0, 2000) || null, now,
    }) as Row;
    this.logger.log(`Test validation ${id} (task ${current.taskId}, ${current.commitSha.slice(0, 12)}): ${status}`);
    return toValidation(row);
  }

  private project(task: Task): Project | null {
    if (!task.projectId) return null;
    try {
      return this.projects.get(task.projectId, { role: 'admin' }) as Project;
    } catch {
      return null;
    }
  }
}

/**
 * passed only if every approved command ran, in order, and exited 0. The runner reports every
 * command (not-run ones as skipped); a missing command means the run did not finish.
 * Precedence: aborted > failed > skipped > passed.
 */
export function deriveStatus(commands: TestCommand[], results: TestCommandResult[]): TestStatus {
  if (results.length !== commands.length) return 'aborted';
  const matches = results.every((r, i) => r && r.name === commands[i].name && JSON.stringify(r.argv) === JSON.stringify(commands[i].argv));
  if (!matches) return 'failed';
  const ran = results.filter((r) => r.status !== 'skipped');
  if (ran.some((r) => r.status === 'aborted' || r.timedOut || r.exitCode === null)) return 'aborted';
  if (ran.some((r) => r.status !== 'passed' || r.exitCode !== 0)) return 'failed';
  if (ran.length !== results.length) return 'skipped';
  return 'passed';
}

function clip(r: TestCommandResult): TestCommandResult {
  return { ...r, outputTail: String(r.outputTail ?? '').slice(-4000) };
}

function toValidation(r: Row): TestValidation {
  return {
    id: r.id, taskId: r.task_id, projectId: r.project_id, baseSha: r.base_sha, commitSha: r.commit_sha, status: r.status,
    commands: JSON.parse(r.commands) as TestCommand[], results: r.results ? (JSON.parse(r.results) as TestCommandResult[]) : null,
    requestedBy: r.requested_by, requestedAt: r.requested_at, claimedBy: r.claimed_by, startedAt: r.started_at, attempts: r.attempts,
    completedAt: r.completed_at, evidence: r.evidence, evidenceHash: r.evidence_hash, evidenceSignature: r.evidence_signature,
    error: r.error, updatedAt: r.updated_at,
  };
}
