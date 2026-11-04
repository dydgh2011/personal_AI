#!/usr/bin/env node
// Real-browser checks of the review decision forms (Edge/Chromium via puppeteer-core).
//
//   node services/dashboard/browser-test/approval.mjs <approveTaskId> <rejectTaskId>
//
// Both tasks must have a review awaiting approval; they WILL be approved / rejected (use test tasks).
// Real form submissions with the browser's own headers. Prints statuses and on-page messages only;
// never cookies, tokens or the password. Restarts the dashboard container once (scenario: expired session).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const BASE = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:8710';
const CONTROLLER = process.env.CONTROLLER_HOST_URL ?? 'http://127.0.0.1:8700';
const BROWSER = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const secret = (f) => readFileSync(join(root, 'secrets', f), 'utf8').trim();
const PASSWORD = process.env.DASHBOARD_E2E_PASSWORD || secret('dashboard-admin.password');
const TOKEN = secret('dashboard-controller.token');
const [approveId, rejectId] = process.argv.slice(2);
if (!approveId || !rejectId) {
  console.error('usage: approval.mjs <approveTaskId> <rejectTaskId>');
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const review = (id) => fetch(`${CONTROLLER}/tasks/${id}/review`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json()).then((j) => j.current);
const flash = (url) => {
  const u = new URL(url);
  return u.searchParams.get('ok') ? `ok: ${u.searchParams.get('ok')}` : u.searchParams.get('error') ? `error: ${u.searchParams.get('error')}` : '';
};

const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true });
const ctx = await browser.createBrowserContext(); // fresh session: no cookies
const page = await ctx.newPage();
const posts = [];
page.on('request', (r) => {
  if (r.method() === 'POST') posts.push({ path: new URL(r.url()).pathname, origin: r.headers().origin ?? '(none)' });
});
let lastStatus = 0;
page.on('response', (r) => {
  if (r.request().method() === 'POST') lastStatus = r.status();
});

async function login() {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[name=username]', 'owner');
  await page.type('input[name=password]', PASSWORD);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type=submit]')]);
  return new URL(page.url()).pathname === '/';
}
async function openConfirm(id, decision) {
  await page.goto(`${BASE}/reviews/${id}?confirm=${decision}#decide`, { waitUntil: 'networkidle0' });
  return page.$('#decide form');
}
async function submit() {
  await page.click('#decide input[name=confirmed]');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#decide button[type=submit]')]);
  return { url: page.url(), text: await page.evaluate(() => document.body.innerText) };
}
/** Re-submits a saved copy of the form in a real browser form (stale tab / back button). */
async function submitSaved(id, fields) {
  await page.goto(`${BASE}/reviews/${id}`, { waitUntil: 'networkidle0' });
  await page.evaluate((id, fields) => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = `/api/reviews/${id}/decision`;
    for (const [k, v] of Object.entries(fields)) {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = k; input.value = v;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  }, id, fields);
  await page.waitForNavigation({ waitUntil: 'networkidle0' });
  return { url: page.url(), text: await page.evaluate(() => document.body.innerText) };
}
const formFields = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#decide form input[type=hidden]')].map((i) => [i.name, i.value])));

// 1. normal approval
check('fresh browser session can log in', await login());
const before = await review(approveId);
check('test review is awaiting approval', before.status === 'awaiting_approval', before.status);
check('confirmation step is shown', !!(await openConfirm(approveId, 'approve')));
const savedApprove = { ...(await formFields()), confirmed: 'yes' };
let r = await submit();
const post = posts.at(-1);
check('browser sent a real same-origin Origin header', post.origin === BASE, `${post.path} Origin=${post.origin}`);
check('approve: no CSRF error, back on the review page', lastStatus === 303 && new URL(r.url).pathname === `/reviews/${approveId}` && !r.text.includes('CSRF check failed'), `${lastStatus} ${flash(r.url)}`);
check('approve: page shows approved', /approved at/.test(flash(r.url)) && r.text.includes('approved'));
const after = await review(approveId);
check('approve: controller recorded approved by dashboard:owner', after.status === 'approved' && after.decidedBy === 'dashboard:owner' && after.headSha === before.headSha, `${after.status} ${after.decidedBy}`);

// 8. duplicate approval (stale form submitted again) -> 409 shown on the page
r = await submitSaved(approveId, savedApprove);
check('duplicate approval: 409 explained on the review page', new URL(r.url).pathname === `/reviews/${approveId}` && /already approved/.test(flash(r.url)), flash(r.url));

// 7. SHA mismatch: hidden headSha tampered in the browser
await openConfirm(rejectId, 'reject');
await page.evaluate(() => { document.querySelector('#decide input[name=headSha]').value = 'f'.repeat(40); });
r = await submit();
check('tampered head SHA: rejected with a clear message', /does not match/.test(flash(r.url)), flash(r.url));
check('tampered head SHA: review unchanged', (await review(rejectId)).status === 'awaiting_approval');

// 6. logout, then a stale form is submitted -> login page, nothing done
await openConfirm(rejectId, 'reject');
const savedReject = { ...(await formFields()), confirmed: 'yes' };
await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('form[action="/api/auth/logout"] button')]);
r = await submitSaved(rejectId, savedReject).catch(async () => ({ url: page.url(), text: '' }));
check('after logout: sent to login with a re-login message', new URL(r.url).pathname === '/login' && /session has expired or you are logged out/.test(flash(r.url)), flash(r.url));
check('after logout: review unchanged', (await review(rejectId)).status === 'awaiting_approval');

// 5 + 11. session lost by a dashboard restart while the form is open, then log in again and reject
await login();
await openConfirm(rejectId, 'reject');
execFileSync('docker', ['restart', 'personal_ai-dashboard-1'], { stdio: 'ignore' });
for (let i = 0; i < 30; i++) {
  const ok = await fetch(`${BASE}/api/health`).then((x) => x.ok, () => false);
  if (ok) break;
  await new Promise((res) => setTimeout(res, 1000));
}
r = await submit();
check('expired session (restart): login page with message, no JSON', new URL(r.url).pathname === '/login' && /Log in again/.test(flash(r.url)) && !r.text.includes('"message"'), flash(r.url));
check('expired session: review unchanged', (await review(rejectId)).status === 'awaiting_approval');
check('after restart: log in again', await login());
await openConfirm(rejectId, 'reject');
r = await submit();
check('reject: back on the review page with the result', new URL(r.url).pathname === `/reviews/${rejectId}` && /rejected at/.test(flash(r.url)), flash(r.url));
const rejected = await review(rejectId);
check('reject: controller recorded rejected by dashboard:owner', rejected.status === 'rejected' && rejected.decidedBy === 'dashboard:owner');

// 10. history kept
const hist = await fetch(`${CONTROLLER}/tasks/${approveId}/review`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((x) => x.json());
check('approval history kept', hist.history.length >= 1 && hist.history.at(-1).status === 'approved');

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
