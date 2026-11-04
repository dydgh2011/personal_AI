import { BadRequestException, Body, Controller, DefaultValuePipe, Get, Headers, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentActor, RequireRole } from '../auth/auth.decorators.js';
import type { AdminPrincipal, TaskActor } from '../auth/principal.js';
import { REVIEW_STATUSES, ReviewsService, type Review, type ReviewStatus } from './reviews.service.js';

export class DecisionDto {
  /** The exact commit the reviewer looked at; the decision applies to this commit only. */
  @Matches(/^[0-9a-f]{40}$/, { message: 'headSha must be the 40-character commit SHA shown by GET /tasks/:id/diff' })
  headSha: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

/**
 * Review of task results. Reading: admin and delegator (Hermes, own tasks only).
 * Deciding: admin only - Hermes and the workers can never approve or reject.
 */
@Controller('tasks')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get(':id/diff')
  @RequireRole(['admin', 'delegator'])
  diff(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentActor() actor: TaskActor) {
    return this.reviews.diff(id, actor);
  }

  @Get(':id/review')
  @RequireRole(['admin', 'delegator'])
  review(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentActor() actor: TaskActor) {
    return this.reviews.review(id, actor);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequireRole('admin')
  approve(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecisionDto,
    @CurrentActor() actor: TaskActor,
    @Headers('x-approver') approver: string | undefined,
  ): Promise<Review> {
    return this.reviews.decide(id, 'approved', dto.headSha, decidedBy(actor, approver), dto.reason ?? null);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequireRole('admin')
  reject(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecisionDto,
    @CurrentActor() actor: TaskActor,
    @Headers('x-approver') approver: string | undefined,
  ): Promise<Review> {
    return this.reviews.decide(id, 'rejected', dto.headSha, decidedBy(actor, approver), dto.reason ?? null);
  }
}

/** Review queue for the Admin Dashboard. */
@Controller('reviews')
@RequireRole('admin')
export class ReviewListController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(
    @Query('status') status: string | undefined,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ): { items: Review[] } {
    if (status !== undefined && !(REVIEW_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`status must be one of ${REVIEW_STATUSES.join(', ')}`);
    }
    return { items: this.reviews.list(status as ReviewStatus | undefined, Math.min(Math.max(limit, 1), 200)) };
  }
}

const APPROVER = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

/**
 * Who decided: the admin credential ('admin' or 'dashboard') plus, for the dashboard, the logged-in
 * user it reports in X-Approver. Only admin credentials reach this code (RequireRole('admin')).
 */
export function decidedBy(actor: TaskActor, approver: string | undefined): string {
  const name = (actor as AdminPrincipal).name ?? 'admin';
  if (approver === undefined) return name;
  if (!APPROVER.test(approver)) throw new BadRequestException('X-Approver must be a short lowercase user name');
  return `${name}:${approver}`;
}
