import type { AuthReport } from './auth.js';
import type { AgentType } from './config.js';

/** Subset of the controller's Task model the worker relies on. */
export interface Task {
  id: string;
  agent: AgentType;
  projectId: string | null;
  instruction: string;
  status: string;
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  attempt: number;
}

/**
 * A project as the controller's registry hands it to this worker (GET /internal/projects):
 * only enabled projects whose allowedAgents include this worker's agent are listed.
 * The worker never uses a path or remote URL from anywhere else.
 */
export interface RegistryProject {
  id: string;
  source: 'local' | 'github';
  defaultBranch: string;
  allowCodeChanges: boolean;
  /** GitHub projects: commit of the default branch last fetched into the repository cache. */
  cachedHeadSha: string | null;
  syncStatus: 'not_synced' | 'synced' | 'error';
  /** Registry v7 (absent from older controllers = nothing configured). Checked by project-settings.ts. */
  commitStyle?: { mode: 'off' | 'auto' | 'manual'; guide: string | null };
  agentInstructions?: { rules: string; forbiddenPaths: string[] };
}

export class ControllerError extends Error {
  constructor(
    message: string,
    /** HTTP status, or null when the controller could not be reached. */
    readonly status: number | null,
  ) {
    super(message);
  }

  /** Network failures, timeouts, 429 and 5xx are worth retrying; other 4xx are final. */
  get retryable(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

/**
 * HTTP client for the controller's /internal worker API.
 * Authentication: `Authorization: Bearer <worker token>`. The token decides
 * which agent's tasks this worker sees; it never appears in errors or logs.
 */
export class ControllerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async claim(): Promise<Task | null> {
    return (await this.post<{ task: Task | null }>('/internal/workers/claim')).task;
  }

  heartbeat(taskId: string): Promise<{ task: Task; cancelRequested: boolean }> {
    return this.post(`/internal/tasks/${encodeURIComponent(taskId)}/heartbeat`);
  }

  async complete(taskId: string, result: string): Promise<Task> {
    return (await this.post<{ task: Task }>(`/internal/tasks/${encodeURIComponent(taskId)}/complete`, { result })).task;
  }

  async fail(taskId: string, error: string): Promise<Task> {
    return (await this.post<{ task: Task }>(`/internal/tasks/${encodeURIComponent(taskId)}/fail`, { error })).task;
  }

  async cancelAck(taskId: string): Promise<Task> {
    return (await this.post<{ task: Task }>(`/internal/tasks/${encodeURIComponent(taskId)}/cancel-ack`)).task;
  }

  /** Reports the CLI login state; returns whether a login was requested and, once, a submitted login code. */
  reportAuth(report: AuthReport): Promise<{ requested: boolean; code: string | null }> {
    return this.post('/internal/workers/auth', report);
  }

  /** Projects this worker may run tasks in, straight from the registry. */
  async projects(): Promise<RegistryProject[]> {
    return (await this.request<{ items: RegistryProject[] }>('GET', '/internal/projects')).items;
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new ControllerError(`Controller ${reason} (${method} ${path})`, null);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new ControllerError(`Controller returned ${response.status} for ${method} ${path}: ${describe(text)}`, response.status);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ControllerError(`Controller sent invalid JSON for ${method} ${path}`, response.status);
    }
  }
}

function describe(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    const message = Array.isArray(parsed.message) ? parsed.message.join('; ') : parsed.message;
    if (typeof message === 'string') return message.slice(0, 300);
  } catch {
    // fall through
  }
  return body.slice(0, 300);
}
