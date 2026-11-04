#!/usr/bin/env node
// End-to-end checks against the running dashboard (http://127.0.0.1:8710) and real controller.
//
//   node services/dashboard/scripts/e2e.mjs [--approve <taskId>] [--reject <taskId>] [--private <taskId>]
//
// Reads the admin password and tokens from secrets/ and never prints them. Without --approve /
// --reject it only reads. Decisions change review records in the controller DB (never git/GitHub).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const BASE = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:8710';
const CONTROLLER = process.env.CONTROLLER_HOST_URL ?? 'http://127.0.0.1:8700';
const secret = (f) => readFileSync(join(root, 'secrets', f), 'utf8').trim();
// The password comes from DASHBOARD_E2E_PASSWORD, or from the generated file while it still exists.
const PASSWORD = process.env.DASHBOARD_E2E_PASSWORD || secret('dashboard-admin.password');
const DASH_TOKEN = secret('dashboard-controller.token');
const HERMES_TOKEN = secret('hermes-controller.token');
const USER = process.env.DASHBOARD_ADMIN_USER ?? 'owner';
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
const noSecrets = (text) => ![PASSWORD, DASH_TOKEN, HERMES_TOKEN].some((s) => text.includes(s));

const SAME = { Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };
async function req(path, { method = 'GET', cookie, form, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  // React separates adjacent text nodes with <!-- -->; drop those so checks match visible text.
  return { status: res.status, location: res.headers.get('location'), headers: res.headers, text: (await res.text()).replaceAll('<!-- -->', '') };
}
async function login(password = PASSWORD, user = USER) {
  const r = await req('/api/auth/login', { method: 'POST', form: { username: user, password }, headers: SAME });
  const set = r.headers.get('set-cookie') ?? '';
  const m = /pai_session=([^;]+)/.exec(set);
  return { r, set, cookie: m && m[1] ? `pai_session=${m[1]}` : null };
}
const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? null;
const ctl = (path, token = DASH_TOKEN) => fetch(CONTROLLER + path, { headers: { Authorization: `Bearer ${token}` } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// ---- health, headers, unauthenticated access
{
  const h = await req('/api/health');
  check('health 200', h.status === 200 && h.text === '{"status":"ok"}');
  for (const p of ['/', '/tasks', '/projects', '/reviews', '/reviews/cbd2ede2-4af3-4311-bea8-2f1ca3619a4c', '/tasks/cbd2ede2-4af3-4311-bea8-2f1ca3619a4c']) {
    const r = await req(p);
    check(`unauthenticated ${p} -> /login`, r.status === 307 && new URL(r.location, BASE).pathname === '/login' && !r.text.includes('hello-world'), `${r.status} ${r.location}`);
  }
  const forged = await req('/reviews', { cookie: 'pai_session=forged-session-id' });
  check('forged session cookie -> /login', (forged.status === 307 || forged.status === 303) && /\/login/.test(forged.location ?? ''), `${forged.status} ${forged.location}`);
  const api = await req('/api/reviews/cbd2ede2-4af3-4311-bea8-2f1ca3619a4c/decision', { method: 'POST', form: { decision: 'approve', headSha: 'a'.repeat(40), confirmed: 'yes' } });
  check('unauthenticated decision POST -> login page, nothing done', api.status === 303 && api.headers.get('x-pai-rejected') === 'session' && new URL(api.location, BASE).pathname === '/login', `${api.status} ${api.location}`);
  const lp = await req('/login');
  const csp = lp.headers.get('content-security-policy') ?? '';
  check('security headers', csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'") && lp.headers.get('x-frame-options') === 'DENY'
    && lp.headers.get('x-content-type-options') === 'nosniff' && lp.headers.get('referrer-policy') === 'same-origin' && !lp.headers.get('x-powered-by'));
}

// ---- login
{
  const bad = await login('definitely-wrong-password');
  check('wrong password rejected, no cookie', bad.r.status === 303 && bad.r.location.startsWith('/login?error=') && !bad.cookie, bad.r.location);
  const cross = await req('/api/auth/login', { method: 'POST', form: { username: USER, password: PASSWORD }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  check('cross-site login refused', cross.status === 303 && !(cross.headers.get('set-cookie') ?? '').includes('pai_session=') , cross.location);
}
const { r: loginRes, set, cookie } = await login();
check('login ok -> /', loginRes.status === 303 && loginRes.location === '/' && !!cookie, `${loginRes.status} ${loginRes.location}`);
check('cookie HttpOnly + SameSite=Strict + Path=/', /HttpOnly/i.test(set) && /SameSite=Strict/i.test(set) && /Path=\//.test(set));
check('no secrets in login response URL/body', noSecrets(loginRes.location + loginRes.text));

// ---- pages
const overview = await req('/', { cookie });
check('overview renders', overview.status === 200 && overview.text.includes('Overview') && overview.text.includes('codex worker') && overview.text.includes('Awaiting approval'));
check('overview has no secrets', noSecrets(overview.text));
check('no token in client-visible storage code', !/localStorage|sessionStorage/.test(overview.text));
const csrf = csrfOf(overview.text);
check('csrf token present in page', !!csrf);
const tasks = await req('/tasks?agent=codex&projectId=hello-world', { cookie });
check('tasks list filtered (codex/hello-world)', tasks.status === 200 && tasks.text.includes('cbd2ede2') && !tasks.text.includes('aa29dc81'));
const tasksClaude = await req('/tasks?agent=claude', { cookie });
check('tasks list claude', tasksClaude.status === 200 && tasksClaude.text.includes('aa29dc81'));
const bogus = await req('/tasks?status=%3Cscript%3E&agent=x', { cookie });
check('invalid filters ignored', bogus.status === 200);
const detail = await req('/tasks/cbd2ede2-4af3-4311-bea8-2f1ca3619a4c', { cookie });
check('task detail shows branch + commit', detail.status === 200 && detail.text.includes('a638d091615426f0e59a4fdac32a0d42a812fe85') && detail.text.includes('Branch'));
const projects = await req('/projects', { cookie });
check('projects read-only view', projects.status === 200 && projects.text.includes('hello-world') && projects.text.includes('spoon-knife') && !/<form[^>]*method="post"[^>]*action="\/api\/projects/.test(projects.text));
check('projects page has no credentials', noSecrets(projects.text) && !/github_pat_|ghp_|x-access-token/i.test(projects.text));
const reviews = await req('/reviews?status=all', { cookie });
check('review list', reviews.status === 200 && reviews.text.includes('approved') && reviews.text.includes('invalidated'));
const old = await req('/reviews/d8bc0ec1-d847-4c15-8227-846d5af148e0', { cookie });
check('old/invalidated review flagged, not decidable', old.text.includes('Review invalidated') && old.text.includes('No patch text') && !old.text.includes('Approve…'));
const approved = await req('/reviews/cbd2ede2-4af3-4311-bea8-2f1ca3619a4c', { cookie });
check('approved review shows diff, SHAs and the test runner result', approved.text.includes('1b39935') && approved.text.includes('Tests passed on this commit (test runner)') && !approved.text.includes('Tests not reported') && approved.text.includes('diff-file') && !approved.text.includes('Approve…'));
const notReviewable = await req('/reviews/62f21a98-b942-4dba-be3e-a388577e7f30', { cookie });
check('failed task: no diff, handled', notReviewable.status === 200 && notReviewable.text.includes('only completed tasks have a diff'));
const nf = await req('/tasks/00000000-0000-4000-8000-000000000000', { cookie });
check('unknown task -> 404', nf.status === 404, String(nf.status));

// ---- CSRF
{
  const noToken = await req('/api/auth/logout', { method: 'POST', cookie, form: {}, headers: SAME });
  check('logout without csrf -> rejected', noToken.status === 303 && noToken.headers.get('x-pai-rejected') === 'csrf:missing_token', `${noToken.status} ${noToken.headers.get('x-pai-rejected')}`);
  const wrongOrigin = await req('/api/tasks/cbd2ede2-4af3-4311-bea8-2f1ca3619a4c/cancel', { method: 'POST', cookie, form: { csrf }, headers: { Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
  check('cross-site post with valid token -> rejected', wrongOrigin.status === 303 && wrongOrigin.headers.get('x-pai-rejected') === 'csrf:cross_site', `${wrongOrigin.status} ${wrongOrigin.headers.get('x-pai-rejected')}`);
  const forgedOrigin = await req('/api/tasks/cbd2ede2-4af3-4311-bea8-2f1ca3619a4c/cancel', { method: 'POST', cookie, form: { csrf }, headers: { Origin: 'http://evil.example' } });
  check('foreign Origin with valid token -> rejected', forgedOrigin.headers.get('x-pai-rejected') === 'csrf:bad_origin', String(forgedOrigin.headers.get('x-pai-rejected')));
  const opaque = await req('/api/tasks/cbd2ede2-4af3-4311-bea8-2f1ca3619a4c/cancel', { method: 'POST', cookie, form: { csrf }, headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' } });
  const oldTab = await req('/api/tasks/cbd2ede2-4af3-4311-bea8-2f1ca3619a4c/cancel', { method: 'POST', cookie, form: { csrf }, headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' } });
  check('same-origin form from a no-referrer page (Origin: null + Sec-Fetch-Site same-origin) passes CSRF', !oldTab.headers.get('x-pai-rejected') && oldTab.location.startsWith('/tasks/cbd2ede2'), `${oldTab.status} ${oldTab.headers.get('x-pai-rejected')} ${oldTab.location}`);
  check('opaque Origin from another site -> rejected', opaque.headers.get('x-pai-rejected') === 'csrf:cross_site', String(opaque.headers.get('x-pai-rejected')));
  const wrongToken = await req('/api/reviews/aa29dc81-c130-4354-8144-163a532694a9/decision', { method: 'POST', cookie, form: { csrf: 'x'.repeat(43), decision: 'reject', headSha: 'a'.repeat(40), confirmed: 'yes' }, headers: SAME });
  check('decision with wrong csrf -> rejected, back to the review page', wrongToken.status === 303 && wrongToken.headers.get('x-pai-rejected') === 'csrf:bad_token' && wrongToken.location.startsWith('/reviews/aa29dc81'), `${wrongToken.status} ${wrongToken.location}`);
}

// ---- decisions on the real controller
async function decide(taskId, decision, headSha, extra = {}) {
  return req(`/api/reviews/${taskId}/decision`, { method: 'POST', cookie, form: { csrf, decision, headSha, confirmed: 'yes', ...extra }, headers: SAME });
}
async function flow(taskId, decision, record = true) {
  const page = await req(`/reviews/${taskId}`, { cookie });
  const head = /<dt>Head<\/dt><dd class="mono">([0-9a-f]{40})</.exec(page.text)?.[1];
  check(`${decision}: review page decidable`, !!head && page.text.includes(decision === 'approve' ? 'Approve…' : 'Reject…'));
  const confirm = await req(`/reviews/${taskId}?confirm=${decision}`, { cookie });
  check(`${decision}: confirmation shows project, base, head, files and checkbox`,
    confirm.text.includes(`Confirm ${decision}`) && confirm.text.includes('Base SHA') && confirm.text.includes(head) && confirm.text.includes('name="confirmed"') && confirm.text.includes('hello-world'));
  const unconfirmed = await req(`/api/reviews/${taskId}/decision`, { method: 'POST', cookie, form: { csrf, decision, headSha: head }, headers: SAME });
  check(`${decision}: without confirmation not recorded`, unconfirmed.status === 303 && unconfirmed.location.includes('confirm=') && unconfirmed.location.includes('error='));
  const wrong = await decide(taskId, decision, 'f'.repeat(40));
  check(`${decision}: wrong SHA -> 409 shown`, wrong.status === 303 && decodeURIComponent(wrong.location).includes('does not match'), decodeURIComponent(wrong.location ?? ''));
  const still = await ctl(`/tasks/${taskId}/review`);
  check(`${decision}: still awaiting after rejects`, still.body?.current?.status === 'awaiting_approval');
  if (!record) return page;
  const ok = await decide(taskId, decision, head, { reason: `e2e ${decision} via dashboard` });
  check(`${decision}: recorded`, ok.status === 303 && ok.location.includes('ok='), decodeURIComponent(ok.location ?? ''));
  const after = await ctl(`/tasks/${taskId}/review`);
  const want = decision === 'approve' ? 'approved' : 'rejected';
  check(`${decision}: controller state ${want} by dashboard:${USER}`, after.body?.current?.status === want && after.body?.current?.decidedBy === `dashboard:${USER}` && after.body?.current?.headSha === head);
  const dup = await decide(taskId, decision === 'approve' ? 'reject' : 'approve', head);
  check(`${decision}: duplicate/opposite decision -> 409 shown`, decodeURIComponent(dup.location ?? '').includes(`already ${want}`), decodeURIComponent(dup.location ?? ''));
  const final = await req(`/reviews/${taskId}`, { cookie });
  check(`${decision}: page shows decision, no decide buttons`, final.text.includes(`dashboard:${USER}`) && !final.text.includes('Approve…'));
  return final;
}
const approveId = arg('--approve');
if (approveId) {
  const final = await flow(approveId, 'approve');
  check('xss: markup in real diff escaped', final.text.includes('&lt;script&gt;') && !/<script>alert/.test(final.text) && !/<img src=x/.test(final.text) && !final.text.includes('<b>bold</b>'));
}
const rejectId = arg('--reject');
if (rejectId) await flow(rejectId, 'reject');
// Checks everything up to (not including) the decision, leaving the review awaiting.
const confirmOnly = arg('--confirm-only');
if (confirmOnly) {
  await flow(confirmOnly, 'approve', false);
  await flow(confirmOnly, 'reject', false);
}

// ---- private patch access: Hermes (delegator) never gets patch text of a private project
const privateId = arg('--private');
if (privateId) {
  const h = await ctl(`/tasks/${privateId}/diff`, HERMES_TOKEN);
  const a = await ctl(`/tasks/${privateId}/diff`);
  check('private: hermes gets patch=null + patchWithheld', h.status === 404 || (h.body?.patch === null && !!h.body?.patchWithheld), String(h.status));
  check('private: admin dashboard gets the patch', a.status === 200 && typeof a.body?.patch === 'string');
}
// Hermes/worker tokens cannot use the review queue or decide.
check('hermes token: GET /reviews 403', (await ctl('/reviews', HERMES_TOKEN)).status === 403);

// ---- logout
const out = await req('/api/auth/logout', { method: 'POST', cookie, form: { csrf }, headers: SAME });
check('logout -> /login, cookie cleared', out.status === 303 && out.location.startsWith('/login') && /pai_session=;/.test(out.headers.get('set-cookie') ?? ''));
const reuse = await req('/', { cookie });
check('old session rejected after logout', reuse.status === 307 && new URL(reuse.location, BASE).pathname === '/login', `${reuse.status} ${reuse.location}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
