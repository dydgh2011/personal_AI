import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { TaskActor } from '../auth/principal.js';
import { Clock } from '../common/clock.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { ProjectsService } from '../projects/projects.service.js';
import type { Task } from '../tasks/task.model.js';
import { TasksService } from '../tasks/tasks.service.js';

export const REVIEW_STATUSES = ['awaiting_approval', 'approved', 'rejected', 'invalidated'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
const SHA = /^[0-9a-f]{40}$/;

/**
 * A reviewer's decision about one exact commit of a task. This is what a future publisher
 * (Phase E-2) must check before pushing: approved + task + base/head SHA + tree must all match.
 */
export interface Review {
  id: string;
  taskId: string;
  projectId: string;
  agent: string;
  baseSha: string;
  headSha: string;
  headTree: string | null;
  status: ReviewStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  invalidatedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReviewRow {
  id: string; task_id: string; project_id: string; agent: string; base_sha: string; head_sha: string; head_tree: string | null;
  status: ReviewStatus; decided_by: string | null; decided_at: string | null; reason: string | null;
  invalidated_reason: string | null; created_at: string; updated_at: string;
}

interface ReportDiffFile {
  path: string; status: string; additions: number | null; deletions: number | null; binary: boolean; sensitive: boolean;
}

/** The parts of an agent-worker/v1 report the review needs. Anything malformed means "no review data". */
export interface ReportedDiff {
  projectId: string;
  baseCommit: string;
  headCommit: string;
  headTree: string | null;
  commitMessage: string | null;
  additions: number | null;
  deletions: number | null;
  files: ReportDiffFile[];
  patch: string | null;
  patchTruncated: boolean;
  omittedFiles: string[];
  tests: unknown | null;
}

export function reportedDiff(task: Task): ReportedDiff | null {
  if (task.status !== 'completed' || !task.result) return null;
  let report: Record<string, any>;
  try {
    report = JSON.parse(task.result);
  } catch {
    return null;
  }
  const ws = report?.workspace;
  if (report?.format !== 'agent-worker/v1' || !ws || ws.mode !== 'write' || !SHA.test(ws.baseCommit ?? '') || !SHA.test(ws.commit ?? '')) {
    return null;
  }
  // Only trust a diff that describes this very commit.
  const d = ws.diff && ws.diff.headCommit === ws.commit && ws.diff.baseCommit === ws.baseCommit ? ws.diff : null;
  const files: ReportDiffFile[] = Array.isArray(d?.files)
    ? d.files.filter((f: any) => typeof f?.path === 'string').map((f: any) => ({
        path: f.path, status: String(f.status ?? 'M'), additions: typeof f.additions === 'number' ? f.additions : null,
        deletions: typeof f.deletions === 'number' ? f.deletions : null, binary: f.binary === true, sensitive: f.sensitive === true,
      }))
    : (Array.isArray(ws.changedFiles) ? ws.changedFiles : []).map((f: any) => ({
        path: String(f.path), status: String(f.status), additions: null, deletions: null, binary: false, sensitive: false,
      }));
  return {
    projectId: task.projectId ?? String(ws.projectId),
    baseCommit: ws.baseCommit,
    headCommit: ws.commit,
    headTree: d && SHA.test(d.headTree ?? '') ? d.headTree : null,
    commitMessage: typeof d?.commitMessage === 'string' ? d.commitMessage : null,
    additions: typeof d?.additions === 'number' ? d.additions : null,
    deletions: typeof d?.deletions === 'number' ? d.deletions : null,
    files,
    patch: typeof d?.patch === 'string' ? d.patch : null,
    patchTruncated: d?.patchTruncated === true,
    omittedFiles: Array.isArray(d?.omittedFiles) ? d.omittedFiles.map(String) : [],
    // Workers do not run tests yet; only a value the worker actually reported is shown.
    tests: report.tests ?? null,
  };
}

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    @Inject(SQLITE_CONNECTION) private readonly db: Database,
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
    private readonly clock: Clock,
  ) {}

  /** Creates the awaiting_approval review for a completed task's commit (idempotent). */
  ensureForTask(task: Task): Review | null {
    const diff = reportedDiff(task);
    if (!diff) return null;
    const now = this.clock.now().toISOString();
    this.db.prepare(`
      INSERT INTO reviews (id, task_id, project_id, agent, base_sha, head_sha, head_tree, status, created_at, updated_at)
      VALUES (@id, @task_id, @project_id, @agent, @base_sha, @head_sha, @head_tree, 'awaiting_approval', @now, @now)
      ON CONFLICT (task_id, head_sha) DO NOTHING`).run({
      id: randomUUID(), task_id: task.id, project_id: diff.projectId, agent: task.agent,
      base_sha: diff.baseCommit, head_sha: diff.headCommit, head_tree: diff.headTree, now,
    });
    return this.current(task.id);
  }

  /** Diff + review for a task the actor may see. Delegators get no patch text for private repositories. */
  async diff(taskId: string, actor: TaskActor) {
    const task = await this.tasks.get(taskId, actor);
    const diff = reportedDiff(task);
    if (!diff) {
      throw new NotFoundException(
        task.status === 'completed'
          ? `Task ${taskId} has no reviewable commit (no changes, read-only, or recorded before reviews existed)`
          : `Task ${taskId} is ${task.status}; only completed tasks have a diff`,
      );
    }
    const review = this.ensureForTask(task);
    const privateRepo = this.isPrivate(diff.projectId);
    const withholdPatch = actor.role !== 'admin' && privateRepo;
    return {
      taskId: task.id,
      projectId: diff.projectId,
      agent: task.agent,
      baseSha: diff.baseCommit,
      headSha: diff.headCommit,
      headTree: diff.headTree,
      commitMessage: diff.commitMessage,
      additions: diff.additions,
      deletions: diff.deletions,
      files: diff.files,
      patch: withholdPatch ? null : diff.patch,
      patchWithheld: withholdPatch ? 'Patch text of private repositories is not given to Hermes (external model).' : null,
      patchTruncated: diff.patchTruncated,
      omittedFiles: diff.omittedFiles,
      tests: diff.tests,
      review,
      history: this.history(task.id),
    };
  }

  async review(taskId: string, actor: TaskActor) {
    const task = await this.tasks.get(taskId, actor);
    const current = this.ensureForTask(task);
    if (!current) throw new NotFoundException(`Task ${taskId} has no review`);
    return { current, history: this.history(task.id) };
  }

  /**
   * Approve or reject exactly `headSha`. A single conditional UPDATE: of two concurrent decisions
   * only one can match status='awaiting_approval'; the other gets 409.
   */
  async decide(taskId: string, decision: 'approved' | 'rejected', headSha: string, decidedBy: string, reason: string | null): Promise<Review> {
    const task = await this.tasks.get(taskId);
    const current = this.ensureForTask(task);
    if (!current) throw new NotFoundException(`Task ${taskId} has no reviewable commit`);
    const now = this.clock.now().toISOString();
    const row = this.db.prepare(`
      UPDATE reviews SET status = @decision, decided_by = @by, decided_at = @now, reason = @reason, updated_at = @now
       WHERE task_id = @task AND head_sha = @head AND status = 'awaiting_approval'
      RETURNING *`).get({ decision, by: decidedBy, now, reason, task: taskId, head: headSha }) as ReviewRow | undefined;
    if (row) {
      this.logger.log(`Task ${taskId} ${decision} at ${headSha.slice(0, 12)} by ${decidedBy}`);
      return toReview(row);
    }
    const target = this.findByHead(taskId, headSha);
    if (!target) {
      throw new ConflictException(`headSha does not match the commit under review (${current.headSha}); review the current diff first`);
    }
    throw new ConflictException(`The review of ${headSha} is already ${target.status}`);
  }

  /**
   * Called with the commit actually found on the task branch (by the worker, later by the publisher).
   * Any pending or approved review of a different commit is invalidated, so an approval can never
   * be used for other code.
   */
  async observeHead(task: Task, observedSha: string): Promise<{ invalidated: Review[]; matches: boolean }> {
    const now = this.clock.now().toISOString();
    const rows = this.db.prepare(`
      UPDATE reviews SET status = 'invalidated', invalidated_reason = @why, updated_at = @now
       WHERE task_id = @task AND head_sha <> @head AND status IN ('awaiting_approval', 'approved')
      RETURNING *`).all({ task: task.id, head: observedSha, now, why: `Task branch now points to ${observedSha}` }) as ReviewRow[];
    for (const r of rows) this.logger.warn(`Task ${task.id}: review of ${r.head_sha.slice(0, 12)} invalidated (branch moved)`);
    return { invalidated: rows.map(toReview), matches: this.findByHead(task.id, observedSha) !== null };
  }

  /** Reviews across all tasks, newest first (admin). */
  list(status: ReviewStatus | undefined, limit: number): Review[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM reviews WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM reviews ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);
    return (rows as ReviewRow[]).map(toReview);
  }

  /** The newest review of a task (the one a decision or publication refers to), if any. */
  latest(taskId: string): Review | null {
    return this.current(taskId);
  }

  byId(id: string): Review | null {
    const row = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow | undefined;
    return row ? toReview(row) : null;
  }

  private current(taskId: string): Review | null {
    const row = this.db.prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId) as ReviewRow | undefined;
    return row ? toReview(row) : null;
  }

  private findByHead(taskId: string, headSha: string): Review | null {
    const row = this.db.prepare('SELECT * FROM reviews WHERE task_id = ? AND head_sha = ?').get(taskId, headSha) as ReviewRow | undefined;
    return row ? toReview(row) : null;
  }

  private history(taskId: string): Review[] {
    return (this.db.prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as ReviewRow[]).map(toReview);
  }

  private isPrivate(projectId: string): boolean {
    try {
      const project = this.projects.get(projectId, { role: 'admin' });
      return 'visibility' in project && project.visibility !== null && project.visibility !== 'public';
    } catch {
      return true; // unknown project: treat as private
    }
  }
}

function toReview(r: ReviewRow): Review {
  return {
    id: r.id, taskId: r.task_id, projectId: r.project_id, agent: r.agent, baseSha: r.base_sha, headSha: r.head_sha,
    headTree: r.head_tree, status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at, reason: r.reason,
    invalidatedReason: r.invalidated_reason, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export { SHA as SHA_PATTERN };
