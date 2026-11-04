import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentActor, RequireRole } from '../auth/auth.decorators.js';
import type { TaskActor } from '../auth/principal.js';
import { CreateTaskDto } from './dto/create-task.dto.js';
import { ListTasksQuery } from './dto/list-tasks.query.js';
import type { Task } from './task.model.js';
import { TasksService, type CancelResult, type TaskListResponse } from './tasks.service.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Management API. The admin token sees every task; the delegator token
 * (Hermes) creates tasks in registered projects and sees only its own.
 */
@Controller('tasks')
@RequireRole(['admin', 'delegator'])
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /**
   * An `Idempotency-Key` header makes retries safe: repeating the same request
   * within the window returns the original task with 200 and
   * `Idempotent-Replayed: true` instead of creating a second one.
   */
  @Post()
  async create(
    @Body() dto: CreateTaskDto,
    @CurrentActor() actor: TaskActor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Task> {
    if (idempotencyKey === undefined) return this.tasks.create(dto, actor);
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 . _ : -');
    }
    const { task, replayed } = await this.tasks.createIdempotent(dto, actor, idempotencyKey);
    if (replayed) {
      response.status(HttpStatus.OK);
      response.setHeader('Idempotent-Replayed', 'true');
    }
    return task;
  }

  @Get()
  list(@Query() query: ListTasksQuery, @CurrentActor() actor: TaskActor): Promise<TaskListResponse> {
    return this.tasks.list(query, actor);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentActor() actor: TaskActor): Promise<Task> {
    return this.tasks.get(id, actor);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentActor() actor: TaskActor,
  ): Promise<CancelResult> {
    return this.tasks.cancel(id, actor);
  }
}
