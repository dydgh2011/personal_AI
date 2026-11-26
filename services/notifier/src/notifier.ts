import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  formatLoginRequired,
  formatLoginResult,
  formatTaskFinished,
  parseLoginRequired,
  parseLoginResult,
  parseTaskFinished,
  ValidationError,
} from './format.js';
import { formatCalendar, formatPlan, formatReminder, parseCalendar, parsePlan, parseReminder } from './plan-format.js';
import { formatLlm, parseLlm } from './llm-format.js';
import { formatSchool, parseSchool } from './school-format.js';
import type { SentStore } from './store.js';

export interface NotifierConfig {
  /** Discord webhook URL. Secret (it contains the webhook token): never logged or returned. */
  webhookUrl: string;
  /** Discord user mentioned in every message (allowed_mentions restricts pings to this user). */
  mentionUserId: string | null;
  /** Callers and their keys (X-Notifier-Key). Each caller is named in the audit log. */
  clients: Array<{ name: string; key: string }>;
  /** Global cap on delivered messages per minute. */
  perMinute: number;
  upstreamTimeoutMs: number;
  /** Base URL shown in messages for review links. */
  dashboardUrl: string;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface PostResult {
  status: number;
  retryAfterSeconds?: number;
}
export type Poster = (url: string, body: unknown, timeoutMs: number) => Promise<PostResult>;

export const discordPoster: Poster = async (url, body, timeoutMs) => {
  const res = await fetch(`${url}?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  let retryAfterSeconds: number | undefined;
  try {
    const data = (await res.json()) as { retry_after?: unknown };
    if (res.status === 429 && typeof data.retry_after === 'number') retryAfterSeconds = Math.ceil(data.retry_after);
  } catch {
    // body is irrelevant otherwise
  }
  return { status: res.status, retryAfterSeconds };
};

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/;
const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/**
 * The only component that can post to Discord. Callers send typed events with an idempotency
 * key; the notifier validates them, renders a fixed template, delivers once, and remembers it.
 * Event types: task_finished, login_required, login_result, plan, reminder, calendar, llm, school (new types are
 * added here, never as free text).
 */
export function createNotifier(config: NotifierConfig, store: SentStore, logger: Logger, post: Poster = discordPoster, now: () => number = Date.now): Server {
  const delivered: number[] = [];
  const inFlight = new Set<string>();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://notifier');
    const audit: Record<string, unknown> = { method: req.method, path: url.pathname };
    let status = 500;
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        status = 200;
        return send(res, 200, { status: 'ok' });
      }
      const client = config.clients.find((c) => keyMatches(req.headers['x-notifier-key'], c.key));
      if (!client) throw new HttpError(401, 'Missing or invalid notifier key');
      audit.client = client.name;
      if (url.pathname !== '/notify') throw new HttpError(404, 'Not found');
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');

      const body = await readJson(req);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object');
      const b = body as Record<string, unknown>;
      const PAYLOAD: Record<string, string> = {
        task_finished: 'task',
        login_required: 'login',
        login_result: 'login',
        plan: 'plan',
        reminder: 'reminder',
        calendar: 'calendar',
        llm: 'llm',
        school: 'school',
      };
      const payloadField = typeof b.type === 'string' && Object.hasOwn(PAYLOAD, b.type) ? PAYLOAD[b.type] : null;
      if (!payloadField) throw new HttpError(400, `type must be one of ${Object.keys(PAYLOAD).join(', ')}`);
      const extra = Object.keys(b).filter((k) => !['type', 'key', payloadField].includes(k));
      if (extra.length) throw new HttpError(400, `Unexpected fields: ${extra.join(', ')}`);
      if (typeof b.key !== 'string' || !KEY_PATTERN.test(b.key)) throw new HttpError(400, 'key must be 8-160 characters of A-Z a-z 0-9 . _ : -');
      let render: () => string;
      if (b.type === 'task_finished') {
        const task = parseTaskFinished(b.task);
        Object.assign(audit, { taskId: task.id, taskStatus: task.status });
        render = () => formatTaskFinished(task, config.mentionUserId, config.dashboardUrl);
      } else if (b.type === 'login_required') {
        const login = parseLoginRequired(b.login);
        Object.assign(audit, { agent: login.agent, sessionId: login.sessionId });
        render = () => formatLoginRequired(login, config.mentionUserId);
      } else if (b.type === 'plan') {
        const plan = parsePlan(b.plan);
        Object.assign(audit, { kind: plan.kind, dates: plan.days.map((d) => d.date).join(',') });
        render = () => formatPlan(plan, config.mentionUserId);
      } else if (b.type === 'reminder') {
        const reminder = parseReminder(b.reminder);
        audit.start = reminder.start;
        render = () => formatReminder(reminder, config.mentionUserId);
      } else if (b.type === 'school') {
        const school = parseSchool(b.school);
        Object.assign(audit, { schoolMode: school.mode, items: school.items.length });
        render = () => formatSchool(school, config.mentionUserId);
      } else if (b.type === 'llm') {
        const llm = parseLlm(b.llm);
        audit.llmKind = llm.kind;
        render = () => formatLlm(llm, config.mentionUserId);
      } else if (b.type === 'calendar') {
        const calendar = parseCalendar(b.calendar);
        audit.calendarStatus = calendar.status;
        render = () => formatCalendar(calendar, config.mentionUserId);
      } else {
        const login = parseLoginResult(b.login);
        Object.assign(audit, { agent: login.agent, sessionId: login.sessionId, loginStatus: login.status });
        render = () => formatLoginResult(login, config.mentionUserId);
      }
      const key = `${client.name}:${b.key}`;
      Object.assign(audit, { type: b.type, key: b.key });

      if (store.has(key) || inFlight.has(key)) {
        status = 200;
        audit.duplicate = true;
        return send(res, 200, { delivered: false, duplicate: true });
      }
      const t = now();
      while (delivered.length && delivered[0] <= t - 60_000) delivered.shift();
      if (delivered.length >= config.perMinute) throw new HttpError(429, `At most ${config.perMinute} messages per minute`, { retryAfterSeconds: 60 });

      inFlight.add(key);
      try {
        const content = render();
        let result: PostResult;
        try {
          result = await post(
            config.webhookUrl,
            { content, allowed_mentions: { parse: [], users: config.mentionUserId ? [config.mentionUserId] : [] } },
            config.upstreamTimeoutMs,
          );
        } catch {
          throw new HttpError(502, 'Discord unreachable');
        }
        audit.discordStatus = result.status;
        if (result.status === 429) throw new HttpError(503, 'Discord rate limited the webhook', { retryAfterSeconds: result.retryAfterSeconds ?? 30 });
        if (result.status < 200 || result.status >= 300) throw new HttpError(502, `Discord answered ${result.status}`);
        delivered.push(t);
        store.add(key, t);
      } finally {
        inFlight.delete(key);
      }
      status = 201;
      send(res, 201, { delivered: true });
    } catch (error) {
      const e =
        error instanceof HttpError ? error : error instanceof ValidationError ? new HttpError(400, error.message) : new HttpError(500, 'Notifier error');
      status = e.status;
      // why it was not delivered stays in the log (file on the data volume): rejected input, Discord down, rate limit
      audit.error = e.message.slice(0, 300);
      if (e.status === 500) logger.warn('Unexpected notifier error', { error: (error as Error).message });
      send(res, e.status, { statusCode: e.status, message: e.message, ...e.extra });
    } finally {
      logger.info('request', { ...audit, status });
    }
  };

  return createServer((req, res) => void handle(req, res));
}

function keyMatches(header: string | string[] | undefined, key: string): boolean {
  if (typeof header !== 'string') return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(key).digest();
  return timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
