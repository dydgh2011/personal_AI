import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.js';
import { Actor } from '../auth/auth.js';
import { Clock } from '../common/clock.js';
import { CALENDAR_DATE, isCalendarDate } from '../common/dates.js';
import { conflict, notFound, parseJson, unprocessable } from '../common/errors.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { MasteryModule, MasteryService } from '../mastery/mastery.js';
import { RoadmapsModule, RoadmapsService } from '../roadmaps/roadmaps.js';
import { RubricsModule, RubricsService } from '../rubrics/rubrics.js';

export const MILESTONE_STATUSES = ['planned', 'active', 'completed', 'archived'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export interface Milestone {
  id: string;
  roadmapId: string;
  nodeKey: string | null;
  title: string;
  description: string | null;
  passingCriteria: string | null;
  rubricVersionId: string | null;
  skillIds: string[];
  weight: number;
  status: MilestoneStatus;
  /**
   * The two deadlines are kept apart on purpose. `fixed` is the owner's and changes only by an
   * owner edit (or by the owner accepting a suggestion). `suggested` comes from AI / the planner
   * and never changes `fixed` by itself.
   */
  deadline: {
    fixed: string | null;
    fixedSetBy: string | null;
    fixedSetAt: string | null;
    suggested: string | null;
    suggestedSource: 'ai' | 'planner' | null;
    suggestedReason: string | null;
    suggestedAt: string | null;
  };
  assignments: { total: number; passed: number; open: number };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class CreateMilestoneDto {
  @IsUUID('4')
  roadmapId: string;

  @IsString() @MinLength(1) @MaxLength(200)
  title: string;

  @IsOptional() @IsString() @MaxLength(4000)
  description?: string;

  @IsOptional() @IsString() @MaxLength(4000)
  passingCriteria?: string;

  @IsOptional() @Matches(KEY)
  nodeKey?: string;

  @IsOptional() @IsUUID('4')
  rubricVersionId?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('4', { each: true })
  skillIds?: string[];

  @IsOptional() @IsInt() @Min(0) @Max(100)
  weight?: number;

  @IsOptional() @Matches(CALENDAR_DATE)
  fixedDeadline?: string;

  @IsOptional() @IsIn(['planned', 'active'])
  status?: 'planned' | 'active';
}

export class UpdateMilestoneDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200)
  title?: string;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(4000)
  description?: string | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(4000)
  passingCriteria?: string | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @Matches(KEY)
  nodeKey?: string | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID('4')
  rubricVersionId?: string | null;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('4', { each: true })
  skillIds?: string[];

  @IsOptional() @IsInt() @Min(0) @Max(100)
  weight?: number;

  /** Owner edit of the fixed deadline; null clears it. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Matches(CALENDAR_DATE)
  fixedDeadline?: string | null;

  @IsOptional() @IsIn(MILESTONE_STATUSES)
  status?: MilestoneStatus;
}

/** From AI or (L3) the planner. Stored next to the fixed deadline, never over it. */
export class SuggestDeadlineDto {
  @Matches(CALENDAR_DATE)
  date: string;

  @IsIn(['ai', 'planner'])
  source: 'ai' | 'planner';

  @IsOptional() @IsString() @MaxLength(1000)
  reason?: string;
}

/** The owner adopts the suggestion they saw (must still be the current one). */
export class AcceptSuggestionDto {
  @Matches(CALENDAR_DATE)
  date: string;
}

interface Row {
  id: string; roadmap_id: string; node_key: string | null; title: string; description: string | null; passing_criteria: string | null; rubric_version_id: string | null;
  skill_ids: string; weight: number; status: MilestoneStatus; fixed_deadline: string | null; fixed_deadline_set_by: string | null; fixed_deadline_set_at: string | null;
  suggested_deadline: string | null; suggested_deadline_source: 'ai' | 'planner' | null; suggested_deadline_reason: string | null; suggested_at: string | null;
  created_by: string; created_at: string; updated_at: string;
}

@Injectable()
export class MilestonesService {
  constructor(
    @Inject(SQLITE_CONNECTION) private readonly db: Database,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly roadmaps: RoadmapsService,
    private readonly rubrics: RubricsService,
    private readonly mastery: MasteryService,
  ) {}

  list(filter: { roadmapId?: string; status?: string } = {}): Milestone[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.roadmapId) {
      where.push('roadmap_id = ?');
      args.push(filter.roadmapId);
    }
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    const sql = `SELECT * FROM milestones ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE status WHEN 'archived' THEN 1 ELSE 0 END, COALESCE(fixed_deadline, suggested_deadline, '9999-12-31'), created_at`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => this.toMilestone(r));
  }

  get(id: string): Milestone {
    const row = this.db.prepare('SELECT * FROM milestones WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw notFound('Milestone', id);
    return this.toMilestone(row);
  }

  /**
   * Roadmap progress = completed milestone weight / total weight (archived excluded). With no
   * milestones or no weight it is "not computable" (null), never a made-up number.
   */
  progress(roadmapId: string): { weightTotal: number; weightCompleted: number; percent: number | null; milestones: number } {
    const rows = this.db.prepare("SELECT weight, status FROM milestones WHERE roadmap_id = ? AND status <> 'archived'").all(roadmapId) as Array<{ weight: number; status: string }>;
    const weightTotal = rows.reduce((s, r) => s + r.weight, 0);
    const weightCompleted = rows.filter((r) => r.status === 'completed').reduce((s, r) => s + r.weight, 0);
    return { weightTotal, weightCompleted, percent: weightTotal > 0 ? Math.round((weightCompleted / weightTotal) * 1000) / 10 : null, milestones: rows.length };
  }

  create(dto: CreateMilestoneDto, actor: string): Milestone {
    this.roadmaps.get(dto.roadmapId);
    this.checkRefs(dto.roadmapId, dto);
    if (dto.fixedDeadline !== undefined && !isCalendarDate(dto.fixedDeadline)) throw unprocessable('INVALID_DATE', `${dto.fixedDeadline} is not a calendar date`);
    const id = randomUUID();
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO milestones (id, roadmap_id, node_key, title, description, passing_criteria, rubric_version_id, skill_ids, weight, status,
        fixed_deadline, fixed_deadline_set_by, fixed_deadline_set_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, dto.roadmapId, dto.nodeKey ?? null, dto.title.trim(), dto.description?.trim() || null, dto.passingCriteria?.trim() || null, dto.rubricVersionId ?? null,
      JSON.stringify([...new Set(dto.skillIds ?? [])]), dto.weight ?? 1, dto.status ?? 'planned',
      dto.fixedDeadline ?? null, dto.fixedDeadline ? actor : null, dto.fixedDeadline ? now : null, actor, now, now,
    );
    this.audit.record(actor, 'milestone.create', 'milestone', id, dto);
    return this.get(id);
  }

  update(id: string, dto: UpdateMilestoneDto, actor: string): Milestone {
    const m = this.get(id);
    this.checkRefs(m.roadmapId, dto);
    if (dto.fixedDeadline && !isCalendarDate(dto.fixedDeadline)) throw unprocessable('INVALID_DATE', `${dto.fixedDeadline} is not a calendar date`);
    if (dto.status === 'completed' && m.status !== 'completed') {
      const open = this.db.prepare("SELECT status FROM assignments WHERE milestone_id = ? AND status <> 'archived'").all(id) as Array<{ status: string }>;
      if (open.length === 0) throw conflict('MILESTONE_NOT_READY', 'A milestone with no assignments cannot be completed');
      if (open.some((a) => a.status !== 'passed')) throw conflict('MILESTONE_NOT_READY', 'Every assignment of the milestone must be passed first');
    }
    const now = this.clock.now().toISOString();
    const deadlineChanged = dto.fixedDeadline !== undefined && dto.fixedDeadline !== m.deadline.fixed;
    const pick = <T>(v: T | undefined, current: T) => (v === undefined ? current : v);
    this.db.prepare(`UPDATE milestones SET title = ?, description = ?, passing_criteria = ?, node_key = ?, rubric_version_id = ?, skill_ids = ?, weight = ?, status = ?,
        fixed_deadline = ?, fixed_deadline_set_by = ?, fixed_deadline_set_at = ?, updated_at = ? WHERE id = ?`).run(
      dto.title?.trim() ?? m.title, pick(dto.description, m.description), pick(dto.passingCriteria, m.passingCriteria), pick(dto.nodeKey, m.nodeKey),
      pick(dto.rubricVersionId, m.rubricVersionId), JSON.stringify(dto.skillIds ? [...new Set(dto.skillIds)] : m.skillIds), dto.weight ?? m.weight, dto.status ?? m.status,
      deadlineChanged ? dto.fixedDeadline : m.deadline.fixed, deadlineChanged ? actor : m.deadline.fixedSetBy, deadlineChanged ? now : m.deadline.fixedSetAt, now, id,
    );
    this.audit.record(actor, deadlineChanged ? 'milestone.update.fixed_deadline' : 'milestone.update', 'milestone', id, dto);
    return this.get(id);
  }

  /** Stores a suggested deadline. The fixed deadline is not read or written here. */
  suggestDeadline(id: string, dto: SuggestDeadlineDto, actor: string): Milestone {
    this.get(id);
    if (!isCalendarDate(dto.date)) throw unprocessable('INVALID_DATE', `${dto.date} is not a calendar date`);
    this.db.prepare(`UPDATE milestones SET suggested_deadline = ?, suggested_deadline_source = ?, suggested_deadline_reason = ?, suggested_at = ?, updated_at = ? WHERE id = ?`)
      .run(dto.date, dto.source, dto.reason?.trim() || null, this.clock.now().toISOString(), this.clock.now().toISOString(), id);
    this.audit.record(actor, `milestone.suggest_deadline.${dto.source}`, 'milestone', id, dto);
    return this.get(id);
  }

  /** The owner adopts the suggestion as their fixed deadline (explicit, never automatic). */
  acceptSuggestion(id: string, dto: AcceptSuggestionDto, actor: string): Milestone {
    const m = this.get(id);
    if (!m.deadline.suggested) throw conflict('NO_SUGGESTION', 'There is no suggested deadline');
    if (m.deadline.suggested !== dto.date) throw conflict('SUGGESTION_CHANGED', `The suggestion is now ${m.deadline.suggested}`);
    const now = this.clock.now().toISOString();
    this.db.prepare(`UPDATE milestones SET fixed_deadline = ?, fixed_deadline_set_by = ?, fixed_deadline_set_at = ?, suggested_deadline = NULL, suggested_deadline_source = NULL,
        suggested_deadline_reason = NULL, suggested_at = NULL, updated_at = ? WHERE id = ? AND suggested_deadline = ?`).run(dto.date, actor, now, now, id, dto.date);
    this.audit.record(actor, 'milestone.accept_suggested_deadline', 'milestone', id, { from: m.deadline.fixed, to: dto.date, source: m.deadline.suggestedSource });
    return this.get(id);
  }

  dismissSuggestion(id: string, actor: string): Milestone {
    const m = this.get(id);
    if (!m.deadline.suggested) throw conflict('NO_SUGGESTION', 'There is no suggested deadline');
    this.db.prepare(`UPDATE milestones SET suggested_deadline = NULL, suggested_deadline_source = NULL, suggested_deadline_reason = NULL, suggested_at = NULL, updated_at = ? WHERE id = ?`)
      .run(this.clock.now().toISOString(), id);
    this.audit.record(actor, 'milestone.dismiss_suggested_deadline', 'milestone', id, { suggested: m.deadline.suggested });
    return this.get(id);
  }

  /** Node key must exist in the roadmap's current version; rubric version and skills must exist. */
  private checkRefs(roadmapId: string, dto: { nodeKey?: string | null; rubricVersionId?: string | null; skillIds?: string[] }): void {
    if (dto.nodeKey) {
      const detail = this.roadmaps.detail(roadmapId);
      if (!detail.current) throw unprocessable('UNKNOWN_NODE', 'The roadmap has no approved version yet; link a node after approving one');
      if (!detail.current.content.nodes.some((n) => n.key === dto.nodeKey)) throw unprocessable('UNKNOWN_NODE', `Node "${dto.nodeKey}" is not in the current roadmap version`);
    }
    if (dto.rubricVersionId) this.rubrics.version(dto.rubricVersionId);
    if (dto.skillIds) this.mastery.assertSkills(dto.skillIds);
  }

  private toMilestone(r: Row): Milestone {
    const counts = this.db.prepare(`SELECT COUNT(*) AS total, SUM(status = 'passed') AS passed, SUM(status NOT IN ('passed', 'archived')) AS open
      FROM assignments WHERE milestone_id = ? AND status <> 'archived'`).get(r.id) as { total: number; passed: number | null; open: number | null };
    return {
      id: r.id, roadmapId: r.roadmap_id, nodeKey: r.node_key, title: r.title, description: r.description, passingCriteria: r.passing_criteria,
      rubricVersionId: r.rubric_version_id, skillIds: parseJson(r.skill_ids, []), weight: r.weight, status: r.status,
      deadline: {
        fixed: r.fixed_deadline, fixedSetBy: r.fixed_deadline_set_by, fixedSetAt: r.fixed_deadline_set_at,
        suggested: r.suggested_deadline, suggestedSource: r.suggested_deadline_source, suggestedReason: r.suggested_deadline_reason, suggestedAt: r.suggested_at,
      },
      assignments: { total: counts.total, passed: counts.passed ?? 0, open: counts.open ?? 0 },
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
}

const uuid = new ParseUUIDPipe({ version: '4' });

@Controller('milestones')
export class MilestonesController {
  constructor(private readonly milestones: MilestonesService) {}

  @Get()
  list(@Query('roadmapId') roadmapId?: string, @Query('status') status?: string) {
    if (status !== undefined && !(MILESTONE_STATUSES as readonly string[]).includes(status)) throw unprocessable('INVALID_FILTER', 'unknown milestone status');
    const items = this.milestones.list({ roadmapId, status });
    return { items, progress: roadmapId ? this.milestones.progress(roadmapId) : null };
  }

  @Post()
  create(@Body() dto: CreateMilestoneDto, @Actor() actor: string) {
    return this.milestones.create(dto, actor);
  }

  @Get(':id')
  get(@Param('id', uuid) id: string) {
    return this.milestones.get(id);
  }

  @Patch(':id')
  update(@Param('id', uuid) id: string, @Body() dto: UpdateMilestoneDto, @Actor() actor: string) {
    return this.milestones.update(id, dto, actor);
  }

  @Post(':id/suggested-deadline')
  @HttpCode(200)
  suggest(@Param('id', uuid) id: string, @Body() dto: SuggestDeadlineDto, @Actor() actor: string) {
    return this.milestones.suggestDeadline(id, dto, actor);
  }

  @Post(':id/suggested-deadline/accept')
  @HttpCode(200)
  accept(@Param('id', uuid) id: string, @Body() dto: AcceptSuggestionDto, @Actor() actor: string) {
    return this.milestones.acceptSuggestion(id, dto, actor);
  }

  @Post(':id/suggested-deadline/dismiss')
  @HttpCode(200)
  dismiss(@Param('id', uuid) id: string, @Actor() actor: string) {
    return this.milestones.dismissSuggestion(id, actor);
  }
}

@Module({ imports: [RoadmapsModule, RubricsModule, MasteryModule], controllers: [MilestonesController], providers: [MilestonesService], exports: [MilestonesService] })
export class MilestonesModule {}
