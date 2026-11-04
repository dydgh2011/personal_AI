/** Shapes of the controller API as the dashboard uses them (subset). */
export interface Task {
  id: string;
  agent: 'claude' | 'codex';
  projectId: string | null;
  instruction: string;
  status: string;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  claimedBy: string | null;
  attempt: number;
  createdBy?: string;
}

export interface TaskList {
  items: Task[];
  total: number;
  limit: number;
  offset: number;
}

export interface SystemStatus {
  controller: { status: string; version: string; uptimeSeconds: number };
  database: { status: string };
  tasks: { total: number; byStatus: Record<string, number> };
  workers: Array<{ agent: string; workerId: string; lastSeenAt: string | null; queuedTasks: number; activeTasks: number }>;
  projects: string[];
  services: Array<{ name: string; status: string; httpStatus?: number; latencyMs?: number; error?: string }>;
}

export interface Project {
  id: string;
  source: 'local' | 'github';
  fullName: string | null;
  defaultBranch: string;
  visibility: string | null;
  allowedAgents: string[];
  enabled: boolean;
  allowCodeChanges: boolean;
  authMode: string;
  syncStatus: string;
  lastFetchedAt: string | null;
  cachedHeadSha: string | null;
  lastSyncError: string | null;
  description: string | null;
}

export interface Review {
  id: string;
  taskId: string;
  projectId: string;
  agent: string;
  baseSha: string;
  headSha: string;
  headTree: string | null;
  status: 'awaiting_approval' | 'approved' | 'rejected' | 'invalidated';
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  invalidatedReason: string | null;
  createdAt: string;
}

export interface DiffFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  sensitive: boolean;
}

export interface DiffResponse {
  taskId: string;
  projectId: string;
  agent: string;
  baseSha: string;
  headSha: string;
  headTree: string | null;
  commitMessage: string | null;
  additions: number | null;
  deletions: number | null;
  files: DiffFile[];
  patch: string | null;
  patchWithheld: string | null;
  patchTruncated: boolean;
  omittedFiles: string[];
  tests: unknown;
  review: Review | null;
  history: Review[];
}

export interface ReviewResponse {
  current: Review;
  history: Review[];
}

/** agent-worker/v1 report fields the task page shows. */
export interface WorkerReport {
  outcome?: string;
  message?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  timedOut?: boolean;
  stderrTail?: string;
  workspace?: { branch?: string | null; baseCommit?: string | null; commit?: string | null; changedFiles?: Array<{ status: string; path: string }>; path?: string; notes?: string[] } | null;
  workspaceError?: string | null;
}

/** Publication of an approved commit (GitHub Publisher). E-2A: dry-run validation only. */
export type PublicationState =
  | 'not_approved'
  | 'approved'
  | 'validation_pending'
  | 'ready_to_publish'
  | 'validation_failed'
  | 'published'
  | 'pr_created';

export interface PublicationCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** One run of the project's approved test commands by the isolated test runner. */
export interface TestValidation {
  id: string;
  taskId: string;
  projectId: string;
  baseSha: string;
  commitSha: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'aborted';
  commands: Array<{ name: string; argv: string[]; timeoutSeconds: number }>;
  results: Array<{ name: string; argv: string[]; status: string; exitCode: number | null; timedOut: boolean; durationMs: number; outputTail: string }> | null;
  requestedBy: string;
  requestedAt: string;
  completedAt: string | null;
  evidenceHash: string | null;
  error: string | null;
}

export interface PublishAuthorization {
  id: string;
  headSha: string;
  testValidationId: string;
  dryRunId: string;
  repositoryId: number;
  authorizedBy: string;
  authorizedAt: string;
  expiresAt: string;
  status: 'active' | 'used' | 'expired' | 'revoked';
  usedAt: string | null;
}

export interface PublicationReport {
  mode?: string;
  gitVerified?: boolean;
  eligible?: boolean;
  canPublish?: boolean;
  reason?: string | null;
  reasons?: string[];
  testValidationId?: string | null;
  tests?: { status: string | null; commitSha: string | null; commands: Array<{ name: string; argv: string[]; exitCode: number | null; status: string }>; evidenceHash: string | null; signatureValid: boolean };
  author?: { name: string; email: string; committerName: string; committerEmail: string; message: string } | null;
  policy?: { tests: string; commitAuthor: string };
  checks?: Array<PublicationCheck & { code?: string }>;
  blockers?: string[];
  warnings?: string[];
  target?: { repository: string | null; baseBranch: string | null; branch: string; baseSha: string | null; headSha: string; headTree: string | null };
  commits?: Array<{ sha: string; subject: string; author: string }>;
  files?: Array<{ status: string; path: string }>;
  pullRequest?: { title: string; body: string; head: string; base: string; draft: boolean } | null;
  pushPerformed?: boolean;
  pullRequestCreated?: boolean;
  verifiedAt?: string;
  error?: string;
  controllerNote?: string;
}

export interface Publication {
  id: string;
  taskId: string;
  reviewId: string;
  headSha: string;
  mode: string;
  status: 'pending' | 'validating' | 'ready' | 'failed' | 'published' | 'pr_created';
  requestedBy: string;
  requestedAt: string;
  attempts: number;
  completedAt: string | null;
  result: PublicationReport | null;
}

export interface PublicationStatus {
  state: PublicationState;
  review: Review | null;
  current: Publication | null;
  history: Publication[];
  testValidation: TestValidation | null;
  authorization: PublishAuthorization | null;
  publishEnabled: boolean;
}
