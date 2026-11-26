import { backoffDelay, sleep } from './backoff.js';
import type { WorkerConfig } from './config.js';
import { ControllerError, type ControllerClient, type RegistryProject, type Task } from './controller-client.js';
import type { Logger } from './logger.js';
import { runProcess, type RunResult } from './process-runner.js';
import { buildProjectPrompt, extractCommitSubject, hasAgentTrace } from './project-settings.js';
import type { AgentOutcome, AgentRunner } from './runners/agent-runner.js';
import { reportedRun, runOptions, type RunOptions, type RunOptionsError } from './runners/run-options.js';
import type { WorkerState } from './state.js';
import { WorkspaceError, type PreparedWorkspace, type Workspace, type WorkspaceSummary } from './workspace.js';

export type ExecutionOutcome = 'completed' | 'failed' | 'canceled' | 'interrupted' | 'lost';

/** What the worker sends as `result` / `error` (JSON-encoded) and keeps in its local reports. */
export interface WorkerReport {
  format: 'agent-worker/v1';
  taskId: string;
  agent: string;
  workerId: string;
  attempt: number;
  outcome: ExecutionOutcome;
  message: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTail: string;
  agentDetails: Record<string, unknown>;
  /** Model and effort the agent was started with (null = the CLI default). */
  run?: { model: string | null; effort: string | null };
  workspace: WorkspaceSummary | null;
  workspaceError: string | null;
}

type StopReason = 'cancel' | 'lost' | 'shutdown';

const MAX_MESSAGE_CHARS = 100_000;
const STDERR_TAIL_CHARS = 4_000;
const REPORT_ATTEMPTS = 8;
const REGISTRY_ATTEMPTS = 3;

/** The registry could not be read: the task is not run (fail closed). */
class RegistryUnavailableError extends Error {}

export interface ExecutorDeps {
  config: WorkerConfig;
  client: ControllerClient;
  workspace: Workspace;
  runner: AgentRunner;
  state: WorkerState;
  logger: Logger;
}

/**
 * Runs one claimed task end to end: workspace → agent process (with
 * heartbeats) → commit on the task branch → report. Never throws for task
 * problems; they become a `fail` report.
 */
export class TaskExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(task: Task, shutdown: AbortSignal): Promise<ExecutionOutcome> {
    const { config, state, logger } = this.deps;
    const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) =>
      logger[level](msg, { taskId: task.id, ...fields });

    log('info', 'Task claimed', {
      projectId: task.projectId,
      attempt: task.attempt,
      instructionChars: task.instruction.length,
      leaseExpiresAt: task.leaseExpiresAt,
    });
    this.warnIfLeaseTooShort(task, log);

    const control = new AbortController();
    let stopReason: StopReason | null = null;
    const stop = (reason: StopReason) => {
      if (stopReason) return;
      stopReason = reason;
      log('warn', `Stopping task: ${reason}`);
      control.abort();
    };
    const onShutdown = () => stop('shutdown');
    shutdown.addEventListener('abort', onShutdown, { once: true });
    if (shutdown.aborted) stop('shutdown');
    const heartbeat = this.startHeartbeat(task, stop, log);

    try {
      await state.saveCurrentTask({ taskId: task.id, startedAt: new Date().toISOString(), workspace: null });

      if (task.agent !== config.agent) {
        return await this.deliver(task, 'failed', this.report(task, 'failed', `Task is for ${task.agent}, this worker runs ${config.agent}`));
      }

      let options: RunOptions;
      try {
        options = runOptions(task);
      } catch (error) {
        return await this.deliver(task, 'failed', this.report(task, 'failed', (error as RunOptionsError).message));
      }

      let prepared: PreparedWorkspace;
      try {
        const project = task.projectId === null ? null : await this.registryProject(task.projectId);
        prepared = await this.deps.workspace.prepare(task, project);
      } catch (error) {
        const message =
          error instanceof WorkspaceError || error instanceof RegistryUnavailableError
            ? error.message
            : `Workspace setup failed: ${(error as Error).message}`;
        return await this.deliver(task, 'failed', this.report(task, 'failed', message));
      }
      await state.saveCurrentTask({ taskId: task.id, startedAt: new Date().toISOString(), workspace: prepared });

      let run: RunResult | null = null;
      if (!stopReason) {
        const invocation = this.deps.runner.buildInvocation({
          taskId: task.id,
          instruction: task.instruction,
          cwd: prepared.cwd,
          mode: prepared.mode,
          projectPrompt: prepared.settings
            ? buildProjectPrompt(prepared.settings, prepared.styleAnalysis ?? null, prepared.mode === 'write')
            : '',
          model: options.model,
          effort: options.effort,
        });
        log('info', 'Agent started', {
          mode: prepared.mode,
          cwd: prepared.cwd,
          branch: prepared.branch,
          model: options.model ?? config.model ?? 'cli-default',
          effort: options.effort ?? 'cli-default',
        });
        run = await runProcess(invocation.command, invocation.args, {
          cwd: prepared.cwd,
          env: invocation.env,
          stdin: invocation.stdin,
          timeoutMs: config.taskTimeoutMs,
          maxStdoutBytes: config.maxOutputBytes,
          maxStderrBytes: 256 * 1024,
          killGraceMs: config.killGraceMs,
          signal: control.signal,
        });
        log('info', 'Agent exited', {
          exitCode: run.exitCode,
          signal: run.signal,
          durationMs: run.durationMs,
          timedOut: run.timedOut,
          aborted: run.aborted,
          stdoutBytes: Buffer.byteLength(run.stdout),
        });
      }

      const outcome = run ? this.deps.runner.interpret(run) : null;
      let finalOutcome = this.decide(stopReason, run, outcome);
      // The agent's proposed subject is used only for a successful run of a project with a commit style.
      const subject =
        finalOutcome === 'completed' && outcome && prepared.settings && (prepared.settings.commitStyle.mode !== 'off' || prepared.settings.commitAuthor)
          ? extractCommitSubject(outcome.summary)
          : null;
      const owner = prepared.settings?.commitAuthor ?? null;

      let summary: WorkspaceSummary | null = null;
      let workspaceError: string | null = null;
      try {
        summary = await this.deps.workspace.finalize(prepared, owner ? ownerCommitMessage(task, subject) : commitMessage(config.workerId, task, finalOutcome, subject));
      } catch (error) {
        workspaceError = (error as Error).message;
        log('error', 'Could not commit task changes', { error: workspaceError });
      }

      let message = this.messageFor(finalOutcome, run, outcome);
      if (summary?.blockedPaths?.length) {
        log('warn', 'Agent changed forbidden paths; nothing committed', { paths: summary.blockedPaths.length });
        if (finalOutcome === 'completed') finalOutcome = 'failed';
        message =
          `Nothing was committed: the agent changed paths this project forbids (${summary.blockedPaths.join(', ')}). ` +
          `The changes stay uncommitted in the task worktree.\n\n${message}`;
      }
      const report = this.report(task, finalOutcome, message, run, outcome, summary, workspaceError);
      return await this.deliver(task, finalOutcome, report);
    } catch (error) {
      log('error', 'Unexpected executor error', { error: (error as Error).message });
      return await this.deliver(task, 'failed', this.report(task, 'failed', `Worker error: ${(error as Error).message}`));
    } finally {
      heartbeat.stop();
      shutdown.removeEventListener('abort', onShutdown);
      await state.clearCurrentTask().catch(() => {});
    }
  }

  /**
   * The registry entry for a project, read fresh for every task so registry changes apply without
   * restarting the worker. Missing = not enabled for this agent. Unreadable = not run.
   */
  private async registryProject(projectId: string): Promise<RegistryProject | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.deps.client.projects()).find((p) => p.id === projectId) ?? null;
      } catch (error) {
        const retryable = error instanceof ControllerError && error.retryable;
        if (!retryable || attempt + 1 >= REGISTRY_ATTEMPTS) {
          throw new RegistryUnavailableError(
            `Project registry unavailable (${(error as Error).message}); the task was not run`,
          );
        }
        await sleep(backoffDelay(attempt, { baseMs: 500, maxMs: 5_000 }));
      }
    }
  }

  private decide(stopReason: StopReason | null, run: RunResult | null, outcome: AgentOutcome | null): ExecutionOutcome {
    // The process finished on its own before a stop took effect: report what really happened.
    const stoppedEarly = run === null || run.aborted;
    if (stopReason === 'lost') return 'lost';
    if (stopReason === 'cancel' && stoppedEarly) return 'canceled';
    if (stopReason === 'shutdown' && stoppedEarly) return 'interrupted';
    return outcome?.ok && run && !run.timedOut ? 'completed' : 'failed';
  }

  private messageFor(result: ExecutionOutcome, run: RunResult | null, outcome: AgentOutcome | null): string {
    switch (result) {
      case 'canceled':
        return 'Canceled on request; the agent process was stopped.';
      case 'interrupted':
        return 'The worker was stopped while this task was running; the agent process was terminated.';
      case 'lost':
        return 'The worker lost ownership of the task (lease expired or task changed); the agent process was stopped.';
      default:
        if (run?.timedOut) return `Timed out after ${Math.round(this.deps.config.taskTimeoutMs / 1000)}s; the agent process was stopped.`;
        return outcome?.summary ?? 'No result';
    }
  }

  private report(
    task: Task,
    outcome: ExecutionOutcome,
    message: string,
    run: RunResult | null = null,
    agent: AgentOutcome | null = null,
    workspace: WorkspaceSummary | null = null,
    workspaceError: string | null = null,
  ): WorkerReport {
    return {
      format: 'agent-worker/v1',
      taskId: task.id,
      agent: this.deps.config.agent,
      workerId: this.deps.config.workerId,
      attempt: task.attempt,
      outcome,
      message: truncate(message, MAX_MESSAGE_CHARS),
      exitCode: run?.exitCode ?? null,
      signal: run?.signal ?? null,
      durationMs: run?.durationMs ?? null,
      timedOut: run?.timedOut ?? false,
      stdoutTruncated: run?.stdoutTruncated ?? false,
      stderrTail: run ? run.stderr.slice(-STDERR_TAIL_CHARS) : '',
      agentDetails: agent?.details ?? {},
      run: reportedRun(task, this.deps.config.model),
      workspace,
      workspaceError,
    };
  }

  /** Sends the final state to the controller, retrying transient failures. */
  private async deliver(task: Task, outcome: ExecutionOutcome, report: WorkerReport): Promise<ExecutionOutcome> {
    const { client, state, logger } = this.deps;
    await state.saveReport(task.id, report).catch(() => {});
    if (outcome === 'lost') {
      logger.warn('Task lost; not reporting', { taskId: task.id });
      return 'lost';
    }

    const body = JSON.stringify(report);
    const send = () => {
      if (outcome === 'completed') return client.complete(task.id, body);
      if (outcome === 'canceled') return client.cancelAck(task.id);
      return client.fail(task.id, body);
    };

    for (let attempt = 0; attempt < REPORT_ATTEMPTS; attempt++) {
      try {
        const updated = await send();
        logger.info('Task reported', { taskId: task.id, outcome, status: updated.status });
        return outcome;
      } catch (error) {
        if (!(error instanceof ControllerError)) throw error;
        if (!error.retryable) {
          logger.warn('Controller rejected the report; task no longer owned by this worker', {
            taskId: task.id,
            outcome,
            status: error.status,
            reason: error.message,
          });
          return 'lost';
        }
        const delay = backoffDelay(attempt, { baseMs: 1000, maxMs: 30_000 });
        logger.warn('Report failed; retrying', { taskId: task.id, attempt: attempt + 1, retryInMs: delay });
        await sleep(delay);
      }
    }
    logger.error('Giving up reporting; the lease will expire on the controller', { taskId: task.id, outcome });
    return 'lost';
  }

  private startHeartbeat(
    task: Task,
    stop: (reason: StopReason) => void,
    log: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void,
  ) {
    let inFlight = false;
    let stopped = false;
    const tick = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const { cancelRequested } = await this.deps.client.heartbeat(task.id);
        if (!stopped && cancelRequested) stop('cancel');
      } catch (error) {
        if (stopped) return;
        if (error instanceof ControllerError && !error.retryable) {
          log('warn', 'Heartbeat rejected', { status: error.status, reason: error.message });
          stop('lost');
        } else {
          log('warn', 'Heartbeat failed; will retry', { reason: (error as Error).message });
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void tick(), this.deps.config.heartbeatIntervalMs);
    return {
      stop() {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  private warnIfLeaseTooShort(task: Task, log: (level: 'warn', msg: string, fields?: Record<string, unknown>) => void) {
    if (!task.leaseExpiresAt) return;
    const leaseMs = Date.parse(task.leaseExpiresAt) - Date.now();
    if (leaseMs > 0 && this.deps.config.heartbeatIntervalMs > leaseMs / 3) {
      log('warn', 'Heartbeat interval is long compared to the lease; the task may expire', {
        heartbeatMs: this.deps.config.heartbeatIntervalMs,
        leaseMs,
      });
    }
  }
}

/**
 * Without a subject: the fixed worker format. With one (project commit style, successful run): the
 * agent's one-line subject, then the same task facts in the body. Either way the worker makes the
 * commit as itself (POLICY B: author and committer stay the worker identity).
 */
function commitMessage(workerId: string, task: Task, outcome: ExecutionOutcome, subject: string | null = null): string {
  if (subject) return `${subject}\n\n${workerId}: task ${task.id} (${outcome})\n\n${truncate(task.instruction, 2000)}\n`;
  return `${workerId}: task ${task.id} (${outcome})\n\n${truncate(task.instruction, 2000)}\n`;
}

/**
 * Commit message when the project has an owner commit author (POLICY B, 2026-11-24): only a subject,
 * written as the owner would. The agent's subject (already cleaned of agent traces), else the first
 * line of the request. No worker name, task id, outcome or trailers.
 */
export function ownerCommitMessage(task: Pick<Task, 'instruction'>, subject: string | null): string {
  if (subject) return `${subject}\n`;
  const first = task.instruction.split('\n').map((l) => l.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  const chars = [...first];
  const line = chars.length > 72 ? `${chars.slice(0, 71).join('').trimEnd()}…` : first;
  return `${hasAgentTrace(line) || !line ? 'Update project files' : line}\n`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}
