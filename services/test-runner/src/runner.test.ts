import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TestRunJob } from './checkout.js';
import { ConfigError, loadConfig, type RunnerConfig } from './config.js';
import { verifySeal, type Evidence } from './evidence.js';
import { runJob } from './main.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=codex-worker', '-c', 'user.email=codex-worker@personal-ai.local', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

function fixture(root: string) {
  const seed = join(root, 'seed');
  mkdirSync(seed);
  g(seed, 'init', '-q');
  writeFileSync(join(seed, 'README.md'), '# hello\n');
  g(seed, 'add', '-A');
  g(seed, 'commit', '-q', '-m', 'initial');
  const base = g(seed, 'rev-parse', 'HEAD');
  const exportRoot = join(root, 'exports');
  mkdirSync(exportRoot);
  g(root, 'clone', '-q', '--bare', seed, join(exportRoot, 'hello.git'));
  chmodSync(exportRoot, 0o700);
  const taskId = randomUUID();
  const branch = `codex/task-${taskId}`;
  g(seed, 'checkout', '-q', '-b', branch);
  writeFileSync(join(seed, 'NOTES.md'), '# Notes\n');
  g(seed, 'add', '-A');
  g(seed, 'commit', '-q', '-m', `codex-worker: task ${taskId} (completed)`);
  const head = g(seed, 'rev-parse', 'HEAD');
  const tree = g(seed, 'rev-parse', 'HEAD^{tree}');
  const artifacts = join(root, 'artifacts', 'codex');
  mkdirSync(artifacts, { recursive: true });
  chmodSync(artifacts, 0o700);
  const bundle = join(artifacts, `${taskId}.bundle`);
  g(seed, 'bundle', 'create', '-q', bundle, `refs/heads/${branch}`, `^${base}`);
  const writeManifest = (over: Record<string, unknown> = {}) => writeFileSync(join(artifacts, `${taskId}.json`), JSON.stringify({
    format: 'personal-ai-artifact/v1', taskId, agent: 'codex', projectId: 'hello', branch, baseSha: base, headSha: head, bundle: `${taskId}.bundle`,
    bundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'), ...over,
  }));
  writeManifest();
  return { exportRoot, artifacts, bundle, taskId, base, head, tree, writeManifest };
}

describe('test runner', () => {
  let root: string;
  let f: ReturnType<typeof fixture>;
  let config: RunnerConfig;
  const key = randomBytes(32);
  const job = (commands: TestRunJob['validation']['commands'], over: Partial<TestRunJob> = {}): TestRunJob => ({
    validation: { id: randomUUID(), taskId: f.taskId, projectId: 'hello', commands },
    task: { id: f.taskId, agent: 'codex', projectId: 'hello', status: 'completed' },
    baseSha: f.base,
    commitSha: f.head,
    headTree: f.tree,
    ...over,
  });
  const evidenceOf = (body: { evidence: string }) => JSON.parse(body.evidence) as Evidence;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runner-'));
    chmodSync(root, 0o755);
    f = fixture(root);
    const work = join(root, 'work');
    mkdirSync(work);
    chmodSync(work, 0o755);
    config = {
      controllerUrl: 'http://controller:3000', token: 'x'.repeat(40), evidenceKey: key,
      artifactRoots: { codex: f.artifacts }, exportRoot: f.exportRoot, workDir: work,
      sandboxUid: 10001, sandboxGid: 10001, maxOutputBytes: 64 * 1024, maxBundleBytes: 1024 * 1024, pollIntervalMs: 1000, runnerId: 'test-runner',
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('loads secrets once and removes them from the environment', () => {
    const env: NodeJS.ProcessEnv = { CONTROLLER_URL: 'http://controller:3000', TEST_RUNNER_CONTROLLER_TOKEN: 't'.repeat(40), TEST_EVIDENCE_KEY: 'a'.repeat(64) };
    const c = loadConfig(env);
    assert.equal(c.token, 't'.repeat(40));
    assert.equal(env.TEST_RUNNER_CONTROLLER_TOKEN, undefined);
    assert.equal(env.TEST_EVIDENCE_KEY, undefined);
    assert.throws(() => loadConfig({ CONTROLLER_URL: 'http://c:1', TEST_RUNNER_CONTROLLER_TOKEN: 't'.repeat(40), TEST_EVIDENCE_KEY: 'a'.repeat(64), TEST_RUNNER_SANDBOX_UID: '1000' }), ConfigError);
    assert.throws(() => loadConfig({ CONTROLLER_URL: 'http://c:1', TEST_RUNNER_CONTROLLER_TOKEN: 't'.repeat(40), TEST_EVIDENCE_KEY: 'short' }), /TEST_EVIDENCE_KEY/);
  });

  it('runs approved commands on the exact commit as the sandbox user and signs the exit codes', { skip: !isRoot }, async () => {
    const body = await runJob(job([
      { name: 'docs', argv: ['sh', '-c', 'test -f NOTES.md && git diff --check "$BASE_SHA" HEAD && test "$(git rev-parse HEAD)" = "$HEAD_SHA"'], timeoutSeconds: 30 },
      { name: 'identity', argv: ['sh', '-c', 'test "$(id -u)" = 10001 && test "$(id -g)" = 10001'], timeoutSeconds: 10 },
    ]), config);
    assert.equal(body.status, 'passed', JSON.stringify(body.results));
    assert.deepEqual(body.results.map((r) => r.exitCode), [0, 0]);
    assert.equal(verifySeal(body.evidence, body.evidenceHash, body.evidenceSignature, key), true);
    assert.equal(verifySeal(body.evidence, body.evidenceHash, body.evidenceSignature, randomBytes(32)), false);
    const e = evidenceOf(body);
    assert.equal(e.commitSha, f.head);
    assert.equal(e.treeSha, f.tree);
    assert.equal(e.status, 'passed');
  });

  it('reports failures, timeouts and missing programs from the real exit status', { skip: !isRoot }, async () => {
    const failed = await runJob(job([
      { name: 'ok', argv: ['true'], timeoutSeconds: 5 },
      { name: 'fails', argv: ['sh', '-c', 'echo boom; exit 3'], timeoutSeconds: 5 },
    ]), config);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.results.map((r) => [r.status, r.exitCode]), [['passed', 0], ['failed', 3]]);
    assert.match(failed.results[1].outputTail, /boom/);

    const timedOut = await runJob(job([{ name: 'hangs', argv: ['sleep', '30'], timeoutSeconds: 1 }]), config);
    assert.equal(timedOut.status, 'aborted');
    assert.equal(timedOut.results[0].timedOut, true);
    assert.equal(timedOut.results[0].exitCode, null);

    const missing = await runJob(job([{ name: 'nope', argv: ['definitely-not-a-program'], timeoutSeconds: 5 }]), config);
    assert.equal(missing.status, 'failed');
    assert.equal(missing.results[0].exitCode, 127);
  });

  it('gives tests no credentials and no view of other repositories or artifacts', { skip: !isRoot }, async () => {
    process.env.SOME_SECRET_TOKEN = 'leak-me-if-you-can';
    try {
      const body = await runJob(job([
        { name: 'env', argv: ['sh', '-c', 'env | grep -E "TOKEN|KEY|SECRET" && exit 1 || exit 0'], timeoutSeconds: 5 },
        { name: 'exports', argv: ['sh', '-c', `ls ${f.exportRoot}`], timeoutSeconds: 5 },
        { name: 'artifacts', argv: ['sh', '-c', `cat ${f.bundle} > /dev/null`], timeoutSeconds: 5 },
        { name: 'alternates', argv: ['sh', '-c', 'test ! -e .git/objects/info/alternates'], timeoutSeconds: 5 },
        { name: 'proc', argv: ['sh', '-c', 'cat /proc/1/environ'], timeoutSeconds: 5 },
      ]), config);
      assert.deepEqual(body.results.map((r) => r.status), ['passed', 'failed', 'failed', 'passed', 'failed']);
      assert.doesNotMatch(body.evidence, /leak-me-if-you-can/);
    } finally {
      delete process.env.SOME_SECRET_TOKEN;
    }
  });

  it('kills processes a test leaves behind', { skip: !isRoot }, async () => {
    const body = await runJob(job([
      { name: 'spawns', argv: ['sh', '-c', 'setsid sleep 300 >/dev/null 2>&1 & exit 0'], timeoutSeconds: 5 },
      { name: 'check', argv: ['sh', '-c', 'for p in /proc/[0-9]*; do tr "\\000" " " < $p/cmdline 2>/dev/null | grep -q "^sleep 300" && exit 1; done; exit 0'], timeoutSeconds: 5 },
    ]), config);
    assert.deepEqual(body.results.map((r) => r.status), ['passed', 'passed']);
  });

  it('aborts without running anything when the artifact is not the commit under test', { skip: !isRoot }, async () => {
    const commands = [{ name: 'ok', argv: ['true'], timeoutSeconds: 5 }];
    let body = await runJob(job(commands, { commitSha: 'e'.repeat(40) }), config);
    assert.equal(body.status, 'aborted');
    assert.match(body.error ?? '', /manifest does not describe this commit/);
    assert.deepEqual(body.results, []);

    const data = readFileSync(f.bundle);
    data[data.length - 3] ^= 0xff;
    writeFileSync(f.bundle, data);
    body = await runJob(job(commands), config);
    assert.equal(body.status, 'aborted');
    assert.match(body.error ?? '', /checksum/);

    rmSync(join(f.artifacts, `${f.taskId}.json`));
    body = await runJob(job(commands), config);
    assert.match(body.error ?? '', /artifact missing/);
    assert.equal(evidenceOf(body).status, 'aborted');
  });
});
