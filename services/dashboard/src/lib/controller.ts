import 'server-only';
import { readSecret, settings } from './server';
import type { DiffResponse, Project, Publication, PublicationStatus, PublishAuthorization, Review, ReviewResponse, SystemStatus, Task, TaskList, TestValidation } from './types';

export class ControllerError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null = null) {
    super(message);
  }
}

/**
 * The dashboard's only way to reach the controller. Runs on the server; the token (a dedicated
 * dashboard admin token, Docker secret) is read here and never sent to the browser.
 */
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ data: T; ms: number }> {
  let token: string;
  try {
    token = readSecret(settings.controllerTokenFile);
  } catch {
    throw new ControllerError('Dashboard controller token is not configured', null);
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(settings.controllerUrl + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ControllerError('Controller unreachable', null);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // keep null
  }
  if (!res.ok) {
    const msg = (data as { message?: unknown })?.message;
    const code = (data as { code?: unknown })?.code;
    throw new ControllerError(Array.isArray(msg) ? msg.join('; ') : typeof msg === 'string' ? msg : `Controller error ${res.status}`, res.status, typeof code === 'string' ? code : null);
  }
  return { data: data as T, ms: Date.now() - started };
}

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return s ? `?${s}` : '';
};

export const controller = {
  systemStatus: () => call<SystemStatus>('GET', '/system/status'),
  tasks: (f: { agent?: string; status?: string; projectId?: string; limit?: string; offset?: string }) =>
    call<TaskList>('GET', `/tasks${q(f)}`).then((r) => r.data),
  task: (id: string) => call<Task>('GET', `/tasks/${encodeURIComponent(id)}`).then((r) => r.data),
  cancel: (id: string) => call<{ outcome: string; message: string }>('POST', `/tasks/${encodeURIComponent(id)}/cancel`).then((r) => r.data),
  projects: () => call<{ items: Project[] }>('GET', '/projects').then((r) => r.data.items),
  reviews: (status?: string) => call<{ items: Review[] }>('GET', `/reviews${q({ status, limit: '100' })}`).then((r) => r.data.items),
  diff: (id: string) => call<DiffResponse>('GET', `/tasks/${encodeURIComponent(id)}/diff`).then((r) => r.data),
  review: (id: string) => call<ReviewResponse>('GET', `/tasks/${encodeURIComponent(id)}/review`).then((r) => r.data),
  decide: (id: string, decision: 'approve' | 'reject', headSha: string, reason: string | undefined, approver: string) =>
    call<Review>('POST', `/tasks/${encodeURIComponent(id)}/${decision}`, { headSha, ...(reason ? { reason } : {}) }, { 'X-Approver': approver }).then((r) => r.data),
  publication: (id: string) => call<PublicationStatus>('GET', `/tasks/${encodeURIComponent(id)}/publication`).then((r) => r.data),
  /** Validate / dry-run only (Phase E-2A): the publisher verifies and plans, nothing is pushed. */
  dryRun: (id: string, headSha: string, approver: string) =>
    call<Publication>('POST', `/tasks/${encodeURIComponent(id)}/publication/dry-run`, { headSha }, { 'X-Approver': approver }).then((r) => r.data),
  /** Queue the project's approved test commands for this commit (isolated test runner). */
  runTests: (id: string, headSha: string, approver: string) =>
    call<TestValidation>('POST', `/tasks/${encodeURIComponent(id)}/tests`, { headSha }, { 'X-Approver': approver }).then((r) => r.data),
  /** The separate publish approval (enforced again by the controller and the publisher). */
  authorize: (id: string, input: { headSha: string; dryRunId: string; idempotencyKey: string }, approver: string) =>
    call<PublishAuthorization>('POST', `/tasks/${encodeURIComponent(id)}/publication/authorize`, input, { 'X-Approver': approver }).then((r) => r.data),
  publish: (id: string, input: { authorizationId: string; idempotencyKey: string }, approver: string) =>
    call<Publication>('POST', `/tasks/${encodeURIComponent(id)}/publication/publish`, input, { 'X-Approver': approver }).then((r) => r.data),
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SHA = /^[0-9a-f]{40}$/;
