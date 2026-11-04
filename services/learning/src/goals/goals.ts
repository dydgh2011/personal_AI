import { Body, Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.js';
import { Actor } from '../auth/auth.js';
import { Clock } from '../common/clock.js';
import { notFound, parseJson } from '../common/errors.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { DomainsModule, DomainsService } from '../domains/domains.js';

export const GOAL_STATUSES = ['active', 'paused', 'achieved', 'abandoned'] as const;

/** Owner-provided constraints. `deadline` is user-fixed: nothing but an owner edit changes it. */
export class GoalConstraintsDto {
  @IsOptional() @IsInt() @Min(0) @Max(10080)
  weeklyMinutes?: number;

  @IsOptional() @IsISO8601({ strict: true })
  deadline?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  priorKnowledge?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  equipment?: string;
}

export interface LearningGoal {
  id: string;
  domainId: string;
  title: string;
  target: string | null;
  targetLevel: number | null;
  constraints: { weeklyMinutes?: number; deadline?: string; priorKnowledge?: string; equipment?: string };
  status: (typeof GOAL_STATUSES)[number];
  createdAt: string;
  updatedAt: string;
}

export class CreateGoalDto {
  @IsUUID('4')
  domainId: string;

  @IsString() @MinLength(1) @MaxLength(200)
  title: string;

  @IsOptional() @IsString() @MaxLength(2000)
  target?: string;

  @IsOptional() @IsInt() @Min(0) @Max(4)
  targetLevel?: number;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => GoalConstraintsDto)
  constraints?: GoalConstraintsDto;
}

export class UpdateGoalDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200)
  title?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  target?: string;

  @IsOptional() @IsInt() @Min(0) @Max(4)
  targetLevel?: number;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => GoalConstraintsDto)
  constraints?: GoalConstraintsDto;

  @IsOptional() @IsIn(GOAL_STATUSES)
  status?: LearningGoal['status'];
}

interface Row {
  id: string; domain_id: string; title: string; target: string | null; target_level: number | null; constraints: string;
  status: LearningGoal['status']; created_at: string; updated_at: string;
}
const toGoal = (r: Row): LearningGoal => ({
  id: r.id, domainId: r.domain_id, title: r.title, target: r.target, targetLevel: r.target_level,
  constraints: parseJson(r.constraints, {}), status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
});

@Injectable()
export class GoalsService {
  constructor(
    @Inject(SQLITE_CONNECTION) private readonly db: Database,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly domains: DomainsService,
  ) {}

  list(domainId?: string): LearningGoal[] {
    const rows = domainId
      ? this.db.prepare('SELECT * FROM goals WHERE domain_id = ? ORDER BY created_at DESC').all(domainId)
      : this.db.prepare('SELECT * FROM goals ORDER BY created_at DESC').all();
    return (rows as Row[]).map(toGoal);
  }

  get(id: string): LearningGoal {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw notFound('Goal', id);
    return toGoal(row);
  }

  create(dto: CreateGoalDto, actor: string): LearningGoal {
    this.domains.get(dto.domainId);
    const now = this.clock.now().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO goals (id, domain_id, title, target, target_level, constraints, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(id, dto.domainId, dto.title.trim(), dto.target ?? null, dto.targetLevel ?? null, JSON.stringify(dto.constraints ?? {}), now, now);
    this.audit.record(actor, 'goal.create', 'goal', id, dto);
    return this.get(id);
  }

  update(id: string, dto: UpdateGoalDto, actor: string): LearningGoal {
    const current = this.get(id);
    const next = { ...current, ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) } as LearningGoal;
    this.db.prepare(`UPDATE goals SET title = ?, target = ?, target_level = ?, constraints = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(next.title.trim(), next.target, next.targetLevel, JSON.stringify(next.constraints ?? {}), next.status, this.clock.now().toISOString(), id);
    this.audit.record(actor, 'goal.update', 'goal', id, dto);
    return this.get(id);
  }
}

@Controller('goals')
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  list(@Query('domainId') domainId?: string) {
    return { items: this.goals.list(domainId) };
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.goals.get(id);
  }

  @Post()
  create(@Body() dto: CreateGoalDto, @Actor() actor: string) {
    return this.goals.create(dto, actor);
  }

  @Patch(':id')
  update(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: UpdateGoalDto, @Actor() actor: string) {
    return this.goals.update(id, dto, actor);
  }
}

@Module({ imports: [DomainsModule], controllers: [GoalsController], providers: [GoalsService], exports: [GoalsService] })
export class GoalsModule {}
