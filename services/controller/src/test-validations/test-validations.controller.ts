import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentActor, CurrentTestRunner, RequireRole } from '../auth/auth.decorators.js';
import type { TaskActor, TestRunnerPrincipal } from '../auth/principal.js';
import { decidedBy } from '../reviews/reviews.controller.js';
import { TestValidationsService, type TestCommandResult, type TestRunJob, type TestStatus, type TestValidation } from './test-validations.service.js';

export class RunTestsDto {
  @Matches(/^[0-9a-f]{40}$/, { message: 'headSha must be the 40-character commit SHA under review' })
  headSha: string;
}

export class TestResultDto {
  @IsIn(['passed', 'failed', 'skipped', 'aborted'])
  status: TestStatus;

  @IsArray()
  results: TestCommandResult[];

  @IsString()
  @MaxLength(262144)
  evidence: string;

  @Matches(/^[0-9a-f]{64}$/)
  evidenceHash: string;

  @Matches(/^[0-9a-f]{64}$/)
  evidenceSignature: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error?: string;
}

/** Test runs of a task's commit (admin). Commands come from the project registry only. */
@Controller('tasks')
@RequireRole('admin')
export class TestValidationsController {
  constructor(private readonly tests: TestValidationsService) {}

  @Post(':id/tests')
  @HttpCode(202)
  run(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RunTestsDto,
    @CurrentActor() actor: TaskActor,
    @Headers('x-approver') approver: string | undefined,
  ): Promise<TestValidation> {
    return this.tests.request(id, dto.headSha, decidedBy(actor, approver));
  }

  @Get(':id/tests')
  list(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): { items: TestValidation[] } {
    return { items: this.tests.list(id) };
  }
}

/** The isolated test runner's pull API (test-runner token only). */
@Controller('internal/test-runner')
@RequireRole('test-runner')
export class TestRunnerController {
  constructor(private readonly tests: TestValidationsService) {}

  @Post('claim')
  @HttpCode(200)
  async claim(@CurrentTestRunner() runner: TestRunnerPrincipal): Promise<{ job: TestRunJob | null }> {
    return { job: await this.tests.claim(runner) };
  }

  @Post('validations/:id/result')
  @HttpCode(200)
  result(
    @CurrentTestRunner() runner: TestRunnerPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: TestResultDto,
  ): TestValidation {
    return this.tests.complete(runner, id, dto);
  }
}
