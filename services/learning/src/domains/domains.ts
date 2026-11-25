import { Body, Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.js';
import { Actor, AllowBroker } from '../auth/auth.js';
import { Clock } from '../common/clock.js';
import { notFound, unprocessable } from '../common/errors.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';

export const DOMAIN_STATUSES = ['exploring', 'planned', 'active', 'paused', 'maintaining', 'archived'] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export interface LearningDomain {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
  status: DomainStatus;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export class CreateDomainDto {
  @IsString() @MinLength(1) @MaxLength(120)
  title: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsOptional() @IsUUID('4')
  parentId?: string;

  @IsOptional() @IsIn(DOMAIN_STATUSES)
  status?: DomainStatus;

  @IsOptional() @IsInt() @Min(1) @Max(5)
  priority?: number;
}

export class UpdateDomainDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  title?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  /** null moves the domain to the top level. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID('4')
  parentId?: string | null;

  @IsOptional() @IsIn(DOMAIN_STATUSES)
  status?: DomainStatus;

  @IsOptional() @IsInt() @Min(1) @Max(5)
  priority?: number;
}

interface Row {
  id: string; parent_id: string | null; title: string; description: string | null; status: DomainStatus; priority: number; created_at: string; updated_at: string;
}
const toDomain = (r: Row): LearningDomain => ({
  id: r.id, parentId: r.parent_id, title: r.title, description: r.description, status: r.status, priority: r.priority, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * Learning areas and sub-areas. There is no delete: "archived" keeps the history (goals,
 * roadmaps and ideas keep pointing at it).
 */
@Injectable()
export class DomainsService {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database, private readonly clock: Clock, private readonly audit: AuditService) {}

  list(status?: string): LearningDomain[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM domains WHERE status = ? ORDER BY priority DESC, title').all(status)
      : this.db.prepare('SELECT * FROM domains ORDER BY priority DESC, title').all();
    return (rows as Row[]).map(toDomain);
  }

  get(id: string): LearningDomain {
    const row = this.db.prepare('SELECT * FROM domains WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw notFound('Domain', id);
    return toDomain(row);
  }

  create(dto: CreateDomainDto, actor: string): LearningDomain {
    if (dto.parentId) this.get(dto.parentId);
    const now = this.clock.now().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO domains (id, parent_id, title, description, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, dto.parentId ?? null, dto.title.trim(), dto.description ?? null, dto.status ?? 'exploring', dto.priority ?? 3, now, now);
    this.audit.record(actor, 'domain.create', 'domain', id, dto);
    return this.get(id);
  }

  update(id: string, dto: UpdateDomainDto, actor: string): LearningDomain {
    const current = this.get(id);
    if (dto.parentId !== undefined && dto.parentId !== null) {
      this.get(dto.parentId);
      // Walking up from the new parent must never reach this domain (no direct or indirect cycle).
      let cursor: string | null = dto.parentId;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor === id) throw unprocessable('DOMAIN_CYCLE', 'A domain cannot be placed under itself or one of its sub-domains');
        if (seen.has(cursor)) break;
        seen.add(cursor);
        cursor = (this.db.prepare('SELECT parent_id FROM domains WHERE id = ?').get(cursor) as { parent_id: string | null } | undefined)?.parent_id ?? null;
      }
    }
    const next = { ...current, ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) } as LearningDomain;
    this.db.prepare(`UPDATE domains SET parent_id = ?, title = ?, description = ?, status = ?, priority = ?, updated_at = ? WHERE id = ?`)
      .run(next.parentId, next.title.trim(), next.description, next.status, next.priority, this.clock.now().toISOString(), id);
    this.audit.record(actor, 'domain.update', 'domain', id, dto);
    return this.get(id);
  }
}

@Controller('domains')
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @AllowBroker()
  @Get()
  list(@Query('status') status?: string) {
    return { items: this.domains.list(DOMAIN_STATUSES.includes(status as DomainStatus) ? status : undefined) };
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.domains.get(id);
  }

  @Post()
  create(@Body() dto: CreateDomainDto, @Actor() actor: string) {
    return this.domains.create(dto, actor);
  }

  @Patch(':id')
  update(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: UpdateDomainDto, @Actor() actor: string) {
    return this.domains.update(id, dto, actor);
  }
}

@Module({ controllers: [DomainsController], providers: [DomainsService], exports: [DomainsService] })
export class DomainsModule {}
