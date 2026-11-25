#!/usr/bin/env node
// Network hardening proof. Renders the Compose config of THIS checkout (render only, never `up`),
// feeds it to the collector's own buildMap and compares it with the live stack:
//
//   node services/service-map/verify-networks.mjs [--project personal_ai] [--live-map <file>] [--json]
//
// - File list: the same Compose files the live project uses (`docker compose ls`), taken from this checkout.
// - "before": the live project's files rendered the same way; "live map": the snapshot the host collector
//   writes every minute (data/service-map/service-map.json in the live project directory).
// - Rendered with --no-env-resolution: env files (secrets/*.env) are never read. Links that only exist in
//   env files (the workers' CONTROLLER_URL) are taken from the live map by NAME and added as placeholders,
//   so buildMap sees the same links as the live collector. Nothing from the config is printed.
// Exit code 0 = every check passed.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMap } from './collect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// Calls the collector cannot see (their value is not a plain http:// URL). They must stay reachable.
export const HIDDEN_LINKS = [
  { from: 'controller', to: 'hermes', why: 'CONTROLLER_STATUS_PROBES=hermes=http://hermes:9119/ (상태 확인)' },
];
// Services that must have NO route to the internet after hardening.
export const EXPECT_NO_INTERNET = ['hermes-broker', 'test-runner'];
// Docker default local address pools on this PC: 172.18-31.0.0/16 (14) + 192.168.0.0/16 in /20 (16)
// minus 192.168.64.0/20, which overlaps Docker Desktop's own 192.168.65.0/24.
export const POOL_CAPACITY = 29;

function docker(args, cwd) {
  return execFileSync('docker', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

function render(dir, files, project) {
  const args = ['compose', '-p', project, '--project-directory', dir, ...files.flatMap((f) => ['-f', path.join(dir, f)]), 'config', '--no-env-resolution', '--format', 'json'];
  try {
    return JSON.parse(docker(args, dir));
  } catch (err) {
    throw new Error(`compose config failed in ${dir}: ${String(err.stderr || err.message).split('\n')[0]}`);
  }
}

/** Add placeholder URL variables for live links whose variable is not in the rendered environment. */
export function withLiveLinks(config, liveLinks) {
  const out = structuredClone(config);
  for (const l of liveLinks) {
    const s = out.services?.[l.from];
    if (!s || !out.services[l.to]) continue;
    if (Array.isArray(s.environment)) s.environment = Object.fromEntries(s.environment.map((e) => { const i = e.indexOf('='); return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)]; }));
    s.environment ||= {};
    for (const name of l.via) if (!(name in s.environment)) s.environment[name] = `http://${l.to}/`;
  }
  return out;
}

const pair = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const count = (map, code) => map.findings.filter((f) => f.code === code).length;

/** Pure checks; returns [{ ok, name, detail }]. */
export function check({ before, after, live }) {
  const checks = [];
  const add = (ok, name, detail = '') => checks.push({ ok: Boolean(ok), name, detail });
  const unreachable = after.findings.filter((f) => f.code === 'link-unreachable');
  add(unreachable.length === 0, 'link-unreachable = 0', unreachable.map((f) => f.services.join(' → ')).join(', '));
  const leaky = after.findings.filter((f) => f.code === 'internal-has-internet');
  add(leaky.length === 0, 'internal-has-internet = 0', leaky.map((f) => f.message.split(':')[0]).join(', '));
  const beforeUnused = before.findings.filter((f) => f.code === 'reachable-unused');
  const afterUnused = after.findings.filter((f) => f.code === 'reachable-unused');
  const previousPairs = new Set(beforeUnused.map((f) => pair(...f.services)));
  const newPairs = afterUnused.filter((f) => !previousPairs.has(pair(...f.services)));
  add(newPairs.length === 0, `reachable-unused 새 연결 없음 (${beforeUnused.length} → ${afterUnused.length})`,
    newPairs.map((f) => f.services.join(' ↔ ')).join(', '));

  const afterLinks = new Map(after.links.map((l) => [`${l.from}>${l.to}`, l]));
  const missing = live.links.filter((l) => !afterLinks.get(`${l.from}>${l.to}`)?.networks.length);
  add(missing.length === 0, `라이브 링크 ${live.links.length}개 모두 유지`, missing.map((l) => `${l.from} → ${l.to}`).join(', '));

  const netsOf = new Map(after.services.map((s) => [s.id, new Set(s.networks)]));
  const hiddenBroken = HIDDEN_LINKS.filter((h) => ![...(netsOf.get(h.from) || [])].some((n) => netsOf.get(h.to)?.has(n)));
  add(hiddenBroken.length === 0, `숨은 호출 ${HIDDEN_LINKS.length}개 유지 (${HIDDEN_LINKS.map((h) => `${h.from} → ${h.to}`).join(', ')})`, hiddenBroken.map((h) => h.why).join(', '));

  add(count(after, 'port-exposed') === 0, 'port-exposed = 0 (127.0.0.1만)');
  const portsOf = (m) => new Map(m.services.map((s) => [s.id, JSON.stringify(s.ports)]));
  const pb = portsOf(before);
  const changedPorts = after.services.filter((s) => pb.has(s.id) && pb.get(s.id) !== JSON.stringify(s.ports)).map((s) => s.id);
  add(changedPorts.length === 0, '포트 바인딩 변화 없음', changedPorts.join(', '));

  const netInternal = new Map(after.networks.map((n) => [n.id, n.internal]));
  const unpublishable = after.services.filter((s) => s.ports.length && !s.networks.some((n) => !netInternal.get(n))).map((s) => s.id);
  add(unpublishable.length === 0, '포트를 여는 서비스는 internal 아닌 네트워크가 하나 이상', unpublishable.join(', '));

  const shared = after.networks.filter((n) => !n.internal && n.members.length !== 1);
  add(shared.length === 0, '인터넷 되는(internal 아닌) 네트워크는 서비스 하나 전용', shared.map((n) => `${n.id}: ${n.members.join(', ')}`).join('; '));

  const online = after.services.filter((s) => EXPECT_NO_INTERNET.includes(s.id) && s.internet).map((s) => s.id);
  add(online.length === 0, `인터넷 없어야 하는 서비스: ${EXPECT_NO_INTERNET.join(', ')}`, online.join(', '));

  const lostServices = before.services.filter((s) => !netsOf.has(s.id)).map((s) => s.id);
  add(lostServices.length === 0, '서비스 목록 그대로', lostServices.join(', '));
  return checks;
}

function table(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ')).join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const opt = { project: 'personal_ai', liveMap: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') opt.project = argv[++i];
    else if (argv[i] === '--live-map') opt.liveMap = argv[++i];
    else if (argv[i] === '--json') opt.json = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(opt.project)) throw new Error('--project must be a Compose project name');

  const entry = JSON.parse(docker(['compose', 'ls', '--all', '--format', 'json']) || '[]').find((p) => p.Name === opt.project);
  if (!entry) throw new Error(`Compose project ${opt.project} not found (is Docker running?)`);
  const liveFiles = String(entry.ConfigFiles).split(',').map((f) => f.trim()).filter(Boolean);
  const liveDir = path.dirname(liveFiles[0]);
  const files = liveFiles.map((f) => path.basename(f));
  for (const f of files) if (!existsSync(path.join(REPO, f))) throw new Error(`${f} is not in ${REPO}`);

  const liveMapFile = opt.liveMap || path.join(liveDir, 'data', 'service-map', 'service-map.json');
  const live = JSON.parse(readFileSync(liveMapFile, 'utf8'));
  const before = buildMap({ config: withLiveLinks(render(liveDir, files, opt.project), live.links), project: opt.project });
  const after = buildMap({ config: withLiveLinks(render(REPO, files, opt.project), live.links), project: opt.project });
  const checks = check({ before, after, live });

  // Sanity: the "before" render must match what the live collector saw.
  const memb = (m) => JSON.stringify(m.networks.map((n) => [n.id, n.internal, n.members]));
  const beforeMatchesLive = memb(before) === memb(live);

  const projectNets = docker(['network', 'ls', '--format', '{{.Name}}']).split(/\r?\n/).filter(Boolean);
  const others = projectNets.filter((n) => !n.startsWith(`${opt.project}_`) && !['bridge', 'host', 'none'].includes(n)).length;
  const needed = after.networks.length + 1; // + repo-egress while repo-sync (profile "tools") runs
  const pool = { needed, otherNetworks: others, capacity: POOL_CAPACITY, spare: POOL_CAPACITY - needed - others };

  if (opt.json) {
    process.stdout.write(JSON.stringify({ checks, beforeMatchesLive, pool, before: summary(before), after: summary(after) }, null, 2) + '\n');
  } else {
    const ib = new Map(before.services.map((s) => [s.id, s]));
    console.log(`파일: ${files.join(' ')}\n이 체크아웃: ${REPO}\n라이브: ${liveDir} (지도 ${path.relative(liveDir, liveMapFile)}, 생성 ${live.generatedAt})\n`);
    console.log('서비스별 인터넷 (전 → 후)');
    console.log(table([['서비스', '전', '후', '포트', '후 네트워크'], ...after.services.map((s) => [s.id, ib.get(s.id)?.internet ? '예' : '아니오', s.internet ? '예' : '아니오', s.ports.map((p) => `${p.hostIp}:${p.published}`).join(' ') || '-', s.networks.join(', ')])]));
    console.log('\n네트워크 (후, * = internal)');
    console.log(table(after.networks.map((n) => [`${n.id}${n.internal ? '*' : ''}`, n.members.join(', ')])));
    const ru = (m) => m.findings.filter((f) => f.code === 'reachable-unused').map((f) => f.services.join(' ↔ '));
    console.log(`\nreachable-unused 전 (${ru(before).length}): ${ru(before).join('; ')}`);
    console.log(`reachable-unused 후 (${ru(after).length}): ${ru(after).join('; ') || '-'}`);
    for (const h of HIDDEN_LINKS) if (ru(after).includes(pair(h.from, h.to).replace('|', ' ↔ '))) console.log(`  └ ${h.from} ↔ ${h.to}: 실제로 쓰는 호출이다 — ${h.why}. 수집기가 이 형식을 못 읽을 뿐.`);
    console.log(`\n전 렌더 = 라이브 지도: ${beforeMatchesLive ? '같음' : '다름 (라이브 스택이 지금 파일과 다르게 떠 있다)'}`);
    console.log(`주소 풀: 필요 ${pool.needed}개(+repo-egress 포함) + 다른 프로젝트 ${pool.otherNetworks}개 / 추정 용량 ${pool.capacity} → 여유 ${pool.spare}`);
    console.log('\n검사');
    for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  }
  const ok = checks.every((c) => c.ok) && beforeMatchesLive && pool.spare >= 0;
  if (!opt.json) console.log(ok ? '\n결과: 통과' : '\n결과: 실패');
  process.exit(ok ? 0 : 1);
}

function summary(m) {
  return {
    internet: Object.fromEntries(m.services.map((s) => [s.id, s.internet])),
    networks: m.networks,
    findings: m.findings.filter((f) => ['link-unreachable', 'internal-has-internet', 'reachable-unused', 'port-exposed'].includes(f.code)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`verify-networks: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    process.exit(1);
  }
}
