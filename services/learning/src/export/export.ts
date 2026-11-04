import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Post } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { IsArray, IsIn, IsInt, IsISO8601, IsObject, IsString } from 'class-validator';
import { AuditService } from '../audit/audit.js';
import { Actor } from '../auth/auth.js';
import { Clock } from '../common/clock.js';
import { conflict, unprocessable } from '../common/errors.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { contentHash, validateContent } from '../roadmaps/content.js';

export const SCHEMA_VERSION = 1;

/** Full JSON export: every id, version, provenance and relation, so it can be imported back. */
export class ImportDto {
  @IsIn(['personal-ai-learning'])
  app: 'personal-ai-learning';

  @IsInt()
  schemaVersion: number;

  @IsISO8601()
  exportedAt: string;

  @IsArray() domains: Array<Record<string, unknown>>;
  @IsArray() ideas: Array<Record<string, unknown>>;
  @IsArray() goals: Array<Record<string, unknown>>;
  @IsArray() roadmaps: Array<Record<string, unknown>>;
  @IsArray() versions: Array<Record<string, unknown>>;
  @IsArray() proposals: Array<Record<string, unknown>>;
  @IsArray() skills: Array<Record<string, unknown>>;
  @IsObject() counts: Record<string, number>;
  @IsString() note: string;
}

const TABLES = ['domains', 'ideas', 'goals', 'skills', 'roadmaps', 'roadmap_versions', 'ai_proposals'] as const;

@Injectable()
export class ExportService {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database, private readonly clock: Clock, private readonly audit: AuditService) {}

  export(actor: string) {
    const all = (table: string) => this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    const data = {
      app: 'personal-ai-learning' as const,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: this.clock.now().toISOString(),
      note: 'Rows are exported as stored (snake_case columns). roadmap_versions.content is the immutable version content; content_hash is sha256 of it.',
      domains: all('domains'),
      ideas: all('ideas'),
      goals: all('goals'),
      skills: all('skills'),
      roadmaps: all('roadmaps'),
      versions: all('roadmap_versions'),
      proposals: all('ai_proposals'),
      counts: {} as Record<string, number>,
    };
    for (const k of ['domains', 'ideas', 'goals', 'skills', 'roadmaps', 'versions', 'proposals'] as const) data.counts[k] = data[k].length;
    this.audit.record(actor, 'export', 'learning', 'all', data.counts);
    return data;
  }

  /**
   * Restores an export into an EMPTY learning database (new install / disaster recovery). Ids and
   * versions are kept; every version's content is re-validated and its hash re-checked, and
   * nodes/edges/skills are rebuilt from the content. Refused if any learning data exists.
   */
  import(dto: ImportDto, actor: string) {
    if (dto.schemaVersion !== SCHEMA_VERSION) throw unprocessable('UNSUPPORTED_SCHEMA', `schemaVersion ${dto.schemaVersion} is not supported (expected ${SCHEMA_VERSION})`);
    const existing = TABLES.reduce((n, t) => n + (this.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c, 0);
    if (existing > 0) throw conflict('NOT_EMPTY', 'Import only restores into an empty learning database');
    const problems: string[] = [];
    for (const v of dto.versions) {
      const checked = validateContent(JSON.parse(String(v.content ?? 'null')));
      if (!checked.ok) problems.push(`version ${String(v.id)}: ${checked.errors[0]}`);
      else if (contentHash(checked.content!) !== v.content_hash) problems.push(`version ${String(v.id)}: content hash does not match`);
    }
    if (problems.length) throw unprocessable('INVALID_IMPORT', problems[0], { errors: problems.slice(0, 20) });

    const insert = (table: string, rows: Array<Record<string, unknown>>, columns: string[]) => {
      const stmt = this.db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`);
      for (const r of rows) stmt.run(Object.fromEntries(columns.map((c) => [c, r[c] ?? null])));
    };
    this.db.transaction(() => {
      // parents before children (domains can nest)
      const domains = [...dto.domains];
      const placed = new Set<unknown>();
      const ordered: typeof domains = [];
      while (domains.length) {
        const i = domains.findIndex((d) => !d.parent_id || placed.has(d.parent_id));
        if (i < 0) throw unprocessable('INVALID_IMPORT', 'domain hierarchy is broken');
        placed.add(domains[i].id);
        ordered.push(...domains.splice(i, 1));
      }
      insert('domains', ordered, ['id', 'parent_id', 'title', 'description', 'status', 'priority', 'created_at', 'updated_at']);
      insert('ideas', dto.ideas, ['id', 'text', 'domain_ids', 'project_ids', 'priority', 'state', 'source', 'created_by', 'created_at', 'updated_at']);
      insert('goals', dto.goals, ['id', 'domain_id', 'title', 'target', 'target_level', 'constraints', 'status', 'created_at', 'updated_at']);
      insert('skills', dto.skills, ['id', 'canonical_name', 'display_name', 'created_at']);
      insert('roadmaps', dto.roadmaps.map((r) => ({ ...r, current_version_id: null })), ['id', 'goal_id', 'title', 'status', 'current_version_id', 'created_at', 'updated_at']);
      insert('roadmap_versions', dto.versions, ['id', 'roadmap_id', 'version', 'content', 'content_hash', 'proposal_id', 'approved_by', 'approved_at']);
      insert('ai_proposals', dto.proposals, ['id', 'roadmap_id', 'source', 'base_version_id', 'state', 'payload', 'validation_errors', 'input', 'provider', 'model', 'prompt_version',
        'input_tokens', 'output_tokens', 'cost_usd', 'created_by', 'created_at', 'decided_by', 'decided_at', 'applied_version_id']);
      for (const v of dto.versions) {
        const content = validateContent(JSON.parse(String(v.content))).content!;
        for (const n of content.nodes) {
          const skillId = n.skill ? ((this.db.prepare('SELECT id FROM skills WHERE canonical_name = ?').get(n.skill.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')) as { id: string } | undefined)?.id ?? null) : null;
          this.db.prepare('INSERT INTO roadmap_nodes (version_id, key, type, title, parent_key, estimate_minutes, skill_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(v.id, n.key, n.type, n.title, n.parentKey, n.estimateMinutes, skillId);
        }
        for (const e of content.edges) this.db.prepare('INSERT INTO prerequisite_edges (version_id, from_key, to_key) VALUES (?, ?, ?)').run(v.id, e.from, e.to);
      }
      for (const r of dto.roadmaps) this.db.prepare('UPDATE roadmaps SET current_version_id = ? WHERE id = ?').run(r.current_version_id ?? null, r.id);
    }).immediate();
    this.audit.record(actor, 'import', 'learning', 'all', dto.counts);
    return { imported: dto.counts };
  }
}

@Controller()
export class ExportController {
  constructor(private readonly exporter: ExportService) {}

  @Get('export')
  export(@Actor() actor: string) {
    return this.exporter.export(actor);
  }

  @Post('import')
  @HttpCode(200)
  import(@Body() dto: ImportDto, @Actor() actor: string) {
    return this.exporter.import(dto, actor);
  }
}

@Module({ controllers: [ExportController], providers: [ExportService] })
export class ExportModule {}
