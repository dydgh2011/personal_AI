import { Body, Controller, Get, HttpException, Inject, Injectable, Logger, Module, Param, ParseUUIDPipe, Post, Query, type OnModuleInit } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { AssignmentsModule, AssignmentsService, CODE_EXECUTION } from '../assignments/assignments.js';
import { AuditService } from '../audit/audit.js';
import { Actor } from '../auth/auth.js';
import { Clock } from '../common/clock.js';
import { conflict, notFound, parseJson, unprocessable } from '../common/errors.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { MasteryModule, MasteryService } from '../mastery/mastery.js';
import { ProviderService } from '../provider/provider.js';
import { canonicalSkill } from '../roadmaps/content.js';
import { RubricsModule, RubricsService, type RubricVersion } from '../rubrics/rubrics.js';
import {
  budgetSources, checkEvaluationOutput, EVALUATION_PROMPT_VERSION, EVALUATION_SCHEMA, EVALUATION_SYSTEM, rubricOutcome, sha256,
  type CriterionScore, type EvaluationSource, type EvidenceDraft,
} from './evaluation-ai.js';

export const EVALUATION_STATUSES = ['pending', 'completed', 'failed'] as const;

export interface Evidence {
  id: string;
  type: EvidenceDraft['type'];
  criterion: string | null;
  sourceRef: string;
  excerpt: string | null;
  hash: string | null;
  verified: boolean;
  score: number | null;
  note: string | null;
  limitations: string | null;
  createdAt: string;
}

export interface Evaluation {
  id: string;
  submissionId: string;
  assignmentId: string;
  assignmentTitle: string;
  revision: number;
  rubricVersionId: string | null;
  evaluatorType: 'ai' | 'owner';
  evaluator: string;
  status: (typeof EVALUATION_STATUSES)[number];
  /** What the scores say against the rubric. Not a pass: the owner decides that. */
  outcome: 'meets_rubric' | 'below_rubric' | 'inconclusive' | null;
  scores: CriterionScore[];
  totalScore: number | null;
  maxScore: number | null;
  passingScore: number | null;
  feedback: string | null;
  confidence: number | null;
  limitations: string[];
  suggestions: { gaps?: Array<{ skill: string | null; title: string; description: string | null; gapId: string | null }>; levels?: Array<{ skill: string; skillId: string | null; level: number; rationale: string | null }> };
  error: { code: string; message: string | null } | null;
  ai: { provider: string | null; model: string | null; promptVersion: string | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null } | null;
  evidenceCount: number;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
}

export class OwnerScoreDto {
  @Matches(/^[a-z0-9][a-z0-9_-]{0,39}$/)
  criterion: string;

  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(100)
  score: number;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;
}

export class OwnerEvidenceDto {
  @IsIn(['owner_check', 'reference'])
  type: 'owner_check' | 'reference';

  @IsString() @MinLength(1) @MaxLength(2000)
  note: string;

  @IsOptional() @IsString() @MaxLength(500)
  sourceRef?: string;
}

/** The owner's own assessment against the rubric (works without any AI). */
export class OwnerEvaluationDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => OwnerScoreDto)
  scores: OwnerScoreDto[];

  @IsOptional() @IsString() @MaxLength(5000)
  feedback?: string;

  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(1)
  confidence?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => OwnerEvidenceDto)
  evidence?: OwnerEvidenceDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(500, { each: true })
  limitations?: string[];
}

interface Row {
  id: string; submission_id: string; rubric_version_id: string | null; evaluator_type: 'ai' | 'owner'; evaluator: string; status: Evaluation['status']; outcome: Evaluation['outcome'];
  scores: string; total_score: number | null; max_score: number | null; feedback: string | null; confidence: number | null; limitations: string; suggestions: string;
  error_code: string | null; error_message: string | null; provider: string | null; model: string | null; prompt_version: string | null; input_tokens: number | null;
  output_tokens: number | null; cost_usd: number | null; requested_by: string; created_at: string; completed_at: string | null;
  assignment_id: string; assignment_title: string; revision: number; passing_score: number | null; evidence_count: number;
}

const SELECT = `SELECT e.*, s.assignment_id, s.revision, a.title AS assignment_title, rv.passing_score,
    (SELECT COUNT(*) FROM evaluation_evidence x WHERE x.evaluation_id = e.id) AS evidence_count
  FROM evaluations e JOIN submissions s ON s.id = e.submission_id JOIN assignments a ON a.id = s.assignment_id
  LEFT JOIN rubric_versions rv ON rv.id = e.rubric_version_id`;

const toEvaluation = (r: Row): Evaluation => ({
  id: r.id, submissionId: r.submission_id, assignmentId: r.assignment_id, assignmentTitle: r.assignment_title, revision: r.revision, rubricVersionId: r.rubric_version_id,
  evaluatorType: r.evaluator_type, evaluator: r.evaluator, status: r.status, outcome: r.outcome, scores: parseJson(r.scores, []), totalScore: r.total_score, maxScore: r.max_score,
  passingScore: r.passing_score, feedback: r.feedback, confidence: r.confidence, limitations: parseJson(r.limitations, []), suggestions: parseJson(r.suggestions, {}),
  error: r.error_code ? { code: r.error_code, message: r.error_message } : null,
  ai: r.evaluator_type === 'ai' ? { provider: r.provider, model: r.model, promptVersion: r.prompt_version, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUsd: r.cost_usd } : null,
  evidenceCount: r.evidence_count, requestedBy: r.requested_by, createdAt: r.created_at, completedAt: r.completed_at,
});

/**
 * Evaluations of submissions, by the owner or by AI (through the provider adapter / LLM gateway,
 * with the same configuration gate and monthly budget as roadmap drafts). An evaluation is a job
 * record: written as "pending" before the AI call and finished as completed or failed. A failure
 * never touches the submission. Results and evidence are immutable history.
 */
@Injectable()
export class EvaluationsService implements OnModuleInit {
  private readonly logger = new Logger(EvaluationsService.name);

  constructor(
    @Inject(SQLITE_CONNECTION) private readonly db: Database,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly provider: ProviderService,
    private readonly assignments: AssignmentsService,
    private readonly rubrics: RubricsService,
    private readonly mastery: MasteryService,
  ) {}

  /** A pending evaluation at startup was cut off by a restart: record it as failed, keep the submission. */
  onModuleInit(): void {
    const res = this.db.prepare(`UPDATE evaluations SET status = 'failed', error_code = 'INTERRUPTED', error_message = 'The service restarted during the evaluation', completed_at = ?
      WHERE status = 'pending'`).run(this.clock.now().toISOString());
    if (res.changes) this.logger.warn(`${res.changes} interrupted evaluation(s) marked failed`);
  }

  list(filter: { status?: string; submissionId?: string; limit?: number } = {}): Evaluation[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.status) {
      where.push('e.status = ?');
      args.push(filter.status);
    }
    if (filter.submissionId) {
      where.push('e.submission_id = ?');
      args.push(filter.submissionId);
    }
    args.push(Math.min(Math.max(filter.limit ?? 100, 1), 500));
    return (this.db.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`).all(...args) as Row[]).map(toEvaluation);
  }

  get(id: string): Evaluation & { evidence: Evidence[] } {
    const row = this.db.prepare(`${SELECT} WHERE e.id = ?`).get(id) as Row | undefined;
    if (!row) throw notFound('Evaluation', id);
    const evidence = (this.db.prepare('SELECT * FROM evaluation_evidence WHERE evaluation_id = ? ORDER BY rowid').all(id) as Array<Record<string, unknown>>).map((e) => ({
      id: e.id as string, type: e.type as Evidence['type'], criterion: e.criterion as string | null, sourceRef: e.source_ref as string, excerpt: e.excerpt as string | null,
      hash: e.hash as string | null, verified: e.verified === 1, score: e.score as number | null, note: e.note as string | null, limitations: e.limitations as string | null, createdAt: e.created_at as string,
    }));
    return { ...toEvaluation(row), evidence };
  }

  /** The rubric of the assignment definition the submission was made against. */
  private context(submissionId: string) {
    const submission = this.assignments.submission(submissionId);
    const assignment = this.assignments.get(submission.assignmentId);
    const def = this.db.prepare('SELECT * FROM assignment_definitions WHERE assignment_id = ? AND version = ?').get(assignment.id, submission.definitionVersion) as
      { title: string; kind: string; instructions: string; rubric_version_id: string | null };
    if (!def.rubric_version_id) throw unprocessable('RUBRIC_REQUIRED', 'This assignment has no rubric; add one (a new assignment definition), then submit again');
    const rubric = this.rubrics.version(def.rubric_version_id);
    const milestone = this.db.prepare('SELECT title, passing_criteria, skill_ids FROM milestones WHERE id = ?').get(assignment.milestoneId) as { title: string; passing_criteria: string | null; skill_ids: string };
    const skills = parseJson<string[]>(milestone.skill_ids, []).map((id) => this.mastery.get(id));
    return { submission, assignment, def, rubric, milestone, skills };
  }

  /** Limitations that always hold for this submission, whoever evaluates it. */
  private standardLimitations(kind: string, files: Array<{ category: string }>, evaluatorType: 'ai' | 'owner'): string[] {
    const out: string[] = [];
    if (kind === 'code') out.push('Code was read, not executed: no isolated runner exists yet (decided separately).');
    if (kind === 'experiment') out.push('Experiment results and physical safety are not verified by this evaluation.');
    const unread = files.filter((f) => f.category !== 'text').length;
    if (evaluatorType === 'ai' && unread) out.push(`${unread} image/PDF file(s) were not read by the AI evaluator.`);
    if (evaluatorType === 'ai') out.push('AI opinion: pass/fail and verified skill levels are decided by the owner.');
    return out;
  }

  async evaluateWithAi(submissionId: string, actor: string): Promise<Evaluation & { evidence: Evidence[] }> {
    const { submission, assignment, def, rubric, milestone, skills } = this.context(submissionId);
    if (this.db.prepare("SELECT 1 FROM evaluations WHERE submission_id = ? AND status = 'pending'").get(submissionId)) {
      throw conflict('EVALUATION_IN_PROGRESS', 'An evaluation of this submission is already running');
    }
    const raw: EvaluationSource[] = [];
    if (submission.body) raw.push({ label: 'body', ref: `submission:${submission.id}#body`, text: submission.body });
    for (const f of this.assignments.textFiles(submission.id)) raw.push({ label: f.name, ref: `submission:${submission.id}#file:${f.id}`, text: f.text });
    const { sources, truncated } = budgetSources(raw);
    const request = {
      assignment: { title: def.title, kind: def.kind, instructions: def.instructions },
      milestone: { title: milestone.title, passingCriteria: milestone.passing_criteria },
      rubric: { criteria: rubric.criteria, passingScore: rubric.passingScore, maxScore: rubric.maxScore },
      skills: skills.map((s) => s.displayName),
      submission: {
        revision: submission.revision,
        texts: sources.map((s) => ({ source: s.label, text: s.text })),
        notReadable: submission.files.filter((f) => f.category !== 'text').map((f) => ({ name: f.name, type: f.category })),
      },
    };
    const prompt = JSON.stringify(request);
    // Refusals (not configured, budget) happen here, before any record: nothing to clean up.
    this.provider.preflight(prompt.length, EVALUATION_SYSTEM.length);

    const id = randomUUID();
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO evaluations (id, submission_id, rubric_version_id, evaluator_type, evaluator, status, requested_by, created_at, prompt_version)
      VALUES (?, ?, ?, 'ai', ?, 'pending', ?, ?, ?)`).run(id, submissionId, rubric.id, 'ai', actor, now, EVALUATION_PROMPT_VERSION);
    this.audit.record(actor, 'evaluation.request.ai', 'evaluation', id, { submissionId });

    let result;
    try {
      result = await this.provider.callJson({ purpose: 'submission.evaluate', promptVersion: EVALUATION_PROMPT_VERSION, system: EVALUATION_SYSTEM, schema: EVALUATION_SCHEMA, prompt, temperature: 0.2 });
    } catch (error) {
      const http = error instanceof HttpException ? error : null;
      const body = (http?.getResponse() ?? {}) as { code?: string; message?: string };
      this.fail(id, body.code ?? 'INTERNAL_ERROR', body.message ?? 'Evaluation failed', null);
      if (http) throw new HttpException({ ...(typeof body === 'object' ? body : {}), evaluationId: id, submissionKept: true }, http.getStatus());
      throw error;
    }
    const ai = { provider: result.provider, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd };
    const checked = checkEvaluationOutput(result.output, rubric.criteria, sources, `rubric:${rubric.id}`);
    if (!checked.ok) {
      this.fail(id, 'INVALID_AI_OUTPUT', checked.errors.slice(0, 5).join('; ').slice(0, 2000), ai);
      return this.get(id);
    }
    const v = checked.value;
    const limitations = [...this.standardLimitations(assignment.kind, submission.files, 'ai'), ...truncated.map((t) => `"${t}" was cut to fit the evaluation length limit.`), ...v.limitations];
    if (v.evidence.some((e) => e.type === 'excerpt' && !e.verified)) limitations.push('Some quoted evidence was not found in the submission and is marked unverified.');
    const total = Math.round(v.scores.reduce((s, x) => s + x.score, 0) * 100) / 100;
    this.db.transaction(() => {
      const skillIdByName = new Map(skills.map((s) => [s.canonicalName, s.id]));
      const allSkills = new Map(this.mastery.list().map((s) => [s.canonicalName, s.id]));
      const gapIds = v.gaps.map((g) => {
        const skillId = g.skill ? (skillIdByName.get(canonicalSkill(g.skill)) ?? allSkills.get(canonicalSkill(g.skill)) ?? null) : null;
        return this.mastery.suggestGap({ skillId, title: g.title, description: g.description, evaluationId: id }, actor).id;
      });
      const suggestions = {
        gaps: v.gaps.map((g, i) => ({ ...g, gapId: gapIds[i] })),
        levels: v.suggestedLevels.map((l) => ({ ...l, skillId: allSkills.get(canonicalSkill(l.skill)) ?? null })),
      };
      this.finish(id, { scores: v.scores, total, rubric, feedback: v.feedback, confidence: v.confidence, limitations, suggestions, ai, evidence: v.evidence });
      this.assignments.markEvaluated(submissionId);
    }).immediate();
    this.audit.record(actor, 'evaluation.complete.ai', 'evaluation', id, { total, confidence: v.confidence });
    return this.get(id);
  }

  /** The owner's own evaluation against the rubric: every criterion scored, stored as completed. */
  evaluateAsOwner(submissionId: string, dto: OwnerEvaluationDto, actor: string): Evaluation & { evidence: Evidence[] } {
    const { submission, assignment, rubric } = this.context(submissionId);
    const byKey = new Map(rubric.criteria.map((c) => [c.key, c]));
    const seen = new Set<string>();
    const scores: CriterionScore[] = [];
    const evidence: EvidenceDraft[] = [];
    for (const s of dto.scores) {
      const c = byKey.get(s.criterion);
      if (!c) throw unprocessable('INVALID_SCORES', `Unknown criterion "${s.criterion}"`);
      if (seen.has(s.criterion)) throw unprocessable('INVALID_SCORES', `Criterion "${s.criterion}" scored twice`);
      if (s.score > c.maxScore) throw unprocessable('INVALID_SCORES', `Score for "${s.criterion}" must be 0-${c.maxScore}`);
      seen.add(s.criterion);
      const score = Math.round(s.score * 100) / 100;
      scores.push({ criterion: c.key, title: c.title, score, maxScore: c.maxScore, rationale: s.note?.trim() ?? '' });
      evidence.push({ type: 'criterion_score', criterion: c.key, sourceRef: `rubric:${rubric.id}#${c.key}`, excerpt: null, hash: null, verified: true, score, note: s.note?.trim() || null, limitations: null });
    }
    const missing = rubric.criteria.filter((c) => !seen.has(c.key)).map((c) => c.key);
    if (missing.length) throw unprocessable('INVALID_SCORES', `Score every criterion (missing: ${missing.join(', ')})`);
    for (const e of dto.evidence ?? []) {
      evidence.push({ type: e.type, criterion: null, sourceRef: e.sourceRef?.trim() || `submission:${submission.id}`, excerpt: null, hash: sha256(e.note.trim()), verified: true, score: null, note: e.note.trim(), limitations: null });
    }
    const total = Math.round(scores.reduce((s, x) => s + x.score, 0) * 100) / 100;
    const limitations = [...this.standardLimitations(assignment.kind, submission.files, 'owner'), ...(dto.limitations ?? []).map((l) => l.trim()).filter(Boolean)];
    const id = randomUUID();
    const now = this.clock.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO evaluations (id, submission_id, rubric_version_id, evaluator_type, evaluator, status, requested_by, created_at)
        VALUES (?, ?, ?, 'owner', ?, 'pending', ?, ?)`).run(id, submissionId, rubric.id, actor, actor, now);
      this.finish(id, { scores, total, rubric, feedback: dto.feedback?.trim() || null, confidence: dto.confidence ?? null, limitations, suggestions: {}, ai: null, evidence });
      this.assignments.markEvaluated(submissionId);
    }).immediate();
    this.audit.record(actor, 'evaluation.complete.owner', 'evaluation', id, { submissionId, total });
    return this.get(id);
  }

  private finish(id: string, r: {
    scores: CriterionScore[]; total: number; rubric: RubricVersion; feedback: string | null; confidence: number | null; limitations: string[];
    suggestions: unknown; ai: { provider: string; model: string; inputTokens: number | null; outputTokens: number | null; costUsd: number } | null; evidence: EvidenceDraft[];
  }): void {
    const now = this.clock.now().toISOString();
    const res = this.db.prepare(`UPDATE evaluations SET status = 'completed', outcome = ?, scores = ?, total_score = ?, max_score = ?, feedback = ?, confidence = ?, limitations = ?,
        suggestions = ?, provider = ?, model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, evaluator = COALESCE(?, evaluator), completed_at = ? WHERE id = ? AND status = 'pending'`).run(
      rubricOutcome(r.total, r.rubric.passingScore, r.confidence), JSON.stringify(r.scores), r.total, r.rubric.maxScore, r.feedback, r.confidence, JSON.stringify(r.limitations),
      JSON.stringify(r.suggestions), r.ai?.provider ?? null, r.ai?.model ?? null, r.ai?.inputTokens ?? null, r.ai?.outputTokens ?? null, r.ai?.costUsd ?? null,
      r.ai ? `ai:${r.ai.provider}/${r.ai.model}` : null, now, id,
    );
    if (res.changes !== 1) throw conflict('EVALUATION_FINISHED', 'The evaluation was already finished');
    const insert = this.db.prepare(`INSERT INTO evaluation_evidence (id, evaluation_id, type, criterion, source_ref, excerpt, hash, verified, score, note, limitations, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of r.evidence) insert.run(randomUUID(), id, e.type, e.criterion, e.sourceRef, e.excerpt, e.hash, e.verified ? 1 : 0, e.score, e.note, e.limitations, now);
  }

  private fail(id: string, code: string, message: string | null, ai: { provider: string; model: string; inputTokens: number | null; outputTokens: number | null; costUsd: number } | null): void {
    this.db.prepare(`UPDATE evaluations SET status = 'failed', error_code = ?, error_message = ?, provider = ?, model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?,
        evaluator = COALESCE(?, evaluator), completed_at = ? WHERE id = ? AND status = 'pending'`).run(
      code, message, ai?.provider ?? null, ai?.model ?? null, ai?.inputTokens ?? null, ai?.outputTokens ?? null, ai?.costUsd ?? null,
      ai ? `ai:${ai.provider}/${ai.model}` : null, this.clock.now().toISOString(), id,
    );
    this.audit.record('system', 'evaluation.failed', 'evaluation', id, { code });
  }
}

const uuid = new ParseUUIDPipe({ version: '4' });

@Controller()
export class EvaluationsController {
  constructor(private readonly evaluations: EvaluationsService) {}

  @Get('evaluations')
  list(@Query('status') status?: string, @Query('limit') limit?: string) {
    if (status !== undefined && !(EVALUATION_STATUSES as readonly string[]).includes(status)) throw unprocessable('INVALID_FILTER', 'unknown evaluation status');
    const n = limit === undefined ? undefined : Number.parseInt(limit, 10);
    return { items: this.evaluations.list({ status, limit: Number.isFinite(n) ? n : undefined }), codeExecution: CODE_EXECUTION };
  }

  @Get('evaluations/:id')
  get(@Param('id', uuid) id: string) {
    return this.evaluations.get(id);
  }

  @Get('submissions/:id/evaluations')
  forSubmission(@Param('id', uuid) id: string) {
    return { items: this.evaluations.list({ submissionId: id, limit: 500 }) };
  }

  /** AI evaluation (synchronous; the record is "pending" while the provider answers). */
  @Post('submissions/:id/evaluate')
  evaluate(@Param('id', uuid) id: string, @Actor() actor: string) {
    return this.evaluations.evaluateWithAi(id, actor);
  }

  @Post('submissions/:id/evaluations')
  evaluateAsOwner(@Param('id', uuid) id: string, @Body() dto: OwnerEvaluationDto, @Actor() actor: string) {
    return this.evaluations.evaluateAsOwner(id, dto, actor);
  }
}

@Module({ imports: [AssignmentsModule, RubricsModule, MasteryModule], controllers: [EvaluationsController], providers: [EvaluationsService], exports: [EvaluationsService] })
export class EvaluationsModule {}
