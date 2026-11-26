export const AGENT_TYPES = ['claude', 'codex'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const TASK_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancel_requested',
  'canceled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A task as stored by the controller and returned by the API. */
export interface Task {
  id: string;
  agent: AgentType;
  projectId: string | null;
  instruction: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt: string | null;
  /** Worker that currently owns (or last owned) the task. */
  claimedBy: string | null;
  /** The claim is considered abandoned after this time unless renewed by a heartbeat. */
  leaseExpiresAt: string | null;
  /** Number of times the task has been claimed. */
  attempt: number;
  /** "admin" or "delegator:<clientId>". */
  createdBy: string;
  /** Client-supplied Idempotency-Key of the request that created the task, if any. */
  idempotencyKey: string | null;
  /** Model the worker runs with (requested, else the agent's default when created); null = CLI default. */
  model: string | null;
  /** Reasoning effort (run-settings.ts EFFORT_LEVELS), chosen the same way; null = CLI default. */
  effort: string | null;
}
