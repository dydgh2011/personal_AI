import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { PROJECT_ID_PATTERN } from '../../config/app-config.js';
import { AGENT_TYPES, TASK_STATUSES, type AgentType, type TaskStatus } from '../task.model.js';

export class ListTasksQuery {
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: TaskStatus;

  @IsOptional()
  @IsIn(AGENT_TYPES)
  agent?: AgentType;

  @IsOptional()
  @Matches(PROJECT_ID_PATTERN)
  projectId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
