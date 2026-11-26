import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { CurrentActor, RequireRole } from '../auth/auth.decorators.js';
import type { TaskActor } from '../auth/principal.js';
import { AgentDefaultsService } from './agent-defaults.service.js';
import { EFFORT_LEVELS, MODEL_MAX_LENGTH, MODEL_PATTERN, type AgentDefaults } from './run-settings.js';
import { AGENT_TYPES, type AgentType } from './task.model.js';

/** A missing field keeps the current default; null clears it (the CLI's own default). */
export class SetAgentDefaultsDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  @Matches(MODEL_PATTERN, { message: 'model must be a model name or alias (letters, digits, . _ : - [ ], not starting with -)' })
  model?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(EFFORT_LEVELS)
  effort?: string | null;
}

/**
 * Default model and effort per coding agent. The owner changes them from the dashboard (admin) or by
 * asking Kelly (delegator; the Hermes plugin only sends a change the owner confirmed in chat).
 */
@Controller('agent-defaults')
@RequireRole(['admin', 'delegator'])
export class AgentDefaultsController {
  constructor(private readonly defaults: AgentDefaultsService) {}

  @Get()
  list(): { items: AgentDefaults[]; effortLevels: readonly string[] } {
    return { items: this.defaults.list(), effortLevels: EFFORT_LEVELS };
  }

  @Post(':agent')
  @HttpCode(200)
  set(@Param('agent') agent: string, @Body() dto: SetAgentDefaultsDto, @CurrentActor() actor: TaskActor): AgentDefaults {
    if (!(AGENT_TYPES as readonly string[]).includes(agent)) throw new BadRequestException('agent must be claude or codex');
    const change: { model?: string | null; effort?: string | null } = {};
    if (dto.model !== undefined) change.model = dto.model;
    if (dto.effort !== undefined) change.effort = dto.effort;
    return this.defaults.set(agent as AgentType, change, actor);
  }
}
