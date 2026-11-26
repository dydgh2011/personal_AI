import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { EFFORT_LEVELS, MODEL_MAX_LENGTH, MODEL_PATTERN } from '../run-settings.js';
import { PROJECT_ID_PATTERN } from '../../config/app-config.js';
import { AGENT_TYPES, type AgentType } from '../task.model.js';

export const MAX_INSTRUCTION_LENGTH = 20_000;

export class CreateTaskDto {
  @IsIn(AGENT_TYPES)
  agent: AgentType;

  @IsOptional()
  @IsString()
  @Matches(PROJECT_ID_PATTERN, {
    message: 'projectId must be a registered project id (lowercase letters, digits, "-" or "_")',
  })
  projectId?: string | null;

  @IsString()
  @Matches(/\S/, { message: 'instruction must not be blank' })
  @MaxLength(MAX_INSTRUCTION_LENGTH)
  instruction: string;

  /** Only for this task; omitted = the agent's default (GET /agent-defaults). */
  @IsOptional()
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  @Matches(MODEL_PATTERN, { message: 'model must be a model name or alias (letters, digits, . _ : - [ ], not starting with -)' })
  model?: string | null;

  @IsOptional()
  @IsIn(EFFORT_LEVELS)
  effort?: string | null;
}
