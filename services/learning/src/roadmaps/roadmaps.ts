import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.js';
import { Actor } from '../auth/auth.js';
import { Clock } from '../common/clock.js';
import { conflict, notFound, parseJson, unprocessable } from '../common/errors.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { DomainsModule, DomainsService } from '../domains/domains.js';
import { GoalsModule, GoalsService } from '../goals/goals.js';
import { PROMPT_VERSION, ProviderService } from '../provider/provider.js';
import { canonicalSkill, contentHash, diffContent, validateContent, type RoadmapContent, type RoadmapDiff } from './content.js';

export type ProposalSource = 'ai' | 'user' | 'restore' | 'import';
export type ProposalState = 'invalid' | 'awaiting_user_approval' | 'applied' | 'rejected';

export interface Roadmap {
  id: string;
  goalId: string;
  title: string;
  status: 'active' | 'archived';
  currentVersionId: string | null;
  currentVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapVersion {
  id: string;
  roadmapId: string;
  version: number;
  contentHash: string;
  proposalId: string;
  approvedBy: string;
  approvedAt: string;
}

export interface Proposal {
  id: string;
  roadmapId: string;
  source: ProposalSource;
  baseVersionId: string | null;
  state: ProposalState;
  /** Normalized content when valid; the raw (untrusted) output when invalid. */
  payload: unknown;
  validationErrors: string[];
  input: unknown;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  createdBy: string;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  appliedVersionId: string | null;
}

export class CreateRoadmapDto {
  @IsUUID('4')
  goalId: string;

  @IsString() @MinLength(1) @MaxLength(200)
  title: string;
}

/** An owner edit: the complete new content, based on the version the owner was looking at. */
export class UserProposalDto {
  @ValidateIf((_o, v) => v !== null) @IsUUID('4')
  baseVersionId: string | null;

  @IsObject()
  content: Record<string, unknown>;
}

export class GenerateDto {
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID('4')
  baseVersionId?: string | null;

  @IsOptional() @IsString() @MaxLength(1000)
  currentLevel?: string;

  @IsOptional() @IsInt() @Min(0) @Max(10080)
  weeklyMinutes?: number;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;
}

/** Applying needs the version the owner saw (optimistic lock): a newer current version -> 409. */
export class ApplyDto {
  @ValidateIf((_o, v) => v !== null) @IsUUID('4')
  baseVersionId: string | null;
}

export class RestoreDto {
  @IsUUID('4')
  versionId: string;

  @IsUUID('4')
  baseVersionId: string;
}

interface RoadmapRow { id: string; goal_id: string; title: string; status: Roadmap['status']; current_version_id: string | null; created_at: string; updated_at: string; version: number | null }
interface VersionRow { id: string; roadmap_id: string; version: number; content: string; content_hash: string; proposal_id: string; approved_by: string; approved_at: string }
interface ProposalRow {
  id: string; roadmap_id: string; source: ProposalSource; base_version_id: string | null; state: ProposalState; payload: string; validation_errors: string;
  input: string | null; provider: string | null; model: string | null; prompt_version: string | null; input_tokens: number | null; output_tokens: number | null;
  cost_usd: number | null; created_by: string; created_at: string; decided_by: string | null; decided_at: string | null; applied_version_id: string | null;
}

const toRoadmap = (r: RoadmapRow): Roadmap => ({
  id: r.id, goalId: r.goal_id, title: r.title, status: r.status, currentVersionId: r.current_version_id, currentVersion: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toVersion = (r: VersionRow): RoadmapVersion => ({
  id: r.id, roadmapId: r.roadmap_id, version: r.version, contentHash: r.content_hash, proposalId: r.proposal_id, approvedBy: r.approved_by, approvedAt: r.approved_at,
});
const toProposal = (r: ProposalRow): Proposal => ({
  id: r.id, roadmapId: r.roadmap_id, source: r.source, baseVersionId: r.base_version_id, state: r.state, payload: parseJson(r.payload, null),
  validationErrors: parseJson(r.validation_errors, []), input: parseJson(r.input, null), provider: r.provider, model: r.model, promptVersion: r.prompt_version,
  inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUsd: r.cost_usd, createdBy: r.created_by, createdAt: r.created_at,
  decidedBy: r.decided_by, decidedAt: r.decided_at, appliedVersionId: r.applied_version_id,
});

const ROADMAP_SELECT = 'SELECT r.*, v.version AS version FROM roadmaps r LEFT JOIN roadmap_versions v ON v.id = r.current_version_id';

/**
 * Roadmaps and their immutable versions. Every change - an owner edit, an AI draft, a restore,
 * an import - is a proposal first; only an explicit apply against the current version creates a
 * new version (one conditional UPDATE, so of two concurrent applies only one wins).
 */
@Injectable()
export class RoadmapsService {
  constructor(
    @Inject(SQLITE_CONNECTION) private readonly db: Database,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly goals: GoalsService,
    private readonly domains: DomainsService,
    private readonly provider: ProviderService,
  ) {}

  list(goalId?: string): Roadmap[] {
    const rows = goalId
      ? this.db.prepare(`${ROADMAP_SELECT} WHERE r.goal_id = ? ORDER BY r.created_at DESC`).all(goalId)
      : this.db.prepare(`${ROADMAP_SELECT} ORDER BY r.created_at DESC`).all();
    return (rows as RoadmapRow[]).map(toRoadmap);
  }

  get(id: string): Roadmap {
    const row = this.db.prepare(`${ROADMAP_SELECT} WHERE r.id = ?`).get(id) as RoadmapRow | undefined;
    if (!row) throw notFound('Roadmap', id);
    return toRoadmap(row);
  }

  /** The roadmap with its current content (null before the first approved version). */
  detail(id: string) {
    const roadmap = this.get(id);
    const current = roadmap.currentVersionId ? this.versionContent(id, roadmap.currentVersionId) : null;
    return { roadmap, current: current && { version: current.version, content: current.content } };
  }

  create(dto: CreateRoadmapDto, actor: string): Roadmap {
    this.goals.get(dto.goalId);
    const now = this.clock.now().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO roadmaps (id, goal_id, title, status, current_version_id, created_at, updated_at) VALUES (?, ?, ?, 'active', NULL, ?, ?)`)
      .run(id, dto.goalId, dto.title.trim(), now, now);
    this.audit.record(actor, 'roadmap.create', 'roadmap', id, dto);
    return this.get(id);
  }

  versions(id: string): RoadmapVersion[] {
    this.get(id);
    return (this.db.prepare('SELECT * FROM roadmap_versions WHERE roadmap_id = ? ORDER BY version DESC').all(id) as VersionRow[]).map(toVersion);
  }

  versionContent(roadmapId: string, versionId: string): RoadmapVersion & { content: RoadmapContent } {
    const row = this.db.prepare('SELECT * FROM roadmap_versions WHERE id = ? AND roadmap_id = ?').get(versionId, roadmapId) as VersionRow | undefined;
    if (!row) throw notFound('Roadmap version', versionId);
    return { ...toVersion(row), content: JSON.parse(row.content) as RoadmapContent };
  }

  proposals(id: string): Proposal[] {
    this.get(id);
    return (this.db.prepare('SELECT * FROM ai_proposals WHERE roadmap_id = ? ORDER BY created_at DESC, rowid DESC').all(id) as ProposalRow[]).map(toProposal);
  }

  proposal(roadmapId: string, proposalId: string): Proposal {
    const row = this.db.prepare('SELECT * FROM ai_proposals WHERE id = ? AND roadmap_id = ?').get(proposalId, roadmapId) as ProposalRow | undefined;
    if (!row) throw notFound('Proposal', proposalId);
    return toProposal(row);
  }

  /** What applying would change, against the proposal's base and whether that base is still current. */
  proposalDiff(roadmapId: string, proposalId: string): { proposal: Proposal; diff: RoadmapDiff | null; stale: boolean; currentVersionId: string | null } {
    const roadmap = this.get(roadmapId);
    const proposal = this.proposal(roadmapId, proposalId);
    const base = proposal.baseVersionId ? this.versionContent(roadmapId, proposal.baseVersionId).content : null;
    const diff = proposal.state === 'invalid' ? null : diffContent(base, proposal.payload as RoadmapContent);
    return { proposal, diff, stale: proposal.baseVersionId !== roadmap.currentVersionId, currentVersionId: roadmap.currentVersionId };
  }

  /** Owner edit. Invalid content is refused (422) and not stored. */
  propose(roadmapId: string, dto: UserProposalDto, actor: string): Proposal {
    this.get(roadmapId);
    if (dto.baseVersionId) this.versionContent(roadmapId, dto.baseVersionId);
    const result = validateContent(dto.content);
    if (!result.ok) {
      throw unprocessable(result.cycle ? 'PREREQUISITE_CYCLE' : 'INVALID_ROADMAP', result.errors[0], { errors: result.errors, cycle: result.cycle });
    }
    return this.storeProposal({ roadmapId, source: 'user', baseVersionId: dto.baseVersionId, state: 'awaiting_user_approval', payload: result.content, errors: [], actor });
  }

  /**
   * AI draft. The result is always stored as a proposal - "invalid" (with the reasons) when the
   * output fails validation - and never changes the current version or the goal.
   */
  async generate(roadmapId: string, dto: GenerateDto, actor: string): Promise<Proposal> {
    const roadmap = this.get(roadmapId);
    const baseVersionId = dto.baseVersionId === undefined ? roadmap.currentVersionId : dto.baseVersionId;
    const base = baseVersionId ? this.versionContent(roadmapId, baseVersionId).content : null;
    const goal = this.goals.get(roadmap.goalId);
    const domain = this.domains.get(goal.domainId);
    const input = {
      domain: { title: domain.title },
      goal: { title: goal.title, target: goal.target, targetLevel: goal.targetLevel, constraints: goal.constraints },
      currentLevel: dto.currentLevel ?? null,
      weeklyMinutes: dto.weeklyMinutes ?? goal.constraints.weeklyMinutes ?? null,
      notes: dto.notes ?? null,
      base,
    };
    const result = await this.provider.draftRoadmap(input);
    const checked = validateContent(result.output);
    // AI never gets to claim owner provenance for resources.
    if (checked.ok) for (const n of checked.content!.nodes) for (const r of n.resources) r.provenance = 'ai_suggested';
    const proposal = this.storeProposal({
      roadmapId, source: 'ai', baseVersionId, state: checked.ok ? 'awaiting_user_approval' : 'invalid',
      payload: checked.ok ? checked.content : truncate(result.output), errors: checked.ok ? [] : checked.errors.length ? checked.errors : ['output was not JSON'],
      actor, input: { currentLevel: input.currentLevel, weeklyMinutes: input.weeklyMinutes, notes: input.notes },
      ai: { provider: result.provider, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd },
    });
    return proposal;
  }

  apply(roadmapId: string, proposalId: string, dto: ApplyDto, actor: string): { roadmap: Roadmap; version: RoadmapVersion } {
    const proposal = this.proposal(roadmapId, proposalId);
    if (proposal.state !== 'awaiting_user_approval') throw conflict('PROPOSAL_NOT_PENDING', `Proposal is ${proposal.state}`);
    if (dto.baseVersionId !== proposal.baseVersionId) throw conflict('VERSION_CONFLICT', 'The proposal is based on another version than the one you approved');
    const version = this.db.transaction(() => {
      const v = this.insertVersion(roadmapId, proposal.payload as RoadmapContent, proposal.id, actor, proposal.baseVersionId);
      const marked = this.db.prepare(`UPDATE ai_proposals SET state = 'applied', decided_by = ?, decided_at = ?, applied_version_id = ? WHERE id = ? AND state = 'awaiting_user_approval'`)
        .run(actor, v.approvedAt, v.id, proposal.id);
      if (marked.changes !== 1) throw conflict('PROPOSAL_NOT_PENDING', 'Proposal was decided meanwhile');
      return v;
    }).immediate();
    this.audit.record(actor, 'roadmap.apply', 'roadmap', roadmapId, { proposalId, version: version.version, contentHash: version.contentHash });
    return { roadmap: this.get(roadmapId), version };
  }

  reject(roadmapId: string, proposalId: string, actor: string): Proposal {
    this.proposal(roadmapId, proposalId);
    const now = this.clock.now().toISOString();
    const res = this.db.prepare(`UPDATE ai_proposals SET state = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND state IN ('awaiting_user_approval', 'invalid')`).run(actor, now, proposalId);
    if (res.changes !== 1) throw conflict('PROPOSAL_NOT_PENDING', 'Proposal is already decided');
    this.audit.record(actor, 'roadmap.reject', 'proposal', proposalId);
    return this.proposal(roadmapId, proposalId);
  }

  /** Restoring an old version creates a NEW version with that content; history is never rewritten. */
  restore(roadmapId: string, dto: RestoreDto, actor: string): { roadmap: Roadmap; version: RoadmapVersion } {
    const old = this.versionContent(roadmapId, dto.versionId);
    const version = this.db.transaction(() => {
      const proposal = this.storeProposal({ roadmapId, source: 'restore', baseVersionId: dto.baseVersionId, state: 'awaiting_user_approval', payload: old.content, errors: [], actor, input: { restoredFrom: old.version } });
      const v = this.insertVersion(roadmapId, old.content, proposal.id, actor, dto.baseVersionId);
      this.db.prepare(`UPDATE ai_proposals SET state = 'applied', decided_by = ?, decided_at = ?, applied_version_id = ? WHERE id = ?`).run(actor, v.approvedAt, v.id, proposal.id);
      return v;
    }).immediate();
    this.audit.record(actor, 'roadmap.restore', 'roadmap', roadmapId, { from: old.version, version: version.version });
    return { roadmap: this.get(roadmapId), version };
  }

  /** Inside a transaction: new immutable version + nodes/edges + shared skills; moves the pointer only from `base`. */
  insertVersion(roadmapId: string, content: RoadmapContent, proposalId: string, actor: string, base: string | null, at?: string): RoadmapVersion {
    const now = at ?? this.clock.now().toISOString();
    const id = randomUUID();
    const next = (this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS n FROM roadmap_versions WHERE roadmap_id = ?').get(roadmapId) as { n: number }).n;
    this.db.prepare(`INSERT INTO roadmap_versions (id, roadmap_id, version, content, content_hash, proposal_id, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, roadmapId, next, JSON.stringify(content), contentHash(content), proposalId, actor, now);
    for (const n of content.nodes) {
      let skillId: string | null = null;
      if (n.skill) {
        const canonical = canonicalSkill(n.skill);
        const found = this.db.prepare('SELECT id FROM skills WHERE canonical_name = ?').get(canonical) as { id: string } | undefined;
        skillId = found?.id ?? randomUUID();
        if (!found) this.db.prepare('INSERT INTO skills (id, canonical_name, display_name, created_at) VALUES (?, ?, ?, ?)').run(skillId, canonical, n.skill, now);
      }
      this.db.prepare(`INSERT INTO roadmap_nodes (version_id, key, type, title, parent_key, estimate_minutes, skill_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, n.key, n.type, n.title, n.parentKey, n.estimateMinutes, skillId);
    }
    for (const e of content.edges) this.db.prepare('INSERT INTO prerequisite_edges (version_id, from_key, to_key) VALUES (?, ?, ?)').run(id, e.from, e.to);
    const moved = this.db.prepare('UPDATE roadmaps SET current_version_id = ?, updated_at = ? WHERE id = ? AND current_version_id IS ?').run(id, now, roadmapId, base);
    if (moved.changes !== 1) throw conflict('VERSION_CONFLICT', 'The roadmap changed since this proposal was made; review the current version and propose again');
    return toVersion(this.db.prepare('SELECT * FROM roadmap_versions WHERE id = ?').get(id) as VersionRow);
  }

  private storeProposal(p: {
    roadmapId: string; source: ProposalSource; baseVersionId: string | null; state: ProposalState; payload: unknown; errors: string[]; actor: string;
    input?: unknown; ai?: { provider: string; model: string; inputTokens: number | null; outputTokens: number | null; costUsd: number };
  }): Proposal {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO ai_proposals (id, roadmap_id, source, base_version_id, state, payload, validation_errors, input, provider, model, prompt_version,
        input_tokens, output_tokens, cost_usd, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, p.roadmapId, p.source, p.baseVersionId, p.state, JSON.stringify(p.payload ?? null), JSON.stringify(p.errors), p.input === undefined ? null : JSON.stringify(p.input),
      p.ai?.provider ?? null, p.ai?.model ?? null, p.ai ? PROMPT_VERSION : null, p.ai?.inputTokens ?? null, p.ai?.outputTokens ?? null, p.ai?.costUsd ?? null,
      p.actor, this.clock.now().toISOString(),
    );
    this.audit.record(p.actor, `proposal.${p.source}`, 'proposal', id, { roadmapId: p.roadmapId, state: p.state });
    return this.proposal(p.roadmapId, id);
  }
}

function truncate(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  return text.length > 200_000 ? { truncated: true, preview: text.slice(0, 2000) } : value;
}

@Controller('roadmaps')
export class RoadmapsController {
  constructor(private readonly roadmaps: RoadmapsService) {}

  @Get()
  list(@Query('goalId') goalId?: string) {
    return { items: this.roadmaps.list(goalId) };
  }

  @Post()
  create(@Body() dto: CreateRoadmapDto, @Actor() actor: string) {
    return this.roadmaps.create(dto, actor);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.roadmaps.detail(id);
  }

  @Get(':id/versions')
  versions(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return { items: this.roadmaps.versions(id) };
  }

  @Get(':id/versions/:versionId')
  version(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string) {
    return this.roadmaps.versionContent(id, versionId);
  }

  @Get(':id/proposals')
  proposals(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return { items: this.roadmaps.proposals(id) };
  }

  @Post(':id/proposals')
  propose(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: UserProposalDto, @Actor() actor: string) {
    return this.roadmaps.propose(id, dto, actor);
  }

  @Post(':id/proposals/generate')
  generate(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: GenerateDto, @Actor() actor: string) {
    return this.roadmaps.generate(id, dto, actor);
  }

  @Get(':id/proposals/:proposalId/diff')
  diff(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Param('proposalId', new ParseUUIDPipe({ version: '4' })) proposalId: string) {
    return this.roadmaps.proposalDiff(id, proposalId);
  }

  @Post(':id/proposals/:proposalId/apply')
  @HttpCode(200)
  apply(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('proposalId', new ParseUUIDPipe({ version: '4' })) proposalId: string,
    @Body() dto: ApplyDto,
    @Actor() actor: string,
  ) {
    return this.roadmaps.apply(id, proposalId, dto, actor);
  }

  @Post(':id/proposals/:proposalId/reject')
  @HttpCode(200)
  reject(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Param('proposalId', new ParseUUIDPipe({ version: '4' })) proposalId: string, @Actor() actor: string) {
    return this.roadmaps.reject(id, proposalId, actor);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: RestoreDto, @Actor() actor: string) {
    return this.roadmaps.restore(id, dto, actor);
  }
}

@Module({ imports: [GoalsModule, DomainsModule], controllers: [RoadmapsController], providers: [RoadmapsService], exports: [RoadmapsService] })
export class RoadmapsModule {}
