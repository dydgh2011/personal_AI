#!/usr/bin/env node
// Operator CLI for the knowledge store: the only way Claude Code (or you) changes it from this PC.
// Fixed commands -> fixed routes; JSON in, JSON out. Needs compose.knowledge-operator.yaml
// (publishes the API on 127.0.0.1:8793 with the operator key; remove that file to close it again).
//
//   node services/knowledge/scripts/kb.mjs help
//   node services/knowledge/scripts/kb.mjs search "베이즈 정리" --kinds fact,page --limit 10
//   node services/knowledge/scripts/kb.mjs fact-add --json '{"page":"STA256","text":"Term Test 1: 10/17 (20%)"}'
//   node services/knowledge/scripts/kb.mjs fact-add --file facts.json      (a JSON array = one call per item)
//   node services/knowledge/scripts/kb.mjs purge --json '{"target":"fact","id":"...","reason":"wrong"}' --yes
//
// The key is read from secrets/knowledge-operator.key and never printed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const BASE = process.env.KB_URL || 'http://127.0.0.1:8793';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// name: [method, path builder, kind]  kind: 'query' (flags -> query string), 'body' (--json/--file), 'none'
const COMMANDS = {
  status: ['GET', () => '/status', 'none', 'counts, vectors, model'],
  profile: ['GET', () => '/profile', 'none', 'the owner page and the page index'],
  graph: ['GET', () => '/graph', 'none', 'pages and links (for the graph view)'],
  changes: ['GET', () => '/changes', 'query', '--limit N: recent changes'],
  search: ['GET', (a) => `/search?q=${encodeURIComponent(need(a, 0, 'query text'))}`, 'query', '"text" [--kinds page,fact,activity,raw] [--limit N]'],
  pages: ['GET', () => '/pages', 'query', '[--type course|topic|goal|project|person|habit|place|org|other]'],
  page: ['GET', (a) => `/page?ref=${encodeURIComponent(need(a, 0, 'page title or slug'))}`, 'none', '"title or slug"'],
  timeline: ['GET', () => '/timeline', 'query', '[--from YYYY-MM-DD] [--to ...] [--page ...] [--kind ...] [--limit N]'],
  'raw-list': ['GET', () => '/raw', 'query', '[--source chat|document|note|import|system] [--from] [--to] [--limit N]'],
  raw: ['GET', (a) => `/raw/${id(a)}`, 'query', '<raw id> [--offset N] [--limit N]: read an original'],
  'page-save': ['POST', () => '/pages', 'body', '{page?|title,type, summary?, aliases?, archived?}'],
  'fact-add': ['POST', () => '/facts', 'body', '{page, text, observedOn?, sourceRawId?, sourceNote?}'],
  'fact-change': ['POST', (a) => `/facts/${id(a)}`, 'body', '<fact id> {text, observedOn?, reason?} or {remove:true, reason}'],
  link: ['POST', () => '/links', 'body', '{from, to, relation?, note?, remove?}'],
  'activity-add': ['POST', () => '/activities', 'body', '{title, kind?, at?, minutes?, detail?, outcome?, feeling?, pages?, sourceRawId?}'],
  'activity-change': ['POST', (a) => `/activities/${id(a)}`, 'body', '<activity id> {fields...} or {remove:true}'],
  note: ['POST', () => '/raw', 'body', '{source:"note", kind:"owner-note", text, title?}: keep a free-form original'],
  purge: ['POST', () => '/purge', 'body', '{target: raw|fact|activity|page, id|page, reason} --yes: PERMANENT delete'],
};

function need(args, i, what) {
  if (!args[i]) fail(`missing ${what}`);
  return args[i];
}
function id(args) {
  const v = need(args, 0, 'id');
  if (!UUID.test(v)) fail('the id must be one returned by an earlier command');
  return v;
}
function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(2);
}

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'yes') flags.yes = true;
      else flags[key] = argv[++i] ?? fail(`--${key} needs a value`);
    } else positional.push(a);
  }
  return { positional, flags };
}

async function call(method, path, body) {
  let key;
  try {
    key = readFileSync(join(root, 'secrets', 'knowledge-operator.key'), 'utf8').trim();
  } catch {
    fail('secrets/knowledge-operator.key is missing (node services/knowledge/scripts/init-secrets.mjs)');
  }
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { 'X-Knowledge-Key': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    fail(`cannot reach ${BASE}: is compose.knowledge-operator.yaml in the compose files?`);
  }
  const text = await res.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, value };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || !COMMANDS[command]) {
    console.log('Knowledge operator CLI. Commands:');
    for (const [name, [, , , help]] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(16)} ${help}`);
    console.log('Bodies: --json \'{...}\' or --file path.json (an array runs one call per item). purge also needs --yes.');
    process.exit(command && command !== 'help' ? 2 : 0);
  }
  const [method, pathOf, kind] = COMMANDS[command];
  const { positional, flags } = parse(rest);
  let path = pathOf(positional);
  if (kind === 'query') {
    const extra = Object.entries(flags).filter(([k]) => !['yes', 'json', 'file'].includes(k));
    if (extra.length) path += (path.includes('?') ? '&' : '?') + new URLSearchParams(extra).toString();
  }
  let bodies = [undefined];
  if (kind === 'body') {
    const source = flags.json ?? (flags.file ? readFileSync(flags.file, 'utf8') : fail('give the body with --json or --file'));
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch {
      fail('the body is not valid JSON');
    }
    bodies = Array.isArray(parsed) ? parsed : [parsed];
    if (command === 'purge' && !flags.yes) fail('purge deletes permanently; add --yes after the owner agreed');
  }
  let failed = 0;
  for (const body of bodies) {
    const result = await call(method, path, body);
    if (!result.ok) failed++;
    console.log(JSON.stringify(result.ok ? result.value : { ok: false, status: result.status, ...result.value }, null, bodies.length > 1 ? 0 : 2));
  }
  process.exit(failed ? 1 : 0);
}

main();
