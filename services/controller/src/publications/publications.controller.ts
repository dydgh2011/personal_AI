import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsIn, IsObject, IsUUID, Matches } from 'class-validator';
import { CurrentActor, CurrentPublisher, RequireRole } from '../auth/auth.decorators.js';
import type { PublisherPrincipal, TaskActor } from '../auth/principal.js';
import { decidedBy } from '../reviews/reviews.controller.js';
import { PublicationsService, type Publication, type PublicationJob, type PublicationStatus, type PublishAuthorization } from './publications.service.js';

export class DryRunDto {
  /** The approved commit the admin is looking at; the request is for this commit only. */
  @Matches(/^[0-9a-f]{40}$/, { message: 'headSha must be the 40-character approved commit SHA' })
  headSha: string;
}

export class AuthorizeDto {
  @Matches(/^[0-9a-f]{40}$/, { message: 'headSha must be the 40-character approved commit SHA' })
  headSha: string;

  /** The eligible dry-run the owner looked at when authorizing. */
  @IsUUID('4')
  dryRunId: string;

  @Matches(/^[A-Za-z0-9_-]{8,100}$/)
  idempotencyKey: string;
}

export class PublishDto {
  @IsUUID('4')
  authorizationId: string;

  @Matches(/^[A-Za-z0-9_-]{8,100}$/)
  idempotencyKey: string;
}

export class PublicationResultDto {
  @IsIn(['ready', 'failed', 'published', 'pr_created'])
  status: PublicationStatus;

  @IsObject()
  report: Record<string, unknown>;
}

/**
 * Publication (admin only). Review approval, publish authorization and the publish request are three
 * separate actions; only an admin can take them. Real publishing is disabled unless
 * CONTROLLER_PUBLISH_ENABLED=true.
 */
@Controller('tasks')
@RequireRole('admin')
export class PublicationsController {
  constructor(private readonly publications: PublicationsService) {}

  @Post(':id/publication/dry-run')
  @HttpCode(202)
  dryRun(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DryRunDto,
    @CurrentActor() actor: TaskActor,
    @Headers('x-approver') approver: string | undefined,
  ): Promise<Publication> {
    return this.publications.requestDryRun(id, dto.headSha, decidedBy(actor, approver));
  }

  @Post(':id/publication/authorize')
  @HttpCode(201)
  authorize(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AuthorizeDto,
    @CurrentActor() actor: TaskActor,
    @Headers('x-approver') approver: string | undefined,
  ): Promise<PublishAuthorization> {
    return this.publications.authorize(id, dto, decidedBy(actor, approver));
  }

  @Post(':id/publication/publish')
  @HttpCode(202)
  publish(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: PublishDto,
    @CurrentActor() actor: TaskActor,
    @Headers('x-approver') approver: string | undefined,
  ): Promise<Publication> {
    return this.publications.requestPublish(id, dto, decidedBy(actor, approver));
  }

  @Get(':id/publication')
  status(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.publications.status(id);
  }
}

/** The GitHub Publisher's pull API (publisher token only). */
@Controller('internal/publisher')
@RequireRole('publisher')
export class PublisherController {
  constructor(private readonly publications: PublicationsService) {}

  @Post('claim')
  @HttpCode(200)
  async claim(@CurrentPublisher() publisher: PublisherPrincipal): Promise<{ job: PublicationJob | null }> {
    return { job: await this.publications.claim(publisher) };
  }

  @Post('publications/:id/result')
  @HttpCode(200)
  result(
    @CurrentPublisher() publisher: PublisherPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: PublicationResultDto,
  ): Publication {
    return this.publications.complete(publisher, id, dto.status, dto.report);
  }
}
