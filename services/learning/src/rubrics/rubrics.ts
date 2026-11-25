import { Body, Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.js';
import { Actor } from '../auth/auth.js';
import { Clock } from '../common/clock.js';
import { conflict, notFound, parseJson, unprocessable } from '../common/errors.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';

/** One scoring criterion. `key` is stable across versions so evaluations can be compared. */
export interface RubricCriterion {
  key: string;
  title: string;
  description: string | null;
  maxScore: number;
}

export interface RubricVersion {
  id: string;
  rubricId: string;
  version: number;
  criteria: RubricCriterion[];
  passingScore: number;
  maxScore: number;
  contentHash: string;
  createdBy: string;
  createdAt: string;
}

export interface Rubric {
  id: string;
  title: string;
  status: 'active' | 'archived';
  latestVersion: RubricVersion | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export class CriterionDto {
  @Matches(/^[a-z0-9][a-z0-9_-]{0,39}$/)
  key: string;

  @IsString() @MinLength(1) @MaxLength(200)
  title: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0.5) @Max(100)
  maxScore: number;
}

export class RubricContentDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => CriterionDto)
  criteria: CriterionDto[];

  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0)
  passingScore: number;
}

export class CreateRubricDto extends RubricContentDto {
  @IsString() @MinLength(1) @MaxLength(200)
  title: string;
}

/** A new version, based on the version the owner edited (optimistic lock). */
export class RubricVersionDto extends RubricContentDto {
  @IsInt() @Min(1)
  baseVersion: number;
}

export class UpdateRubricDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200)
  title?: string;

  @IsOptional() @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';
}


interface VersionRow { id: string; rubric_id: string; version: number; criteria: string; passing_score: number; max_score: number; content_hash: string; created_by: string; created_at: string }
interface RubricRow { id: string; title: string; status: Rubric['status']; created_by: string; created_at: string; updated_at: string }

export const toRubricVersion = (r: VersionRow): RubricVersion => ({
  id: r.id, rubricId: r.rubric_id, version: r.version, criteria: parseJson(r.criteria, []), passingScore: r.passing_score, maxScore: r.max_score,
  contentHash: r.content_hash, createdBy: r.created_by, createdAt: r.created_at,
});

/** Validates criteria (unique keys, passing score reachable) and returns the normalized content + hash. */
export function normalizeRubric(dto: RubricContentDto): { criteria: RubricCriterion[]; passingScore: number; maxScore: number; hash: string } {
  const keys = new Set<string>();
  const criteria = dto.criteria.map((c) => {
    if (keys.has(c.key)) throw unprocessable('INVALID_RUBRIC', `criterion key "${c.key}" is duplicated`);
    keys.add(c.key);
    return { key: c.key, title: c.title.trim(), description: c.description?.trim() || null, maxScore: Math.round(c.maxScore * 100) / 100 };
  });
  const maxScore = Math.round(criteria.reduce((s, c) => s + c.maxScore, 0) * 100) / 100;
  const passingScore = Math.round(dto.passingScore * 100) / 100;
  if (passingScore > maxScore) throw unprocessable('INVALID_RUBRIC', `passingScore ${passingScore} is higher than the maximum ${maxScore}`);
  const hash = createHash('sha256').update(JSON.stringify({ criteria, passingScore })).digest('hex');
  return { criteria, passingScore, maxScore, hash };
}

/**
 * Rubrics and their immutable versions. Editing a rubric creates a new version; milestones,
 * assignments and evaluations keep pointing at the exact version they were made with.
 */
@Injectable()
export class RubricsService {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database, private readonly clock: Clock, private readonly audit: AuditService) {}

  list(): Rubric[] {
    return (this.db.prepare('SELECT * FROM rubrics ORDER BY status, created_at DESC').all() as RubricRow[]).map((r) => this.toRubric(r));
  }

  get(id: string): Rubric & { versions: RubricVersion[] } {
    const row = this.db.prepare('SELECT * FROM rubrics WHERE id = ?').get(id) as RubricRow | undefined;
    if (!row) throw notFound('Rubric', id);
    const versions = (this.db.prepare('SELECT * FROM rubric_versions WHERE rubric_id = ? ORDER BY version DESC').all(id) as VersionRow[]).map(toRubricVersion);
    return { ...this.toRubric(row), versions };
  }

  version(versionId: string): RubricVersion {
    const row = this.db.prepare('SELECT * FROM rubric_versions WHERE id = ?').get(versionId) as VersionRow | undefined;
    if (!row) throw notFound('Rubric version', versionId);
    return toRubricVersion(row);
  }

  create(dto: CreateRubricDto, actor: string): Rubric {
    const content = normalizeRubric(dto);
    const id = randomUUID();
    const now = this.clock.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO rubrics (id, title, status, created_by, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)`).run(id, dto.title.trim(), actor, now, now);
      this.insertVersion(id, 1, content, actor, now);
    }).immediate();
    this.audit.record(actor, 'rubric.create', 'rubric', id, content);
    return this.toRubric(this.db.prepare('SELECT * FROM rubrics WHERE id = ?').get(id) as RubricRow);
  }

  addVersion(id: string, dto: RubricVersionDto, actor: string): RubricVersion {
    const rubric = this.get(id);
    const content = normalizeRubric(dto);
    const latest = rubric.latestVersion!;
    if (dto.baseVersion !== latest.version) throw conflict('VERSION_CONFLICT', `The rubric is at version ${latest.version}; you edited version ${dto.baseVersion}`);
    if (latest.contentHash === content.hash) throw conflict('NO_CHANGES', 'The new version is identical to the latest one');
    const now = this.clock.now().toISOString();
    const versionId = this.db.transaction(() => {
      const vid = this.insertVersion(id, latest.version + 1, content, actor, now);
      this.db.prepare('UPDATE rubrics SET updated_at = ? WHERE id = ?').run(now, id);
      return vid;
    }).immediate();
    this.audit.record(actor, 'rubric.version', 'rubric', id, { version: latest.version + 1, hash: content.hash });
    return this.version(versionId);
  }

  update(id: string, dto: UpdateRubricDto, actor: string): Rubric {
    const current = this.get(id);
    this.db.prepare('UPDATE rubrics SET title = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(dto.title?.trim() ?? current.title, dto.status ?? current.status, this.clock.now().toISOString(), id);
    this.audit.record(actor, 'rubric.update', 'rubric', id, dto);
    return this.get(id);
  }

  private insertVersion(rubricId: string, version: number, c: ReturnType<typeof normalizeRubric>, actor: string, at: string): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO rubric_versions (id, rubric_id, version, criteria, passing_score, max_score, content_hash, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, rubricId, version, JSON.stringify(c.criteria), c.passingScore, c.maxScore, c.hash, actor, at);
    return id;
  }

  private toRubric(r: RubricRow): Rubric {
    const latest = this.db.prepare('SELECT * FROM rubric_versions WHERE rubric_id = ? ORDER BY version DESC LIMIT 1').get(r.id) as VersionRow | undefined;
    return { id: r.id, title: r.title, status: r.status, latestVersion: latest ? toRubricVersion(latest) : null, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at };
  }
}

const uuid = new ParseUUIDPipe({ version: '4' });

@Controller('rubrics')
export class RubricsController {
  constructor(private readonly rubrics: RubricsService) {}

  @Get()
  list() {
    return { items: this.rubrics.list() };
  }

  @Post()
  create(@Body() dto: CreateRubricDto, @Actor() actor: string) {
    return this.rubrics.create(dto, actor);
  }

  @Get('versions/:versionId')
  version(@Param('versionId', uuid) versionId: string) {
    return this.rubrics.version(versionId);
  }

  @Get(':id')
  get(@Param('id', uuid) id: string) {
    return this.rubrics.get(id);
  }

  @Patch(':id')
  update(@Param('id', uuid) id: string, @Body() dto: UpdateRubricDto, @Actor() actor: string) {
    return this.rubrics.update(id, dto, actor);
  }

  @Post(':id/versions')
  addVersion(@Param('id', uuid) id: string, @Body() dto: RubricVersionDto, @Actor() actor: string) {
    return this.rubrics.addVersion(id, dto, actor);
  }
}

@Module({ controllers: [RubricsController], providers: [RubricsService], exports: [RubricsService] })
export class RubricsModule {}
