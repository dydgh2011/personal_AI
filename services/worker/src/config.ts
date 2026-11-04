export const AGENT_TYPES = ['claude', 'codex'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

/** Same rule as the controller: project ids are opaque keys, never paths. */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface WorkerConfig {
  agent: AgentType;
  workerId: string;
  controllerUrl: string;
  token: string;
  /** Root of everything the agent may touch: /workspace in the container. */
  workspaceRoot: string;
  /** Worker bookkeeping (lock, current task, local reports). Not visible to the agent. */
  stateDir: string;
  /**
   * Optional extra restriction on top of the controller's project registry (WORKER_PROJECTS).
   * null = no extra restriction: the registry alone decides.
   */
  projects: string[] | null;
  /** Optional extra restriction on where files may change (WORKER_WRITABLE_PROJECTS). null = registry decides. */
  writableProjects: string[] | null;
  /** Read-only repository cache maintained by repo-sync: <root>/<projectId>.git */
  repoCacheRoot: string;
  /** Refuse GitHub projects whose cached repository is larger than this. */
  maxRepoBytes: number;
  /**
   * Where task commits of GitHub projects are exported as git bundles for the GitHub Publisher
   * (WORKER_ARTIFACT_DIR, a volume only this worker writes). null = no export.
   */
  artifactRoot: string | null;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  taskTimeoutMs: number;
  maxOutputBytes: number;
  killGraceMs: number;
  /** Executable plus fixed leading arguments, e.g. ["claude"]. */
  agentCommand: string[];
  model: string | null;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const problems: string[] = [];

  const agent = (env.WORKER_AGENT ?? 'claude').trim() as AgentType;
  if (!AGENT_TYPES.includes(agent)) problems.push(`WORKER_AGENT must be one of ${AGENT_TYPES.join(', ')}`);

  const controllerUrl = (env.CONTROLLER_URL ?? '').trim().replace(/\/+$/, '');
  if (!isHttpUrl(controllerUrl)) problems.push('CONTROLLER_URL must be an http(s) URL');

  const token = (env.CONTROLLER_WORKER_TOKEN ?? '').trim();
  if (token.length < 32) problems.push('CONTROLLER_WORKER_TOKEN is required (>= 32 characters)');

  const projects = env.WORKER_PROJECTS?.trim() ? list(env.WORKER_PROJECTS) : null;
  const writableProjects = env.WORKER_WRITABLE_PROJECTS?.trim() ? list(env.WORKER_WRITABLE_PROJECTS) : null;
  for (const id of [...(projects ?? []), ...(writableProjects ?? [])]) {
    if (!PROJECT_ID_PATTERN.test(id)) problems.push(`WORKER_PROJECTS / WORKER_WRITABLE_PROJECTS contain an invalid project id: "${id}"`);
  }
  for (const id of writableProjects ?? []) {
    if (projects && !projects.includes(id)) problems.push(`WORKER_WRITABLE_PROJECTS entry "${id}" is not in WORKER_PROJECTS`);
  }

  const seconds = (name: string, fallback: number, min: number, max: number): number => {
    const value = int(env[name], fallback);
    if (value === null || value < min || value > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  };
  const pollSeconds = seconds('WORKER_POLL_INTERVAL_SECONDS', 5, 1, 3600);
  const heartbeatSeconds = seconds('WORKER_HEARTBEAT_SECONDS', 30, 1, 3600);
  const timeoutSeconds = seconds('WORKER_TASK_TIMEOUT_SECONDS', 1800, 10, 86400);
  const maxOutputBytes = seconds('WORKER_MAX_OUTPUT_BYTES', 2 * 1024 * 1024, 1024, 64 * 1024 * 1024);
  const maxRepoBytes = seconds('WORKER_MAX_REPO_BYTES', 1024 ** 3, 1024, 16 * 1024 ** 3);

  let agentCommand = [agent as string];
  if (env.WORKER_AGENT_COMMAND?.trim()) {
    try {
      const parsed: unknown = JSON.parse(env.WORKER_AGENT_COMMAND);
      if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === 'string' && p)) {
        throw new Error();
      }
      agentCommand = parsed;
    } catch {
      problems.push('WORKER_AGENT_COMMAND must be a JSON array of strings, e.g. ["claude"]');
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid worker configuration:\n - ${problems.join('\n - ')}`);
  }

  return {
    agent,
    workerId: `${agent}-worker`,
    controllerUrl,
    token,
    workspaceRoot: env.WORKER_WORKSPACE_ROOT?.trim() || '/workspace',
    stateDir: env.WORKER_STATE_DIR?.trim() || '/home/node/.agent-worker',
    projects,
    writableProjects,
    repoCacheRoot: env.WORKER_REPO_CACHE?.trim() || '/repo-cache',
    maxRepoBytes,
    artifactRoot: env.WORKER_ARTIFACT_DIR?.trim() || null,
    pollIntervalMs: pollSeconds * 1000,
    heartbeatIntervalMs: heartbeatSeconds * 1000,
    taskTimeoutMs: timeoutSeconds * 1000,
    maxOutputBytes,
    killGraceMs: 10_000,
    agentCommand,
    model: env.WORKER_MODEL?.trim() || null,
  };
}

function list(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function int(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
