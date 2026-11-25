import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GoogleError } from './google.js';
import type { Notify } from './notify.js';
import { PlannerError, type Actor, type Planner } from './planner.js';
import { addDays, isValidDate, localParts } from './time.js';

export interface ApiLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

const MAX_BODY_BYTES = 32 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
/** Google event ids (instances of a series carry a _<time> suffix). */
const EVENT_ID = '[A-Za-z0-9_]{3,300}';
/** Proposal codes A, B, ... AA. */
const CODE = '[A-Z]{1,3}';

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (ctx: { body: Record<string, unknown>; query: URLSearchParams; params: string[]; actor: Actor }) => Promise<unknown> | unknown;
interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  name: string;
  learning?: true;
  handler: Handler;
}

function dateParam(query: URLSearchParams, name: string, fallback: string): string {
  const v = query.get(name);
  if (v === null) return fallback;
  if (!isValidDate(v)) throw new HttpError(400, 'invalid_request', `${name} must be a date YYYY-MM-DD`);
  return v;
}

/**
 * Internal API for the hermes-broker (and operators). Every route is listed here with its input
 * checks in Planner; callers must send X-Planner-Key. Not published on the host.
 */
export function createApi(planner: Planner, notify: Notify, clientKeys: Array<{ name: string; key: string }>, logger: ApiLogger): Server {
  const routes: Route[] = [
    {
      method: 'GET',
      pattern: /^\/status$/,
      name: 'status',
      handler: () => {
        const now = localParts(new Date(), planner.timeZone);
        return {
          timeZone: planner.timeZone,
          localDate: now.date,
          localTime: now.time,
          calendar: { ...planner.google.status(), managed: planner.managedCalendar() },
          settings: planner.settings(),
        };
      },
    },
    {
      method: 'GET', pattern: /^\/learning\/availability$/, name: 'learning.availability', learning: true,
      handler: ({ query }) => {
        const days = Number(query.get('days') ?? 1);
        if (!Number.isInteger(days) || days < 1 || days > 7) throw new HttpError(400, 'invalid_request', 'days must be 1-7');
        return planner.learningAvailability(dateParam(query, 'date', planner.today()), days);
      },
    },
    { method: 'POST', pattern: /^\/learning\/proposals$/, name: 'learning.proposals.create', learning: true,
      handler: ({ body }) => ({ proposal: planner.createLearningProposal(body) }),
    },
    { method: 'GET', pattern: /^\/day$/, name: 'day', handler: ({ query }) => planner.day(dateParam(query, 'date', planner.today())) },
    {
      method: 'GET',
      pattern: /^\/week$/,
      name: 'week',
      handler: async ({ query }) => {
        const start = dateParam(query, 'start', planner.today());
        const days = [];
        for (let i = 0; i < 7; i++) days.push(await planner.day(addDays(start, i)));
        return { days };
      },
    },
    {
      method: 'POST',
      pattern: /^\/plans\/generate$/,
      name: 'plans.generate',
      handler: async ({ body, actor }) => {
        only(body, ['date', 'days']);
        const days = body.days === undefined ? 1 : body.days;
        return { days: await planner.generate(body.date as string, days as number, actor) };
      },
    },
    {
      method: 'POST',
      pattern: /^\/plans\/confirm$/,
      name: 'plans.confirm',
      handler: async ({ body, actor }) => {
        only(body, ['dates']);
        return { days: await planner.confirm(body.dates as string[], actor) };
      },
    },
    { method: 'POST', pattern: /^\/blocks$/, name: 'blocks.add', handler: ({ body, actor }) => ({ block: planner.addBlock(body, actor) }) },
    {
      method: 'POST',
      pattern: new RegExp(`^/blocks/(${UUID})/update$`),
      name: 'blocks.update',
      handler: ({ body, params, actor }) => ({ block: planner.updateBlock(params[0], body, actor) }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/blocks/(${UUID})/remove$`),
      name: 'blocks.remove',
      handler: ({ params, actor }) => {
        planner.removeBlock(params[0], actor);
        return { removed: true };
      },
    },
    {
      method: 'GET',
      pattern: /^\/todos$/,
      name: 'todos.list',
      handler: ({ query }) => {
        const status = query.get('status') ?? 'open';
        if (!['open', 'done', 'all'].includes(status)) throw new HttpError(400, 'invalid_request', 'status must be open, done or all');
        return { todos: planner.listTodos(status as 'open' | 'done' | 'all') };
      },
    },
    { method: 'POST', pattern: /^\/todos$/, name: 'todos.add', handler: ({ body, actor }) => ({ todo: planner.addTodo(body, actor) }) },
    {
      method: 'POST',
      pattern: new RegExp(`^/todos/(${UUID})/update$`),
      name: 'todos.update',
      handler: ({ body, params, actor }) => ({ todo: planner.updateTodo(params[0], body, actor) }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/todos/(${UUID})/progress$`),
      name: 'todos.progress',
      handler: ({ body, params, actor }) => {
        only(body, ['minutes', 'done']);
        if (body.done !== undefined && typeof body.done !== 'boolean') throw new HttpError(400, 'invalid_request', 'done must be true or false');
        return { todo: planner.progressTodo(params[0], body.minutes as number | undefined, body.done === true, actor) };
      },
    },
    { method: 'GET', pattern: /^\/settings$/, name: 'settings.get', handler: () => ({ settings: planner.settings() }) },
    { method: 'POST', pattern: /^\/settings$/, name: 'settings.update', handler: ({ body, actor }) => ({ settings: planner.updateSettings(body, actor) }) },
    {
      method: 'GET',
      pattern: /^\/changes$/,
      name: 'changes',
      handler: ({ query }) => {
        const limit = Number(query.get('limit') ?? 30);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'invalid_request', 'limit must be 1-200');
        return { changes: planner.changes(limit) };
      },
    },
    { method: 'GET', pattern: /^\/calendars$/, name: 'calendars', handler: async () => ({ calendars: await planner.calendars() }) },
    { method: 'POST', pattern: /^\/events$/, name: 'events.add', handler: async ({ body, actor }) => ({ event: await planner.addEvent(body, actor) }) },
    {
      method: 'POST',
      pattern: new RegExp(`^/events/(${EVENT_ID})/update$`),
      name: 'events.update',
      handler: async ({ body, params, actor }) => ({ event: await planner.updateEvent(params[0], body, actor) }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/events/(${EVENT_ID})/remove$`),
      name: 'events.remove',
      handler: async ({ body, params, actor }) => planner.removeEvent(params[0], body, actor),
    },
    { method: 'POST', pattern: /^\/reference\/sync$/, name: 'reference.sync', handler: ({ body, actor }) => planner.referenceSync(body, actor) },
    { method: 'POST', pattern: /^\/reference\/search$/, name: 'reference.search', handler: ({ body }) => planner.referenceSearch(body) },
    {
      method: 'GET',
      pattern: /^\/proposals$/,
      name: 'proposals.list',
      handler: ({ query }) => {
        const status = query.get('status') ?? 'draft';
        if (status !== 'draft' && status !== 'all') throw new HttpError(400, 'invalid_request', 'status must be draft or all');
        return { proposals: planner.proposals(status) };
      },
    },
    // create / show / edit return the draft with the code checks (checks.ts) as warnings.
    {
      method: 'POST',
      pattern: /^\/proposals$/,
      name: 'proposals.create',
      handler: async ({ body, actor }) => ({ proposal: await planner.checkedProposal(planner.createProposal(body, actor).code) }),
    },
    { method: 'GET', pattern: new RegExp(`^/proposals/(${CODE})$`), name: 'proposals.get', handler: async ({ params }) => ({ proposal: await planner.checkedProposal(params[0]) }) },
    {
      method: 'POST',
      pattern: new RegExp(`^/proposals/(${CODE})/edit$`),
      name: 'proposals.edit',
      handler: async ({ body, params, actor }) => ({ proposal: await planner.checkedProposal(planner.editProposal(params[0], body, actor).code) }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/proposals/(${CODE})/apply$`),
      name: 'proposals.apply',
      handler: async ({ body, params, actor }) => ({ proposal: await planner.applyProposal(params[0], body, actor) }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/proposals/(${CODE})/discard$`),
      name: 'proposals.discard',
      handler: ({ params, actor }) => planner.discardProposal(params[0], actor),
    },
    {
      method: 'POST',
      pattern: /^\/calendar\/connect$/,
      name: 'calendar.connect',
      handler: async () => {
        const started = planner.google.start();
        // The link also goes to Discord, so the owner can open it from the phone or PC.
        let posted = false;
        try {
          await notify({ type: 'calendar', key: `calendar:connect:${Date.parse(started.expiresAt)}`, calendar: { status: 'connect', ...started } });
          posted = true;
        } catch (error) {
          logger.warn('Could not post the calendar link', { error: (error as Error).message });
        }
        return { ...started, postedToDiscord: posted, note: 'Open the link on this PC (the sign-in returns to http://127.0.0.1); it works for 15 minutes.' };
      },
    },
  ];

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://planner');
    const audit: Record<string, unknown> = { method: req.method, path: url.pathname };
    let status = 500;
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        status = 200;
        return send(res, 200, { status: 'ok' });
      }
      const client = clientKeys.find((c) => keyMatches(req.headers['x-planner-key'], c.key));
      if (!client) throw new HttpError(401, 'auth_error', 'Missing or invalid planner key');
      audit.client = client.name;
      const candidates = routes.filter((r) => r.pattern.test(url.pathname));
      if (!candidates.length) throw new HttpError(404, 'not_found', 'Not found');
      const route = candidates.find((r) => r.method === req.method);
      if (!route) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      const learning = client.name === 'learning';
      if (learning !== (route.learning === true)) throw new HttpError(403, 'forbidden', 'Planner key does not have access to this route');
      audit.op = route.name;
      const params = (url.pathname.match(route.pattern) ?? []).slice(1);
      const body = req.method === 'POST' ? await readJson(req) : {};
      const actor: Actor = client.name === 'hermes-broker' ? 'hermes' : 'system';
      const result = await route.handler({ body, query: url.searchParams, params, actor });
      status = 200;
      send(res, 200, result);
    } catch (error) {
      const e =
        error instanceof HttpError
          ? error
          : error instanceof PlannerError
            ? new HttpError(error.status, error.code, error.message)
            : error instanceof GoogleError
              ? new HttpError(error.status === 401 || error.status === 403 ? 502 : error.status >= 500 ? 502 : error.status, error.reconnect ? 'calendar_not_connected' : 'calendar_error', error.message)
              : new HttpError(500, 'server_error', 'Planner error');
      if (e.status === 500) logger.warn('Unexpected planner error', { error: (error as Error).message });
      status = e.status;
      send(res, e.status, { statusCode: e.status, code: e.code, message: e.message });
    } finally {
      logger.info('request', { ...audit, status });
    }
  };
  return createServer((req, res) => void handle(req, res));
}

/**
 * The only thing published on the host (127.0.0.1): Google's redirect after the owner signs in.
 * It accepts only a state the planner issued in the last 15 minutes.
 */
export function createOAuthServer(planner: Planner, notify: Notify, logger: ApiLogger): Server {
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });
    if (req.method !== 'GET' || url.pathname !== '/oauth/callback') return page(res, 404, '찾을 수 없는 주소예요.');
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const denied = url.searchParams.get('error');
    if (denied) {
      logger.warn('Google sign-in was not completed', { error: denied.slice(0, 60) });
      return page(res, 400, 'Google 연결을 취소했거나 권한을 주지 않았어요. 다시 하려면 Kelly에게 "캘린더 연결해줘"라고 보내주세요.');
    }
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(state) || !/^[A-Za-z0-9/._~-]{10,512}$/.test(code)) return page(res, 400, '잘못된 요청이에요.');
    try {
      await planner.google.finish(state, code);
      logger.info('Google Calendar connected');
      await notify({ type: 'calendar', key: `calendar:connected:${Date.now()}`, calendar: { status: 'connected' } }).catch(() => undefined);
      page(res, 200, '✅ Google Calendar가 연결됐어요. 이 창은 닫아도 돼요.');
    } catch (error) {
      const message = (error as Error).message;
      logger.warn('Google Calendar connection failed', { error: message });
      page(res, 400, `연결하지 못했어요: ${escapeHtml(message)}`);
    }
  };
  return createServer((req, res) => void handle(req, res));
}

function page(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  res.end(
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Personal AI planner</title>` +
      `<style>body{font-family:system-ui,sans-serif;background:#f6f5f2;color:#1d1d1b;display:grid;place-items:center;min-height:100vh;margin:0}` +
      `main{background:#fff;border-radius:14px;padding:32px 36px;max-width:440px;box-shadow:0 2px 16px rgba(0,0,0,.06);font-size:17px;line-height:1.6}` +
      `@media(prefers-color-scheme:dark){body{background:#1b1b1a;color:#eee}main{background:#262624}}</style></head>` +
      `<body><main>${message}</main></body></html>`,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function only(body: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw new HttpError(400, 'invalid_request', `Unexpected fields: ${extra.join(', ')}`);
}

function keyMatches(header: string | string[] | undefined, key: string): boolean {
  if (typeof header !== 'string') return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(key).digest();
  return timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'invalid_request', 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_request', 'Body must be valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'invalid_request', 'Body must be a JSON object');
  return value as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
