// Allowed operations per link (Service Map stage 2), read from the services' own source code.
//
// Nothing here is hand-written per operation: each parser reads the table the service itself
// enforces (hermes-broker ROUTES, knowledge client allowlists, LLM gateway CLIENT_RIGHTS, controller
// @RequireRole decorators, Learning controller decorators, notifier event types). Each parser checks
// whole table (e.g. as many parsed routes as `method:` entries), and throws when it did not, so a
// code change the parser cannot read fails loudly instead of silently shrinking the map.
//
// Output: names, methods and path shapes only. Regex parameters become `:id`-style placeholders;
// no environment value, key or token is read.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SOURCES = {
  broker: 'services/hermes-broker/src/broker.ts',
  knowledge: 'services/knowledge/src/api.ts',
  gatewayConfig: 'services/llm-gateway/src/config.ts',
  gateway: 'services/llm-gateway/src/gateway.ts',
  controllerDir: 'services/controller/src',
  controllerTokens: 'services/controller/src/auth/token-registry.ts',
  controllerConfig: 'services/controller/src/config/app-config.ts',
  learningDir: 'services/learning/src',
  notifier: 'services/notifier/src/notifier.ts',
};

class ExtractError extends Error {}
const lf = (text) => String(text).replace(/\r\n/g, '\n');
const fail = (source, message) => {
  throw new ExtractError(`${source}: ${message}`);
};

// ---------------------------------------------------------------- text helpers

/** Text between `start` (first match) and the first `end` after it. */
function block(text, start, end, source) {
  const i = text.indexOf(start);
  if (i < 0) fail(source, `"${start}" not found`);
  const j = text.indexOf(end, i + start.length);
  if (j < 0) fail(source, `end of "${start}" not found`);
  return text.slice(i + start.length, j);
}

/** Top-level `{ ... }` objects of an array body (brace depth; the code's regexes and templates are balanced). */
function topObjects(body) {
  const out = [];
  let depth = 0;
  let begin = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') {
      if (depth === 0) begin = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && begin >= 0) {
        out.push(body.slice(begin, i + 1));
        begin = -1;
      }
    }
  }
  return out;
}

const count = (text, re) => (text.match(re) || []).length;

const PARAM_NAMES = { TASK_ID: 'id', UUID: 'id', PROJECT_ID: 'project', EVENT_ID: 'event' };

/** Readable path from a route regex source: `^\/tasks\/${TASK_ID}$` → `/tasks/:id`. */
export function prettyPath(source) {
  let p = String(source).replace(/^\^/, '').replace(/\$$/, '');
  p = p.replace(/\(\$\{(\w+)\}\)|\$\{(\w+)\}/g, (_, a, b) => `:${PARAM_NAMES[a || b] || String(a || b).toLowerCase()}`);
  p = p.replace(/\(([a-z0-9_-]+(?:\|[a-z0-9_-]+)+)\)/gi, '{$1}');
  p = p.replace(/\((?:[^()]|\([^()]*\))*\)/g, ':param');
  p = p.replace(/\[[^\]]*\](?:\{[^}]*\}|[+*?])?/g, ':param');
  return p.replace(/\\(.)/g, '$1');
}

/** Pattern of a route object: a regex literal or `new RegExp(`...`)`. Returns the regex source. */
function patternOf(obj) {
  const lit = obj.match(/pattern:\s*\/((?:\\.|[^/\\\n])+)\/[a-z]*/);
  if (lit) return lit[1];
  const ctor = obj.match(/pattern:\s*new RegExp\(`([^`]*)`\)/);
  if (ctor) return ctor[1];
  return null;
}

const sortOps = (ops) => ops.slice().sort((a, b) => a.name.localeCompare(b.name) || a.method.localeCompare(b.method));

// ---------------------------------------------------------------- hermes-broker

/**
 * Broker ROUTES: every operation Hermes can ask for, with its upstream (`target`, default the
 * controller). Helper-built groups (`...plannerRoutes()`) are expanded from the helper's template.
 */
export function parseBrokerRoutes(text, source = SOURCES.broker) {
  text = lf(text);
  const body = block(text, 'const ROUTES: Route[] = [', '\n];', source);
  const routes = [];
  const objects = topObjects(body);
  for (const obj of objects) {
    const method = obj.match(/method:\s*'([A-Z]+)'/)?.[1];
    const name = obj.match(/name:\s*'([^']+)'/)?.[1];
    const pattern = patternOf(obj);
    if (!method || !name || pattern == null) fail(source, `cannot read route ${obj.slice(0, 80)}`);
    routes.push({ name, method, path: prettyPath(pattern), target: obj.match(/target:\s*'(\w+)'/)?.[1] || 'controller' });
  }
  if (objects.length !== count(body, /method:\s*'/g)) fail(source, 'some inline routes were not read');

  const spreads = [...body.matchAll(/\.\.\.(\w+)\(\)/g)].map((m) => m[1]);
  for (const fn of spreads) {
    const fnBody = block(text, `function ${fn}(): Route[] {`, '\n}\n', source);
    const helper = fnBody.match(/const (\w+) = \([^)]*\)[^=]*=>\s*\(\{([\s\S]*?)\}\);/);
    if (!helper) fail(source, `${fn}: route helper not found`);
    const [, h, def] = helper;
    const prefix = def.match(/pattern:\s*new RegExp\(`\^([^`$]*)\$\{path\}\$`\)/)?.[1];
    const namePrefix = def.match(/name:\s*`([^`$]*)\$\{name\}`/)?.[1];
    const target = def.match(/target:\s*'(\w+)'/)?.[1] || 'controller';
    if (prefix == null || namePrefix == null) fail(source, `${fn}: cannot read the helper's path or name template`);
    const calls = [...fnBody.matchAll(new RegExp(`\\b${h}\\(\\s*'([A-Z]+)',\\s*(?:'([^']*)'|\`([^\`]*)\`),\\s*'([^']+)'`, 'g'))];
    if (calls.length === 0) fail(source, `${fn}: no routes`);
    if (calls.length !== count(fnBody, new RegExp(`\\b${h}\\(\\s*'`, 'g'))) fail(source, `${fn}: some routes were not read`);
    for (const [, method, plain, tmpl, name] of calls) {
      routes.push({ name: namePrefix + name, method, path: prettyPath(prefix + (plain ?? tmpl)), target });
    }
  }
  if (routes.length === 0) fail(source, 'no routes');
  const names = new Set();
  for (const r of routes) {
    const k = `${r.method} ${r.name}`;
    if (names.has(k)) fail(source, `duplicate route ${k}`);
    names.add(k);
  }
  return routes;
}

// ---------------------------------------------------------------- knowledge

/** Knowledge routes plus CLIENT_ROUTES; `allowedFor(client)` mirrors the checks in createApi. */
export function parseKnowledgeApi(text, source = SOURCES.knowledge) {
  text = lf(text);
  const body = block(text, 'const routes: Route[] = [', '\n  ];', source);
  const objects = topObjects(body);
  const routes = objects.map((obj) => {
    const method = obj.match(/method:\s*'([A-Z]+)'/)?.[1];
    const name = obj.match(/name:\s*'([^']+)'/)?.[1];
    const pattern = patternOf(obj);
    if (!method || !name || pattern == null) fail(source, `cannot read route ${obj.slice(0, 80)}`);
    const clients = obj.match(/clients:\s*\[([^\]]*)\]/)?.[1];
    return { name, method, path: prettyPath(pattern), clients: clients ? [...clients.matchAll(/'([^']+)'/g)].map((m) => m[1]) : null };
  });
  if (routes.length === 0) fail(source, 'no routes');
  if (routes.length !== count(body, /method:\s*'/g)) fail(source, 'some routes were not read');

  const listBody = block(text, 'const CLIENT_ROUTES: Record<string, ReadonlySet<string>> = {', '\n};', source);
  const clientRoutes = {};
  for (const m of listBody.matchAll(/(?:'([^']+)'|([\w-]+)):\s*new Set\(\[([^\]]*)\]\)/g)) {
    clientRoutes[m[1] || m[2]] = [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  if (Object.keys(clientRoutes).length !== count(listBody, /new Set\(/g)) fail(source, 'some CLIENT_ROUTES entries were not read');
  const known = new Set(routes.map((r) => r.name));
  for (const [client, names] of Object.entries(clientRoutes)) {
    for (const n of names) if (!known.has(n)) fail(source, `CLIENT_ROUTES.${client} names unknown route ${n}`);
  }
  const allowedFor = (client) =>
    sortOps(
      routes
        .filter((r) => (r.clients ? r.clients.includes(client) : true) && (clientRoutes[client] ? clientRoutes[client].includes(r.name) : true))
        .map(({ name, method, path: p }) => ({ name, method, path: p })),
    );
  return { routes, clientRoutes, allowedFor };
}

// ---------------------------------------------------------------- llm-gateway

/** CLIENT_RIGHTS (aliases, /usage, /control/paid) checked against the endpoints in gateway.ts. */
export function parseGatewayRights(configText, gatewayText, source = SOURCES.gatewayConfig) {
  const body = block(configText, 'export const CLIENT_RIGHTS: Record<string, Omit<ClientDef, \'name\' | \'key\'>> = {', '\n};', source);
  const rights = {};
  for (const m of body.matchAll(/(?:'([^']+)'|([\w-]+)):\s*\{\s*aliases:\s*\[([^\]]*)\],\s*usage:\s*(true|false),\s*control:\s*(true|false)\s*\}/g)) {
    rights[m[1] || m[2]] = { aliases: [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]), usage: m[4] === 'true', control: m[5] === 'true' };
  }
  if (Object.keys(rights).length === 0) fail(source, 'no CLIENT_RIGHTS');
  if (Object.keys(rights).length !== count(body, /aliases:/g)) fail(source, 'some CLIENT_RIGHTS entries were not read');
  // The endpoints and the checks that guard them must still be where the map says they are.
  const need = [
    ["'/v1/chat/completions'", 'chat endpoint'],
    ["'/v1/models'", 'models endpoint'],
    ["url.pathname === '/usage'", 'usage endpoint'],
    ["url.pathname === '/usage/series'", 'usage series endpoint'],
    ["url.pathname === '/control/paid'", 'paid switch endpoint'],
    ['client.aliases.includes(alias)', 'alias check'],
    ['!client.usage', 'usage check'],
    ['!client.control', 'control check'],
  ];
  for (const [needle, what] of need) if (!gatewayText.includes(needle)) fail(SOURCES.gateway, `${what} not found`);
  const allowedFor = (client) => {
    const r = rights[client];
    if (!r) return [];
    const ops = r.aliases.map((a) => ({ name: `chat.${a}`, method: 'POST', path: `/v1/chat/completions (model=${a})` }));
    ops.push({ name: 'models', method: 'GET', path: '/v1/models' });
    if (r.usage) ops.push({ name: 'usage', method: 'GET', path: '/usage' }, { name: 'usage.series', method: 'GET', path: '/usage/series' });
    if (r.control) ops.push({ name: 'control.paid', method: 'POST', path: '/control/paid' });
    return sortOps(ops);
  };
  return { rights, allowedFor };
}

// ---------------------------------------------------------------- controller (NestJS)

const HTTP_DECORATOR = /^\s*@(Get|Post|Put|Patch|Delete|Head|Options)\((?:'([^']*)')?\)/;
const NEST_ROUTE = /^\s*@(Get|Post|Put|Patch|Delete|Head|Options|All|Sse)\(/;
const ROLE_DECORATOR = /^\s*@RequireRole\((?:'([^']+)'|\[([^\]]*)\])\)/;

function rolesOf(line) {
  const m = line.match(ROLE_DECORATOR);
  if (!m) return null;
  return m[1] ? [m[1]] : [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Handlers of one *.controller.ts file with the roles allowed on each (handlers without RequireRole need admin). */
export function parseNestController(text, source) {
  text = lf(text);
  const lines = text.split(/\r?\n/);
  const handlers = [];
  let pendingClass = { prefix: null, roles: null };
  let cls = null;
  let pending = { http: null, roles: null, isPublic: false };
  for (const line of lines) {
    const ctrl = line.match(/^@Controller\((?:'([^']*)')?\)/);
    if (ctrl) {
      pendingClass.prefix = ctrl[1] ?? '';
      continue;
    }
    if (/^export class /.test(line) || /^class /.test(line)) {
      cls = pendingClass.prefix != null ? { prefix: pendingClass.prefix, roles: pendingClass.roles } : null;
      pendingClass = { prefix: null, roles: null };
      pending = { http: null, roles: null, isPublic: false };
      continue;
    }
    const roles = rolesOf(line);
    if (roles && /^@/.test(line)) {
      pendingClass.roles = roles;
      continue;
    }
    if (!cls) continue;
    const http = line.match(HTTP_DECORATOR);
    if (http) {
      pending.http = { method: http[1].toUpperCase(), sub: http[2] ?? '' };
      continue;
    }
    if (roles) {
      pending.roles = roles;
      continue;
    }
    if (/^\s*@Public\(\)/.test(line)) {
      pending.isPublic = true;
      continue;
    }
    if (pending.http && /^\s+(?:async\s+)?\w+\s*\(/.test(line) && !/^\s*@/.test(line)) {
      const joined = [cls.prefix, pending.http.sub].filter(Boolean).join('/');
      handlers.push({
        method: pending.http.method,
        path: '/' + joined.replace(/^\/+/, ''),
        name: line.trim().match(/^(?:async\s+)?(\w+)/)[1],
        roles: pending.isPublic ? ['*'] : pending.roles || cls.roles || ['admin'],
      });
      pending = { http: null, roles: null, isPublic: false };
    }
  }
  const decorators = lines.filter((l) => NEST_ROUTE.test(l)).length;
  if (handlers.length !== decorators) fail(source, `read ${handlers.length} of ${decorators} handlers`);
  return handlers;
}

function listSourceFiles(root, matches) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && matches(e.name)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Which service holds which controller role. Read from the controller's own code: the token registry
 * names the dashboard, publisher and test-runner principals, app-config names the worker ids. The
 * delegator is Hermes' restricted token, which only the hermes-broker holds (broker.ts BrokerConfig.token).
 */
export function parseControllerCallers(tokensText, configText, brokerText) {
  const callers = {};
  for (const m of tokensText.matchAll(/role:\s*'([\w-]+)',\s*(?:name|publisherId|runnerId):\s*'([\w-]+)'/g)) {
    if (m[2] !== 'admin') callers[m[2]] = m[1];
  }
  for (const m of configText.matchAll(/workerId:\s*'([\w-]+)'/g)) callers[m[1]] = 'worker';
  if (/role:\s*'delegator'/.test(tokensText) && /controller delegator token/i.test(brokerText)) callers['hermes-broker'] = 'delegator';
  if (!Object.values(callers).includes('worker')) fail(SOURCES.controllerConfig, 'no worker ids');
  if (!callers.dashboard) fail(SOURCES.controllerTokens, 'dashboard principal not found');
  return callers;
}

// ---------------------------------------------------------------- notifier

export function parseNotifierTypes(text, source = SOURCES.notifier) {
  text = lf(text);
  const body = block(text, 'const PAYLOAD: Record<string, string> = {', '};', source);
  const types = [...body.matchAll(/^\s*(\w+):\s*'\w+'/gm)].map((m) => m[1]);
  if (types.length === 0) fail(source, 'no event types');
  if (!text.includes("url.pathname !== '/notify'")) fail(source, '/notify check not found');
  return types;
}

// ---------------------------------------------------------------- per link

/**
 * Rule sets for every (caller → callee) pair the code knows about. Each rule set says WHO enforces
 * it (`by`: the caller filters what it forwards, or the callee checks the caller) and WHERE.
 * Returns { rules: Map<'from>to' | '*>to', RuleSet[]>, errors: string[], brokerRoutes } — a parser that fails adds an
 * error and its links stay without rules; the other parsers still run.
 */
export function extractRules(root) {
  const read = (rel) => lf(readFileSync(path.join(root, rel), 'utf8'));
  const rules = new Map();
  const errors = [];
  let brokerRoutes = null;
  const add = (from, to, set) => {
    if (!set.ops.length) return;
    const k = `${from}>${to}`;
    if (!rules.has(k)) rules.set(k, []);
    rules.get(k).push(set);
  };
  const attempt = (what, fn) => {
    try {
      fn();
    } catch (err) {
      errors.push(`${what}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  };

  attempt('hermes-broker', () => {
    const routes = parseBrokerRoutes(read(SOURCES.broker));
    brokerRoutes = routes;
    const strip = (r) => ({ name: r.name, method: r.method, path: r.path });
    add('hermes', 'hermes-broker', { by: 'hermes-broker', role: 'callee', source: SOURCES.broker, ops: sortOps(routes.map(strip)) });
    for (const target of [...new Set(routes.map((r) => r.target))]) {
      // The broker forwards these without its /<target> prefix; show the path the callee sees.
      const cut = target === 'controller' ? '' : `/${target}`;
      const ops = routes.filter((r) => r.target === target).map((r) => ({ ...strip(r), path: r.path.startsWith(cut) ? r.path.slice(cut.length) || '/' : r.path }));
      add('hermes-broker', target, { by: 'hermes-broker', role: 'caller', source: SOURCES.broker, ops: sortOps(ops) });
    }
  });
  attempt('knowledge', () => {
    const k = parseKnowledgeApi(read(SOURCES.knowledge));
    for (const client of ['hermes-broker', 'school', 'dashboard']) {
      add(client, 'knowledge', { by: 'knowledge', role: 'callee', source: SOURCES.knowledge, ops: k.allowedFor(client) });
    }
  });
  attempt('llm-gateway', () => {
    const g = parseGatewayRights(read(SOURCES.gatewayConfig), read(SOURCES.gateway));
    for (const client of Object.keys(g.rights)) {
      if (client === 'operator') continue; // Claude Code on the host, not a service
      add(client, 'llm-gateway', { by: 'llm-gateway', role: 'callee', source: SOURCES.gatewayConfig, ops: g.allowedFor(client) });
    }
  });
  attempt('controller', () => {
    const files = listSourceFiles(path.join(root, SOURCES.controllerDir), (name) => name.endsWith('.controller.ts'));
    if (files.length === 0) fail(SOURCES.controllerDir, 'no *.controller.ts files');
    const handlers = files.flatMap((f) => parseNestController(readFileSync(f, 'utf8'), path.relative(root, f).split(path.sep).join('/')));
    const callers = parseControllerCallers(read(SOURCES.controllerTokens), read(SOURCES.controllerConfig), read(SOURCES.broker));
    for (const [service, role] of Object.entries(callers)) {
      const ops = handlers
        .filter((h) => h.roles.includes(role))
        .map((h) => ({ name: `${h.method} ${h.path}`, method: h.method, path: h.path }));
      add(service, 'controller', { by: 'controller', role: 'callee', source: `${SOURCES.controllerDir} (@RequireRole '${role}')`, ops: sortOps(ops) });
    }
  });
  attempt('learning', () => {
    const files = listSourceFiles(path.join(root, SOURCES.learningDir), (name) => name.endsWith('.ts') && !/\.(?:spec|test|d)\.ts$/.test(name));
    const handlers = files.flatMap((file) => {
      const code = readFileSync(file, 'utf8');
      if (!/^@Controller\(/m.test(code)) return [];
      return parseNestController(code, path.relative(root, file).split(path.sep).join('/'));
    });
    // The Learning guard grants the Dashboard owner access to every authenticated handler.
    const ops = handlers
      .filter(({ roles }) => roles.includes('admin') || roles.includes('owner'))
      .map(({ method, path: route }) => ({ name: `${method} ${route}`, method, path: route }));
    if (ops.length === 0) fail(SOURCES.learningDir, 'no authenticated Learning handlers');
    add('dashboard', 'learning', { by: 'learning', role: 'callee', source: SOURCES.learningDir, ops: sortOps(ops) });
  });
  attempt('notifier', () => {
    const types = parseNotifierTypes(read(SOURCES.notifier));
    const ops = types.map((t) => ({ name: `notify.${t}`, method: 'POST', path: `/notify (type=${t})` }));
    // The notifier does not tell callers apart: every caller with a key may send every event type.
    add('*', 'notifier', { by: 'notifier', role: 'callee', source: SOURCES.notifier, ops });
  });
  return { rules, errors, brokerRoutes };
}
