import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface BrokerConfig {
  controllerUrl: string;
  /** The controller delegator token. Lives only in this process. */
  token: string;
  submitPerMinute: number;
  submitPerHour: number;
  upstreamTimeoutMs: number;
  /**
   * Shared key the Hermes plugin sends as X-Broker-Key. Requests without it are rejected before
   * anything is forwarded. Only processes that can read the key file (the Hermes plugin, not the
   * LLM's remaining tools such as the browser) can use the broker. null = not required.
   */
  clientKey: string | null;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

const AGENTS = ['claude', 'codex'];
const STATUSES = ['queued', 'running', 'completed', 'failed', 'cancel_requested', 'canceled'];
const TASK_ID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PROJECT_ID = '[a-z0-9][a-z0-9_-]{0,63}';
const PROJECT_ID_PATTERN = new RegExp(`^${PROJECT_ID}$`);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_INSTRUCTION_CHARS = 20_000;

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  name: string;
  /** Query parameters forwarded to the controller, each with its validator. Everything else is rejected. */
  query?: Record<string, (value: string) => boolean>;
}

/**
 * The complete list of operations Hermes can perform. Anything not listed here
 * is answered by the broker itself with 404/405 and never reaches the controller.
 */
const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/system\/status$/, name: 'system.status' },
  { method: 'GET', pattern: /^\/projects$/, name: 'projects.list' },
  { method: 'GET', pattern: new RegExp(`^/projects/${PROJECT_ID}$`), name: 'projects.get' },
  {
    method: 'GET',
    pattern: new RegExp(`^/projects/${PROJECT_ID}/status$`),
    name: 'projects.status',
    query: { refresh: (v) => v === 'true' || v === 'false' },
  },
  {
    method: 'GET',
    pattern: /^\/tasks$/,
    name: 'tasks.list',
    query: {
      status: (v) => STATUSES.includes(v),
      agent: (v) => AGENTS.includes(v),
      limit: (v) => /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 200,
      offset: (v) => /^\d{1,6}$/.test(v),
    },
  },
  { method: 'GET', pattern: new RegExp(`^/tasks/${TASK_ID}$`), name: 'tasks.get' },
  // Review data is read-only for Hermes; approve/reject are deliberately not routed.
  { method: 'GET', pattern: new RegExp(`^/tasks/${TASK_ID}/diff$`), name: 'tasks.diff' },
  { method: 'GET', pattern: new RegExp(`^/tasks/${TASK_ID}/review$`), name: 'tasks.review' },
  { method: 'POST', pattern: /^\/tasks$/, name: 'tasks.create' },
  { method: 'POST', pattern: new RegExp(`^/tasks/${TASK_ID}/cancel$`), name: 'tasks.cancel' },
];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Credential broker between Hermes and the task controller. Hermes (and its LLM
 * tools) never hold a controller token: they can only ask this service for the
 * operations in ROUTES, with validated input, and task creation is rate limited.
 * The controller still enforces the delegator role on every forwarded request.
 */
export function createBroker(config: BrokerConfig, logger: Logger, now: () => number = Date.now): Server {
  const created: number[] = [];

  const rateLimit = () => {
    const t = now();
    while (created.length && created[0] <= t - 3_600_000) created.shift();
    const lastMinute = created.filter((c) => c > t - 60_000).length;
    if (lastMinute >= config.submitPerMinute) {
      throw new HttpError(429, `Too many new tasks: at most ${config.submitPerMinute} per minute`, { retryAfterSeconds: 60 });
    }
    if (created.length >= config.submitPerHour) {
      const retry = Math.ceil((created[0] + 3_600_000 - t) / 1000);
      throw new HttpError(429, `Too many new tasks: at most ${config.submitPerHour} per hour`, { retryAfterSeconds: retry });
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const started = now();
    const url = new URL(req.url ?? '/', 'http://broker');
    const audit: Record<string, unknown> = { method: req.method, path: url.pathname };
    let status = 500;
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        status = 200;
        return send(res, 200, { status: 'ok' });
      }
      if (config.clientKey !== null && !keyMatches(req.headers['x-broker-key'], config.clientKey)) {
        audit.op = 'auth';
        throw new HttpError(401, 'Missing or invalid broker client key');
      }
      const candidates = ROUTES.filter((r) => r.pattern.test(url.pathname));
      if (candidates.length === 0) throw new HttpError(404, 'Not found');
      const route = candidates.find((r) => r.method === req.method);
      if (!route) throw new HttpError(405, 'Method not allowed');
      audit.op = route.name;

      for (const [key, value] of url.searchParams) {
        const valid = route.query?.[key];
        if (!valid || !valid(value) || url.searchParams.getAll(key).length > 1) {
          throw new HttpError(400, `Query parameter "${key}" is not allowed or invalid`);
        }
      }

      const headers: Record<string, string> = { Authorization: `Bearer ${config.token}`, Accept: 'application/json' };
      let body: string | undefined;
      if (route.name === 'tasks.create') {
        const task = validateTask(await readJson(req));
        const key = req.headers['idempotency-key'];
        if (key !== undefined && (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key))) {
          throw new HttpError(400, 'Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 . _ : -');
        }
        // Without a client key, identical requests (e.g. an LLM retrying a tool call) still collapse into one task.
        headers['Idempotency-Key'] =
          typeof key === 'string'
            ? key
            : `broker-${createHash('sha256').update([task.agent, task.projectId, task.instruction].join('\0')).digest('hex').slice(0, 40)}`;
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(task);
        Object.assign(audit, { agent: task.agent, projectId: task.projectId, instructionChars: task.instruction.length });
        rateLimit();
      } else if (req.method === 'POST') {
        await readJson(req, true);
      }
      if (route.name.startsWith('tasks.get') || route.name === 'tasks.cancel') audit.taskId = url.pathname.split('/')[2];

      let upstream: Response;
      try {
        upstream = await fetch(config.controllerUrl + url.pathname + url.search, {
          method: route.method,
          headers,
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        });
      } catch {
        throw new HttpError(502, 'Controller unreachable');
      }
      // The controller never returns tokens; this is a last line of defence.
      const text = (await upstream.text()).split(config.token).join('[redacted]');
      status = upstream.status;
      const replayed = upstream.headers.get('idempotent-replayed') === 'true';
      if (route.name === 'tasks.create') {
        if (status === 201) created.push(now());
        audit.replayed = replayed;
        if (status < 300) audit.taskId = safeId(text);
      }
      res.writeHead(status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        ...(replayed ? { 'Idempotent-Replayed': 'true' } : {}),
      });
      res.end(text);
    } catch (error) {
      const e = error instanceof HttpError ? error : new HttpError(500, 'Broker error');
      status = e.status;
      if (!(error instanceof HttpError)) logger.warn('Unexpected broker error', { error: (error as Error).message });
      send(res, e.status, { statusCode: e.status, message: e.message, ...e.extra });
    } finally {
      logger.info('request', { ...audit, status, durationMs: now() - started });
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

function validateTask(value: unknown): { agent: string; projectId: string; instruction: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Body must be a JSON object');
  const body = value as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => !['agent', 'projectId', 'instruction'].includes(k));
  if (extra.length) throw new HttpError(400, `Unexpected fields: ${extra.join(', ')}`);
  if (typeof body.agent !== 'string' || !AGENTS.includes(body.agent)) throw new HttpError(400, 'agent must be claude or codex');
  if (typeof body.projectId !== 'string' || !PROJECT_ID_PATTERN.test(body.projectId)) {
    throw new HttpError(400, 'projectId must be a registered project id');
  }
  if (typeof body.instruction !== 'string' || !/\S/.test(body.instruction)) throw new HttpError(400, 'instruction must not be blank');
  if (body.instruction.length > MAX_INSTRUCTION_CHARS) {
    throw new HttpError(400, `instruction is longer than ${MAX_INSTRUCTION_CHARS} characters`);
  }
  return { agent: body.agent, projectId: body.projectId, instruction: body.instruction };
}

async function readJson(req: IncomingMessage, mustBeEmpty = false): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (mustBeEmpty) {
    if (text && text !== '{}') throw new HttpError(400, 'This request takes no body');
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
}

function safeId(text: string): string | undefined {
  try {
    const id = (JSON.parse(text) as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
