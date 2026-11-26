import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { creatorOf, type TaskActor } from '../auth/principal.js';
import { Clock } from '../common/clock.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { isEffort, MODEL_PATTERN, type AgentDefaults, type EffortLevel, type RunSettings } from './run-settings.js';
import { AGENT_TYPES, type AgentType } from './task.model.js';

interface DefaultsRow {
  agent: AgentType;
  model: string | null;
  effort: string | null;
  updated_at: string;
  updated_by: string;
}

/** What a request asked for: a missing field keeps the current value, null clears it (CLI default). */
export interface RunSettingsChange {
  model?: string | null;
  effort?: string | null;
}

/** The owner's default model and effort per agent (owner request 2026-11-25). */
@Injectable()
export class AgentDefaultsService {
  private readonly logger = new Logger(AgentDefaultsService.name);

  constructor(
    @Inject(SQLITE_CONNECTION) private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  list(): AgentDefaults[] {
    const rows = new Map(
      (this.db.prepare('SELECT * FROM agent_defaults').all() as DefaultsRow[]).map((r) => [r.agent, r]),
    );
    return AGENT_TYPES.map((agent) => toDefaults(agent, rows.get(agent)));
  }

  get(agent: AgentType): AgentDefaults {
    const row = this.db.prepare('SELECT * FROM agent_defaults WHERE agent = ?').get(agent) as DefaultsRow | undefined;
    return toDefaults(agent, row);
  }

  set(agent: AgentType, change: RunSettingsChange, actor: TaskActor): AgentDefaults {
    if (!AGENT_TYPES.includes(agent)) throw new BadRequestException('agent must be claude or codex');
    if (change.model === undefined && change.effort === undefined) {
      throw new BadRequestException('Give model and/or effort (null = the CLI default)');
    }
    const current = this.get(agent);
    const next: RunSettings = {
      model: change.model === undefined ? current.model : checkedModel(change.model),
      effort: change.effort === undefined ? current.effort : checkedEffort(change.effort),
    };
    const by = creatorOf(actor);
    this.db
      .prepare(`
        INSERT INTO agent_defaults (agent, model, effort, updated_at, updated_by)
        VALUES (@agent, @model, @effort, @now, @by)
        ON CONFLICT (agent) DO UPDATE SET model = @model, effort = @effort, updated_at = @now, updated_by = @by`)
      .run({ agent, model: next.model, effort: next.effort, now: this.clock.now().toISOString(), by });
    this.logger.log(
      `Defaults for ${agent} set by ${by}: model ${current.model ?? 'cli-default'} -> ${next.model ?? 'cli-default'}, ` +
        `effort ${current.effort ?? 'cli-default'} -> ${next.effort ?? 'cli-default'}`,
    );
    return this.get(agent);
  }

  /** The settings a new task runs with: what the request asked for, else the agent's default. */
  resolve(agent: AgentType, requested: RunSettingsChange): RunSettings {
    const defaults = this.get(agent);
    return {
      model: requested.model == null ? defaults.model : checkedModel(requested.model),
      effort: requested.effort == null ? defaults.effort : checkedEffort(requested.effort),
    };
  }
}

function checkedModel(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !MODEL_PATTERN.test(value)) {
    throw new BadRequestException('model must be a model name or alias (letters, digits, . _ : - [ ], max 80, not starting with -)');
  }
  return value;
}

function checkedEffort(value: string | null): EffortLevel | null {
  if (value === null) return null;
  if (!isEffort(value)) throw new BadRequestException('effort must be one of low, medium, high, xhigh, max');
  return value;
}

function toDefaults(agent: AgentType, row: DefaultsRow | undefined): AgentDefaults {
  return {
    agent,
    model: row?.model ?? null,
    effort: row && isEffort(row.effort) ? row.effort : null,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}
