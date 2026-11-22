import type { Logger } from './broker.js';

/**
 * Task watcher: polls the controller with the broker's own delegator token (so it sees exactly the
 * tasks Hermes created) and reports every task that reached completed / failed / canceled to the
 * notifier as a typed task_finished event. No LLM is involved, so a finished task is reported even
 * when Hermes is busy, restarting or out of model quota.
 *
 * Delivery is at-least-once: recently finished tasks (lookback window) are re-sent after a broker
 * restart and the notifier drops the duplicates by key.
 */
export interface WatcherConfig {
  controllerUrl: string;
  token: string;
  notifierUrl: string;
  notifierKey: string;
  intervalMs: number;
  /** Only tasks that finished within this window are reported (also covers broker restarts). */
  lookbackMs: number;
  /** Windows path of the workspaces folder, to show where the result is on the PC. */
  hostWorkspaces: string;
  timeoutMs: number;
}

interface ControllerTask {
  id: string;
  agent: string;
  projectId: string | null;
  status: string;
  result: string | null;
  error: string | null;
  updatedAt: string;
  completedAt: string | null;
}

interface ControllerAuth {
  agent: string;
  session: {
    id: string;
    status: string;
    loginUrl: string | null;
    userCode: string | null;
    needsCode: boolean;
    expiresAt: string | null;
    message: string | null;
    updatedAt: string;
  } | null;
}

const TERMINAL = new Set(['completed', 'failed', 'canceled']);

export interface Watcher {
  tick(): Promise<void>;
  stop(): void;
}

export function createWatcher(config: WatcherConfig, logger: Logger, now: () => number = Date.now): Watcher {
  const sent = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let pausedUntil = 0;

  const controller = async <T>(path: string): Promise<T | null> => {
    const res = await fetch(`${config.controllerUrl}${path}`, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!res.ok) {
      logger.warn('watcher: controller request failed', { path, status: res.status });
      return null;
    }
    return (await res.json()) as T;
  };

  /** 'sent' | 'retry' (stop this tick). Rejected (400) events are logged and never retried. */
  const deliver = async (key: string, event: Record<string, unknown>, fields: Record<string, unknown>): Promise<'sent' | 'retry'> => {
    let r: Response;
    try {
      r = await fetch(`${config.notifierUrl}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Notifier-Key': config.notifierKey },
        body: JSON.stringify({ ...event, key }),
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch {
      logger.warn('watcher: notifier unreachable', fields);
      return 'retry';
    }
    if (r.status === 200 || r.status === 201) {
      sent.set(key, now());
      logger.info('watcher: reported', { ...fields, type: event.type, notifier: r.status });
      return 'sent';
    }
    const body = (await r.json().catch(() => ({}))) as { retryAfterSeconds?: unknown; message?: unknown };
    if (r.status === 400) {
      sent.set(key, now());
      logger.warn('watcher: notifier rejected event', { ...fields, message: body.message });
      return 'sent';
    }
    if (typeof body.retryAfterSeconds === 'number') pausedUntil = now() + body.retryAfterSeconds * 1000;
    logger.warn('watcher: notifier did not deliver', { ...fields, status: r.status });
    return 'retry';
  };

  const tick = async () => {
    if (running || now() < pausedUntil) return;
    running = true;
    try {
      const cutoff = now() - config.lookbackMs;
      for (const [k, t] of sent) if (t < cutoff - config.lookbackMs) sent.delete(k);

      // 1) Worker logins: a waiting login is the most urgent message (nothing runs until it is done).
      const auth = await controller<{ items?: ControllerAuth[] }>('/workers/auth');
      for (const a of auth?.items ?? []) {
        const s = a.session;
        if (!s) continue;
        if (s.status === 'waiting_user') {
          if (s.expiresAt && Date.parse(s.expiresAt) < now()) continue;
          const key = `login:${s.id}:waiting`;
          if (sent.has(key)) continue;
          const event = { type: 'login_required', login: { agent: a.agent, sessionId: s.id, loginUrl: s.loginUrl, userCode: s.userCode, needsCode: s.needsCode, expiresAt: s.expiresAt } };
          if ((await deliver(key, event, { agent: a.agent, sessionId: s.id })) === 'retry') return;
        } else if (s.status === 'succeeded' || s.status === 'failed' || s.status === 'expired') {
          if (Date.parse(s.updatedAt) < cutoff) continue;
          const key = `login:${s.id}:${s.status}`;
          if (sent.has(key)) continue;
          const event = { type: 'login_result', login: { agent: a.agent, sessionId: s.id, status: s.status, message: s.message } };
          if ((await deliver(key, event, { agent: a.agent, sessionId: s.id })) === 'retry') return;
        }
      }

      // 2) Finished tasks, oldest first.
      const page = await controller<{ items?: ControllerTask[] }>('/tasks?limit=50');
      const finished = (page?.items ?? [])
        .filter((t) => TERMINAL.has(t.status))
        .filter((t) => Date.parse(t.completedAt ?? t.updatedAt) >= cutoff)
        .sort((a, b) => Date.parse(a.completedAt ?? a.updatedAt) - Date.parse(b.completedAt ?? b.updatedAt));
      for (const task of finished) {
        const key = `task:${task.id}:${task.status}`;
        if (sent.has(key)) continue;
        const event = { type: 'task_finished', task: toEvent(task, config.hostWorkspaces) };
        if ((await deliver(key, event, { taskId: task.id, status: task.status })) === 'retry') return;
      }
    } catch (error) {
      logger.warn('watcher: tick failed', { error: (error as Error).message });
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void tick(), config.intervalMs);
  timer.unref();
  return {
    tick,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/** Facts from the worker's agent-worker/v1 report (stored in result on success, error on failure). Nothing inferred. */
export function toEvent(task: ControllerTask, hostWorkspaces: string) {
  const raw = task.result ?? task.error;
  let report: Record<string, unknown> | null = null;
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).format === 'agent-worker/v1') report = parsed as Record<string, unknown>;
  } catch {
    report = null;
  }
  const workspace = report && typeof report.workspace === 'object' && report.workspace !== null ? (report.workspace as Record<string, unknown>) : {};
  const s = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  const path = s(workspace.path, 400);
  const hostPath =
    hostWorkspaces && path && (task.agent === 'claude' || task.agent === 'codex')
      ? `${hostWorkspaces}\\${task.agent}\\${path.replace(/^\/workspace\/?/, '').replace(/\//g, '\\')}`.slice(0, 500)
      : null;
  const files = Array.isArray(workspace.changedFiles) ? workspace.changedFiles : [];
  const commit = s(workspace.commit, 64);
  return {
    id: task.id,
    agent: task.agent,
    projectId: task.projectId,
    status: task.status,
    success: task.status === 'completed' && (report ? report.outcome === 'completed' : true),
    summary: report ? s(report.message, 4000) : s(raw, 4000),
    changedFiles: files
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null && typeof (f as Record<string, unknown>).path === 'string')
      .slice(0, 500)
      .map((f) => ({ status: (s(f.status, 8) ?? '?'), path: s(f.path, 500)! })),
    branch: s(workspace.branch, 300),
    commit: commit && /^[0-9a-f]{7,64}$/.test(commit) ? commit : null,
    durationSeconds: typeof report?.durationMs === 'number' && report.durationMs >= 0 ? Math.round(report.durationMs / 100) / 10 : null,
    hostPath,
  };
}
