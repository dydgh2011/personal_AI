import type { AgentType } from '../tasks/task.model.js';

export const PROJECT_SOURCES = ['local', 'github'] as const;
export type ProjectSource = (typeof PROJECT_SOURCES)[number];

/** How the repository is reached. Only 'none' (public, anonymous) is used today. */
export const AUTH_MODES = ['none', 'token', 'github_app'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const SYNC_STATUSES = ['not_synced', 'synced', 'error'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export type Visibility = 'public' | 'private' | 'internal';

/**
 * A verification command an admin approved for a project. Run by the isolated test runner on the
 * exact commit under review, as argv (no shell unless argv itself names one), with no credentials.
 * Never taken from a task or an agent.
 */
export interface TestCommand {
  name: string;
  argv: string[];
  timeoutSeconds: number;
}

/**
 * A project tasks can run in. `id` is an opaque key (never a path); workers map
 * it to a directory under their own /workspace or the repository cache.
 */
export interface Project {
  id: string;
  source: ProjectSource;
  githubRepositoryId: number | null;
  /** "owner/repo" for GitHub projects. */
  fullName: string | null;
  /** HTTPS clone URL without credentials. */
  remoteUrl: string | null;
  defaultBranch: string;
  visibility: Visibility | null;
  allowedAgents: AgentType[];
  /** Disabled projects accept no tasks and are hidden from delegators. */
  enabled: boolean;
  /** false: workers may only read the project. */
  allowCodeChanges: boolean;
  authMode: AuthMode;
  description: string | null;
  syncStatus: SyncStatus;
  lastFetchedAt: string | null;
  cachedHeadSha: string | null;
  lastSyncError: string | null;
  /** Admin-approved verification commands (empty: none configured, nothing can be published). */
  testCommands: TestCommand[];
  createdAt: string;
  updatedAt: string;
}

/** What a delegator (Hermes) may see about a project. */
export interface DelegatorProjectView {
  id: string;
  source: ProjectSource;
  fullName: string | null;
  defaultBranch: string;
  visibility: Visibility | null;
  allowedAgents: AgentType[];
  allowCodeChanges: boolean;
  description: string | null;
  syncStatus: SyncStatus;
  lastFetchedAt: string | null;
}

/**
 * What a worker needs to prepare a workspace for a project. No remote URL: workers only read
 * the repository cache by project id and never contact a remote themselves.
 */
export interface WorkerProjectView {
  id: string;
  source: ProjectSource;
  defaultBranch: string;
  allowCodeChanges: boolean;
  cachedHeadSha: string | null;
  syncStatus: SyncStatus;
}

export function delegatorView(p: Project): DelegatorProjectView {
  return {
    id: p.id,
    source: p.source,
    fullName: p.fullName,
    defaultBranch: p.defaultBranch,
    visibility: p.visibility,
    allowedAgents: p.allowedAgents,
    allowCodeChanges: p.allowCodeChanges,
    description: p.description,
    syncStatus: p.syncStatus,
    lastFetchedAt: p.lastFetchedAt,
  };
}

export function workerView(p: Project): WorkerProjectView {
  return {
    id: p.id,
    source: p.source,
    defaultBranch: p.defaultBranch,
    allowCodeChanges: p.allowCodeChanges,
    cachedHeadSha: p.cachedHeadSha,
    syncStatus: p.syncStatus,
  };
}
