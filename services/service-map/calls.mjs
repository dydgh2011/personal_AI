// Recent calls per link (Service Map stage 3): counts only.
//
// Sources (all read-only, all on the host through the Docker CLI):
//   - request logs: hermes-broker, knowledge, planner and notifier print one JSON line per request
//     ({"msg":"request", op, client, status, ...}). Only `op`, `client` and `status` are kept; the
//     path, ids and everything else on the line are dropped while parsing.
//   - llm-gateway `calls` table: one row per provider call. A read-only SQLite query inside the
//     gateway container returns only (client, alias, outcome, count). No prompt, error text or
//     token count leaves the container. The /usage/series endpoint was not used: it needs a caller
//     key, and the collector must not read keys.

export const WINDOW_HOURS = 24;

/** Services whose request log names the caller (`client`). Their logs count calls INTO them. */
export const CALLEE_LOGS = ['knowledge', 'planner', 'notifier'];

/**
 * Request lines of a service's log → [{ client, op, status }]. Health checks and lines that are
 * not request records are skipped. Nothing but these three fields is returned.
 */
export function parseRequestLog(text, { sinceMs = null } = {}) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf('{');
    if (i < 0 || !line.includes('"request"')) continue;
    let rec;
    try {
      rec = JSON.parse(line.slice(i));
    } catch {
      continue;
    }
    if (!rec || rec.msg !== 'request' || rec.path === '/health') continue;
    if (sinceMs != null && typeof rec.ts === 'string' && Date.parse(rec.ts) < sinceMs) continue;
    rows.push({
      client: typeof rec.client === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(rec.client) ? rec.client : null,
      op: typeof rec.op === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(rec.op) ? rec.op : null,
      status: Number.isInteger(rec.status) ? rec.status : null,
    });
  }
  return rows;
}

/** The SQL the gateway container runs (read-only connection). Aggregates only. */
export const GATEWAY_QUERY =
  "const { DatabaseSync } = require('node:sqlite');" +
  "const db = new DatabaseSync(process.env.LLM_DB_FILE || '/var/lib/llm-gateway/gateway.db', { readOnly: true });" +
  "const rows = db.prepare('SELECT client, alias, outcome, COUNT(*) AS n FROM calls WHERE at >= ? GROUP BY client, alias, outcome').all(process.argv[1]);" +
  'process.stdout.write(JSON.stringify(rows));';

export function parseGatewayRows(text) {
  const rows = JSON.parse(String(text).trim() || '[]');
  if (!Array.isArray(rows)) throw new Error('gateway query did not return a list');
  return rows
    .filter((r) => r && typeof r.client === 'string' && typeof r.alias === 'string')
    .map((r) => ({ client: r.client, alias: r.alias, outcome: r.outcome === 'error' ? 'error' : 'ok', n: Number(r.n) || 0 }));
}

function bucket() {
  return { total: 0, failed: 0, ops: new Map() };
}

function addTo(b, op, n, failed) {
  b.total += n;
  if (failed) b.failed += n;
  const o = b.ops.get(op) || { name: op, total: 0, failed: 0 };
  o.total += n;
  if (failed) o.failed += n;
  b.ops.set(op, o);
}

const failedStatus = (s) => s != null && s >= 400;

/** Op name used when a request matched no operation (refused before routing). */
export const NO_OP = '(경로 없음)';

/**
 * Counts per link. `links` are the snapshot links with their `allowed` rule sets; a source only
 * counts links it can see (so "0" means "seen, no calls", and a missing `calls` means "not measured").
 *
 *   broker:   { rows, routes }  hermes → hermes-broker (every request) and hermes-broker → target
 *             (requests whose op is a route to that target; `routes` from parseBrokerRoutes).
 *   callees:  { knowledge: rows, planner: rows, notifier: rows }  caller = the line's `client`.
 *   gateway:  rows from parseGatewayRows; links to llm-gateway whose rules include chat aliases.
 *
 * Links the broker forwards on (to the controller, planner, knowledge, school) are counted from the
 * broker's own log, so op names match the broker's route names. The first source to claim a link
 * counts it; later ones skip it, so nothing is counted twice.
 */
export function aggregateCalls(links, { broker = null, callees = {}, gateway = null } = {}) {
  const out = new Map();
  const seen = new Map();
  const claim = (key, source) => {
    if (!out.has(key)) {
      out.set(key, bucket());
      seen.set(key, source);
    }
    return out.get(key);
  };
  const linkKeys = new Set(links.map((l) => `${l.from}>${l.to}`));

  if (broker) {
    // The broker logs the requests Kelly sends it. Its own background calls (the task watcher
    // polling the controller, notifying the notifier) are not in that log: links the broker only
    // uses in the background are left to the callee's log.
    const targetOf = new Map(broker.routes.map((r) => [r.name, r.target]));
    const targets = new Set(broker.routes.map((r) => r.target));
    const entry = 'hermes>hermes-broker';
    const forwarded = 'hermes-broker 로그 (Kelly 요청 전달분)';
    if (linkKeys.has(entry)) claim(entry, 'hermes-broker 로그');
    for (const l of links) if (l.from === 'hermes-broker' && targets.has(l.to)) claim(`${l.from}>${l.to}`, forwarded);
    for (const r of broker.rows) {
      const op = r.op || NO_OP;
      const failed = failedStatus(r.status);
      if (out.has(entry)) addTo(out.get(entry), op, 1, failed);
      const k = `hermes-broker>${targetOf.get(r.op)}`;
      if (out.has(k) && seen.get(k) === forwarded) addTo(out.get(k), op, 1, failed);
    }
  }

  for (const [callee, rows] of Object.entries(callees)) {
    if (!rows) continue;
    const source = `${callee} 로그`;
    for (const l of links) {
      const k = `${l.from}>${l.to}`;
      if (l.to === callee && !out.has(k)) claim(k, source);
    }
    for (const r of rows) {
      if (!r.client) continue;
      const k = `${r.client}>${callee}`;
      if (!out.has(k) || seen.get(k) !== source) continue;
      addTo(out.get(k), r.op || (callee === 'notifier' ? 'notify' : NO_OP), 1, failedStatus(r.status));
    }
  }

  if (gateway) {
    const source = 'llm-gateway calls 표 (공급자 호출 단위)';
    for (const l of links) {
      const k = `${l.from}>${l.to}`;
      const chats = (l.allowed || []).some((set) => set.ops.some((o) => o.name.startsWith('chat.')));
      if (l.to === 'llm-gateway' && chats && !out.has(k)) claim(k, source);
    }
    for (const r of gateway) {
      const k = `${r.client}>llm-gateway`;
      if (!out.has(k) || seen.get(k) !== source) continue;
      addTo(out.get(k), `chat.${r.alias}`, r.n, r.outcome === 'error');
    }
  }

  const result = new Map();
  for (const [k, b] of out) {
    result.set(k, {
      total: b.total,
      failed: b.failed,
      ops: [...b.ops.values()].sort((x, y) => y.total - x.total || x.name.localeCompare(y.name)),
      source: seen.get(k),
    });
  }
  return result;
}
