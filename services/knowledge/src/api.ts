import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { KnowledgeError, type Actor, type Knowledge } from './knowledge.js';

export interface ApiLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** Imported files arrive with their extracted text (a textbook can be megabytes). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SEARCH_KINDS = ['page', 'fact', 'activity', 'raw'] as const;
const SCHOOL_ROUTES = new Set(['status', 'raw.add']);

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
  handler: Handler;
  /** Only these callers (default: every caller with a key). */
  clients?: string[];
}

function kindsParam(query: URLSearchParams): Array<(typeof SEARCH_KINDS)[number]> | undefined {
  const v = query.get('kinds');
  if (!v) return undefined;
  const kinds = v.split(',');
  if (!kinds.every((k) => (SEARCH_KINDS as readonly string[]).includes(k))) throw new HttpError(400, 'invalid_request', `kinds must be a comma list of ${SEARCH_KINDS.join(', ')}`);
  return kinds as Array<(typeof SEARCH_KINDS)[number]>;
}

/**
 * Internal API for the hermes-broker (and operators). Callers send X-Knowledge-Key.
 * Not published on the host.
 */
export function createApi(kb: Knowledge, clientKeys: Array<{ name: string; key: string }>, logger: ApiLogger): Server {
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/status$/, name: 'status', handler: () => ({ timeZone: kb.timeZone, today: kb.localDate(), ...kb.stats() }) },
    // layer 0
    { method: 'POST', pattern: /^\/raw$/, name: 'raw.add', handler: ({ body, actor }) => kb.addRaw(body, actor) },
    { method: 'POST', pattern: /^\/raw\/document$/, name: 'raw.document', handler: ({ body, actor }) => kb.addDocument(body, actor) },
    { method: 'GET', pattern: /^\/raw$/, name: 'raw.list', handler: ({ query }) => ({ items: kb.listRaw(query) }) },
    { method: 'GET', pattern: new RegExp(`^/raw/(${UUID})$`), name: 'raw.get', handler: ({ params, query }) => kb.getRaw(params[0], query) },
    // bulk import (operator only: Claude Code with the operator key, never Hermes)
    { method: 'GET', pattern: /^\/raw\/by-sha\/([0-9a-f]{64})$/, name: 'raw.bySha', handler: ({ params }) => kb.rawBySha(params[0]), clients: ['operator'] },
    { method: 'POST', pattern: /^\/raw\/file$/, name: 'raw.file', handler: ({ body, actor }) => kb.addRawFile(body, actor), clients: ['operator'] },
    // permanent deletion on the owner's request (Hermes only after the owner's explicit OK, enforced by the plugin)
    { method: 'POST', pattern: /^\/purge$/, name: 'purge', handler: ({ body, actor }) => kb.purge(body, actor) },
    // layer 2
    { method: 'GET', pattern: /^\/pages$/, name: 'pages.list', handler: ({ query }) => ({ pages: kb.listPages(query) }) },
    { method: 'POST', pattern: /^\/pages$/, name: 'pages.save', handler: ({ body, actor }) => kb.savePage(body, actor) },
    {
      method: 'GET',
      pattern: /^\/page$/,
      name: 'pages.get',
      handler: ({ query }) => {
        const ref = query.get('ref');
        if (!ref) throw new HttpError(400, 'invalid_request', 'ref is required (slug or title)');
        return kb.getPage(ref);
      },
    },
    { method: 'GET', pattern: /^\/facts$/, name: 'facts.list', handler: ({ query }) => kb.listFacts(query) },
    { method: 'POST', pattern: /^\/facts$/, name: 'facts.add', handler: ({ body, actor }) => kb.addFact(body, actor) },
    { method: 'POST', pattern: new RegExp(`^/facts/(${UUID})$`), name: 'facts.change', handler: ({ body, params, actor }) => kb.changeFact(params[0], body, actor) },
    { method: 'POST', pattern: /^\/links$/, name: 'links.save', handler: ({ body, actor }) => kb.link(body, actor) },
    // layer 1
    { method: 'POST', pattern: /^\/activities$/, name: 'activities.add', handler: ({ body, actor }) => kb.addActivity(body, actor) },
    {
      method: 'POST',
      pattern: new RegExp(`^/activities/(${UUID})$`),
      name: 'activities.change',
      handler: ({ body, params, actor }) => kb.changeActivity(params[0], body, actor),
    },
    { method: 'GET', pattern: /^\/timeline$/, name: 'timeline', handler: ({ query }) => kb.timeline(query) },
    // layer 3, search, graph, history
    { method: 'GET', pattern: /^\/profile$/, name: 'profile', handler: ({ query }) => kb.profile(query.get('compact') === '1') },
    {
      method: 'GET',
      pattern: /^\/search$/,
      name: 'search',
      handler: async ({ query }) => {
        const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
        if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 30)) throw new HttpError(400, 'invalid_request', 'limit must be 1-30');
        return { results: await kb.search(query.get('q') ?? '', { kinds: kindsParam(query), limit }), semantic: kb.embedder !== null };
      },
    },
    { method: 'GET', pattern: /^\/recall$/, name: 'recall', handler: ({ query }) => kb.recall(query.get('q') ?? '') },
    { method: 'GET', pattern: /^\/graph$/, name: 'graph', handler: () => kb.graph() },
    { method: 'GET', pattern: /^\/changes$/, name: 'changes', handler: ({ query }) => ({ changes: kb.changes(Number(query.get('limit') ?? 30) || 30) }) },
  ];

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://knowledge');
    const audit: Record<string, unknown> = { method: req.method, path: url.pathname };
    let status = 500;
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        status = 200;
        return send(res, 200, { status: 'ok' });
      }
      const client = clientKeys.find((c) => keyMatches(req.headers['x-knowledge-key'], c.key));
      if (!client) throw new HttpError(401, 'auth_error', 'Missing or invalid knowledge key');
      audit.client = client.name;
      const candidates = routes.filter((r) => r.pattern.test(url.pathname));
      if (!candidates.length) throw new HttpError(404, 'not_found', 'Not found');
      const route = candidates.find((r) => r.method === req.method);
      if (!route) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      audit.op = route.name;
      if (route.clients && !route.clients.includes(client.name)) throw new HttpError(403, 'forbidden', 'This operation is for the operator only');
      // The school connector only adds originals (and reads status).
      if (client.name === 'school' && !SCHOOL_ROUTES.has(route.name)) throw new HttpError(403, 'forbidden', 'The school connector may only add originals');
      const params = (url.pathname.match(route.pattern) ?? []).slice(1);
      const body = req.method === 'POST' ? await readJson(req) : {};
      const actor: Actor = client.name === 'hermes-broker' ? 'hermes' : client.name === 'school' ? 'system' : 'operator';
      const result = await route.handler({ body, query: url.searchParams, params, actor });
      status = 200;
      send(res, 200, result);
    } catch (error) {
      let body: Record<string, unknown>;
      if (error instanceof HttpError) {
        status = error.status;
        body = { statusCode: status, code: error.code, message: error.message };
      } else if (error instanceof KnowledgeError) {
        status = error.status;
        body = { statusCode: status, code: error.code, message: error.message, ...error.extra };
      } else {
        status = 500;
        logger.warn('Unexpected knowledge error', { error: (error as Error).message });
        body = { statusCode: 500, code: 'server_error', message: 'Knowledge store error' };
      }
      send(res, status, body);
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
