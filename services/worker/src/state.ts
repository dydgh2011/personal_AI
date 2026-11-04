import { hostname } from 'node:os';
import { mkdir, open, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PreparedWorkspace } from './workspace.js';

/** Local bookkeeping in WORKER_STATE_DIR. Survives container restarts; never shown to the agent. */
export interface CurrentTaskRecord {
  taskId: string;
  startedAt: string;
  workspace: PreparedWorkspace | null;
}

export class WorkerState {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(join(this.dir, 'reports'), { recursive: true });
  }

  async saveCurrentTask(record: CurrentTaskRecord): Promise<void> {
    await writeFile(this.currentTaskPath, JSON.stringify(record, null, 2));
  }

  async readCurrentTask(): Promise<CurrentTaskRecord | null> {
    try {
      return JSON.parse(await readFile(this.currentTaskPath, 'utf8')) as CurrentTaskRecord;
    } catch {
      return null;
    }
  }

  async clearCurrentTask(): Promise<void> {
    await rm(this.currentTaskPath, { force: true });
  }

  /** Keeps a copy of every final report, so nothing is lost if the controller cannot be told. */
  async saveReport(taskId: string, report: unknown): Promise<void> {
    await writeFile(join(this.dir, 'reports', `${taskId}.json`), JSON.stringify(report, null, 2));
  }

  private get currentTaskPath(): string {
    return join(this.dir, 'current-task.json');
  }
}

export class LockError extends Error {}

/** Lock files held by this process right now (a same-pid lock not in here is a leftover). */
const heldByThisProcess = new Set<string>();

/**
 * Ensures only one worker process runs per state directory (and therefore per
 * workspace). The lock file's mtime is refreshed periodically; a lock is stale
 * when it was not refreshed recently, or when it was written by this same
 * container under a pid that is no longer running (or is ours after a restart).
 */
export class InstanceLock {
  private timer: NodeJS.Timeout | null = null;
  private readonly path: string;

  constructor(
    dir: string,
    private readonly staleAfterMs = 90_000,
    private readonly refreshMs = 20_000,
  ) {
    this.path = join(dir, 'worker.lock');
  }

  get file(): string {
    return this.path;
  }

  async acquire(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.path, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }));
        await handle.close();
        heldByThisProcess.add(this.path);
        this.timer = setInterval(() => void this.refresh(), this.refreshMs);
        this.timer.unref();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!(await this.isStale())) {
          throw new LockError(`Another worker instance holds ${this.path}`);
        }
        await rm(this.path, { force: true });
      }
    }
    throw new LockError(`Could not acquire ${this.path}`);
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!heldByThisProcess.delete(this.path)) return;
    await rm(this.path, { force: true });
  }

  private async refresh(): Promise<void> {
    const now = new Date();
    await utimes(this.path, now, now).catch(() => {});
  }

  private async isStale(): Promise<boolean> {
    if (heldByThisProcess.has(this.path)) return false;
    try {
      const [info, raw] = await Promise.all([stat(this.path), readFile(this.path, 'utf8')]);
      if (Date.now() - info.mtimeMs > this.staleAfterMs) return true;
      const owner = JSON.parse(raw) as { pid?: number; hostname?: string };
      if (owner.hostname !== hostname()) return false;
      return owner.pid === process.pid || !isRunning(owner.pid);
    } catch {
      return true;
    }
  }
}

function isRunning(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
