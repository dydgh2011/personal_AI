import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PROJECT_ID_PATTERN } from '../../config/app-config.js';
import { FULL_NAME_PATTERN } from '../../github/github-client.js';
import { AGENT_TYPES, type AgentType } from '../../tasks/task.model.js';
import { PROJECT_SOURCES, SYNC_STATUSES, type ProjectSource, type SyncStatus } from '../project.model.js';

/** Git branch names we accept: no "..", no leading "/" or "-", no trailing "." or "/". */
export const BRANCH_NAME_PATTERN = /^(?![-/])(?!.*(?:\.\.|\/\/|@\{|\\))[A-Za-z0-9._/-]{1,200}(?<![./])$/;

/**
 * POST /projects. GitHub projects are resolved through the GitHub API (id, default
 * branch, clone URL, visibility come from GitHub, never from the request), so a
 * remote URL with embedded credentials cannot be registered.
 */
export class CreateProjectDto {
  @Matches(PROJECT_ID_PATTERN, { message: 'id must be lowercase letters, digits, "-" or "_" (max 64)' })
  id: string;

  @IsIn(PROJECT_SOURCES)
  source: ProjectSource;

  @ValidateIf((o: CreateProjectDto) => o.source === 'github')
  @IsString()
  @Matches(FULL_NAME_PATTERN, { message: 'fullName must look like "owner/repo"' })
  fullName?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AGENT_TYPES.length)
  @ArrayUnique()
  @IsIn(AGENT_TYPES, { each: true })
  allowedAgents: AgentType[];

  /** Local projects only; GitHub projects use the repository's default branch. */
  @IsOptional()
  @Matches(BRANCH_NAME_PATTERN, { message: 'defaultBranch is not a valid branch name' })
  defaultBranch?: string;

  /** New projects start disabled unless enabled explicitly. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** New projects are read-only for workers unless allowed explicitly. */
  @IsOptional()
  @IsBoolean()
  allowCodeChanges?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

/** One admin-approved verification command (argv, no shell expansion by the runner). */
export class TestCommandDto {
  @Matches(/^[a-z0-9][a-z0-9_-]{0,39}$/, { message: 'test command name must be lowercase letters, digits, "-" or "_"' })
  name: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  argv: string[];

  @IsInt()
  @Min(1)
  @Max(1800)
  timeoutSeconds: number;
}

/** PATCH /projects/:id. Identity fields (id, source, fullName, remote) cannot change. */
export class UpdateProjectDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  allowCodeChanges?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AGENT_TYPES.length)
  @ArrayUnique()
  @IsIn(AGENT_TYPES, { each: true })
  allowedAgents?: AgentType[];

  @IsOptional()
  @Matches(BRANCH_NAME_PATTERN, { message: 'defaultBranch is not a valid branch name' })
  defaultBranch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** Written by the repository sync tool after a fetch. */
  @IsOptional()
  @IsIn(SYNC_STATUSES)
  syncStatus?: SyncStatus;

  @IsOptional()
  @IsISO8601({ strict: true })
  lastFetchedAt?: string;

  @IsOptional()
  @Matches(/^[0-9a-f]{40}$/, { message: 'cachedHeadSha must be a 40-character commit SHA' })
  cachedHeadSha?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  lastSyncError?: string;

  /**
   * Verification commands for this project (admin only: PATCH /projects requires the admin role).
   * Replaces the whole list; [] removes them (the project can then not be published).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TestCommandDto)
  testCommands?: TestCommandDto[];
}
