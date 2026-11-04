#!/usr/bin/env node
// Real end-to-end dry-run through the Admin Dashboard (as the owner would click it).
//
//   node services/github-publisher/scripts/e2e-dry-run.mjs <taskId> [--expect ready|failed]
//
// Logs in to the dashboard, requests "Validate / Dry-run" for the task's approved commit, waits for
// the publisher's verdict and prints it. Never prints secrets. Writes nothing to GitHub.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const BASE = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:8710';
const CONTROLLER = process.env.CONTROLLER_HOST_URL ?? 'http://127.0.0.1:8700';
const secret = (f) => readFileSync(join(root, 'secrets', f), 'utf8').trim();
const PASSWORD = process.env.DASHBOARD_E2E_PASSWORD || secret('dashboard-admin.password');
const TOKEN = secret('dashboard-controller.token');
const taskId = process.argv[2];
const expect = process.argv.includes('--expect') ? process.argv[process.argv.indexOf('--expect') + 1] : null;
if (!/^[0-9a-f-]{36}$/.test(taskId ?? '')) {
  console.error('usage: e2e-dry-run.mjs <taskId> [--expect ready|failed]');
  process.exit(2);
}

const SAME = { Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };
const jar = {};
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function req(path, { method = 'GET', form } = {}) {
  const res = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: { Cookie: cookieHeader(), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded', ...SAME } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    if (v) jar[k] = v;
    else delete jar[k];
  }
  return { status: res.status, location: res.headers.get('location'), text: (await res.text()).replaceAll('<!-- -->', '') };
}
const status = () => fetch(`${CONTROLLER}/tasks/${taskId}/publication`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());

const login = await req('/api/auth/login', { method: 'POST', form: { username: 'owner', password: PASSWORD } });
if (login.location !== '/') throw new Error(`login failed: ${login.location}`);
const page = await req(`/reviews/${taskId}`);
const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1];
const head = /<dt>Head<\/dt><dd class="mono">([0-9a-f]{40})</.exec(page.text)?.[1];
const before = await status();
console.log(`before: state=${before.state} review=${before.review?.status} head=${head?.slice(0, 12)} button=${page.text.includes('Validate / Dry-run')}`);
if (!page.text.includes('Validate / Dry-run')) {
  console.log('no Validate / Dry-run button (not approved or already pending)');
  process.exit(expect === 'unavailable' ? 0 : 1);
}
const requested = await req(`/api/reviews/${taskId}/dry-run`, { method: 'POST', form: { csrf, headSha: head } });
console.log(`request: ${requested.status} ${decodeURIComponent(requested.location ?? '')}`);
let s;
for (let i = 0; i < 60; i++) {
  s = await status();
  if (s.state !== 'validation_pending') break;
  await new Promise((r) => setTimeout(r, 1000));
}
const r = s.current?.result ?? {};
console.log(`after: state=${s.state} publication=${s.current?.status} attempts=${s.current?.attempts}`);
console.log(`gitVerified=${r.gitVerified} publishable=${r.publishable} pushPerformed=${r.pushPerformed} pullRequestCreated=${r.pullRequestCreated}`);
for (const c of r.checks ?? []) console.log(`  ${c.ok ? 'pass   ' : 'BLOCKED'} ${c.id.padEnd(20)} ${c.detail}`);
for (const w of r.warnings ?? []) console.log(`  warning ${w}`);
if (r.error) console.log(`  error ${r.error}`);
if (r.target) console.log(`target: ${r.target.repository} ${r.target.baseBranch} -> ${r.target.branch}`);
if (r.pullRequest) console.log(`planned PR: "${r.pullRequest.title}" ${r.pullRequest.head} -> ${r.pullRequest.base} draft=${r.pullRequest.draft}`);
const final = await req(`/reviews/${taskId}`);
const label = s.state === 'ready_to_publish' ? 'Ready to publish' : 'Validation failed';
console.log(`dashboard shows "${label}": ${final.text.includes(label)}; planned PR shown: ${final.text.includes('Planned pull request (not created)')}`);
await req('/api/auth/logout', { method: 'POST', form: { csrf: /name="csrf" value="([^"]+)"/.exec(final.text)?.[1] } });
const ok = expect === null || (expect === 'ready' ? s.state === 'ready_to_publish' : s.state === 'validation_failed');
process.exit(ok ? 0 : 1);
