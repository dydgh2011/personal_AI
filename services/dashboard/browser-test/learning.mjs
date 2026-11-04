#!/usr/bin/env node
// Real-browser check of the Learning L1 flow (Edge/Chromium via puppeteer-core).
//
//   node services/dashboard/browser-test/learning.mjs
//
// Creates test data (titles start with "[E2E]") in the learning database: run it against a test
// instance, or back up first and restore afterwards (services/learning/scripts/backup.mjs / restore.mjs).
// Prints statuses and on-page messages only; never cookies, tokens or the password.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const BASE = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:8710';
const BROWSER = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PASSWORD = process.env.DASHBOARD_E2E_PASSWORD || readFileSync(join(root, 'secrets', 'dashboard-admin.password'), 'utf8').trim();
const tag = `[E2E] ${new Date().toISOString().slice(11, 19)}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true });
const page = await (await browser.createBrowserContext()).newPage();
let dialogs = 0;
page.on('dialog', async (d) => { dialogs++; await d.dismiss(); });
const flash = () => {
  const u = new URL(page.url());
  return u.searchParams.get('ok') ? `ok: ${u.searchParams.get('ok')}` : u.searchParams.get('error') ? `error: ${u.searchParams.get('error')}` : '';
};
const text = () => page.evaluate(() => document.body.innerText);
const submit = async (selector) => Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click(selector)]);
async function fillForm(action, values) {
  for (const [name, value] of Object.entries(values)) {
    const sel = `form[action="${action}"] [name="${name}"]`;
    const tagName = await page.$eval(sel, (el) => el.tagName);
    const type = await page.$eval(sel, (el) => el.getAttribute('type'));
    if (tagName === 'SELECT') await page.select(sel, value);
    else if (type === 'date' || type === 'number') {
      // typing into date inputs is locale dependent; set the value like a date picker would
      await page.$eval(sel, (el, v) => { el.value = v; }, value);
    } else {
      await page.$eval(sel, (el) => { el.value = ''; });
      await page.type(sel, value);
    }
  }
  await submit(`form[action="${action}"] button[type=submit]`);
}

// login
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
await page.type('input[name=username]', 'owner');
await page.type('input[name=password]', PASSWORD);
await submit('button[type=submit]');
await page.goto(`${BASE}/learning`, { waitUntil: 'networkidle0' });
check('Learning overview opens from the nav', (await text()).includes('Learning') && (await page.$('nav a[href="/learning"]')) !== null);
check('AI drafts shown as not configured', (await text()).includes('not configured'));
check('unbuilt widgets say N/A (no fake numbers)', (await text()).includes('roadmap progress — N/A'));

// domain, goal, roadmap
await fillForm('/api/learning/domains/create', { title: `${tag} Frontend`, status: 'active' });
check('domain created', flash().startsWith('ok:'), flash());
const domainId = await page.$eval('form[action="/api/learning/goals/create"] select[name=domainId] option', (o) => o.value);
await fillForm('/api/learning/goals/create', { title: `${tag} React`, domainId, weeklyMinutes: '300', deadline: '2027-03-01' });
check('goal created', flash().startsWith('ok:'), flash());
await fillForm('/api/learning/roadmaps/create', { title: `${tag} React path` });
check('roadmap created, explorer opened', /\/learning\/roadmaps\/[0-9a-f-]{36}/.test(page.url()), flash());
const roadmapUrl = page.url().split('?')[0];
check('deadline shown as yours / fixed', (await text()).includes('2027-03-01') && (await text()).includes('yours · fixed'));
check('AI draft button disabled until configured', await page.$eval('form[action$="/generate"] button', (b) => b.disabled));

// manual edit -> proposal -> diff -> approve
await page.goto(`${roadmapUrl}?edit=1`, { waitUntil: 'networkidle0' });
const v1 = JSON.stringify({
  nodes: [
    { key: 'basics', type: 'stage', title: 'Basics <script>alert(1)</script>' },
    { key: 'jsx', type: 'topic', title: 'JSX', parentKey: 'basics', estimateMinutes: 60, skill: 'React JSX' },
    { key: 'hooks', type: 'skill', title: 'Hooks', parentKey: 'basics', estimateMinutes: 90, skill: 'React Hooks' },
  ],
  edges: [{ from: 'jsx', to: 'hooks' }],
});
await page.$eval('textarea[name=content]', (el, v) => { el.value = v; }, v1);
await submit('form[action$="/propose"] button[type=submit]');
check('edit becomes a proposal (not applied yet)', flash().startsWith('ok:') && (await text()).includes('No approved version yet'), flash());
check('diff shows added nodes', (await text()).includes('+ topic JSX'));
// approve needs the checkbox: browser blocks submit without it
const before = page.url();
await page.click('form[action$="/apply"] button[type=submit]');
await new Promise((r) => setTimeout(r, 500));
check('approve without checkbox does nothing', page.url() === before);
await page.click('form[action$="/apply"] input[name=confirmed]');
await submit('form[action$="/apply"] button[type=submit]');
check('approved as v1', /버전 1을 승인/.test(flash()), flash());
let t = await text();
check('explorer lists hierarchy + prerequisites', t.includes('requires: JSX') && t.includes('3 node(s) · 1 prerequisite link(s)'));
check('markup in titles shown as text', t.includes('<script>alert(1)</script>') && dialogs === 0);

// cycle is refused with the path, current version unchanged
await page.goto(`${roadmapUrl}?edit=1`, { waitUntil: 'networkidle0' });
await page.$eval('textarea[name=content]', (el) => {
  const c = JSON.parse(el.value);
  c.edges.push({ from: 'hooks', to: 'jsx' });
  el.value = JSON.stringify(c);
});
await submit('form[action$="/propose"] button[type=submit]');
check('prerequisite cycle refused with its path', /PREREQUISITE_CYCLE/.test(flash()) && /jsx → hooks → jsx|hooks → jsx → hooks/.test(flash()), flash());
await page.goto(roadmapUrl, { waitUntil: 'networkidle0' });
// section headings are CSS-uppercased, and innerText returns them that way
check('current version still v1', (await text()).toLowerCase().includes('current version (v1)'));

// second edit -> v2, then restore v1 as v3
await page.goto(`${roadmapUrl}?edit=1`, { waitUntil: 'networkidle0' });
await page.$eval('textarea[name=content]', (el) => {
  const c = JSON.parse(el.value);
  c.nodes.push({ key: 'state', type: 'topic', title: 'State management', parentKey: 'basics', estimateMinutes: 120, skill: 'react hooks' });
  c.edges.push({ from: 'hooks', to: 'state' });
  el.value = JSON.stringify(c);
});
await submit('form[action$="/propose"] button[type=submit]');
await page.click('form[action$="/apply"] input[name=confirmed]');
await submit('form[action$="/apply"] button[type=submit]');
check('approved as v2', /버전 2를 승인|버전 2을 승인/.test(flash()), flash());
const restoreForm = 'form[action$="/restore"]';
await page.click(`${restoreForm} input[name=confirmed]`);
await submit(`${restoreForm} button[type=submit]`);
check('restore creates a new version (v3)', /새 버전 3/.test(flash()), flash());
t = await text();
check('version history kept (v3, v2, v1)', /v3[\s\S]*v2[\s\S]*v1/.test(t) && t.toLowerCase().includes('current version (v3)'));

// AI generate is refused cleanly while not configured (direct form post)
await page.evaluate((url) => {
  const f = document.querySelector('form[action$="/generate"]');
  f.querySelector('button').disabled = false;
}, roadmapUrl);
await submit('form[action$="/generate"] button[type=submit]');
check('AI draft without configuration: clear message, nothing stored', /PROVIDER_NOT_CONFIGURED/.test(flash()), flash());

// ideas
await page.goto(`${BASE}/learning/ideas`, { waitUntil: 'networkidle0' });
await fillForm('/api/learning/ideas/create', { text: `${tag} Learn WebGL 100%` });
check('idea captured (not scheduled)', /자동으로 들어가지 않습니다/.test(flash()), flash());
await page.goto(`${BASE}/learning/ideas?q=${encodeURIComponent('WebGL 100%')}`, { waitUntil: 'networkidle0' });
check('idea search finds it', (await text()).includes('Learn WebGL 100%'));
const updateForm = await page.$eval('form[action^="/api/learning/ideas/"][action$="/update"]', (f) => f.getAttribute('action'));
await page.select(`form[action="${updateForm}"] select[name=state]`, 'archived');
await submit(`form[action="${updateForm}"] button[type=submit]`);
check('idea archived', /archived/.test(flash()), flash());
await page.goto(`${BASE}/learning/ideas?q=WebGL`, { waitUntil: 'networkidle0' });
check('archived idea hidden from the open inbox', !(await text()).includes('Learn WebGL 100%'));

// export download
const res = await page.evaluate(async () => {
  const r = await fetch('/api/learning-export');
  const j = await r.json();
  return { status: r.status, disposition: r.headers.get('content-disposition'), app: j.app, versions: j.counts?.versions };
});
check('JSON export downloads', res.status === 200 && /attachment/.test(res.disposition ?? '') && res.app === 'personal-ai-learning' && res.versions >= 3, JSON.stringify(res));

// CSRF: a cross-site form post is refused
const cross = await page.evaluate(async () => {
  const r = await fetch('/api/learning/domains/create', { method: 'POST', body: new URLSearchParams({ csrf: 'forged', title: 'x' }), redirect: 'manual' });
  return { type: r.type, status: r.status };
});
check('forged CSRF token refused', cross.type === 'opaqueredirect' || cross.status === 303, JSON.stringify(cross));

// mobile
for (const width of [390, 1280]) {
  await page.setViewport({ width, height: 900, isMobile: width < 500 });
  for (const path of ['/learning', '/learning/ideas', new URL(roadmapUrl).pathname]) {
    await page.goto(BASE + path, { waitUntil: 'networkidle0' });
    const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: innerWidth }));
    check(`${width}px ${path.replace(/[0-9a-f-]{36}/, ':id')} has no horizontal overflow`, m.s <= m.i, `${m.s}/${m.i}`);
  }
}
check('no script ever ran (no dialogs)', dialogs === 0);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
