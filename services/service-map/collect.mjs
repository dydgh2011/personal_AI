#!/usr/bin/env node
// Service map collector (runs on the host, never in a container: it needs the Docker CLI, and no
// container gets the Docker socket). It reads the running Compose project and writes a snapshot
// that the Dashboard only reads:
//
//   node services/service-map/collect.mjs [--project personal_ai] [--out <file>] [--stdout]
//
// Default output: <project dir>/data/service-map/service-map.json (written atomically).
// Only whitelisted fields are copied. Environment values, build args, labels, secret file paths and
// commands never reach the snapshot; from the environment only the NAMES of variables whose value
// is a URL to another service are kept (they are how links between services are found).

import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAYERS, SERVICES } from './catalog.mjs';

export const SNAPSHOT_VERSION = 1;
const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// ---------------------------------------------------------------- pure part (tested)

function envEntries(environment) {
  if (!environment) return [];
  if (Array.isArray(environment)) {
    return environment.map((line) => {
      const i = String(line).indexOf('=');
      return i < 0 ? [String(line), ''] : [line.slice(0, i), line.slice(i + 1)];
    });
  }
  return Object.entries(environment);
}

/** Host of an http(s) URL value, or null. The value itself is never returned. */
function urlHost(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null;
  try {
    return new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function megabytes(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.round(n / (1024 * 1024));
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*([kmg])b?$/i);
  if (!m) return null;
  const factor = { k: 1 / 1024, m: 1, g: 1024 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * factor);
}

function relativeSource(source, projectDir) {
  if (!source) return null;
  const rel = projectDir ? path.relative(projectDir, source) : null;
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return './' + rel.split(path.sep).join('/');
  return '(호스트 경로)';
}

function networkNames(service) {
  const n = service.networks;
  if (!n) return ['default'];
  return (Array.isArray(n) ? n : Object.keys(n)).slice().sort();
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Build the snapshot from the resolved Compose config (`docker compose config --format json`),
 * container states and the hand-written catalog.
 */
export function buildMap({ config, containers = [], catalog = { LAYERS, SERVICES }, project, projectDir, composeFiles = [], now = new Date() }) {
  const serviceIds = Object.keys(config.services || {}).sort();
  const known = new Set(serviceIds);
  const netDefs = config.networks || {};
  const findings = [];
  const byService = new Map();
  for (const c of containers) {
    if (!c?.service) continue;
    const prev = byService.get(c.service);
    // Several containers for one service (scale, one-off runs): prefer the running one.
    if (!prev || (prev.state !== 'running' && c.state === 'running')) byService.set(c.service, c);
  }

  const networks = new Map();
  const services = serviceIds.map((id) => {
    const s = config.services[id];
    const info = catalog.SERVICES[id] || null;
    const nets = networkNames(s);
    for (const n of nets) {
      if (!networks.has(n)) networks.set(n, { id: n, internal: Boolean(netDefs[n]?.internal), members: [] });
      networks.get(n).members.push(id);
    }
    const internet = nets.some((n) => !netDefs[n]?.internal);
    const ports = (s.ports || []).map((p) => ({
      hostIp: p.host_ip || '0.0.0.0',
      published: p.published != null ? String(p.published) : null,
      target: p.target ?? null,
      protocol: p.protocol || 'tcp',
    }));
    const volumes = (s.volumes || []).map((v) => ({
      type: v.type,
      source: v.type === 'volume' ? v.source || null : v.type === 'bind' ? relativeSource(v.source, projectDir) : null,
      target: v.target,
      readOnly: Boolean(v.read_only),
    }));
    const capDrop = (s.cap_drop || []).map((c) => String(c).toUpperCase());
    const securityOpt = (s.security_opt || []).map(String);
    const c = byService.get(id);
    const status = c
      ? {
          state: c.state || 'unknown',
          health: c.health || null,
          startedAt: c.startedAt || null,
          restartCount: Number(c.restartCount) || 0,
          exitCode: c.exitCode == null || c.exitCode === '' ? null : Number(c.exitCode),
        }
      : null;
    const external = [...(info?.external || [])].map((e) => ({ name: e.name, purpose: e.purpose }));

    if (!info) findings.push({ level: 'info', code: 'uncatalogued', services: [id], message: `${id}: 설명이 없다 (services/service-map/catalog.mjs).` });
    if (!status || status.state !== 'running') {
      findings.push({ level: 'warn', code: 'not-running', services: [id], message: `${id}: 실행 중이 아니다 (${status?.state || '컨테이너 없음'}).` });
    } else if (status.health && status.health !== 'healthy') {
      findings.push({ level: 'warn', code: 'unhealthy', services: [id], message: `${id}: 헬스체크 ${status.health}.` });
    }
    for (const p of ports) {
      if (!LOCAL_HOSTS.has(p.hostIp)) {
        findings.push({ level: 'danger', code: 'port-exposed', services: [id], message: `${id}: 포트 ${p.published}가 ${p.hostIp}에 열려 있다 (127.0.0.1만 허용).` });
      }
    }
    if (!s.read_only) findings.push({ level: 'info', code: 'writable-root', services: [id], message: `${id}: 루트 파일 시스템이 쓰기 가능하다.` });
    if (!capDrop.includes('ALL')) findings.push({ level: 'info', code: 'caps-kept', services: [id], message: `${id}: 리눅스 권한(capabilities)을 모두 버리지 않았다.` });

    return {
      id,
      title: info?.title || id,
      layer: info?.layer || 'core',
      description: info?.description || null,
      image: s.image || null,
      networks: nets,
      internet,
      ports,
      volumes,
      secrets: (s.secrets || []).map((x) => (typeof x === 'string' ? x : x.source)).filter(Boolean).sort(),
      hardening: {
        readOnly: Boolean(s.read_only),
        capDropAll: capDrop.includes('ALL'),
        noNewPrivileges: securityOpt.some((o) => /^no-new-privileges(:true)?$/.test(o)),
        memLimitMb: megabytes(s.mem_limit),
        cpus: s.cpus != null ? Number(s.cpus) : null,
        pidsLimit: s.pids_limit != null ? Number(s.pids_limit) : null,
        healthcheck: Boolean(s.healthcheck && !s.healthcheck.disable),
      },
      external,
      status,
    };
  });

  // Links: a service whose environment points at another service by URL calls it.
  const links = new Map();
  for (const id of serviceIds) {
    for (const [key, value] of envEntries(config.services[id].environment)) {
      const host = urlHost(value);
      if (!host || !known.has(host) || host === id) continue;
      const k = `${id}>${host}`;
      if (!links.has(k)) links.set(k, { from: id, to: host, via: [] });
      links.get(k).via.push(key);
    }
  }
  const netsOf = new Map(services.map((s) => [s.id, new Set(s.networks)]));
  const linkList = [...links.values()]
    .map((l) => ({ ...l, via: l.via.sort(), networks: [...netsOf.get(l.from)].filter((n) => netsOf.get(l.to).has(n)).sort() }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  for (const l of linkList) {
    if (l.networks.length === 0) {
      findings.push({ level: 'warn', code: 'link-unreachable', services: [l.from, l.to], message: `${l.from} → ${l.to}: 설정은 부르는데 같은 네트워크가 없다.` });
    }
  }

  // Reachable: two services share a network. Unused reachable pairs are permissions to trim.
  const reachable = new Map();
  for (const net of networks.values()) {
    const m = net.members;
    for (let i = 0; i < m.length; i++) {
      for (let j = i + 1; j < m.length; j++) {
        const k = pairKey(m[i], m[j]);
        if (!reachable.has(k)) reachable.set(k, { a: k.split('|')[0], b: k.split('|')[1], networks: [] });
        reachable.get(k).networks.push(net.id);
      }
    }
  }
  const used = new Set(linkList.map((l) => pairKey(l.from, l.to)));
  const reachableList = [...reachable.values()]
    .map((r) => ({ ...r, networks: r.networks.sort(), used: used.has(pairKey(r.a, r.b)) }))
    .sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  for (const r of reachableList) {
    if (!r.used) {
      findings.push({ level: 'info', code: 'reachable-unused', services: [r.a, r.b], message: `${r.a} ↔ ${r.b}: ${r.networks.join(', ')}로 서로 닿지만 부르는 설정이 없다.` });
    }
  }
  const publishing = new Set(services.filter((s) => s.ports.length > 0).map((s) => s.id));
  for (const net of networks.values()) {
    if (/-internal$/.test(net.id) && !net.internal) {
      const withPorts = net.members.filter((m) => publishing.has(m));
      const why = withPorts.length
        ? ` 포트를 여는 ${withPorts.join(', ')}는 internal 네트워크만으로는 포트를 열 수 없어 일부러 둔 것일 수 있다.`
        : '';
      findings.push({ level: 'warn', code: 'internal-has-internet', services: net.members.slice(), message: `${net.id}: 이름은 내부망인데 internal: true가 아니어서 인터넷으로 나갈 수 있다.${why}` });
    }
  }
  for (const id of Object.keys(catalog.SERVICES)) {
    if (!known.has(id)) findings.push({ level: 'info', code: 'catalog-extra', services: [id], message: `${id}: 설명은 있는데 Compose에 없다.` });
  }

  const order = { danger: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level] || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));

  return {
    version: SNAPSHOT_VERSION,
    generatedAt: now.toISOString(),
    project: project || config.name || null,
    composeFiles: composeFiles.map((f) => path.basename(f)),
    layers: catalog.LAYERS,
    services,
    networks: [...networks.values()].map((n) => ({ ...n, members: n.members.sort() })).sort((a, b) => a.id.localeCompare(b.id)),
    links: linkList,
    reachable: reachableList,
    findings,
  };
}

/** One line per container from `docker inspect --format INSPECT_FORMAT`. */
export const INSPECT_FORMAT =
  '{{index .Config.Labels "com.docker.compose.service"}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.State.StartedAt}}\t{{.RestartCount}}\t{{.State.ExitCode}}';

export function parseInspectLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const [service, state, health, startedAt, restartCount, exitCode] = line.split('\t');
      return { service, state, health: health || null, startedAt: startedAt || null, restartCount: Number(restartCount) || 0, exitCode: exitCode === '' ? null : Number(exitCode) };
    });
}

// ---------------------------------------------------------------- host part

function docker(args, cwd) {
  return execFileSync('docker', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

function parseArgs(argv) {
  const out = { project: 'personal_ai', out: null, stdout: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--stdout') out.stdout = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(out.project || '')) throw new Error('--project must be a Compose project name');
  return out;
}

export function collect({ project }) {
  const listed = JSON.parse(docker(['compose', 'ls', '--all', '--format', 'json']) || '[]');
  const entry = listed.find((p) => p.Name === project);
  if (!entry) throw new Error(`Compose project ${project} not found (is Docker running?)`);
  const composeFiles = String(entry.ConfigFiles || '').split(',').map((f) => f.trim()).filter(Boolean);
  if (composeFiles.length === 0) throw new Error(`no config files recorded for ${project}`);
  const projectDir = path.dirname(composeFiles[0]);
  const fileArgs = composeFiles.flatMap((f) => ['-f', f]);
  const config = JSON.parse(docker(['compose', '-p', project, ...fileArgs, 'config', '--format', 'json'], projectDir));
  const ids = docker(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`]).split(/\s+/).filter(Boolean);
  const containers = ids.length ? parseInspectLines(docker(['inspect', '--format', INSPECT_FORMAT, ...ids])) : [];
  return { snapshot: buildMap({ config, containers, project, projectDir, composeFiles }), projectDir };
}

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8' });
  renameSync(tmp, file);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { snapshot, projectDir } = collect(args);
  const text = JSON.stringify(snapshot, null, 2) + '\n';
  if (args.stdout) {
    process.stdout.write(text);
    return;
  }
  const out = args.out || path.join(projectDir, 'data', 'service-map', 'service-map.json');
  writeAtomic(out, text);
  const counts = snapshot.findings.reduce((acc, f) => ({ ...acc, [f.level]: (acc[f.level] || 0) + 1 }), {});
  const running = snapshot.services.filter((s) => s.status?.state === 'running').length;
  console.log(`service map: ${snapshot.services.length} services (${running} running), ${snapshot.links.length} links, findings ${JSON.stringify(counts)} -> ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    // Docker's stderr can be long; the message is enough. Never print the config.
    console.error(`service map: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    process.exit(1);
  }
}
