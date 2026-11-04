import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig, type StatusProbe } from '../config/app-config.js';
import { CLAIMED_STATUSES } from '../tasks/task-state.js';
import { TASK_STATUSES, type AgentType, type TaskStatus } from '../tasks/task.model.js';
import { TaskRepository } from '../tasks/task.repository.js';
import { ProjectsService } from '../projects/projects.service.js';
import { WorkerPresence } from '../workers/worker-presence.js';

export const CONTROLLER_VERSION = '0.1.0';
const PROBE_TIMEOUT_MS = 2000;

export interface ServiceProbeResult {
  name: string;
  status: 'reachable' | 'unreachable';
  httpStatus?: number;
  latencyMs?: number;
  error?: string;
}

export interface SystemStatus {
  controller: {
    status: 'ok';
    version: string;
    startedAt: string;
    uptimeSeconds: number;
    nodeVersion: string;
  };
  database: { status: 'ok' | 'error' };
  tasks: { total: number; byStatus: Record<TaskStatus, number> };
  workers: Array<{
    agent: AgentType;
    workerId: string;
    lastSeenAt: string | null;
    queuedTasks: number;
    activeTasks: number;
  }>;
  projects: string[];
  services: ServiceProbeResult[];
}

@Injectable()
export class SystemStatusService {
  private readonly startedAt: Date;

  constructor(
    private readonly repository: TaskRepository,
    private readonly presence: WorkerPresence,
    private readonly projects: ProjectsService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.startedAt = clock.now();
  }

  async isDatabaseHealthy(): Promise<boolean> {
    try {
      await this.repository.ping();
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<SystemStatus> {
    const [databaseOk, counts, services] = await Promise.all([
      this.isDatabaseHealthy(),
      this.repository.countByAgentAndStatus().catch(() => []),
      Promise.all(this.config.statusProbes.map((probe) => this.probe(probe))),
    ]);

    const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    for (const row of counts) byStatus[row.status] += row.count;
    const countFor = (agent: AgentType, statuses: readonly TaskStatus[]) =>
      counts
        .filter((row) => row.agent === agent && statuses.includes(row.status))
        .reduce((sum, row) => sum + row.count, 0);

    const now = this.clock.now();
    return {
      controller: {
        status: 'ok',
        version: CONTROLLER_VERSION,
        startedAt: this.startedAt.toISOString(),
        uptimeSeconds: Math.floor((now.getTime() - this.startedAt.getTime()) / 1000),
        nodeVersion: process.version,
      },
      database: { status: databaseOk ? 'ok' : 'error' },
      tasks: { total: counts.reduce((sum, row) => sum + row.count, 0), byStatus },
      workers: this.config.workers.map(({ agent, workerId }) => ({
        agent,
        workerId,
        lastSeenAt: this.presence.lastSeenAt(workerId),
        queuedTasks: countFor(agent, ['queued']),
        activeTasks: countFor(agent, CLAIMED_STATUSES),
      })),
      projects: this.projects.enabledIds(),
      services,
    };
  }

  /** Any HTTP response counts as reachable; only connection errors and timeouts do not. */
  private async probe({ name, url }: StatusProbe): Promise<ServiceProbeResult> {
    const started = performance.now();
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      await response.body?.cancel();
      return {
        name,
        status: 'reachable',
        httpStatus: response.status,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return { name, status: 'unreachable', error: timedOut ? 'timeout' : 'connection failed' };
    }
  }
}
