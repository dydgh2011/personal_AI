import type { TaskStatus } from './task.model.js';

/**
 * Every state change a task can go through, keyed by the action that causes
 * it. Repositories apply these as compare-and-set updates
 * (`UPDATE ... WHERE status IN (from)`), so a transition only happens if the
 * task is still in one of the expected source states.
 *
 *   queued ──claim──▶ running ──complete──▶ completed
 *     │                 │   └────fail─────▶ failed
 *     │                 └─cancel─▶ cancel_requested ──acknowledge──▶ canceled
 *     └─────────cancel───────────────────────────────────────────────▶ canceled
 *
 * A worker that finishes before it notices a cancel request may still report
 * completed/failed from cancel_requested, so the real outcome is recorded.
 *
 * Worker transitions additionally require an unexpired lease. When a lease
 * runs out the controller moves the task to failed (expireLease) instead of
 * re-queuing it: a coding task that half-ran must be inspected before retrying.
 */
export const TRANSITIONS = {
  claim: { from: ['queued'], to: 'running' },
  heartbeat: { from: ['running', 'cancel_requested'], to: null },
  complete: { from: ['running', 'cancel_requested'], to: 'completed' },
  fail: { from: ['running', 'cancel_requested'], to: 'failed' },
  cancelQueued: { from: ['queued'], to: 'canceled' },
  requestCancel: { from: ['running'], to: 'cancel_requested' },
  acknowledgeCancel: { from: ['cancel_requested'], to: 'canceled' },
  expireLease: { from: ['running', 'cancel_requested'], to: 'failed' },
} as const satisfies Record<string, { from: readonly TaskStatus[]; to: TaskStatus | null }>;

export type TransitionName = keyof typeof TRANSITIONS;

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'canceled'];

/** Statuses in which a worker holds a claim on the task. */
export const CLAIMED_STATUSES: readonly TaskStatus[] = ['running', 'cancel_requested'];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canApply(transition: TransitionName, status: TaskStatus): boolean {
  return (TRANSITIONS[transition].from as readonly TaskStatus[]).includes(status);
}
