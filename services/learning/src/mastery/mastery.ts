import { Body, Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.js';
import { Actor } from '../auth/auth.js';
import { Clock } from '../common/clock.js';
import { daysSince } from '../common/dates.js';
import { conflict, notFound, parseJson, unprocessable } from '../common/errors.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { canonicalSkill } from '../roadmaps/content.js';

/** A verified level older than this is shown as "needs re-check" (scheduling the re-check is L3). */
export const FRESH_DAYS = 90;

export const GAP_STATUSES = ['suggested', 'open', 'addressed', 'dismissed'] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];
/** Allowed gap status changes. AI suggestions only become real gaps when the owner opens them. */
const GAP_TRANSITIONS: Record<GapStatus, GapStatus[]> = {
  suggested: ['open', 'dismissed'],
  open: ['addressed', 'dismissed'],
  addressed: ['open'],
  dismissed: ['open'],
};

export interface SkillMastery {
  /** What the owner thinks. Never used as, or turned into, the verified level. */
  self: { level: number; note: string | null; at: string } | null;
  /** Confirmed by the owner from a completed, rubric-based evaluation with evidence. null = unverified. */
  verified: { level: number; at: string; by: string; evaluationId: string; confidence: number | null; ageDays: number; stale: boolean } | null;
}

export interface Skill {
  id: string;
  canonicalName: string;
  displayName: string;
  createdAt: string;
  mastery: SkillMastery;
  openGaps: number;
}

export interface Gap {
  id: string;
  skillId: string | null;
  title: string;
  description: string | null;
  source: 'owner' | 'ai';
  evaluationId: string | null;
  status: GapStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export class CreateSkillDto {
  @IsString() @MinLength(1) @MaxLength(100)
  name: string;
}

export class SelfAssessmentDto {
  @IsInt() @Min(0) @Max(4)
  level: number;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

export class VerifyDto {
  @IsInt() @Min(0) @Max(4)
  level: number;

  @IsUUID('4')
  evaluationId: string;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

export class CreateGapDto {
  @IsString() @MinLength(1) @MaxLength(200)
  title: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsOptional() @IsUUID('4')
  skillId?: string;
}

export class UpdateGapDto {
  @IsIn(GAP_STATUSES)
  status: GapStatus;
}

interface SkillRow { id: string; canonical_name: string; display_name: string; created_at: string }
interface MasteryRow {
  skill_id: string; self_level: number | null; self_note: string | null; self_assessed_at: string | null; verified_level: number | null;
  verified_evaluation_id: string | null; verified_by: string | null; verified_at: string | null; confidence: number | null; updated_at: string;
}
interface GapRow { id: string; skill_id: string | null; title: string; description: string | null; source: Gap['source']; evaluation_id: string | null; status: GapStatus; created_by: string; created_at: string; updated_at: string }

const toGap = (r: GapRow): Gap => ({
  id: r.id, skillId: r.skill_id, title: r.title, description: r.description, source: r.source, evaluationId: r.evaluation_id, status: r.status,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * Skills (canonical, shared by roadmaps), the owner's self-assessment, the verified level (0-4)
 * and learning gaps. Self-assessment and verified level are stored in separate columns and set
 * by separate actions; a verified level always points at the evaluation that justifies it.
 */
@Injectable()
export class MasteryService {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database, private readonly clock: Clock, private readonly audit: AuditService) {}

  list(): Skill[] {
    return (this.db.prepare('SELECT * FROM skills ORDER BY display_name COLLATE NOCASE').all() as SkillRow[]).map((r) => this.toSkill(r));
  }

  get(id: string): Skill {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined;
    if (!row) throw notFound('Skill', id);
    return this.toSkill(row);
  }

  /** The skill with its mastery history, gaps and the evaluations behind verified levels. */
  detail(id: string) {
    const skill = this.get(id);
    const history = (this.db.prepare('SELECT * FROM mastery_events WHERE skill_id = ? ORDER BY at DESC, rowid DESC').all(id) as Array<Record<string, unknown>>).map((e) => ({
      id: e.id as string, kind: e.kind as 'self' | 'verified', level: e.level as number, evaluationId: e.evaluation_id as string | null, note: e.note as string | null, actor: e.actor as string, at: e.at as string,
    }));
    const gaps = (this.db.prepare('SELECT * FROM gaps WHERE skill_id = ? ORDER BY created_at DESC').all(id) as GapRow[]).map(toGap);
    // Milestones that train this skill (where its evaluations come from).
    const milestones = (this.db.prepare('SELECT id, title, roadmap_id, status, skill_ids FROM milestones').all() as Array<{ id: string; title: string; roadmap_id: string; status: string; skill_ids: string }>)
      .filter((m) => parseJson<string[]>(m.skill_ids, []).includes(id))
      .map((m) => ({ id: m.id, title: m.title, roadmapId: m.roadmap_id, status: m.status }));
    return { skill, history, gaps, milestones, freshDays: FRESH_DAYS };
  }

  create(dto: CreateSkillDto, actor: string): Skill {
    const canonical = canonicalSkill(dto.name);
    if (!canonical) throw unprocessable('INVALID_SKILL', 'Skill name is empty');
    if (this.db.prepare('SELECT 1 FROM skills WHERE canonical_name = ?').get(canonical)) throw conflict('SKILL_EXISTS', `Skill "${canonical}" already exists`);
    const id = randomUUID();
    this.db.prepare('INSERT INTO skills (id, canonical_name, display_name, created_at) VALUES (?, ?, ?, ?)').run(id, canonical, dto.name.trim(), this.clock.now().toISOString());
    this.audit.record(actor, 'skill.create', 'skill', id, { canonical });
    return this.get(id);
  }

  /** Checks that every id is a skill (for milestones' skill lists). */
  assertSkills(ids: string[]): void {
    for (const id of ids) this.get(id);
  }

  selfAssess(id: string, dto: SelfAssessmentDto, actor: string): Skill {
    this.get(id);
    const now = this.clock.now().toISOString();
    this.db.transaction(() => {
      this.ensureRow(id, now);
      this.db.prepare('UPDATE skill_mastery SET self_level = ?, self_note = ?, self_assessed_at = ?, updated_at = ? WHERE skill_id = ?').run(dto.level, dto.note?.trim() || null, now, now, id);
      this.event(id, 'self', dto.level, null, dto.note ?? null, actor, now);
    }).immediate();
    this.audit.record(actor, 'mastery.self', 'skill', id, dto);
    return this.get(id);
  }

  /**
   * The owner confirms a verified level. It needs a completed evaluation that used a rubric, has
   * at least one evidence item, and assessed this skill (the skill is on the assignment's
   * milestone). An AI opinion alone is never enough: the owner makes this call.
   */
  verify(id: string, dto: VerifyDto, actor: string): Skill {
    this.get(id);
    const ev = this.db.prepare(`SELECT e.id, e.status, e.rubric_version_id, e.confidence, m.skill_ids
      FROM evaluations e JOIN submissions s ON s.id = e.submission_id JOIN assignments a ON a.id = s.assignment_id JOIN milestones m ON m.id = a.milestone_id
      WHERE e.id = ?`).get(dto.evaluationId) as { id: string; status: string; rubric_version_id: string | null; confidence: number | null; skill_ids: string } | undefined;
    if (!ev) throw notFound('Evaluation', dto.evaluationId);
    if (ev.status !== 'completed') throw unprocessable('EVALUATION_NOT_COMPLETED', `Evaluation is ${ev.status}; only a completed evaluation can verify a level`);
    if (!ev.rubric_version_id) throw unprocessable('EVIDENCE_REQUIRED', 'The evaluation did not use a rubric');
    const evidence = (this.db.prepare('SELECT COUNT(*) AS c FROM evaluation_evidence WHERE evaluation_id = ?').get(ev.id) as { c: number }).c;
    if (evidence === 0) throw unprocessable('EVIDENCE_REQUIRED', 'The evaluation has no evidence');
    if (!parseJson<string[]>(ev.skill_ids, []).includes(id)) throw unprocessable('SKILL_NOT_ASSESSED', "This evaluation's milestone does not train this skill");
    const now = this.clock.now().toISOString();
    this.db.transaction(() => {
      this.ensureRow(id, now);
      this.db.prepare(`UPDATE skill_mastery SET verified_level = ?, verified_evaluation_id = ?, verified_by = ?, verified_at = ?, confidence = ?, updated_at = ? WHERE skill_id = ?`)
        .run(dto.level, ev.id, actor, now, ev.confidence, now, id);
      this.event(id, 'verified', dto.level, ev.id, dto.note ?? null, actor, now);
    }).immediate();
    this.audit.record(actor, 'mastery.verify', 'skill', id, dto);
    return this.get(id);
  }

  gaps(filter: { status?: string; skillId?: string } = {}): Gap[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    } else where.push("status IN ('suggested', 'open')");
    if (filter.skillId) {
      where.push('skill_id = ?');
      args.push(filter.skillId);
    }
    return (this.db.prepare(`SELECT * FROM gaps WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC`).all(...args) as GapRow[]).map(toGap);
  }

  gap(id: string): Gap {
    const row = this.db.prepare('SELECT * FROM gaps WHERE id = ?').get(id) as GapRow | undefined;
    if (!row) throw notFound('Gap', id);
    return toGap(row);
  }

  createGap(dto: CreateGapDto, actor: string): Gap {
    if (dto.skillId) this.get(dto.skillId);
    return this.insertGap({ skillId: dto.skillId ?? null, title: dto.title.trim(), description: dto.description?.trim() || null, source: 'owner', evaluationId: null, status: 'open' }, actor);
  }

  /** AI-noticed weaknesses from an evaluation: stored as suggestions only, until the owner opens them. */
  suggestGap(g: { skillId: string | null; title: string; description: string | null; evaluationId: string }, actor: string): Gap {
    return this.insertGap({ ...g, source: 'ai', status: 'suggested' }, actor);
  }

  updateGap(id: string, dto: UpdateGapDto, actor: string): Gap {
    const gap = this.gap(id);
    if (!GAP_TRANSITIONS[gap.status].includes(dto.status)) throw conflict('INVALID_TRANSITION', `A ${gap.status} gap cannot become ${dto.status}`);
    const res = this.db.prepare('UPDATE gaps SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(dto.status, this.clock.now().toISOString(), id, gap.status);
    if (res.changes !== 1) throw conflict('INVALID_TRANSITION', 'The gap changed meanwhile');
    this.audit.record(actor, 'gap.update', 'gap', id, dto);
    return this.gap(id);
  }

  private insertGap(g: Omit<Gap, 'id' | 'createdBy' | 'createdAt' | 'updatedAt'>, actor: string): Gap {
    const id = randomUUID();
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO gaps (id, skill_id, title, description, source, evaluation_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, g.skillId, g.title, g.description, g.source, g.evaluationId, g.status, actor, now, now);
    this.audit.record(actor, `gap.create.${g.source}`, 'gap', id, { skillId: g.skillId, title: g.title });
    return this.gap(id);
  }

  private ensureRow(skillId: string, now: string): void {
    this.db.prepare('INSERT OR IGNORE INTO skill_mastery (skill_id, updated_at) VALUES (?, ?)').run(skillId, now);
  }

  private event(skillId: string, kind: 'self' | 'verified', level: number, evaluationId: string | null, note: string | null, actor: string, at: string): void {
    this.db.prepare('INSERT INTO mastery_events (id, skill_id, kind, level, evaluation_id, note, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), skillId, kind, level, evaluationId, note?.trim() || null, actor, at);
  }

  private toSkill(r: SkillRow): Skill {
    const m = this.db.prepare('SELECT * FROM skill_mastery WHERE skill_id = ?').get(r.id) as MasteryRow | undefined;
    const openGaps = (this.db.prepare("SELECT COUNT(*) AS c FROM gaps WHERE skill_id = ? AND status = 'open'").get(r.id) as { c: number }).c;
    const now = this.clock.now();
    const ageDays = m?.verified_at ? daysSince(m.verified_at, now) : 0;
    return {
      id: r.id, canonicalName: r.canonical_name, displayName: r.display_name, createdAt: r.created_at, openGaps,
      mastery: {
        self: m && m.self_level !== null ? { level: m.self_level, note: m.self_note, at: m.self_assessed_at! } : null,
        verified: m && m.verified_level !== null
          ? { level: m.verified_level, at: m.verified_at!, by: m.verified_by!, evaluationId: m.verified_evaluation_id!, confidence: m.confidence, ageDays, stale: ageDays > FRESH_DAYS }
          : null,
      },
    };
  }
}

const uuid = new ParseUUIDPipe({ version: '4' });

@Controller()
export class MasteryController {
  constructor(private readonly mastery: MasteryService) {}

  @Get('skills')
  list() {
    return { items: this.mastery.list(), freshDays: FRESH_DAYS };
  }

  @Post('skills')
  create(@Body() dto: CreateSkillDto, @Actor() actor: string) {
    return this.mastery.create(dto, actor);
  }

  @Get('skills/:id')
  detail(@Param('id', uuid) id: string) {
    return this.mastery.detail(id);
  }

  @Get('skills/:id/mastery')
  masteryOf(@Param('id', uuid) id: string) {
    return this.mastery.get(id).mastery;
  }

  @Post('skills/:id/self-assessment')
  selfAssess(@Param('id', uuid) id: string, @Body() dto: SelfAssessmentDto, @Actor() actor: string) {
    return this.mastery.selfAssess(id, dto, actor);
  }

  @Post('skills/:id/verify')
  verify(@Param('id', uuid) id: string, @Body() dto: VerifyDto, @Actor() actor: string) {
    return this.mastery.verify(id, dto, actor);
  }

  @Get('gaps')
  gaps(@Query('status') status?: string, @Query('skillId') skillId?: string) {
    if (status !== undefined && !(GAP_STATUSES as readonly string[]).includes(status)) throw unprocessable('INVALID_FILTER', 'unknown gap status');
    return { items: this.mastery.gaps({ status, skillId }) };
  }

  @Post('gaps')
  createGap(@Body() dto: CreateGapDto, @Actor() actor: string) {
    return this.mastery.createGap(dto, actor);
  }

  @Patch('gaps/:id')
  updateGap(@Param('id', uuid) id: string, @Body() dto: UpdateGapDto, @Actor() actor: string) {
    return this.mastery.updateGap(id, dto, actor);
  }
}

@Module({ controllers: [MasteryController], providers: [MasteryService], exports: [MasteryService] })
export class MasteryModule {}
