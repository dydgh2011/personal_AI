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
   * anything is forwarded. Processes that can read this file share the Hermes credential.
   */
  clientKey: string;
  /** Planner service (compose.planner.yaml); null = planner routes answer 503. */
  planner?: { url: string; key: string } | null;
  /** Cap on planner write requests per minute (an LLM looping on a tool). */
  plannerWritesPerMinute?: number;
  /** Knowledge store (compose.knowledge.yaml); null = knowledge routes answer 503. */
  knowledge?: { url: string; key: string } | null;
  /** Cap on knowledge writes per minute (chat turns are stored too, so higher than the planner's). */
  knowledgeWritesPerMinute?: number;
  /** School connector service (compose.school.yaml): read-only updates; null = school routes answer 503. */
  school?: { url: string; key: string } | null;
  /** Learning caller key is scoped to queries and schedule proposals by the Learning service. */
  learning?: { url: string; key: string } | null;
  learningQueriesPerMinute?: number;
  learningProposalsPerMinute?: number;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

const AGENTS = ['claude', 'codex'];
const STATUSES = ['queued', 'running', 'completed', 'failed', 'cancel_requested', 'canceled'];
const TASK_ID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PROJECT_ID = '[a-z0-9][a-z0-9_-]{0,63}';
/** Google Calendar event id (instances of a repeating event carry a _<time> suffix). */
const EVENT_ID = '[A-Za-z0-9_]{3,300}';
const PROJECT_ID_PATTERN = new RegExp(`^${PROJECT_ID}$`);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_BODY_BYTES = 64 * 1024;
/** Knowledge writes carry whole chat turns and the text of attached documents. */
const MAX_KNOWLEDGE_BODY_BYTES = 4 * 1024 * 1024;
const MAX_LEARNING_BODY_BYTES = 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const MAX_INSTRUCTION_CHARS = 20_000;
/** Same rules as the controller (tasks/run-settings.ts): a model name or alias, never starting with "-". */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

type Target = 'planner' | 'knowledge' | 'school' | 'learning';
const TARGETS: Record<Target, { label: string; header: string }> = {
  planner: { label: 'planner', header: 'X-Planner-Key' },
  knowledge: { label: 'knowledge store', header: 'X-Knowledge-Key' },
  school: { label: 'school service', header: 'X-School-Key' },
  learning: { label: 'learning service', header: 'X-Learning-Key' },
};

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  name: string;
  /** Upstream service; defaults to the controller. Other targets each get a distinct request header. */
  target?: Target;
  /** Validated query parameters to forward. Everything else is rejected. */
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
  // Default model and effort per worker. Kelly sends a change only after the owner confirmed it in chat.
  { method: 'GET', pattern: /^\/agent-defaults$/, name: 'defaults.get' },
  { method: 'POST', pattern: /^\/agent-defaults\/(claude|codex)$/, name: 'defaults.set' },
  // Worker CLI logins: see the state, ask for a new login, pass on the code the owner got after signing in.
  { method: 'GET', pattern: /^\/workers\/auth$/, name: 'auth.list' },
  { method: 'POST', pattern: /^\/workers\/(claude|codex)\/auth\/start$/, name: 'auth.start' },
  { method: 'POST', pattern: /^\/workers\/(claude|codex)\/auth\/code$/, name: 'auth.code' },
  // Planner (todos, day plans, Google Calendar). Forwarded without the /planner prefix; the
  // planner validates every body field itself.
  ...plannerRoutes(),
  // Knowledge store (pages, facts, activities, raw originals, search). Forwarded without the
  // /knowledge prefix; the knowledge service validates every field itself.
  ...knowledgeRoutes(),
  // School connectors (Quercus, Piazza, UofT mail, course sites): read-only, plus "check now".
  ...schoolRoutes(),
  ...learningRoutes(),
];

function learningRoutes(): Route[] {
  const l = (method: Route['method'], path: string, name: string, query?: Route['query']): Route => ({
    method,
    pattern: new RegExp(`^/learning${path}$`),
    name: `learning.${name}`,
    target: 'learning',
    query,
  });
  return [
    l('GET', '/domains', 'domains.list'),
    l('GET', '/roadmaps', 'roadmaps.list'),
    l('GET', `/roadmaps/${UUID}`, 'roadmaps.get'),
    l('GET', '/schedule/status', 'status'),
    l('GET', '/schedule', 'schedule.query', { period: learningPeriod, date: learningDate }),
    l('POST', '/schedule/propose', 'schedule.propose'),
  ];
}

function learningPeriod(value: unknown): value is 'day' | 'week' {
  return value === 'day' || value === 'week';
}

function learningDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateLearningProposal(value: Record<string, unknown>): void {
  if (Object.keys(value).some((key) => key !== 'date' && key !== 'period')) {
    throw new HttpError(400, 'The schedule proposal accepts only date and period');
  }
  if (value.date !== undefined && !learningDate(value.date)) throw new HttpError(400, 'date must be a valid YYYY-MM-DD date');
  if (value.period !== undefined && !learningPeriod(value.period)) throw new HttpError(400, 'period must be day or week');
}

function schoolRoutes(): Route[] {
  const s = (method: Route['method'], path: string, name: string, query?: Route['query']): Route => ({
    method,
    pattern: new RegExp(`^/school${path}$`),
    name: `school.${name}`,
    target: 'school',
    query,
  });
  return [
    s('GET', '/status', 'status'),
    s('GET', '/updates', 'updates', {
      days: (v) => /^\d{1,2}$/.test(v),
      limit: (v) => /^\d{1,3}$/.test(v),
      service: (v) => ['quercus', 'piazza', 'outlook', 'gmail', 'course_site'].includes(v),
      important: (v) => v === '1' || v === '0',
    }),
    s('GET', '/item', 'item', {
      service: (v) => ['quercus', 'piazza', 'outlook', 'gmail', 'course_site'].includes(v),
      id: (v) => v.length >= 1 && v.length <= 300,
    }),
    s('POST', '/poll', 'poll'),
    // The owner's mail rules and summary style (the school service validates every field).
    s('GET', '/settings', 'settings'),
    s('POST', '/settings/mail-rule', 'settings.mailRule'),
    s('POST', '/settings/summary-style', 'settings.summaryStyle'),
    // Quercus deadlines as todo candidates and the owner's decision on each (the school service validates).
    s('GET', '/deadlines', 'deadlines', { all: (v) => v === '1' || v === '0' }),
    s('POST', '/deadlines/decide', 'deadlines.decide'),
  ];
}

function knowledgeRoutes(): Route[] {
  const date = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const short = (max: number) => (v: string) => v.length >= 1 && v.length <= max;
  const k = (method: Route['method'], path: string, name: string, query?: Route['query']): Route => ({
    method,
    pattern: new RegExp(`^/knowledge${path}$`),
    name: `knowledge.${name}`,
    target: 'knowledge',
    query,
  });
  const limit = (v: string) => /^\d{1,3}$/.test(v);
  return [
    k('GET', '/status', 'status'),
    k('POST', '/raw', 'raw.add'),
    k('POST', '/raw/document', 'raw.document'),
    k('GET', '/raw', 'raw.list', { source: short(20), from: date, to: date, limit }),
    k('GET', `/raw/${UUID}`, 'raw.get', { offset: (v) => /^\d{1,8}$/.test(v), limit: (v) => /^\d{1,5}$/.test(v) }),
    k('GET', '/pages', 'pages.list', { type: short(20) }),
    k('POST', '/pages', 'pages.save'),
    k('GET', '/page', 'pages.get', { ref: short(200) }),
    k('POST', '/facts', 'facts.add'),
    k('POST', `/facts/${UUID}`, 'facts.change'),
    k('POST', '/links', 'links.save'),
    k('POST', '/activities', 'activities.add'),
    k('POST', `/activities/${UUID}`, 'activities.change'),
    k('GET', '/timeline', 'timeline', { from: date, to: date, kind: short(20), page: short(200), limit }),
    k('GET', '/profile', 'profile', { compact: (v) => v === '1' }),
    k('GET', '/search', 'search', { q: short(300), kinds: short(40), limit }),
    k('GET', '/recall', 'recall', { q: short(2000) }),
    k('GET', '/graph', 'graph'),
    k('GET', '/changes', 'changes', { limit }),
    k('POST', '/purge', 'purge'),
  ];
}

function plannerRoutes(): Route[] {
  const date = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const p = (method: Route['method'], path: string, name: string, query?: Route['query']): Route => ({
    method,
    pattern: new RegExp(`^/planner${path}$`),
    name: `planner.${name}`,
    target: 'planner',
    query,
  });
  return [
    p('GET', '/status', 'status'),
    p('GET', '/day', 'day', { date }),
    p('GET', '/week', 'week', { start: date }),
    p('POST', '/plans/generate', 'generate'),
    p('POST', '/plans/confirm', 'confirm'),
    p('POST', '/blocks', 'blocks.add'),
    p('POST', `/blocks/${TASK_ID}/update`, 'blocks.update'),
    p('POST', `/blocks/${TASK_ID}/remove`, 'blocks.remove'),
    p('GET', '/todos', 'todos.list', { status: (v) => ['open', 'done', 'all'].includes(v) }),
    p('POST', '/todos', 'todos.add'),
    p('POST', `/todos/${TASK_ID}/update`, 'todos.update'),
    p('POST', `/todos/${TASK_ID}/progress`, 'todos.progress'),
    p('GET', '/settings', 'settings.get'),
    p('POST', '/settings', 'settings.update'),
    p('GET', '/changes', 'changes', { limit: (v) => /^\d{1,3}$/.test(v) }),
    p('POST', '/calendar/connect', 'calendar.connect'),
    p('GET', '/calendars', 'calendars'),
    p('POST', '/events', 'events.add'),
    p('POST', `/events/${EVENT_ID}/update`, 'events.update'),
    p('POST', `/events/${EVENT_ID}/remove`, 'events.remove'),
    p('POST', '/reference/sync', 'reference.sync'),
    p('POST', '/reference/search', 'reference.search'),
    p('GET', '/proposals', 'proposals.list', { status: (v) => v === 'draft' || v === 'all' }),
    p('POST', '/proposals', 'proposals.create'),
    p('GET', '/proposals/[A-Z]{1,3}', 'proposals.get'),
    p('POST', '/proposals/[A-Z]{1,3}/edit', 'proposals.edit'),
    p('POST', '/proposals/[A-Z]{1,3}/apply', 'proposals.apply'),
    p('POST', '/proposals/[A-Z]{1,3}/discard', 'proposals.discard'),
  ];
}

const AUTH_CODE_PATTERN = /^[A-Za-z0-9#._~-]{8,512}$/;
const UUID_PATTERN = new RegExp(`^${TASK_ID}$`);

function validateAuthCode(value: unknown): { code: string; sessionId?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Body must be a JSON object');
  const body = value as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => !['code', 'sessionId'].includes(k));
  if (extra.length) throw new HttpError(400, `Unexpected fields: ${extra.join(', ')}`);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!AUTH_CODE_PATTERN.test(code)) throw new HttpError(400, 'code must be the code shown after signing in (letters, digits, # . _ ~ -)');
  if (body.sessionId !== undefined && (typeof body.sessionId !== 'string' || !UUID_PATTERN.test(body.sessionId))) {
    throw new HttpError(400, 'sessionId must be a session UUID');
  }
  return body.sessionId === undefined ? { code } : { code, sessionId: body.sessionId as string };
}

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
  if (typeof config.clientKey !== 'string' || config.clientKey.length < 32 || /\s/.test(config.clientKey)) {
    throw new Error('A valid broker client key is required');
  }
  if (config.clientKey === config.token) throw new Error('The broker client key must differ from the controller token');
  if (config.learning && [config.clientKey, config.token].includes(config.learning.key)) {
    throw new Error('The learning key must differ from the broker client key and controller token');
  }
  const clientKeyDigest = digestKey(config.clientKey);
  const created: number[] = [];
  const writes: Record<Target, number[]> = { planner: [], knowledge: [], school: [], learning: [] };
  const learningQueries: number[] = [];
  const writesPerMinute: Record<Target, number> = {
    planner: config.plannerWritesPerMinute ?? 30,
    knowledge: config.knowledgeWritesPerMinute ?? 120,
    school: 10,
    learning: config.learningProposalsPerMinute ?? 5,
  };
  const bodyLimit: Record<Target, number> = {
    planner: MAX_BODY_BYTES,
    knowledge: MAX_KNOWLEDGE_BODY_BYTES,
    school: MAX_BODY_BYTES,
    learning: MAX_LEARNING_BODY_BYTES,
  };

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
    const audit: Record<string, unknown> = { method: req.method };
    let status = 500;
    try {
      const requestTarget = req.url ?? '/';
      if (!requestTarget.startsWith('/') || requestTarget.startsWith('//') || requestTarget.includes('\\')) {
        throw new HttpError(400, 'Invalid request target');
      }
      const url = new URL(requestTarget, 'http://broker');
      if (req.method === 'GET' && url.pathname === '/health') {
        audit.path = '/health';
        status = 200;
        return send(res, 200, { status: 'ok' });
      }
      const keys = req.headersDistinct['x-broker-key'];
      if (keys?.length !== 1 || !timingSafeEqual(digestKey(keys[0]), clientKeyDigest)) {
        audit.op = 'auth';
        throw new HttpError(401, 'Missing or invalid broker client key');
      }
      audit.caller = 'hermes';
      const candidates = ROUTES.filter((r) => r.pattern.test(url.pathname));
      if (candidates.length === 0) throw new HttpError(404, 'Not found');
      const route = candidates.find((r) => r.method === req.method);
      if (!route) throw new HttpError(405, 'Method not allowed');
      audit.op = route.name;
      audit.path = url.pathname;

      for (const [key, value] of url.searchParams) {
        const valid = route.query && Object.hasOwn(route.query, key) ? route.query[key] : undefined;
        if (!valid || !valid(value) || url.searchParams.getAll(key).length > 1) {
          throw new HttpError(400, `Query parameter "${key}" is not allowed or invalid`);
        }
      }

      if (route.target) {
        const target = route.target;
        const upstreamConfig = config[target];
        const label = TARGETS[target].label;
        if (!upstreamConfig) throw new HttpError(503, `The ${label} is not set up`);
        let body: string | undefined;
        if (route.method === 'POST') {
          const value = await readJson(req, false, true, bodyLimit[target]);
          if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Body must be a JSON object');
          if (target === 'learning') validateLearningProposal(value as Record<string, unknown>);
          body = JSON.stringify(value);
          consumeRateLimit(writes[target], writesPerMinute[target], now(), target === 'learning' ? 'learning proposals' : `${label} changes`);
        } else if (target === 'learning') {
          consumeRateLimit(learningQueries, config.learningQueriesPerMinute ?? 60, now(), 'learning queries');
        }
        const header = TARGETS[target].header;
        let upstream: Response;
        try {
          upstream = await fetch(upstreamConfig.url + url.pathname.slice(`/${target}`.length) + url.search, {
            method: route.method,
            headers: { [header]: upstreamConfig.key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(Math.max(config.upstreamTimeoutMs, 30_000)),
          });
        } catch {
          throw new HttpError(502, `${label[0].toUpperCase()}${label.slice(1)} unreachable`);
        }
        const text = (await upstream.text()).split(upstreamConfig.key).join('[redacted]');
        status = upstream.status;
        res.writeHead(status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
        res.end(text);
        return;
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
            : `broker-${createHash('sha256').update([task.agent, task.projectId, task.instruction, task.model ?? '', task.effort ?? ''].join('\0')).digest('hex').slice(0, 40)}`;
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(task);
        Object.assign(audit, {
          agent: task.agent,
          projectId: task.projectId,
          instructionChars: task.instruction.length,
          model: task.model ?? null,
          effort: task.effort ?? null,
        });
        rateLimit();
      } else if (route.name === 'defaults.set') {
        const change = validateDefaults(await readJson(req));
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(change);
        Object.assign(audit, { agent: url.pathname.split('/')[2], ...change });
      } else if (route.name === 'auth.code') {
        // The code is a one-time authorization code; it is forwarded, never logged.
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(validateAuthCode(await readJson(req)));
        audit.agent = url.pathname.split('/')[2];
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

function digestKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

function consumeRateLimit(recent: number[], perMinute: number, now: number, label: string): void {
  while (recent.length && recent[0] <= now - 60_000) recent.shift();
  if (recent.length >= perMinute) {
    throw new HttpError(429, `Too many ${label}: at most ${perMinute} per minute`, { retryAfterSeconds: 60 });
  }
  recent.push(now);
}

type RunChange = { model?: string | null; effort?: string | null };

/** model/effort: absent = not given; null only where allowed (a default going back to the CLI default). */
function validateRun(body: Record<string, unknown>, allowNull: boolean): RunChange {
  const out: RunChange = {};
  if (body.model !== undefined) {
    if (body.model === null && allowNull) out.model = null;
    else if (typeof body.model !== 'string' || !MODEL_PATTERN.test(body.model)) {
      throw new HttpError(400, 'model must be a model name or alias (letters, digits, . _ : - [ ], max 80, not starting with -)');
    } else out.model = body.model;
  }
  if (body.effort !== undefined) {
    if (body.effort === null && allowNull) out.effort = null;
    else if (typeof body.effort !== 'string' || !EFFORT_LEVELS.includes(body.effort)) {
      throw new HttpError(400, `effort must be one of ${EFFORT_LEVELS.join(', ')}`);
    } else out.effort = body.effort;
  }
  return out;
}

function validateDefaults(value: unknown): RunChange {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Body must be a JSON object');
  const body = value as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => !['model', 'effort'].includes(k));
  if (extra.length) throw new HttpError(400, `Unexpected fields: ${extra.join(', ')}`);
  const change = validateRun(body, true);
  if (!('model' in change) && !('effort' in change)) throw new HttpError(400, 'Give model and/or effort');
  return change;
}

function validateTask(value: unknown): { agent: string; projectId: string; instruction: string; model?: string; effort?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Body must be a JSON object');
  const body = value as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => !['agent', 'projectId', 'instruction', 'model', 'effort'].includes(k));
  if (extra.length) throw new HttpError(400, `Unexpected fields: ${extra.join(', ')}`);
  if (typeof body.agent !== 'string' || !AGENTS.includes(body.agent)) throw new HttpError(400, 'agent must be claude or codex');
  if (typeof body.projectId !== 'string' || !PROJECT_ID_PATTERN.test(body.projectId)) {
    throw new HttpError(400, 'projectId must be a registered project id');
  }
  if (typeof body.instruction !== 'string' || !/\S/.test(body.instruction)) throw new HttpError(400, 'instruction must not be blank');
  if (body.instruction.length > MAX_INSTRUCTION_CHARS) {
    throw new HttpError(400, `instruction is longer than ${MAX_INSTRUCTION_CHARS} characters`);
  }
  const run = validateRun(body, false) as { model?: string; effort?: string };
  return { agent: body.agent, projectId: body.projectId, instruction: body.instruction, ...run };
}

async function readJson(req: IncomingMessage, mustBeEmpty = false, emptyIsObject = false, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      req.resume();
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (mustBeEmpty) {
    if (text && text !== '{}') throw new HttpError(400, 'This request takes no body');
    return null;
  }
  if (!text && emptyIsObject) return {};
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
