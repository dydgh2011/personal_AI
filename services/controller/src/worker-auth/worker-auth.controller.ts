import { Body, Controller, Get, HttpCode, Param, ParseEnumPipe, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';
import { CurrentWorker, RequireRole } from '../auth/auth.decorators.js';
import type { WorkerPrincipal } from '../auth/principal.js';
import { AGENT_TYPES, type AgentType } from '../tasks/task.model.js';
import { WorkerPresence } from '../workers/worker-presence.js';
import { AUTH_SESSION_STATUSES, WorkerAuthService, type AgentAuthView, type AuthSessionStatus } from './worker-auth.service.js';

export class AuthSessionDto {
  @IsUUID('4')
  id: string;

  @IsIn(AUTH_SESSION_STATUSES)
  status: AuthSessionStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Matches(/^https:\/\/[^\s]+$/, { message: 'loginUrl must be an https URL' })
  loginUrl?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9-]{4,24}$/, { message: 'userCode must be a short device code' })
  userCode?: string | null;

  @IsOptional()
  @IsBoolean()
  needsCode?: boolean;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string | null;
}

export class WorkerAuthReportDto {
  @IsBoolean()
  loggedIn: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => AuthSessionDto)
  session?: AuthSessionDto | null;
}

export class SubmitCodeDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9#._~-]{8,512}$/, { message: 'code must be the code shown after signing in (letters, digits, # . _ ~ -)' })
  code: string;

  @IsOptional()
  @IsUUID('4')
  sessionId?: string;
}

/** Worker side: report login state and pick up a submitted code (agent comes from the token). */
@Controller('internal/workers')
@RequireRole('worker')
export class WorkerAuthInternalController {
  constructor(
    private readonly auth: WorkerAuthService,
    private readonly presence: WorkerPresence,
  ) {}

  @Post('auth')
  @HttpCode(200)
  report(@CurrentWorker() worker: WorkerPrincipal, @Body() dto: WorkerAuthReportDto): { requested: boolean; code: string | null } {
    // A worker waiting for its login still polls here, so it counts as online (status shows the login state).
    this.presence.touch(worker);
    return this.auth.report(worker.agent, dto);
  }
}

/** Hermes (through the broker) and the admin: see login state, start a login, send the code. */
@Controller('workers')
@RequireRole(['admin', 'delegator'])
export class WorkerAuthController {
  constructor(private readonly auth: WorkerAuthService) {}

  @Get('auth')
  list(): { items: AgentAuthView[] } {
    return { items: this.auth.list() };
  }

  @Post(':agent/auth/start')
  @HttpCode(200)
  start(@Param('agent', new ParseEnumPipe(AGENT_TYPES)) agent: AgentType): AgentAuthView {
    return this.auth.requestLogin(agent);
  }

  @Post(':agent/auth/code')
  @HttpCode(200)
  code(@Param('agent', new ParseEnumPipe(AGENT_TYPES)) agent: AgentType, @Body() dto: SubmitCodeDto): AgentAuthView {
    return this.auth.submitCode(agent, dto.code.trim(), dto.sessionId);
  }
}
