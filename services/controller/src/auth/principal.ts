import type { Request } from 'express';
import type { AgentType } from '../tasks/task.model.js';

export type Role = 'admin' | 'worker' | 'delegator' | 'publisher' | 'test-runner';

export interface AdminPrincipal {
  role: 'admin';
  /** Which admin credential: 'admin' (operator token) or 'dashboard' (Admin Dashboard server). */
  name?: string;
}

export interface WorkerPrincipal {
  role: 'worker';
  agent: AgentType;
  workerId: string;
}

/**
 * A client that delegates work on behalf of the user (Hermes). It may create
 * tasks in registered projects and see or cancel only the tasks it created.
 */
export interface DelegatorPrincipal {
  role: 'delegator';
  clientId: string;
}

/**
 * The GitHub Publisher (Phase E-2). It may only claim publication requests an admin made and
 * report their results; it cannot create, approve or change tasks or reviews.
 */
export interface PublisherPrincipal {
  role: 'publisher';
  publisherId: string;
}

/**
 * The isolated test runner. It may only claim test validations an admin or the controller queued
 * and report their results; it cannot see tasks, reviews or projects otherwise.
 */
export interface TestRunnerPrincipal {
  role: 'test-runner';
  runnerId: string;
}

export type Principal = AdminPrincipal | WorkerPrincipal | DelegatorPrincipal | PublisherPrincipal | TestRunnerPrincipal;

/** Who a task-management request acts for. Admin sees everything; a delegator only its own tasks. */
export type TaskActor = AdminPrincipal | DelegatorPrincipal;

/** Value stored in tasks.created_by. */
export function creatorOf(actor: TaskActor): string {
  return actor.role === 'admin' ? 'admin' : `delegator:${actor.clientId}`;
}

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
}
