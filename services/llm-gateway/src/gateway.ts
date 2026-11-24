import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ALIASES, listCost, POOLS, PROVIDERS, type ClientDef, type ProviderId, type RouteDef } from './config.js';
import { parseSeriesQuery, SeriesError, usageSeries } from './series.js';
import { estimatePromptTokens, redact, shapeBody } from './shape.js';
import { dayIn, OWNER_TIME_ZONE, type Store } from './store.js';

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** Typed events for the notifier (rendered there with fixed templates). */
export type LlmEvent =
  | { kind: 'free_switch'; pool: string; label: string; used: number; limit: number; unit: 'tokens' | 'requests' }
  | { kind: 'paid_needed'; alias: string; capUsd: number }
  | { kind: 'paid_cap'; spentUsd: number; capUsd: number };

export interface GatewayOptions {
  clients: ClientDef[];
  providerKeys: Partial<Record<ProviderId, string>>;
  store: Store;
  logger: Logger;
  notify: (event: LlmEvent, key: string) => Promise<void>;
  paidDailyCapUsd: number;
  headersTimeoutMs: number;
  idleTimeoutMs: number;
  /** Longest provider "retry after" worth waiting for before falling back. */
  maxRetryWaitMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Tests only: replace provider base URLs. */
  baseUrls?: Partial<Record<ProviderId, string>>;
}

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const OUTPUT_RESERVE_TOKENS = 4096;
/** Statuses after which the next route is tried. */
const FALLBACK_STATUSES = new Set([400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504, 529]);

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', `Request body over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body must be JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'invalid_request', 'Body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function openAiError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { message, type: status === 429 ? 'rate_limit_error' : 'gateway_error', code } });
}

interface Usage {
  prompt: number;
  cached: number;
  completion: number;
}

function usageOf(u: unknown): Usage | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  const prompt = Number(o.prompt_tokens ?? 0);
  const completion = Number(o.completion_tokens ?? 0);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || (prompt === 0 && completion === 0)) return null;
  const details = (o.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cached = Number(details.cached_tokens ?? 0);
  return { prompt, completion, cached: Number.isFinite(cached) ? cached : 0 };
}

/** Seconds to wait from a 429 (Retry-After header, or Gemini's "retryDelay": "12s"). */
function retryAfterMs(res: Response, bodyText: string): number | null {
  const h = res.headers.get('retry-after');
  if (h && /^\d+(\.\d+)?$/.test(h.trim())) return Math.ceil(Number(h) * 1000);
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(bodyText);
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

export function createGateway(opts: GatewayOptions): Server {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clientDigests = opts.clients.map((c) => ({ client: c, digest: digest(c.key) }));

  const authenticate = (req: IncomingMessage): ClientDef => {
    const token = bearer(req);
    if (!token) throw new HttpError(401, 'unauthorized', 'Missing bearer key');
    const d = digest(token);
    const found = clientDigests.find((c) => timingSafeEqual(c.digest, d));
    if (!found) throw new HttpError(401, 'unauthorized', 'Invalid key');
    return found.client;
  };

  const notifyOnce = (key: string, event: LlmEvent) => {
    if (!opts.store.firstNotice(key, now())) return;
    opts.notify(event, key).catch((err: unknown) => opts.logger.warn('Notify failed', { key, error: String(err) }));
  };

  /** Why a route cannot be used right now (null = usable). */
  const blocked = (alias: string, route: RouteDef, estimate: number, reserve: number): string | null => {
    if (!opts.providerKeys[route.provider]) return 'no_key';
    if (route.maxPromptTokens && estimate > route.maxPromptTokens) return 'too_large';
    const at = now();
    if (route.pool) {
      const pool = POOLS[route.pool];
      const used = opts.store.poolUsage(pool.id, at);
      if (pool.tokensPerDay !== null && used.tokens + estimate + reserve > pool.tokensPerDay * pool.stopAt) {
        notifyOnce(`free_switch:${pool.id}:${used.day}`, {
          kind: 'free_switch', pool: pool.id, label: pool.label, used: used.tokens, limit: pool.tokensPerDay, unit: 'tokens',
        });
        return 'free_quota';
      }
      if (pool.requestsPerDay !== null && used.requests + 1 > pool.requestsPerDay * pool.stopAt) {
        notifyOnce(`free_switch:${pool.id}:${used.day}`, {
          kind: 'free_switch', pool: pool.id, label: pool.label, used: used.requests, limit: pool.requestsPerDay, unit: 'requests',
        });
        return 'free_quota';
      }
    }
    if (route.paid) {
      if (!ALIASES[alias].explicitPaid && !opts.store.approval(at).enabled) return 'paid_not_approved';
      if (opts.store.paidSpend(at) >= opts.paidDailyCapUsd) return 'paid_cap';
    }
    return null;
  };

  const record = (
    client: ClientDef, alias: string, route: RouteDef, status: number, usage: Usage | null, startedAt: number, error: string | null,
  ) => {
    const u = usage ?? { prompt: 0, cached: 0, completion: 0 };
    const list = listCost(route.model, u.prompt, u.cached, u.completion);
    opts.store.record({
      at: now(), client: client.name, alias, provider: route.provider, model: route.model, pool: route.pool ?? null,
      paid: !!route.paid, status, outcome: error ? 'error' : 'ok', promptTokens: u.prompt, cachedTokens: u.cached,
      completionTokens: u.completion, costUsd: route.paid ? list : 0, listCostUsd: list, latencyMs: Date.now() - startedAt,
      error: error ? redact(error).text.slice(0, 500) : null,
    });
  };

  /** One upstream attempt. Returns true when the client has been answered. */
  const attempt = async (
    req: IncomingMessage, res: ServerResponse, client: ClientDef, alias: string, route: RouteDef, body: Record<string, unknown>, estimate: number,
  ): Promise<{ done: true } | { done: false; status: number; retryMs: number | null; error: string }> => {
    const provider = PROVIDERS[route.provider];
    const shaped = shapeBody(body, provider, route.model, { redact: alias !== 'private' });
    if (shaped.redactions) opts.logger.info('Redacted secrets before sending', { alias, provider: route.provider, count: shaped.redactions });
    const stream = shaped.body.stream === true;
    const base = (opts.baseUrls?.[route.provider] ?? provider.baseUrl).replace(/\/+$/, '');
    const controller = new AbortController();
    let clientClosed = false;
    const onClose = () => {
      clientClosed = true;
      controller.abort();
    };
    res.once('close', onClose);
    let timer = setTimeout(() => controller.abort(), opts.headersTimeoutMs);
    const startedAt = Date.now();
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.providerKeys[route.provider]}` },
        body: JSON.stringify(shaped.body),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      res.off('close', onClose);
      const msg = controller.signal.aborted ? 'timeout or client closed' : `network: ${String(err)}`;
      record(client, alias, route, 0, null, startedAt, msg);
      return { done: false, status: 0, retryMs: null, error: msg };
    }
    clearTimeout(timer);

    if (upstream.status !== 200) {
      const text = await upstream.text().catch(() => '');
      res.off('close', onClose);
      record(client, alias, route, upstream.status, null, startedAt, `${upstream.status}: ${text.slice(0, 400)}`);
      return {
        done: false, status: upstream.status, retryMs: upstream.status === 429 ? retryAfterMs(upstream, text) : null,
        error: `${route.provider} ${upstream.status}`,
      };
    }

    const routeHeader = `${route.provider}/${route.model}`;
    if (!stream) {
      const text = await upstream.text();
      res.off('close', onClose);
      let usage: Usage | null = null;
      try {
        usage = usageOf((JSON.parse(text) as Record<string, unknown>).usage);
      } catch {
        // pass the body through anyway
      }
      usage ??= { prompt: estimate, cached: 0, completion: Math.ceil(Buffer.byteLength(text) / 4) };
      record(client, alias, route, 200, usage, startedAt, null);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Gateway-Route': routeHeader });
      res.end(text);
      return { done: true };
    }

    // Stream: pass every chunk through as it arrives and read the usage chunk at the end.
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Gateway-Route': routeHeader });
    let usage: Usage | null = null;
    let pending = '';
    let bytes = 0;
    const scan = (text: string) => {
      pending += text;
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line.startsWith('data:') || !line.includes('"usage"')) continue;
        try {
          const u = usageOf((JSON.parse(line.slice(5).trim()) as Record<string, unknown>).usage);
          if (u) usage = u;
        } catch {
          // not JSON ([DONE]) or a partial line
        }
      }
    };
    const decoder = new TextDecoder();
    let failed: string | null = null;
    try {
      const reader = upstream.body!.getReader();
      for (;;) {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), opts.idleTimeoutMs);
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        scan(decoder.decode(value, { stream: true }));
        if (!res.write(value)) await new Promise<void>((r) => res.once('drain', () => r()));
      }
    } catch (err) {
      // The client hanging up once it has its answer is normal (not every provider sends [DONE]).
      if (!clientClosed) failed = controller.signal.aborted ? 'stream idle timeout' : `stream: ${String(err)}`;
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      res.end();
    }
    const finalUsage: Usage = usage ?? { prompt: estimate, cached: 0, completion: Math.ceil(bytes / 8) };
    record(client, alias, route, 200, finalUsage, startedAt, failed);
    if (failed) opts.logger.warn('Stream ended early', { alias, route: routeHeader, error: failed });
    void req;
    return { done: true };
  };

  const chat = async (req: IncomingMessage, res: ServerResponse, client: ClientDef, audit: Record<string, unknown>) => {
    const body = await readJson(req);
    const alias = typeof body.model === 'string' ? body.model : '';
    audit.alias = alias;
    if (!Object.hasOwn(ALIASES, alias)) throw new HttpError(400, 'unknown_model', `model must be one of: ${client.aliases.join(', ')}`);
    if (!client.aliases.includes(alias)) throw new HttpError(403, 'alias_not_allowed', `This caller may use: ${client.aliases.join(', ') || 'nothing'}`);
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw new HttpError(400, 'invalid_request', 'messages must be a non-empty array');

    const estimate = estimatePromptTokens(body);
    const askedMax = Number(body.max_completion_tokens ?? body.max_tokens ?? 0);
    const reserve = Number.isFinite(askedMax) && askedMax > 0 ? Math.min(askedMax, 32_000) : OUTPUT_RESERVE_TOKENS;
    const skipped: string[] = [];
    let paidBlocked = false;
    let paidCap = false;
    let lastStatus = 0;

    for (const route of ALIASES[alias].routes) {
      const why = blocked(alias, route, estimate, reserve);
      if (why) {
        skipped.push(`${route.provider}:${why}`);
        if (why === 'paid_not_approved') paidBlocked = true;
        if (why === 'paid_cap') paidCap = true;
        continue;
      }
      for (let tryNo = 0; tryNo < 2; tryNo++) {
        const result = await attempt(req, res, client, alias, route, body, estimate);
        if (result.done) {
          audit.route = `${route.provider}/${route.model}`;
          if (skipped.length) audit.skipped = skipped.join(',');
          return;
        }
        lastStatus = result.status;
        skipped.push(`${route.provider}:${result.status || 'network'}`);
        if (res.destroyed) return;
        const canWait = !route.paid && result.status === 429 && result.retryMs !== null && result.retryMs <= opts.maxRetryWaitMs;
        if (!canWait || tryNo === 1 || !FALLBACK_STATUSES.has(result.status)) break;
        await sleep(result.retryMs! + 250);
      }
    }
    audit.skipped = skipped.join(',');
    const at = now();
    const day = dayIn(OWNER_TIME_ZONE, at);
    if (paidCap) {
      notifyOnce(`paid_cap:${day}`, { kind: 'paid_cap', spentUsd: Math.round(opts.store.paidSpend(at) * 100) / 100, capUsd: opts.paidDailyCapUsd });
      throw new HttpError(429, 'paid_daily_cap', `오늘 유료 상한($${opts.paidDailyCapUsd})에 닿았어요. 내일 다시 무료로 시작해요.`);
    }
    if (paidBlocked) {
      notifyOnce(`paid_needed:${day}`, { kind: 'paid_needed', alias, capUsd: opts.paidDailyCapUsd });
      throw new HttpError(429, 'free_quota_exhausted', '무료 한도가 모두 찼어요. Discord에서 /ai-paid on 으로 오늘만 유료(nano)를 허용할 수 있어요.');
    }
    throw new HttpError(lastStatus === 429 ? 429 : 502, 'all_routes_failed', `모든 경로가 실패했어요 (${skipped.join(', ')})`);
  };

  const usage = (query: URLSearchParams) => {
    const at = now();
    const days = Math.min(Math.max(Number(query.get('days') ?? 7) || 7, 1), 92);
    const approval = opts.store.approval(at);
    return {
      localDay: dayIn(OWNER_TIME_ZONE, at),
      pools: Object.values(POOLS).map((p) => {
        const u = opts.store.poolUsage(p.id, at);
        const used = p.tokensPerDay !== null ? u.tokens / p.tokensPerDay : u.requests / (p.requestsPerDay ?? 1);
        return {
          id: p.id, label: p.label, day: u.day, resetTimeZone: p.resetTimeZone, tokens: u.tokens, requests: u.requests,
          tokensPerDay: p.tokensPerDay, requestsPerDay: p.requestsPerDay, stopAt: p.stopAt, usedShare: Math.round(used * 1000) / 1000,
        };
      }),
      paid: { approvedToday: approval.enabled, approvedAt: approval.at, spentTodayUsd: Math.round(opts.store.paidSpend(at) * 10_000) / 10_000, dailyCapUsd: opts.paidDailyCapUsd },
      totalSpentUsd: Math.round(opts.store.totalSpend() * 10_000) / 10_000,
      aliases: Object.fromEntries(Object.entries(ALIASES).map(([k, v]) => [k, { description: v.description, routes: v.routes.map((r) => `${r.provider}/${r.model}${r.paid ? ' (paid)' : ''}`) }])),
      daily: opts.store.daily(days, at),
      recentErrors: opts.store.recentErrors(10),
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://gateway');
    const audit: Record<string, unknown> = { method: req.method, path: url.pathname };
    const started = Date.now();
    try {
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { status: 'ok' });
      const client = authenticate(req);
      audit.client = client.name;
      if (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') {
        if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST only');
        await chat(req, res, client, audit);
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        return sendJson(res, 200, {
          object: 'list',
          data: client.aliases.map((id) => ({ id, object: 'model', owned_by: 'personal-ai', description: ALIASES[id].description })),
        });
      }
      if (req.method === 'GET' && url.pathname === '/usage') {
        if (!client.usage) throw new HttpError(403, 'forbidden', 'Not allowed');
        return sendJson(res, 200, usage(url.searchParams));
      }
      if (req.method === 'GET' && url.pathname === '/usage/series') {
        if (!client.usage) throw new HttpError(403, 'forbidden', 'Not allowed');
        const at = now();
        let query;
        try {
          query = parseSeriesQuery(url.searchParams, at);
        } catch (err) {
          if (err instanceof SeriesError) throw new HttpError(400, 'invalid_request', err.message);
          throw err;
        }
        return sendJson(res, 200, usageSeries(opts.store.db, query, { paidDailyCapUsd: opts.paidDailyCapUsd, now: at }));
      }
      if (req.method === 'POST' && url.pathname === '/control/paid') {
        if (!client.control) throw new HttpError(403, 'forbidden', 'Not allowed');
        const body = await readJson(req);
        if (typeof body.enable !== 'boolean' || Object.keys(body).some((k) => k !== 'enable')) throw new HttpError(400, 'invalid_request', 'Body must be {"enable": true|false}');
        const at = now();
        opts.store.setApproval(at, body.enable, client.name);
        audit.paid = body.enable;
        return sendJson(res, 200, { approvedToday: body.enable, localDay: dayIn(OWNER_TIME_ZONE, at), dailyCapUsd: opts.paidDailyCapUsd, spentTodayUsd: opts.store.paidSpend(at) });
      }
      throw new HttpError(404, 'not_found', 'Not found');
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, 'internal', 'Internal error');
      if (!(err instanceof HttpError)) opts.logger.warn('Unhandled error', { error: String(err) });
      audit.status = e.status;
      audit.error = e.code;
      openAiError(res, e.status, e.code, e.message);
    } finally {
      audit.ms = Date.now() - started;
      opts.logger.info('request', audit);
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.requestTimeout = 0; // long streams; per-request timeouts are enforced above
  server.headersTimeout = 30_000;
  return server;
}
