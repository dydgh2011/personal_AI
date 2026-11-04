#!/usr/bin/env node
// Drives the publishing flow through the Admin Dashboard, like the owner clicking it (Phase E-2B).
//
//   node services/github-publisher/scripts/e2e-policy.mjs <taskId> <step> [<step> ...]
//   steps: state | tests | dry-run | authorize | publish
//
// tests: "Run tests" and wait for the isolated runner. dry-run: "Validate / Dry-run" and wait.
// authorize: open the confirmation step, tick the box, authorize. publish: same for publishing
// (refused while publishing is disabled). Prints results; never prints secrets; writes nothing to GitHub.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const BASE = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:8710';
const CONTROLLER = process.env.CONTROLLER_HOST_URL ?? 'http://127.0.0.1:8700';
const secret = (f) => readFileSync(join(root, 'secrets', f), 'utf8').trim();
const PASSWORD = process.env.DASHBOARD_E2E_PASSWORD || secret('dashboard-admin.password');
const TOKEN = secret('dashboard-controller.token');
const [taskId, ...steps] = process.argv.slice(2);
if (!/^[0-9a-f-]{36}$/.test(taskId ?? '') || steps.length === 0) {
  console.error('usage: e2e-policy.mjs <taskId> state|tests|dry-run|authorize|publish ...');
  process.exit(2);
}

const SAME = { Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };
const jar = {};
async function req(path, form) {
  const res = await fetch(BASE + path, {
    method: form ? 'POST' : 'GET',
    redirect: 'manual',
    headers: { Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded', ...SAME } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [k, v] = c.split(';')[0].split('=');
    if (v) jar[k] = v;
    else delete jar[k];
  }
  return { status: res.status, location: decodeURIComponent(res.headers.get('location') ?? ''), text: (await res.text()).replaceAll('<!-- -->', '') };
}
const status = () => fetch(`${CONTROLLER}/tasks/${taskId}/publication`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
const field = (html, name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
const page = () => req(`/reviews/${taskId}`);
const flash = (loc) => (loc.match(/[?&](ok|error)=(.*)$/) ?? [, '', loc]).slice(1).join(': ');

function show(s) {
  const t = s.testValidation;
  const r = s.current?.result ?? {};
  console.log(`  state=${s.state} review=${s.review?.status} publishEnabled=${s.publishEnabled}`);
  console.log(`  tests: ${t ? `${t.status} run=${t.id.slice(0, 8)} commit=${t.commitSha.slice(0, 12)} exit=[${(t.results ?? []).map((x) => `${x.name}:${x.exitCode ?? (x.timedOut ? 'timeout' : '-')}`).join(', ')}]${t.error ? ` error=${t.error}` : ''}` : 'none'}`);
  if (s.current) {
    console.log(`  last ${s.current.mode}: ${s.current.status} eligible=${r.eligible} canPublish=${r.canPublish} reason=${r.reason} reasons=${JSON.stringify(r.reasons ?? [])}`);
    if (r.author) console.log(`  author: ${r.author.name} <${r.author.email}> / committer ${r.author.committerName} <${r.author.committerEmail}>; gitVerified=${r.gitVerified}; tests.signatureValid=${r.tests?.signatureValid}`);
  }
  if (s.authorization) console.log(`  authorization: ${s.authorization.status} by ${s.authorization.authorizedBy} expires ${s.authorization.expiresAt}`);
}

async function waitWhile(pred) {
  let s;
  for (let i = 0; i < 120; i++) {
    s = await status();
    if (!pred(s)) return s;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return s;
}

const login = await req('/api/auth/login', { username: 'owner', password: PASSWORD });
if (login.location !== '/') throw new Error(`login failed: ${login.location}`);
for (const step of steps) {
  const p = await page();
  const csrf = field(p.text, 'csrf');
  const head = /<dt>Head<\/dt><dd class="mono">([0-9a-f]{40})</.exec(p.text)?.[1];
  console.log(`# ${step}`);
  if (step === 'state') {
    show(await status());
    console.log(`  page: missing-tests banner=${p.text.includes('게시 불가 — 이 커밋에 연결된 테스트 실행 결과가 없습니다.')} runTests=${p.text.includes('>Run tests<')} dryRun=${p.text.includes('Validate / Dry-run')} authorize=${p.text.includes('Authorize publishing…')} publishDisabled=${p.text.includes('Publish (disabled in Phase E-2B)')}`);
  } else if (step === 'tests') {
    const r = await req(`/api/reviews/${taskId}/tests`, { csrf, headSha: head });
    console.log(`  request -> ${flash(r.location)}`);
    show(await waitWhile((s) => ['pending', 'running'].includes(s.testValidation?.status)));
  } else if (step === 'dry-run') {
    const r = await req(`/api/reviews/${taskId}/dry-run`, { csrf, headSha: head });
    console.log(`  request -> ${flash(r.location)}`);
    show(await waitWhile((s) => s.state === 'validation_pending'));
  } else if (step === 'authorize') {
    const c = await req(`/reviews/${taskId}?confirm=authorize`);
    const offered = c.text.includes('Confirm publish authorization');
    console.log(`  confirmation step offered: ${offered}${offered ? ` (repo/branch/files/tests/author shown: ${['Repository', 'Branch', 'Files', 'Tests', 'Author'].every((k) => c.text.includes(`<dt>${k}</dt>`))})` : ''}`);
    const dryRunId = field(c.text, 'dryRunId') ?? (await status()).current?.id;
    const key = field(c.text, 'idempotencyKey') ?? `e2e-${Date.now()}`;
    const unconfirmed = await req(`/api/reviews/${taskId}/authorize`, { csrf: field(c.text, 'csrf'), headSha: head, dryRunId, idempotencyKey: key });
    console.log(`  without checkbox -> ${flash(unconfirmed.location)}`);
    const r = await req(`/api/reviews/${taskId}/authorize`, { csrf: field(c.text, 'csrf'), headSha: head, dryRunId, idempotencyKey: key, confirmed: 'yes' });
    console.log(`  authorize -> ${flash(r.location)}`);
    const again = await req(`/api/reviews/${taskId}/authorize`, { csrf: field(c.text, 'csrf'), headSha: head, dryRunId, idempotencyKey: key, confirmed: 'yes' });
    console.log(`  same request again (same idempotency key) -> ${flash(again.location)}`);
    show(await status());
  } else if (step === 'publish') {
    const s = await status();
    const authId = s.authorization?.id ?? '00000000-0000-4000-8000-000000000000';
    const r = await req(`/api/reviews/${taskId}/publish`, { csrf, authorizationId: authId, idempotencyKey: `publish-${Date.now()}`, confirmed: 'yes' });
    console.log(`  publish -> ${flash(r.location)}`);
    show(await status());
  }
}
const last = await page();
await req('/api/auth/logout', { csrf: field(last.text, 'csrf') });
