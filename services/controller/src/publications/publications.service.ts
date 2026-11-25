import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { PublisherPrincipal } from '../auth/principal.js';
import { Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import type { Project, TestCommand } from '../projects/project.model.js';
import { ProjectsService } from '../projects/projects.service.js';
import { reportedDiff, ReviewsService, type Review } from '../reviews/reviews.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { conflict, TestValidationsService, type TestValidation } from '../test-validations/test-validations.service.js';

export type PublicationMode = 'dry-run' | 'publish';
export type PublicationStatus = 'pending' | 'validating' | 'ready' | 'failed' | 'published' | 'pr_created';

/** What the dashboard shows for a task: derived from the review and its newest publication request. */
export type PublicationState =
  | 'not_approved'
  | 'approved'
  | 'validation_pending'
  | 'ready_to_publish'
  | 'validation_failed'
  | 'published'
  | 'pr_created';

export interface Publication {
  id: string;
  taskId: string;
  reviewId: string;
  headSha: string;
  mode: PublicationMode;
  status: PublicationStatus;
  requestedBy: string;
  requestedAt: string;
  claimedBy: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  attempts: number;
  completedAt: string | null;
  /** The publisher's structured report (preflight checks, reason codes, planned branch / PR). */
  result: Record<string, unknown> | null;
  authorizationId: string | null;
  idempotencyKey: string | null;
  updatedAt: string;
}

interface PublicationRow {
  id: string; task_id: string; review_id: string; head_sha: string; mode: PublicationMode; status: PublicationStatus;
  requested_by: string; requested_at: string; claimed_by: string | null; claimed_at: string | null;
  lease_expires_at: string | null; attempts: number; completed_at: string | null; result: string | null; updated_at: string;
  authorization_id: string | null; idempotency_key: string | null;
}

/** The owner's separate decision to publish one approved, tested, validated commit. */
export interface PublishAuthorization {
  id: string;
  taskId: string;
  reviewId: string;
  projectId: string;
  repositoryId: number;
  headSha: string;
  testValidationId: string;
  dryRunId: string;
  authorizedBy: string;
  authorizedAt: string;
  expiresAt: string;
  status: 'active' | 'used' | 'expired' | 'revoked';
  usedAt: string | null;
  publicationId: string | null;
  idempotencyKey: string;
}

interface AuthorizationRow {
  id: string; task_id: string; review_id: string; project_id: string; repository_id: number; head_sha: string;
  test_validation_id: string; dry_run_id: string; authorized_by: string; authorized_at: string; expires_at: string;
  status: PublishAuthorization['status']; used_at: string | null; publication_id: string | null; idempotency_key: string;
}

/** Everything the publisher needs for one request. It still verifies all of it against git itself. */
export interface PublicationJob {
  publication: Publication;
  task: { id: string; status: string; agent: string; projectId: string | null; createdBy: string; completedAt: string | null };
  /** The review the request was made for, as it is now (it may have been invalidated since). */
  review: Review | null;
  /** The newest review of the task (a different head means the request is stale). */
  latestReview: Review | null;
  /** What the reviewer was shown, from the immutable worker report. No patch text. */
  reported: {
    baseSha: string;
    headSha: string;
    headTree: string | null;
    commitMessage: string | null;
    files: Array<{ path: string; status: string; additions: number | null; deletions: number | null; binary: boolean; sensitive: boolean }>;
    patchRecorded: boolean;
    patchTruncated: boolean;
    omittedFiles: string[];
    tests: unknown | null;
    branch: string | null;
  } | null;
  project: (Pick<Project,
    'id' | 'source' | 'fullName' | 'remoteUrl' | 'defaultBranch' | 'visibility' | 'githubRepositoryId' | 'enabled' |
    'allowCodeChanges' | 'allowedAgents' | 'syncStatus' | 'cachedHeadSha' | 'commitAuthor'> & { testCommands: TestCommand[] }) | null;
  /** Newest test run of the approved commit (with the runner's signed evidence), or null. */
  testValidation: TestValidation | null;
  /** publish: the authorization the request consumed. dry-run: the currently active one, if any. */
  authorization: PublishAuthorization | null;
}

const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const MAX_RESULT_CHARS = 64 * 1024;
const AUTHORIZATION_TTL_MS = 30 * 60_000;
const DRY_RUN_MAX_AGE_MS = 30 * 60_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

@Injectable()
export class PublicationsService {
  private readonly logger = new Logger(PublicationsService.name);

  constructor(
    @Inject(SQLITE_CONNECTION) private readonly db: Database,
    private readonly tasks: TasksService,
    private readonly reviews: ReviewsService,
    private readonly projects: ProjectsService,
    private readonly tests: TestValidationsService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * An admin asks the publisher to run the preflight gate (dry-run) for one approved commit. Approval
   * and this request are separate actions; the request pins the head SHA the admin saw.
   */
  async requestDryRun(taskId: string, headSha: string, requestedBy: string): Promise<Publication> {
    const review = await this.approvedReview(taskId, headSha);
    const now = this.clock.now().toISOString();
    const id = randomUUID();
    this.insert({ id, task: taskId, review: review.id, head: headSha, mode: 'dry-run', by: requestedBy, now, auth: null, key: null }, 'A validation of this review is already pending');
    this.logger.log(`Task ${taskId}: dry-run requested for ${headSha.slice(0, 12)} by ${requestedBy}`);
    return this.byId(id)!;
  }

  /**
   * The separate publish approval. Allowed only when the same policy the publisher enforces holds:
   * approved review of exactly this commit, a passed test run of exactly this commit with the
   * project's current commands, and a recent dry-run that the publisher found eligible for that run.
   */
  async authorize(taskId: string, input: { headSha: string; dryRunId: string; idempotencyKey: string }, authorizedBy: string): Promise<PublishAuthorization> {
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw conflict('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must be 8-100 characters [A-Za-z0-9_-]');
    this.expireAuthorizations();
    const existing = this.db.prepare('SELECT * FROM publish_authorizations WHERE idempotency_key = ?').get(input.idempotencyKey) as AuthorizationRow | undefined;
    if (existing) {
      if (existing.task_id !== taskId || existing.head_sha !== input.headSha) throw conflict('IDEMPOTENCY_KEY_REUSED', 'idempotencyKey was used for another request');
      return toAuthorization(existing);
    }
    const review = await this.approvedReview(taskId, input.headSha);
    const task = await this.tasks.get(taskId);
    const project = this.project(task.projectId);
    if (!project || project.source !== 'github' || project.githubRepositoryId === null) throw conflict('REPOSITORY_NOT_ALLOWED', 'Only registered GitHub repositories can be published');
    const validation = this.requirePassedTests(taskId, input.headSha, project);

    const dryRun = this.byId(input.dryRunId);
    const age = dryRun?.completedAt ? this.clock.now().getTime() - Date.parse(dryRun.completedAt) : Infinity;
    if (!dryRun || dryRun.taskId !== taskId || dryRun.reviewId !== review.id || dryRun.mode !== 'dry-run' || dryRun.status !== 'ready' ||
        dryRun.result?.eligible !== true || dryRun.result?.testValidationId !== validation.id || age > DRY_RUN_MAX_AGE_MS) {
      throw conflict('DRY_RUN_REQUIRED', 'Run Validate / Dry-run again: the newest eligible dry-run must cover this commit and test run (and be at most 30 minutes old)');
    }
    const now = this.clock.now();
    const id = randomUUID();
    try {
      this.db.prepare(`
        INSERT INTO publish_authorizations (id, task_id, review_id, project_id, repository_id, head_sha, test_validation_id, dry_run_id,
          authorized_by, authorized_at, expires_at, status, idempotency_key, updated_at)
        VALUES (@id, @task, @review, @project, @repo, @head, @tests, @dry, @by, @now, @expires, 'active', @key, @now)`).run({
        id, task: taskId, review: review.id, project: project.id, repo: project.githubRepositoryId, head: input.headSha, tests: validation.id,
        dry: dryRun.id, by: authorizedBy, now: now.toISOString(), expires: new Date(now.getTime() + AUTHORIZATION_TTL_MS).toISOString(), key: input.idempotencyKey,
      });
    } catch (error) {
      if (/UNIQUE constraint failed/.test((error as Error).message)) throw conflict('PUBLISH_ALREADY_AUTHORIZED', 'This review already has an active publish authorization');
      throw error;
    }
    this.logger.log(`Task ${taskId}: publish authorized for ${input.headSha.slice(0, 12)} by ${authorizedBy}`);
    return this.authorizationById(id)!;
  }

  /**
   * Starts a real publication. Disabled unless CONTROLLER_PUBLISH_ENABLED=true (off in Phase E-2B).
   * The authorization is consumed atomically, so two requests cannot both publish; a repeated
   * request with the same idempotency key returns the first publication.
   */
  async requestPublish(taskId: string, input: { authorizationId: string; idempotencyKey: string }, requestedBy: string): Promise<Publication> {
    if (!this.config.publishEnabled) throw conflict('PUBLISH_DISABLED', 'Publishing is disabled (CONTROLLER_PUBLISH_ENABLED is not true)');
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw conflict('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must be 8-100 characters [A-Za-z0-9_-]');
    const repeated = this.db.prepare('SELECT * FROM publications WHERE idempotency_key = ?').get(input.idempotencyKey) as PublicationRow | undefined;
    if (repeated) {
      if (repeated.task_id !== taskId) throw conflict('IDEMPOTENCY_KEY_REUSED', 'idempotencyKey was used for another request');
      return toPublication(repeated);
    }
    this.expireAuthorizations();
    const auth = this.authorizationById(input.authorizationId);
    if (!auth || auth.taskId !== taskId || auth.status !== 'active') throw conflict('PUBLISH_APPROVAL_REQUIRED', 'No active publish authorization for this task');
    const review = await this.approvedReview(taskId, auth.headSha);
    if (review.id !== auth.reviewId) throw conflict('REVIEW_NOT_APPROVED', 'The authorization belongs to an older review');
    const task = await this.tasks.get(taskId);
    const validation = this.requirePassedTests(taskId, auth.headSha, this.project(task.projectId));
    if (validation.id !== auth.testValidationId) throw conflict('TEST_COMMIT_MISMATCH', 'A newer test run exists; authorize again');
    if (this.db.prepare(`SELECT 1 FROM publications WHERE review_id = ? AND status IN ('published', 'pr_created')`).get(review.id)) {
      throw conflict('ALREADY_PUBLISHED', 'This review has already been published');
    }
    const now = this.clock.now().toISOString();
    const id = randomUUID();
    this.db.transaction(() => {
      this.insert({ id, task: taskId, review: review.id, head: auth.headSha, mode: 'publish', by: requestedBy, now, auth: auth.id, key: input.idempotencyKey }, 'A publication of this review is already in progress');
      // Consumed in the same transaction: if it is no longer active, the publication row is rolled back too.
      const used = this.db.prepare(`
        UPDATE publish_authorizations SET status = 'used', used_at = @now, publication_id = @pub, updated_at = @now
         WHERE id = @id AND status = 'active' AND expires_at > @now`).run({ id: auth.id, now, pub: id });
      if (used.changes !== 1) throw conflict('PUBLISH_APPROVAL_REQUIRED', 'The publish authorization is no longer active');
    }).immediate();
    this.logger.log(`Task ${taskId}: publish requested for ${auth.headSha.slice(0, 12)} by ${requestedBy}`);
    return this.byId(id)!;
  }

  async status(taskId: string) {
    const task = await this.tasks.get(taskId);
    const review = this.reviews.ensureForTask(task);
    this.expireAuthorizations();
    const history = (this.db.prepare('SELECT * FROM publications WHERE task_id = ? ORDER BY requested_at, rowid').all(taskId) as PublicationRow[]).map(toPublication);
    const current = review ? [...history].reverse().find((p) => p.reviewId === review.id) ?? null : null;
    const authorizations = (this.db.prepare('SELECT * FROM publish_authorizations WHERE task_id = ? ORDER BY authorized_at, rowid').all(taskId) as AuthorizationRow[]).map(toAuthorization);
    return {
      state: stateOf(review, current),
      review,
      current,
      history,
      testValidation: review ? this.tests.latestFor(taskId, review.headSha) : null,
      authorization: review ? authorizations.filter((a) => a.reviewId === review.id).at(-1) ?? null : null,
      publishEnabled: this.config.publishEnabled,
    };
  }

  /** Next request for the publisher: pending, or one whose previous claim expired (publisher restarted). */
  async claim(publisher: PublisherPrincipal): Promise<PublicationJob | null> {
    const now = this.clock.now();
    const iso = now.toISOString();
    const claimed = this.db.transaction(() => {
      // A request whose publisher died repeatedly fails instead of looping forever.
      this.db.prepare(`
        UPDATE publications SET status = 'failed', completed_at = @now, updated_at = @now, lease_expires_at = NULL,
               result = json_object('mode', mode, 'eligible', json('false'), 'canPublish', json('false'), 'reason', 'PUBLISHER_UNAVAILABLE',
                                    'error', 'publisher did not finish after ' || attempts || ' attempts')
         WHERE status = 'validating' AND lease_expires_at < @now AND attempts >= @max`).run({ now: iso, max: MAX_ATTEMPTS });
      const row = this.db.prepare(`
        SELECT id FROM publications
         WHERE status = 'pending' OR (status = 'validating' AND lease_expires_at < @now)
         ORDER BY requested_at, rowid LIMIT 1`).get({ now: iso }) as { id: string } | undefined;
      if (!row) return null;
      return this.db.prepare(`
        UPDATE publications SET status = 'validating', claimed_by = @by, claimed_at = @now, lease_expires_at = @lease,
               attempts = attempts + 1, updated_at = @now
         WHERE id = @id RETURNING *`).get({
        id: row.id, by: publisher.publisherId, now: iso, lease: new Date(now.getTime() + LEASE_MS).toISOString(),
      }) as PublicationRow;
    }).immediate();
    if (!claimed) return null;
    const publication = toPublication(claimed);
    this.expireAuthorizations();

    const task = await this.tasks.get(publication.taskId);
    const diff = reportedDiff(task);
    let report: Record<string, any> | null = null;
    try {
      report = task.result ? JSON.parse(task.result) : null;
    } catch {
      report = null;
    }
    const p = this.project(task.projectId);
    const active = this.db.prepare(`SELECT * FROM publish_authorizations WHERE review_id = ? AND status = 'active'`).get(publication.reviewId) as AuthorizationRow | undefined;
    const authorization = publication.mode === 'publish'
      ? (publication.authorizationId ? this.authorizationById(publication.authorizationId) : null)
      : (active ? toAuthorization(active) : null);
    return {
      publication,
      task: { id: task.id, status: task.status, agent: task.agent, projectId: task.projectId, createdBy: task.createdBy, completedAt: task.completedAt },
      review: this.reviews.byId(publication.reviewId),
      latestReview: this.reviews.latest(task.id),
      reported: diff && {
        baseSha: diff.baseCommit, headSha: diff.headCommit, headTree: diff.headTree, commitMessage: diff.commitMessage,
        files: diff.files, patchRecorded: diff.patch !== null, patchTruncated: diff.patchTruncated, omittedFiles: diff.omittedFiles,
        tests: diff.tests, branch: typeof report?.workspace?.branch === 'string' ? report.workspace.branch : null,
      },
      project: p && {
        id: p.id, source: p.source, fullName: p.fullName, remoteUrl: p.remoteUrl, defaultBranch: p.defaultBranch,
        visibility: p.visibility, githubRepositoryId: p.githubRepositoryId, enabled: p.enabled, allowCodeChanges: p.allowCodeChanges,
        allowedAgents: p.allowedAgents, syncStatus: p.syncStatus, cachedHeadSha: p.cachedHeadSha, testCommands: p.testCommands,
        commitAuthor: p.commitAuthor,
      },
      testValidation: this.tests.latestFor(task.id, publication.headSha),
      authorization,
    };
  }

  /**
   * The publisher's verdict. dry-run: 'ready' (eligible) or 'failed'. publish: 'published',
   * 'pr_created' or 'failed'. 'ready' / 'published' are accepted only while the review is still the
   * approved review of the same commit.
   */
  complete(publisher: PublisherPrincipal, id: string, status: PublicationStatus, result: Record<string, unknown>): Publication {
    const current = this.byId(id);
    if (!current) throw new NotFoundException(`Publication ${id} not found`);
    const allowed: PublicationStatus[] = current.mode === 'dry-run' ? ['ready', 'failed'] : ['published', 'pr_created', 'failed'];
    if (!allowed.includes(status)) throw conflict('INVALID_RESULT', `${status} is not a result of a ${current.mode} request`);
    let final: PublicationStatus = status;
    const stored: Record<string, unknown> = { ...result };
    if (status === 'ready') {
      const review = this.reviews.byId(current.reviewId);
      if (!review || review.status !== 'approved' || review.headSha !== current.headSha) {
        final = 'failed';
        stored.eligible = false;
        stored.controllerNote = `review is ${review?.status ?? 'missing'} now; not ready`;
      }
    }
    const json = JSON.stringify(stored);
    if (json.length > MAX_RESULT_CHARS) throw conflict('RESULT_TOO_LARGE', `result is larger than ${MAX_RESULT_CHARS} characters`);
    const now = this.clock.now().toISOString();
    const row = this.db.prepare(`
      UPDATE publications SET status = @status, result = @result, completed_at = @now, lease_expires_at = NULL, updated_at = @now
       WHERE id = @id AND status = 'validating' AND claimed_by = @by
      RETURNING *`).get({ id, status: final, result: json, now, by: publisher.publisherId }) as PublicationRow | undefined;
    if (!row) throw conflict('NOT_VALIDATING', `Publication ${id} is ${current.status}, not being handled by this publisher`);
    this.logger.log(`Publication ${id} (task ${current.taskId}, ${current.mode}): ${final}`);
    return toPublication(row);
  }

  private async approvedReview(taskId: string, headSha: string): Promise<Review> {
    const task = await this.tasks.get(taskId);
    const review = this.reviews.ensureForTask(task);
    if (!review) throw new NotFoundException(`Task ${taskId} has no reviewable commit`);
    if (review.headSha !== headSha) throw conflict('COMMIT_MISMATCH', `headSha does not match the commit under review (${review.headSha})`);
    if (review.status !== 'approved') throw conflict('REVIEW_NOT_APPROVED', `The review of ${headSha} is ${review.status}; only approved commits can be published`);
    return review;
  }

  /** POLICY A on the controller side (the publisher additionally verifies the runner's signature). */
  private requirePassedTests(taskId: string, headSha: string, project: Project | null): TestValidation {
    const validation = this.tests.latestFor(taskId, headSha);
    if (!validation || validation.status === 'pending' || validation.status === 'running') {
      throw conflict('TEST_REPORT_MISSING', 'Not publishable: there is no completed test run for this commit');
    }
    if (validation.status === 'skipped') throw conflict('TEST_SKIPPED', 'Not publishable: tests were skipped');
    if (validation.status === 'aborted') throw conflict('TEST_ABORTED', 'Not publishable: the test run was interrupted or timed out');
    if (validation.status !== 'passed') throw conflict('TEST_FAILED', 'Not publishable: tests failed');
    if (validation.commitSha !== headSha) throw conflict('TEST_COMMIT_MISMATCH', 'The test run is for another commit');
    if (!project || JSON.stringify(validation.commands) !== JSON.stringify(project.testCommands)) {
      throw conflict('TEST_COMMANDS_CHANGED', 'The project test commands changed since this run; run the tests again');
    }
    if (!validation.evidence || !validation.evidenceHash || !validation.evidenceSignature) throw conflict('TEST_EVIDENCE_INVALID', 'The test run has no signed evidence');
    return validation;
  }

  private insert(v: { id: string; task: string; review: string; head: string; mode: PublicationMode; by: string; now: string; auth: string | null; key: string | null }, duplicate: string) {
    try {
      this.db.prepare(`
        INSERT INTO publications (id, task_id, review_id, head_sha, mode, status, requested_by, requested_at, updated_at, authorization_id, idempotency_key)
        VALUES (@id, @task, @review, @head, @mode, 'pending', @by, @now, @now, @auth, @key)`).run(v);
    } catch (error) {
      if (/UNIQUE constraint failed/.test((error as Error).message)) throw conflict('ALREADY_IN_PROGRESS', duplicate);
      throw error;
    }
  }

  private expireAuthorizations(): void {
    const now = this.clock.now().toISOString();
    this.db.prepare(`UPDATE publish_authorizations SET status = 'expired', updated_at = @now WHERE status = 'active' AND expires_at <= @now`).run({ now });
  }

  private project(projectId: string | null): Project | null {
    if (!projectId) return null;
    try {
      return this.projects.get(projectId, { role: 'admin' }) as Project;
    } catch {
      return null;
    }
  }

  private byId(id: string): Publication | null {
    const row = this.db.prepare('SELECT * FROM publications WHERE id = ?').get(id) as PublicationRow | undefined;
    return row ? toPublication(row) : null;
  }

  private authorizationById(id: string): PublishAuthorization | null {
    const row = this.db.prepare('SELECT * FROM publish_authorizations WHERE id = ?').get(id) as AuthorizationRow | undefined;
    return row ? toAuthorization(row) : null;
  }
}

export function stateOf(review: Review | null, current: Publication | null): PublicationState {
  if (!review || review.status !== 'approved') return 'not_approved';
  if (!current) return 'approved';
  switch (current.status) {
    case 'pending':
    case 'validating':
      return 'validation_pending';
    case 'ready':
      // Results from before the E-2B preflight (no eligibility verdict) must be validated again.
      return current.result?.eligible === true ? 'ready_to_publish' : 'approved';
    case 'failed':
      return 'validation_failed';
    case 'published':
      return 'published';
    case 'pr_created':
      return 'pr_created';
  }
}

function toPublication(r: PublicationRow): Publication {
  let result: Record<string, unknown> | null = null;
  try {
    result = r.result ? JSON.parse(r.result) : null;
  } catch {
    result = { error: 'unreadable result' };
  }
  return {
    id: r.id, taskId: r.task_id, reviewId: r.review_id, headSha: r.head_sha, mode: r.mode, status: r.status,
    requestedBy: r.requested_by, requestedAt: r.requested_at, claimedBy: r.claimed_by, claimedAt: r.claimed_at,
    leaseExpiresAt: r.lease_expires_at, attempts: r.attempts, completedAt: r.completed_at, result,
    authorizationId: r.authorization_id, idempotencyKey: r.idempotency_key, updatedAt: r.updated_at,
  };
}

function toAuthorization(r: AuthorizationRow): PublishAuthorization {
  return {
    id: r.id, taskId: r.task_id, reviewId: r.review_id, projectId: r.project_id, repositoryId: r.repository_id, headSha: r.head_sha,
    testValidationId: r.test_validation_id, dryRunId: r.dry_run_id, authorizedBy: r.authorized_by, authorizedAt: r.authorized_at,
    expiresAt: r.expires_at, status: r.status, usedAt: r.used_at, publicationId: r.publication_id, idempotencyKey: r.idempotency_key,
  };
}
