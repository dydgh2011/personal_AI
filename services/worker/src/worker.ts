import { backoffDelay, sleep } from './backoff.js';
import type { WorkerConfig } from './config.js';
import { ControllerError, type ControllerClient } from './controller-client.js';
import { TaskExecutor, type WorkerReport } from './executor.js';
import type { Logger } from './logger.js';
import type { AgentRunner } from './runners/agent-runner.js';
import { InstanceLock, type WorkerState } from './state.js';
import type { Workspace, WorkspaceSummary } from './workspace.js';

export interface WorkerDeps {
  config: WorkerConfig;
  client: ControllerClient;
  workspace: Workspace;
  runner: AgentRunner;
  state: WorkerState;
  lock: InstanceLock;
  logger: Logger;
}

const RECONNECT_BACKOFF = { baseMs: 1000, maxMs: 60_000 };

/**
 * Long-running poll loop: claim → execute → repeat, one task at a time.
 * Controller outages are retried with capped exponential backoff.
 */
export class Worker {
  private readonly stopping = new AbortController();
  private readonly executor: TaskExecutor;

  constructor(private readonly deps: WorkerDeps) {
    this.executor = new TaskExecutor(deps);
  }

  /** Resolves when the worker has stopped. Throws if it cannot start (e.g. lock held). */
  async run(): Promise<void> {
    const { state, lock, workspace, logger, config } = this.deps;
    await state.init();
    await lock.acquire();
    try {
      await workspace.init();
      logger.info('Worker started', {
        agent: config.agent,
        controller: config.controllerUrl,
        projects: config.projects ?? 'registry',
        writableProjects: config.writableProjects ?? 'registry',
        repoCache: config.repoCacheRoot,
      });
      await this.recoverInterruptedTask();
      await this.loop();
    } finally {
      await lock.release();
      logger.info('Worker stopped');
    }
  }

  stop(): void {
    this.stopping.abort();
  }

  private async loop(): Promise<void> {
    const signal = this.stopping.signal;
    const { client, logger, config } = this.deps;
    let failures = 0;

    while (!signal.aborted) {
      let task;
      try {
        task = await client.claim();
        if (failures > 0) logger.info('Controller reachable again', { afterFailures: failures });
        failures = 0;
      } catch (error) {
        if (!(error instanceof ControllerError)) {
          logger.error('Unexpected error while claiming', { error: (error as Error).message });
        }
        const delay = backoffDelay(failures++, RECONNECT_BACKOFF);
        const status = error instanceof ControllerError ? error.status : null;
        logger.warn(status === 401 || status === 403 ? 'Controller rejected worker token' : 'Controller unavailable', {
          status,
          retryInMs: delay,
        });
        await sleep(delay, signal);
        continue;
      }

      if (!task) {
        await sleep(config.pollIntervalMs, signal);
        continue;
      }
      try {
        await this.executor.execute(task, signal);
      } catch (error) {
        logger.error('Task execution crashed', { taskId: task.id, error: (error as Error).message });
      }
    }
  }

  /**
   * If the previous process died mid-task, commit what it left on the task
   * branch and report the task as failed rather than waiting for its lease to
   * expire. The task is never re-run automatically.
   */
  private async recoverInterruptedTask(): Promise<void> {
    const { state, workspace, client, logger, config } = this.deps;
    const record = await state.readCurrentTask();
    if (!record) return;
    logger.warn('Found a task interrupted by a worker restart', { taskId: record.taskId });

    let summary: WorkspaceSummary | null = null;
    let workspaceError: string | null = null;
    if (record.workspace) {
      try {
        summary = await workspace.finalize(record.workspace, `${config.workerId}: task ${record.taskId} (interrupted)\n`);
      } catch (error) {
        workspaceError = (error as Error).message;
      }
    }
    const report: WorkerReport = {
      format: 'agent-worker/v1',
      taskId: record.taskId,
      agent: config.agent,
      workerId: config.workerId,
      attempt: 0,
      outcome: 'interrupted',
      message: `The worker restarted while this task was running (started ${record.startedAt}). It was not retried.`,
      exitCode: null,
      signal: null,
      durationMs: null,
      timedOut: false,
      stdoutTruncated: false,
      stderrTail: '',
      agentDetails: {},
      workspace: summary,
      workspaceError,
    };
    await state.saveReport(record.taskId, report).catch(() => {});
    try {
      await client.fail(record.taskId, JSON.stringify(report));
      logger.info('Interrupted task reported as failed', { taskId: record.taskId });
    } catch (error) {
      const status = error instanceof ControllerError ? error.status : null;
      // 409/404: already finished or expired. Unreachable: the controller's lease sweep will fail it.
      logger.warn('Could not report interrupted task', { taskId: record.taskId, status, reason: (error as Error).message });
    }
    await state.clearCurrentTask();
  }
}
