import { Body, Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.js';
import { Actor } from '../auth/auth.js';
import { Clock } from '../common/clock.js';
import { notFound, parseJson } from '../common/errors.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { DomainsModule, DomainsService } from '../domains/domains.js';

export const IDEA_STATES = ['inbox', 'triaged', 'promoted', 'archived'] as const;
export const IDEA_PRIORITIES = ['low', 'normal', 'high'] as const;
/** Controller Project Registry ids (references only; the learning service never writes projects). */
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface Idea {
  id: string;
  text: string;
  domainIds: string[];
  projectIds: string[];
  priority: (typeof IDEA_PRIORITIES)[number];
  state: (typeof IDEA_STATES)[number];
  source: 'dashboard' | 'hermes' | 'import';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export class CreateIdeaDto {
  @IsString() @MinLength(1) @MaxLength(2000)
  text: string;

  @IsOptional() @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsUUID('4', { each: true })
  domainIds?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(10) @ArrayUnique() @Matches(PROJECT_ID, { each: true })
  projectIds?: string[];

  @IsOptional() @IsIn(IDEA_PRIORITIES)
  priority?: Idea['priority'];
}

export class UpdateIdeaDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(2000)
  text?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsUUID('4', { each: true })
  domainIds?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(10) @ArrayUnique() @Matches(PROJECT_ID, { each: true })
  projectIds?: string[];

  @IsOptional() @IsIn(IDEA_PRIORITIES)
  priority?: Idea['priority'];

  @IsOptional() @IsIn(IDEA_STATES)
  state?: Idea['state'];
}

interface Row {
  id: string; text: string; domain_ids: string; project_ids: string; priority: Idea['priority']; state: Idea['state'];
  source: Idea['source']; created_by: string; created_at: string; updated_at: string;
}
const toIdea = (r: Row): Idea => ({
  id: r.id, text: r.text, domainIds: parseJson(r.domain_ids, []), projectIds: parseJson(r.project_ids, []), priority: r.priority,
  state: r.state, source: r.source, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * Quick capture. Capturing an idea never puts it on a roadmap or a schedule: an idea only
 * becomes a goal when the owner promotes it explicitly. Archive instead of delete.
 */
@Injectable()
export class IdeasService {
  constructor(
    @Inject(SQLITE_CONNECTION) private readonly db: Database,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly domains: DomainsService,
  ) {}

  list(filter: { q?: string; state?: string; domainId?: string }): Idea[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.state && (IDEA_STATES as readonly string[]).includes(filter.state)) {
      where.push('state = ?');
      params.push(filter.state);
    } else {
      where.push("state <> 'archived'");
    }
    if (filter.q) {
      where.push("text LIKE ? ESCAPE '\\'");
      params.push(`%${filter.q.slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const rows = (this.db.prepare(`SELECT * FROM ideas WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT 500`).all(...params) as Row[]).map(toIdea);
    return filter.domainId ? rows.filter((i) => i.domainIds.includes(filter.domainId!)) : rows;
  }

  get(id: string): Idea {
    const row = this.db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw notFound('Idea', id);
    return toIdea(row);
  }

  create(dto: CreateIdeaDto, actor: string, source: Idea['source'] = 'dashboard'): Idea {
    for (const d of dto.domainIds ?? []) this.domains.get(d);
    const now = this.clock.now().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO ideas (id, text, domain_ids, project_ids, priority, state, source, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'inbox', ?, ?, ?, ?)`).run(id, dto.text.trim(), JSON.stringify(dto.domainIds ?? []), JSON.stringify(dto.projectIds ?? []), dto.priority ?? 'normal', source, actor, now, now);
    this.audit.record(actor, 'idea.create', 'idea', id, dto);
    return this.get(id);
  }

  update(id: string, dto: UpdateIdeaDto, actor: string): Idea {
    const current = this.get(id);
    for (const d of dto.domainIds ?? []) this.domains.get(d);
    const next = { ...current, ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) } as Idea;
    this.db.prepare(`UPDATE ideas SET text = ?, domain_ids = ?, project_ids = ?, priority = ?, state = ?, updated_at = ? WHERE id = ?`)
      .run(next.text.trim(), JSON.stringify(next.domainIds), JSON.stringify(next.projectIds), next.priority, next.state, this.clock.now().toISOString(), id);
    this.audit.record(actor, 'idea.update', 'idea', id, dto);
    return this.get(id);
  }
}

@Controller('ideas')
export class IdeasController {
  constructor(private readonly ideas: IdeasService) {}

  @Get()
  list(@Query('q') q?: string, @Query('state') state?: string, @Query('domainId') domainId?: string) {
    return { items: this.ideas.list({ q, state, domainId }) };
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.ideas.get(id);
  }

  @Post()
  create(@Body() dto: CreateIdeaDto, @Actor() actor: string) {
    return this.ideas.create(dto, actor);
  }

  @Patch(':id')
  update(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: UpdateIdeaDto, @Actor() actor: string) {
    return this.ideas.update(id, dto, actor);
  }
}

@Module({ imports: [DomainsModule], controllers: [IdeasController], providers: [IdeasService] })
export class IdeasModule {}
