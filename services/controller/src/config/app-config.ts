import type { AgentType } from '../tasks/task.model.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface WorkerCredential {
  agent: AgentType;
  workerId: string;
  token: string;
}

export interface DelegatorCredential {
  clientId: string;
  token: string;
}

export interface StatusProbe {
  name: string;
  url: string;
}

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  adminToken: string;
  workers: WorkerCredential[];
  /** Restricted task-delegation clients (Hermes). Empty when not configured. */
  delegators: DelegatorCredential[];
  /** Admin Dashboard server token (admin role, recorded as 'dashboard'). null = not configured. */
  dashboardToken: string | null;
  /** GitHub Publisher token (publisher role). null = not configured. */
  publisherToken: string | null;
  /** Isolated test runner token (test-runner role). null = not configured. */
  testRunnerToken: string | null;
  /**
   * Whether publish requests (real pushes) are accepted at all. false by default; Phase E-2B
   * keeps it false - publishing is only exercised against mocks in tests.
   */
  publishEnabled: boolean;
  leaseSeconds: number;
  /** How often expired leases are failed; 0 disables the sweep (tests). */
  leaseSweepSeconds: number;
  projectIds: string[];
  statusProbes: StatusProbe[];
  /** A repeated POST /tasks with the same Idempotency-Key within this window returns the first task. */
  idempotencyWindowSeconds: number;
  github: GitHubConfig;
}

export interface GitHubConfig {
  /** GitHub REST API base URL (tests point it at a mock). */
  apiUrl: string;
  /** Optional read-only token file. Unset = anonymous: public repositories only. */
  tokenFile: string | null;
}

export const MIN_TOKEN_LENGTH = 32;
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROBE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class ConfigError extends Error {}

/**
 * Builds the controller configuration from environment variables and fails
 * fast on anything missing or unsafe. Error messages name the variable but
 * never include its value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  const token = (name: string): string => {
    const value = env[name]?.trim() ?? '';
    if (!value) {
      problems.push(`${name} is required`);
    } else if (value.length < MIN_TOKEN_LENGTH) {
      problems.push(`${name} must be at least ${MIN_TOKEN_LENGTH} characters`);
    }
    return value;
  };

  const adminToken = token('CONTROLLER_ADMIN_TOKEN');
  const workers: WorkerCredential[] = [
    { agent: 'claude', workerId: 'claude-worker', token: token('CONTROLLER_CLAUDE_WORKER_TOKEN') },
    { agent: 'codex', workerId: 'codex-worker', token: token('CONTROLLER_CODEX_WORKER_TOKEN') },
  ];

  // Optional: Hermes' restricted token. Unset means no delegator can authenticate.
  const delegators: DelegatorCredential[] = [];
  if (env.CONTROLLER_HERMES_TOKEN?.trim()) {
    delegators.push({ clientId: 'hermes', token: token('CONTROLLER_HERMES_TOKEN') });
  }

  const dashboardToken = env.CONTROLLER_DASHBOARD_TOKEN?.trim() ? token('CONTROLLER_DASHBOARD_TOKEN') : null;
  const publisherToken = env.CONTROLLER_PUBLISHER_TOKEN?.trim() ? token('CONTROLLER_PUBLISHER_TOKEN') : null;
  const testRunnerToken = env.CONTROLLER_TEST_RUNNER_TOKEN?.trim() ? token('CONTROLLER_TEST_RUNNER_TOKEN') : null;
  const publishEnabled = env.CONTROLLER_PUBLISH_ENABLED?.trim() === 'true';

  const allTokens = [adminToken, ...workers.map((w) => w.token), ...delegators.map((d) => d.token), dashboardToken ?? '', publisherToken ?? '', testRunnerToken ?? ''].filter(Boolean);
  if (new Set(allTokens).size !== allTokens.length) {
    problems.push('Admin, worker and delegator tokens must all be different');
  }

  const port = parseInteger(env.PORT, 3000);
  if (port === null || port < 1 || port > 65535) {
    problems.push('PORT must be an integer between 1 and 65535');
  }

  const leaseSeconds = parseInteger(env.CONTROLLER_LEASE_SECONDS, 900);
  if (leaseSeconds === null || leaseSeconds < 30 || leaseSeconds > 86400) {
    problems.push('CONTROLLER_LEASE_SECONDS must be an integer between 30 and 86400');
  }

  const leaseSweepSeconds = parseInteger(env.CONTROLLER_LEASE_SWEEP_SECONDS, 15);
  if (leaseSweepSeconds === null || leaseSweepSeconds < 1 || leaseSweepSeconds > 3600) {
    problems.push('CONTROLLER_LEASE_SWEEP_SECONDS must be an integer between 1 and 3600');
  }

  const idempotencyWindowSeconds = parseInteger(env.CONTROLLER_IDEMPOTENCY_WINDOW_SECONDS, 600);
  if (idempotencyWindowSeconds === null || idempotencyWindowSeconds < 1 || idempotencyWindowSeconds > 86400) {
    problems.push('CONTROLLER_IDEMPOTENCY_WINDOW_SECONDS must be an integer between 1 and 86400');
  }

  const githubApiUrl = (env.GITHUB_API_URL?.trim() || 'https://api.github.com').replace(/\/+$/, '');
  if (!isHttpUrl(githubApiUrl)) problems.push('GITHUB_API_URL must be an http(s) URL');

  const projectIds = splitList(env.CONTROLLER_PROJECT_IDS);
  for (const id of projectIds) {
    if (!PROJECT_ID_PATTERN.test(id)) {
      problems.push(`CONTROLLER_PROJECT_IDS contains an invalid project id: "${id}"`);
    }
  }

  const statusProbes: StatusProbe[] = [];
  for (const entry of splitList(env.CONTROLLER_STATUS_PROBES)) {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator);
    const url = entry.slice(separator + 1);
    if (separator < 1 || !PROBE_NAME_PATTERN.test(name) || !isHttpUrl(url)) {
      problems.push('CONTROLLER_STATUS_PROBES entries must look like name=http://host:port/path');
      continue;
    }
    statusProbes.push({ name, url });
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid controller configuration:\n - ${problems.join('\n - ')}`);
  }

  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: port!,
    databasePath: env.CONTROLLER_DB_PATH?.trim() || './data/controller.db',
    adminToken,
    workers,
    delegators,
    dashboardToken,
    publisherToken,
    testRunnerToken,
    publishEnabled,
    leaseSeconds: leaseSeconds!,
    leaseSweepSeconds: leaseSweepSeconds!,
    projectIds,
    statusProbes,
    idempotencyWindowSeconds: idempotencyWindowSeconds!,
    github: { apiUrl: githubApiUrl, tokenFile: env.GITHUB_TOKEN_FILE?.trim() || null },
  };
}

function parseInteger(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
