import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Matches } from 'class-validator';
import { CurrentWorker, RequireRole } from '../auth/auth.decorators.js';
import type { WorkerPrincipal } from '../auth/principal.js';
import type { WorkerProjectView } from '../projects/project.model.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ReviewsService, type Review } from '../reviews/reviews.service.js';
import type { Task } from '../tasks/task.model.js';
import { TasksService } from '../tasks/tasks.service.js';
import { TestValidationsService } from '../test-validations/test-validations.service.js';
import { CompleteTaskDto, FailTaskDto } from './dto/report-result.dto.js';
import { WorkerPresence } from './worker-presence.js';

export class ObservedHeadDto {
  @Matches(/^[0-9a-f]{40}$/)
  headSha: string;
}

/**
 * Pull-based worker API. The agent a worker may act for comes from its token,
 * never from the request body, so a Claude worker cannot claim or report on
 * Codex tasks and vice versa.
 */
@Controller('internal')
@RequireRole('worker')
export class WorkersController {
  constructor(
    private readonly tasks: TasksService,
    private readonly presence: WorkerPresence,
    private readonly projects: ProjectsService,
    private readonly reviews: ReviewsService,
    private readonly testValidations: TestValidationsService,
  ) {}

  /**
   * The commit currently on the task branch. Pending or approved reviews of any other commit are
   * invalidated (an approval is only ever valid for the commit it was given for).
   */
  @Post('tasks/:id/observed-head')
  @HttpCode(200)
  async observedHead(
    @CurrentWorker() worker: WorkerPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ObservedHeadDto,
  ): Promise<{ invalidated: Review[]; matches: boolean }> {
    const task = await this.tasks.get(id);
    if (task.agent !== worker.agent || task.claimedBy !== worker.workerId) throw new NotFoundException(`Task ${id} not found`);
    return this.reviews.observeHead(task, dto.headSha);
  }

  /** Enabled projects this worker's agent may work in (for workspace preparation / allowlist sync). */
  @Get('projects')
  listProjects(@CurrentWorker() worker: WorkerPrincipal): { items: WorkerProjectView[] } {
    this.presence.touch(worker);
    return { items: this.projects.forWorker(worker.agent) };
  }

  /** Returns the next queued task for this worker's agent, or `{ task: null }` if there is none. */
  @Post('workers/claim')
  @HttpCode(200)
  async claim(@CurrentWorker() worker: WorkerPrincipal): Promise<{ task: Task | null }> {
    this.presence.touch(worker);
    return { task: await this.tasks.claimNext(worker) };
  }

  /** Extends the lease. Workers should stop and call cancel-ack when `cancelRequested` is true. */
  @Post('tasks/:id/heartbeat')
  @HttpCode(200)
  async heartbeat(
    @CurrentWorker() worker: WorkerPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ task: Task; cancelRequested: boolean }> {
    this.presence.touch(worker);
    const task = await this.tasks.heartbeat(worker, id);
    return { task, cancelRequested: task.status === 'cancel_requested' };
  }

  @Post('tasks/:id/complete')
  @HttpCode(200)
  async complete(
    @CurrentWorker() worker: WorkerPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CompleteTaskDto,
  ): Promise<{ task: Task }> {
    this.presence.touch(worker);
    const task = await this.tasks.complete(worker, id, dto.result);
    // A completed commit becomes reviewable (awaiting_approval) right away, and its approved test
    // commands are queued for the isolated test runner (if the project has any).
    this.reviews.ensureForTask(task);
    await this.testValidations.requestForCompletedTask(task);
    return { task };
  }

  @Post('tasks/:id/fail')
  @HttpCode(200)
  async fail(
    @CurrentWorker() worker: WorkerPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: FailTaskDto,
  ): Promise<{ task: Task }> {
    this.presence.touch(worker);
    return { task: await this.tasks.fail(worker, id, dto.error) };
  }

  /** Confirms that execution of a cancel_requested task has actually stopped. */
  @Post('tasks/:id/cancel-ack')
  @HttpCode(200)
  async acknowledgeCancel(
    @CurrentWorker() worker: WorkerPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ task: Task }> {
    this.presence.touch(worker);
    return { task: await this.tasks.acknowledgeCancel(worker, id) };
  }
}
