#!/usr/bin/env node
// Applies an owner-approved English rename list to the knowledge store (owner decision 2026-11-26: stored text
// is English, the old Korean page titles stay as aliases). Only through the service's normal routes, so every
// change is validated, logged in change_log (actor "operator", with a reason) and keeps history:
//   pages       POST /pages        (page_save: title/summary/aliases; the slug never changes)
//   facts       POST /facts/:id    (fact_change: the old fact stays as "superseded"; kind and date are kept)
//   activities  POST /activities/:id (activity_change: before/after in change_log)
// No direct DB edits, no purge, nothing is removed.
//
// The list is a proposal JSON (data/plans/knowledge-english/proposal-*.json). An item is applied only when it is
// approved: "approved": true on the item, or "approveAll": true on the file and the item is not "approved": false.
// Before each change the current value is read again; an item that changed since the proposal is skipped.
//
//   node services/knowledge/scripts/english-apply.mjs <proposal.json>            dry run (default): prints the plan
//   node services/knowledge/scripts/english-apply.mjs <proposal.json> --apply    applies it
//        [--only pages|facts|activities] [--max N]
//
// Needs the operator access (compose.knowledge-operator.yaml, 127.0.0.1:8793) and secrets/knowledge-operator.key,
// like kb.mjs. The key is never printed. With --apply the results are written next to the proposal
// (apply-<time>.json), so what was done and why stays on record.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const BASE = process.env.KB_URL || 'http://127.0.0.1:8793';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLUG = /^[\p{L}\p{N}-]{1,100}$/u;

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(2);
}

export function parseArgs(argv) {
  const opts = { file: null, apply: false, only: null, max: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--max') opts.max = Number(argv[++i]);
    else if (!a.startsWith('--') && !opts.file) opts.file = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.file) throw new Error('give the proposal JSON file');
  if (opts.only && !['pages', 'facts', 'activities'].includes(opts.only)) throw new Error('--only must be pages, facts or activities');
  if (!(opts.max > 0)) throw new Error('--max must be a positive number');
  return opts;
}

export function approved(doc, item) {
  return item.approved === true || (doc.approveAll === true && item.approved !== false);
}

/** The planned calls for one proposal, given a reader of current values. Pure apart from `read`. */
export async function plan(doc, read, opts = {}) {
  const reason = String(doc.reason || 'Stored text in English (owner decision 2026-11-26)').slice(0, 300);
  const steps = [];
  const want = (kind) => !opts.only || opts.only === kind;
  if (want('pages')) {
    for (const p of doc.pages ?? []) {
      if (!approved(doc, p)) { steps.push({ kind: 'page', ref: p.slug, skip: 'not approved' }); continue; }
      if (!SLUG.test(String(p.slug))) { steps.push({ kind: 'page', ref: p.slug, skip: 'bad slug' }); continue; }
      const now = await read.page(p.slug);
      if (!now) { steps.push({ kind: 'page', ref: p.slug, skip: 'page not found' }); continue; }
      const body = { page: p.slug, reason };
      // A field already at its new value is done; one that is neither the old nor the new value changed since.
      if (p.after?.title !== undefined && now.title !== p.after.title) {
        if (now.title !== p.before?.title) { steps.push({ kind: 'page', ref: p.slug, skip: 'title changed since the proposal', now: now.title }); continue; }
        const other = await read.page(p.after.title);
        if (other && other.slug !== p.slug) { steps.push({ kind: 'page', ref: p.slug, skip: `"${p.after.title}" already names ${other.slug}` }); continue; }
        body.title = p.after.title;
      }
      if (p.after?.summary !== undefined && now.summary !== p.after.summary) {
        if (now.summary !== p.before?.summary) { steps.push({ kind: 'page', ref: p.slug, skip: 'summary changed since the proposal' }); continue; }
        body.summary = p.after.summary;
      }
      const add = (p.addAliases ?? []).filter((a) => !now.aliases.includes(a));
      if (add.length) body.aliases = [...now.aliases, ...add];
      if (body.aliases && body.aliases.length > 20) { steps.push({ kind: 'page', ref: p.slug, skip: 'more than 20 aliases' }); continue; }
      if (Object.keys(body).length === 2) { steps.push({ kind: 'page', ref: p.slug, skip: 'already done' }); continue; }
      steps.push({ kind: 'page', ref: p.slug, method: 'POST', path: '/pages', body, before: { title: now.title, summary: now.summary, aliases: now.aliases } });
    }
  }
  if (want('facts')) {
    for (const f of doc.facts ?? []) {
      if (!approved(doc, f)) { steps.push({ kind: 'fact', ref: f.id, skip: 'not approved' }); continue; }
      if (!UUID.test(String(f.id))) { steps.push({ kind: 'fact', ref: f.id, skip: 'bad id' }); continue; }
      const now = await read.fact(f.id);
      if (!now) { steps.push({ kind: 'fact', ref: f.id, skip: 'fact not found' }); continue; }
      if (now.status !== 'active') { steps.push({ kind: 'fact', ref: f.id, skip: `fact is ${now.status}`, newer: now.supersededBy ?? null }); continue; }
      if (now.text === f.after) { steps.push({ kind: 'fact', ref: f.id, skip: 'already done' }); continue; }
      if (now.text !== f.before) { steps.push({ kind: 'fact', ref: f.id, skip: 'text changed since the proposal' }); continue; }
      const body = { text: f.after, reason, ...(now.observedOn ? { observedOn: now.observedOn } : {}) };   // keep the date (and kind: kept by the service)
      steps.push({ kind: 'fact', ref: f.id, method: 'POST', path: `/facts/${f.id}`, body, before: { text: now.text, kind: now.kind, observedOn: now.observedOn } });
    }
  }
  if (want('activities')) {
    for (const a of doc.activities ?? []) {
      if (!approved(doc, a)) { steps.push({ kind: 'activity', ref: a.id, skip: 'not approved' }); continue; }
      if (!UUID.test(String(a.id))) { steps.push({ kind: 'activity', ref: a.id, skip: 'bad id' }); continue; }
      const now = await read.activity(a.id, a.before?.at);
      if (!now) { steps.push({ kind: 'activity', ref: a.id, skip: 'activity not found' }); continue; }
      const body = {};
      for (const key of ['title', 'detail', 'outcome', 'feeling']) {
        if (a.after?.[key] === undefined) continue;
        if ((now[key] ?? null) !== (a.before?.[key] ?? null)) { body.__changed = key; break; }
        if (now[key] !== a.after[key]) body[key] = a.after[key];
      }
      if (body.__changed) { steps.push({ kind: 'activity', ref: a.id, skip: `${body.__changed} changed since the proposal` }); continue; }
      if (!Object.keys(body).length) { steps.push({ kind: 'activity', ref: a.id, skip: 'already done' }); continue; }
      steps.push({ kind: 'activity', ref: a.id, method: 'POST', path: `/activities/${a.id}`, body, before: { title: now.title } });
    }
  }
  return steps;
}

/** Sends the planned calls one by one (each is its own logged change in the service). */
export async function applySteps(steps, call, onResult = () => {}) {
  const results = [];
  for (const s of steps) {
    const r = await call(s.method, s.path, s.body);
    const entry = { kind: s.kind, ref: s.ref, ok: r.ok, status: r.status, before: s.before, change: s.body, result: r.ok ? r.value : { error: r.value } };
    results.push(entry);
    onResult(entry);
  }
  return results;
}

function apiKey() {
  try {
    return readFileSync(join(root, 'secrets', 'knowledge-operator.key'), 'utf8').trim();
  } catch {
    fail('secrets/knowledge-operator.key is missing (node services/knowledge/scripts/init-secrets.mjs)');
  }
}

function http(key) {
  return async (method, path, body) => {
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { 'X-Knowledge-Key': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      fail(`cannot reach ${BASE}: is the operator access open (scripts\\stack.ps1 operator open)?`);
    }
    const text = await res.text();
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = { raw: text.slice(0, 300) };
    }
    return { ok: res.ok, status: res.status, value };
  };
}

export function reader(call) {
  return {
    async page(ref) {
      const r = await call('GET', `/page?ref=${encodeURIComponent(ref)}`);
      return r.ok ? r.value.page : null;
    },
    async fact(id) {
      const r = await call('GET', `/facts/${id}`);
      return r.ok ? r.value : null;
    },
    async activity(id, at) {
      const day = String(at ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
      const r = await call('GET', `/timeline?from=${day}&to=${day}&limit=100`);
      return r.ok ? (r.value.activities ?? []).find((a) => a.id === id) ?? null : null;
    },
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(opts.file, 'utf8'));
  } catch {
    fail('the proposal is not readable JSON');
  }
  const call = http(apiKey());
  const steps = await plan(doc, reader(call), opts);
  const todo = steps.filter((s) => !s.skip).slice(0, opts.max);
  const skipped = steps.filter((s) => s.skip);
  const summary = (list) => list.reduce((acc, s) => ({ ...acc, [s.kind]: (acc[s.kind] ?? 0) + 1 }), {});
  if (!opts.apply) {
    for (const s of todo) console.log(JSON.stringify({ dryRun: true, kind: s.kind, ref: s.ref, before: s.before, change: s.body }));
    const reasons = skipped.reduce((acc, s) => ({ ...acc, [s.skip]: (acc[s.skip] ?? 0) + 1 }), {});
    console.log(JSON.stringify({ dryRun: true, wouldChange: summary(todo), skipped: reasons, note: 'nothing changed; add --apply to apply' }));
    return;
  }
  const results = await applySteps(todo, call, (r) => console.log(JSON.stringify({ kind: r.kind, ref: r.ref, ok: r.ok, status: r.status })));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const log = join(dirname(opts.file), `apply-${stamp}.json`);
  writeFileSync(log, JSON.stringify({ proposal: opts.file, at: new Date().toISOString(), results, skipped }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ applied: summary(results.filter((r) => r.ok)), failed, skipped: skipped.length, log }));
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
