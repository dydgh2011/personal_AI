import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.js';
import { Actor } from '../auth/auth.js';
import { Clock } from '../common/clock.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { MilestonesModule, MilestonesService } from '../milestones/milestones.js';
import { RubricsModule, RubricsService } from '../rubrics/rubrics.js';
import { ALLOWED_EXTENSIONS, checkUploads, MAX_BODY_CHARS, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, UploadError, type FileCategory } from './uploads.js';

export const ASSIGNMENT_KINDS = ['text', 'file', 'code', 'photo', 'experiment'] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];
export const ASSIGNMENT_STATUSES = ['planned', 'available', 'submitted', 'evaluated', 'passed', 'revision_required', 'archived'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/**
 * Status changes the owner may make directly. submitted / evaluated / passed / revision_required
 * are set by the server only (submitting, a finished evaluation, the owner's decision).
 */
const OWNER_TRANSITIONS: Partial<Record<AssignmentStatus, AssignmentStatus[]>> = {
  planned: ['available', 'archived'],
  available: ['planned', 'archived'],
  submitted: ['archived'],
  evaluated: ['archived'],
  revision_required: ['archived'],
  passed: ['archived'],
  archived: ['planned'],
};
/** Where a new submission is accepted. */
const OPEN_FOR_SUBMISSION: AssignmentStatus[] = ['available', 'submitted', 'evaluated', 'revision_required'];

/** No code is executed for any assignment kind. Recorded so it is visible, not implied. */
export const CODE_EXECUTION = {
  available: false,
  reason: 'Code submissions are stored and read as text only. Running them needs a separate isolated runner (no network, no secrets, resource limits) that is decided later (ROADMAP L2-03); the Test Runner and Publisher and their keys are never used for learning.',
} as const;

export const UPLOAD_LIMITS = { maxFileBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES, maxTotalBytes: MAX_TOTAL_BYTES, maxBodyChars: MAX_BODY_CHARS, extensions: ALLOWED_EXTENSIONS };

export interface Assignment {
  id: string;
  milestoneId: string;
  title: string;
  kind: AssignmentKind;
  instructions: string;
  rubricVersionId: string | null;
  definitionVersion: number;
  status: AssignmentStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionEvaluationId: string | null;
  submissions: number;
  latestSubmissionId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionFile {
  id: string;
  position: number;
  name: string;
  mediaType: string;
  category: FileCategory;
  size: number;
  sha256: string;
}

export interface Submission {
  id: string;
  assignmentId: string;
  revision: number;
  definitionVersion: number;
  body: string | null;
  note: string | null;
  contentHash: string;
  files: SubmissionFile[];
  submittedBy: string;
  submittedAt: string;
}

export class CreateAssignmentDto {
  @IsUUID('4')
  milestoneId: string;

  @IsString() @MinLength(1) @MaxLength(200)
  title: string;

  @IsIn(ASSIGNMENT_KINDS)
  kind: AssignmentKind;

  @IsString() @MinLength(1) @MaxLength(20_000)
  instructions: string;

  /** Defaults to the milestone's rubric version. */
  @IsOptional() @IsUUID('4')
  rubricVersionId?: string;

  @IsOptional() @IsIn(['planned', 'available'])
  status?: 'planned' | 'available';
}

export class UpdateAssignmentDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200)
  title?: string;

  @IsOptional() @IsIn(ASSIGNMENT_KINDS)
  kind?: AssignmentKind;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(20_000)
  instructions?: string;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID('4')
  rubricVersionId?: string | null;

  @IsOptional() @IsIn(ASSIGNMENT_STATUSES)
  status?: AssignmentStatus;
}

export class UploadDto {
  @IsString() @MinLength(1) @MaxLength(500)
  name: string;

  /** Checked again after decoding (size, type); the DTO bound only keeps the JSON parser honest. */
  @IsString() @MaxLength(Math.ceil(MAX_FILE_BYTES / 3) * 4 + 16)
  contentBase64: string;
}

export class SubmitDto {
  @IsOptional() @IsString() @MaxLength(MAX_BODY_CHARS)
  body?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(MAX_FILES) @ValidateNested({ each: true }) @Type(() => UploadDto)
  files?: UploadDto[];
}

export class DecisionDto {
  @IsUUID('4')
  evaluationId: string;

  @IsIn(['passed', 'revision_required'])
  decision: 'passed' | 'revision_required';
}

interface Row {
  id: string; milestone_id: string; title: string; kind: AssignmentKind; instructions: string; rubric_version_id: string | null; definition_version: number;
  status: AssignmentStatus; decided_by: string | null; decided_at: string | null; decision_evaluation_id: string | null; created_by: string; created_at: string; updated_at: string;
}
interface SubmissionRow { id: string; assignment_id: string; revision: number; definition_version: number; body: string | null; note: string | null; content_hash: string; submitted_by: string; submitted_at: string }
interface FileRow { id: string; submission_id: string; position: number; name: string; media_type: string; category: FileCategory; size: number; sha256: string }

const toFile = (f: FileRow): SubmissionFile => ({ id: f.id, position: f.position, name: f.name, mediaType: f.media_type, category: f.category, size: f.size, sha256: f.sha256 });

export function submissionHash(body: string | null, note: string | null, files: Array<{ name: string; sha256: string }>): string {
  return createHash('sha256').update(JSON.stringify({ body, note, files: files.map((f) => ({ name: f.name, sha256: f.sha256 })) })).digest('hex');
}

/**
 * Assignments (with versioned definitions) and their submissions. A submission is an immutable
 * revision: re-submitting adds revision n+1 and keeps every earlier one with its files.
 */
@Injectable()
export class AssignmentsService {
  constructor(
    @Inject(SQLITE_CONNECTION) private readonly db: Database,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly milestones: MilestonesService,
    private readonly rubrics: RubricsService,
  ) {}

  list(filter: { milestoneId?: string; status?: string } = {}): Assignment[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.milestoneId) {
      where.push('milestone_id = ?');
      args.push(filter.milestoneId);
    }
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    const sql = `SELECT * FROM assignments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE status WHEN 'archived' THEN 1 ELSE 0 END, created_at`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => this.toAssignment(r));
  }

  get(id: string): Assignment {
    const row = this.db.prepare('SELECT * FROM assignments WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw notFound('Assignment', id);
    return this.toAssignment(row);
  }

  /** The assignment with its definition history and all submission revisions (newest first). */
  detail(id: string) {
    const assignment = this.get(id);
    const definitions = (this.db.prepare('SELECT * FROM assignment_definitions WHERE assignment_id = ? ORDER BY version DESC').all(id) as Array<Record<string, unknown>>).map((d) => ({
      version: d.version as number, title: d.title as string, kind: d.kind as AssignmentKind, instructions: d.instructions as string,
      rubricVersionId: d.rubric_version_id as string | null, createdBy: d.created_by as string, createdAt: d.created_at as string,
    }));
    const submissions = (this.db.prepare('SELECT * FROM submissions WHERE assignment_id = ? ORDER BY revision DESC').all(id) as SubmissionRow[]).map((s) => this.toSubmission(s));
    return { assignment, definitions, submissions, codeExecution: CODE_EXECUTION, uploadLimits: UPLOAD_LIMITS };
  }

  create(dto: CreateAssignmentDto, actor: string): Assignment {
    const milestone = this.milestones.get(dto.milestoneId);
    if (milestone.status === 'archived' || milestone.status === 'completed') throw conflict('MILESTONE_CLOSED', `The milestone is ${milestone.status}`);
    const rubricVersionId = dto.rubricVersionId ?? milestone.rubricVersionId;
    if (rubricVersionId) this.rubrics.version(rubricVersionId);
    const id = randomUUID();
    const now = this.clock.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO assignments (id, milestone_id, title, kind, instructions, rubric_version_id, definition_version, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(id, dto.milestoneId, dto.title.trim(), dto.kind, dto.instructions.trim(), rubricVersionId, dto.status ?? 'available', actor, now, now);
      this.insertDefinition(id, 1, { title: dto.title.trim(), kind: dto.kind, instructions: dto.instructions.trim(), rubricVersionId }, actor, now);
    }).immediate();
    this.audit.record(actor, 'assignment.create', 'assignment', id, dto);
    return this.get(id);
  }

  update(id: string, dto: UpdateAssignmentDto, actor: string): Assignment {
    const a = this.get(id);
    if (dto.status !== undefined && dto.status !== a.status && !(OWNER_TRANSITIONS[a.status] ?? []).includes(dto.status)) {
      throw conflict('INVALID_TRANSITION', `An assignment that is ${a.status} cannot be set to ${dto.status} directly`);
    }
    if (dto.rubricVersionId) this.rubrics.version(dto.rubricVersionId);
    const next = {
      title: dto.title?.trim() ?? a.title,
      kind: dto.kind ?? a.kind,
      instructions: dto.instructions?.trim() ?? a.instructions,
      rubricVersionId: dto.rubricVersionId === undefined ? a.rubricVersionId : dto.rubricVersionId,
    };
    const definitionChanged = next.title !== a.title || next.kind !== a.kind || next.instructions !== a.instructions || next.rubricVersionId !== a.rubricVersionId;
    const now = this.clock.now().toISOString();
    this.db.transaction(() => {
      const version = definitionChanged ? a.definitionVersion + 1 : a.definitionVersion;
      if (definitionChanged) this.insertDefinition(id, version, next, actor, now);
      const res = this.db.prepare(`UPDATE assignments SET title = ?, kind = ?, instructions = ?, rubric_version_id = ?, definition_version = ?, status = ?, updated_at = ?
        WHERE id = ? AND status = ? AND definition_version = ?`).run(next.title, next.kind, next.instructions, next.rubricVersionId, version, dto.status ?? a.status, now, id, a.status, a.definitionVersion);
      if (res.changes !== 1) throw conflict('ASSIGNMENT_CHANGED', 'The assignment changed meanwhile; reload and try again');
    }).immediate();
    this.audit.record(actor, 'assignment.update', 'assignment', id, dto);
    return this.get(id);
  }

  /** A new immutable revision. Files are checked and stored as bytes; nothing is executed. */
  submit(id: string, dto: SubmitDto, actor: string): Submission {
    const a = this.get(id);
    if (!OPEN_FOR_SUBMISSION.includes(a.status)) throw conflict('ASSIGNMENT_NOT_OPEN', `The assignment is ${a.status}; it does not take submissions`);
    let files;
    try {
      files = checkUploads(dto.files ?? []);
    } catch (error) {
      if (error instanceof UploadError) throw unprocessable('UPLOAD_REJECTED', error.message);
      throw error;
    }
    const body = dto.body?.replace(/\r\n/g, '\n').trim() || null;
    const note = dto.note?.trim() || null;
    if (!body && files.length === 0) throw unprocessable('EMPTY_SUBMISSION', 'Add an answer text or at least one file');
    if (a.kind === 'photo' && !files.some((f) => f.category === 'image')) throw unprocessable('EMPTY_SUBMISSION', 'A photo assignment needs at least one image');
    if ((a.kind === 'file') && files.length === 0) throw unprocessable('EMPTY_SUBMISSION', 'A file assignment needs at least one file');
    const hash = submissionHash(body, note, files);
    const latest = this.db.prepare('SELECT content_hash FROM submissions WHERE assignment_id = ? ORDER BY revision DESC LIMIT 1').get(id) as { content_hash: string } | undefined;
    if (latest?.content_hash === hash) throw conflict('DUPLICATE_SUBMISSION', 'This is identical to your latest submission');
    const submissionId = randomUUID();
    const now = this.clock.now().toISOString();
    const revision = this.db.transaction(() => {
      const next = (this.db.prepare('SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM submissions WHERE assignment_id = ?').get(id) as { n: number }).n;
      this.db.prepare(`INSERT INTO submissions (id, assignment_id, revision, definition_version, body, note, content_hash, submitted_by, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(submissionId, id, next, a.definitionVersion, body, note, hash, actor, now);
      const insertFile = this.db.prepare(`INSERT INTO submission_files (id, submission_id, position, name, media_type, category, size, sha256, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      files.forEach((f, i) => insertFile.run(randomUUID(), submissionId, i + 1, f.name, f.mediaType, f.category, f.size, f.sha256, f.content));
      const moved = this.db.prepare(`UPDATE assignments SET status = 'submitted', decided_by = NULL, decided_at = NULL, decision_evaluation_id = NULL, updated_at = ?
        WHERE id = ? AND status = ?`).run(now, id, a.status);
      if (moved.changes !== 1) throw conflict('ASSIGNMENT_CHANGED', 'The assignment changed meanwhile; reload and try again');
      return next;
    }).immediate();
    // Only hashes and sizes go to the audit log, never the submitted content.
    this.audit.record(actor, 'submission.create', 'submission', submissionId, { assignmentId: id, revision, hash, files: files.map((f) => ({ sha256: f.sha256, size: f.size })) });
    return this.submission(submissionId);
  }

  /**
   * The owner decides. "passed" needs a completed evaluation of the LATEST revision that used a
   * rubric and has evidence - an AI summary alone never passes an assignment.
   */
  decide(id: string, dto: DecisionDto, actor: string): Assignment {
    const a = this.get(id);
    if (a.status !== 'evaluated') throw conflict('INVALID_TRANSITION', `The assignment is ${a.status}; it needs a finished evaluation of the latest submission first`);
    const ev = this.db.prepare(`SELECT e.id, e.status, e.rubric_version_id, s.revision, s.assignment_id FROM evaluations e JOIN submissions s ON s.id = e.submission_id WHERE e.id = ?`)
      .get(dto.evaluationId) as { id: string; status: string; rubric_version_id: string | null; revision: number; assignment_id: string } | undefined;
    if (!ev || ev.assignment_id !== id) throw notFound('Evaluation', dto.evaluationId);
    if (ev.status !== 'completed') throw unprocessable('EVALUATION_NOT_COMPLETED', `Evaluation is ${ev.status}`);
    const latest = (this.db.prepare('SELECT MAX(revision) AS r FROM submissions WHERE assignment_id = ?').get(id) as { r: number }).r;
    if (ev.revision !== latest) throw conflict('STALE_EVALUATION', `This evaluation is for revision ${ev.revision}; the latest submission is revision ${latest}`);
    if (dto.decision === 'passed') {
      if (!ev.rubric_version_id) throw unprocessable('EVIDENCE_REQUIRED', 'Passing needs an evaluation against a rubric');
      const evidence = (this.db.prepare('SELECT COUNT(*) AS c FROM evaluation_evidence WHERE evaluation_id = ?').get(ev.id) as { c: number }).c;
      if (evidence === 0) throw unprocessable('EVIDENCE_REQUIRED', 'Passing needs an evaluation with evidence');
    }
    const now = this.clock.now().toISOString();
    const res = this.db.prepare(`UPDATE assignments SET status = ?, decided_by = ?, decided_at = ?, decision_evaluation_id = ?, updated_at = ? WHERE id = ? AND status = 'evaluated'`)
      .run(dto.decision, actor, now, ev.id, now, id);
    if (res.changes !== 1) throw conflict('ASSIGNMENT_CHANGED', 'The assignment changed meanwhile; reload and try again');
    this.audit.record(actor, `assignment.decide.${dto.decision}`, 'assignment', id, dto);
    return this.get(id);
  }

  /** After an evaluation of the latest revision finishes: submitted -> evaluated. */
  markEvaluated(submissionId: string): void {
    const s = this.db.prepare('SELECT assignment_id, revision FROM submissions WHERE id = ?').get(submissionId) as { assignment_id: string; revision: number };
    const latest = (this.db.prepare('SELECT MAX(revision) AS r FROM submissions WHERE assignment_id = ?').get(s.assignment_id) as { r: number }).r;
    if (s.revision !== latest) return;
    this.db.prepare(`UPDATE assignments SET status = 'evaluated', updated_at = ? WHERE id = ? AND status = 'submitted'`).run(this.clock.now().toISOString(), s.assignment_id);
  }

  submission(id: string): Submission {
    const row = this.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as SubmissionRow | undefined;
    if (!row) throw notFound('Submission', id);
    return this.toSubmission(row);
  }

  /** Text content of the text files (for evaluation); images and PDFs are not read. */
  textFiles(submissionId: string): Array<{ id: string; name: string; text: string }> {
    return (this.db.prepare("SELECT id, name, content FROM submission_files WHERE submission_id = ? AND category = 'text' ORDER BY position").all(submissionId) as Array<{ id: string; name: string; content: Buffer }>)
      .map((f) => ({ id: f.id, name: f.name, text: f.content.toString('utf8') }));
  }

  /** One file's bytes, base64 in JSON (the dashboard serves it with safe headers). */
  file(submissionId: string, fileId: string): SubmissionFile & { contentBase64: string } {
    const row = this.db.prepare('SELECT * FROM submission_files WHERE id = ? AND submission_id = ?').get(fileId, submissionId) as (FileRow & { content: Buffer }) | undefined;
    if (!row) throw notFound('File', fileId);
    return { ...toFile(row), contentBase64: row.content.toString('base64') };
  }

  private insertDefinition(id: string, version: number, d: { title: string; kind: AssignmentKind; instructions: string; rubricVersionId: string | null }, actor: string, at: string): void {
    this.db.prepare(`INSERT INTO assignment_definitions (assignment_id, version, title, kind, instructions, rubric_version_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, version, d.title, d.kind, d.instructions, d.rubricVersionId, actor, at);
  }

  private toSubmission(s: SubmissionRow): Submission {
    const files = (this.db.prepare('SELECT id, submission_id, position, name, media_type, category, size, sha256 FROM submission_files WHERE submission_id = ? ORDER BY position').all(s.id) as FileRow[]).map(toFile);
    return {
      id: s.id, assignmentId: s.assignment_id, revision: s.revision, definitionVersion: s.definition_version, body: s.body, note: s.note, contentHash: s.content_hash,
      files, submittedBy: s.submitted_by, submittedAt: s.submitted_at,
    };
  }

  private toAssignment(r: Row): Assignment {
    const sub = this.db.prepare('SELECT COUNT(*) AS c, (SELECT id FROM submissions WHERE assignment_id = ? ORDER BY revision DESC LIMIT 1) AS latest FROM submissions WHERE assignment_id = ?')
      .get(r.id, r.id) as { c: number; latest: string | null };
    return {
      id: r.id, milestoneId: r.milestone_id, title: r.title, kind: r.kind, instructions: r.instructions, rubricVersionId: r.rubric_version_id, definitionVersion: r.definition_version,
      status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionEvaluationId: r.decision_evaluation_id, submissions: sub.c, latestSubmissionId: sub.latest,
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
}

const uuid = new ParseUUIDPipe({ version: '4' });

@Controller()
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get('assignments')
  list(@Query('milestoneId') milestoneId?: string, @Query('status') status?: string) {
    if (status !== undefined && !(ASSIGNMENT_STATUSES as readonly string[]).includes(status)) throw unprocessable('INVALID_FILTER', 'unknown assignment status');
    return { items: this.assignments.list({ milestoneId, status }), uploadLimits: UPLOAD_LIMITS, codeExecution: CODE_EXECUTION };
  }

  @Post('assignments')
  create(@Body() dto: CreateAssignmentDto, @Actor() actor: string) {
    return this.assignments.create(dto, actor);
  }

  @Get('assignments/:id')
  detail(@Param('id', uuid) id: string) {
    return this.assignments.detail(id);
  }

  @Patch('assignments/:id')
  update(@Param('id', uuid) id: string, @Body() dto: UpdateAssignmentDto, @Actor() actor: string) {
    return this.assignments.update(id, dto, actor);
  }

  @Post('assignments/:id/submissions')
  submit(@Param('id', uuid) id: string, @Body() dto: SubmitDto, @Actor() actor: string) {
    return this.assignments.submit(id, dto, actor);
  }

  @Post('assignments/:id/decision')
  @HttpCode(200)
  decide(@Param('id', uuid) id: string, @Body() dto: DecisionDto, @Actor() actor: string) {
    return this.assignments.decide(id, dto, actor);
  }

  @Get('submissions/:id')
  submission(@Param('id', uuid) id: string) {
    return this.assignments.submission(id);
  }

  @Get('submissions/:id/files/:fileId')
  file(@Param('id', uuid) id: string, @Param('fileId', uuid) fileId: string) {
    return this.assignments.file(id, fileId);
  }
}

@Module({ imports: [MilestonesModule, RubricsModule], controllers: [AssignmentsController], providers: [AssignmentsService], exports: [AssignmentsService] })
export class AssignmentsModule {}
