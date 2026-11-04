import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { WorkerConfig } from './config.js';
import { ControllerClient } from './controller-client.js';
import type { WorkerReport } from './executor.js';
import { silentLogger } from './logger.js';
import type { AgentRunner } from './runners/agent-runner.js';
import { ClaudeRunner } from './runners/claude-runner.js';
import { CodexRunner } from './runners/codex-runner.js';
import { InstanceLock, WorkerState } from './state.js';
import { FakeController, localProject } from './testing/fake-controller.js';
import { FAKE_CLAUDE, FAKE_CODEX, makeCacheRepo, tempDir, testConfig, waitFor } from './testing/helpers.js';
import { Worker } from './worker.js';
import { Workspace } from './workspace.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** The worker driven by the controller's project registry (GET /internal/projects). */
describe('Worker + project registry', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let controller: FakeController;
  let workers: Array<{ worker: Worker; running: Promise<void>; config: WorkerConfig }>;
  let cacheRoot: string;

  const start = (agent: 'claude' | 'codex', overrides: Partial<WorkerConfig> = {}) => {
    const root = join(dir.path, agent);
    const config: WorkerConfig = {
      ...testConfig(root, {
        agent,
        workerId: `${agent}-worker`,
        token: agent === 'claude' ? 'c'.repeat(40) : 'x'.repeat(40),
        controllerUrl: controller.url,
        agentCommand: [process.execPath, agent === 'claude' ? FAKE_CLAUDE : FAKE_CODEX],
        repoCacheRoot: cacheRoot, // shared, read-only for workers
      }),
      ...overrides,
    };
    const runner: AgentRunner = agent === 'claude' ? new ClaudeRunner(config.agentCommand) : new CodexRunner(config.agentCommand);
    const worker = new Worker({
      config,
      client: new ControllerClient(config.controllerUrl, config.token, 2000),
      workspace: new Workspace(config),
      runner,
      state: new WorkerState(config.stateDir),
      lock: new InstanceLock(config.stateDir),
      logger: silentLogger,
    });
    workers.push({ worker, running: worker.run(), config });
    return config;
  };
  const statusOf = (id: string) => controller.tasks.get(id)!.status;
  const reportOf = (id: string) => JSON.parse(controller.tasks.get(id)!.result ?? controller.tasks.get(id)!.error!) as WorkerReport;
  const agentStarted = (config: WorkerConfig, taskId: string) => existsSync(join(config.workspaceRoot, '.worktrees', taskId));

  beforeEach(async () => {
    dir = await tempDir('registry-');
    cacheRoot = join(dir.path, 'repo-cache');
    controller = new FakeController();
    await controller.start();
    workers = [];
  });

  afterEach(async () => {
    for (const w of workers) w.worker.stop();
    await Promise.all(workers.map((w) => w.running.catch(() => {})));
    await controller.stop();
    await dir.cleanup();
  });

  it('refuses projects the registry does not list for this agent, without starting the CLI', async () => {
    controller.projects.set('codex-only', localProject('codex-only', { allowedAgents: ['codex'] }));
    controller.projects.set('off', localProject('off', { enabled: false }));
    const config = start('claude');
    const tasks = ['unregistered', 'codex-only', 'off'].map((p) => controller.addTask('claude', '@write x.txt=x', p));
    await waitFor(() => tasks.every((t) => statusOf(t.id) === 'failed'), 10_000, 'rejections');
    for (const t of tasks) {
      assert.match(reportOf(t.id).message, /not enabled for claude in the project registry/);
      assert.equal(agentStarted(config, t.id), false);
    }
  });

  it('picks up registry changes without a restart: a new project is used, a disabled one is refused', async () => {
    const config = start('claude');
    const first = controller.addTask('claude', '@write a.txt=a', 'notes');
    await waitFor(() => statusOf(first.id) === 'failed', 10_000, 'unknown project refused');

    // admin registers and syncs a GitHub project while the worker keeps running
    const cache = await makeCacheRepo(cacheRoot, 'notes', join(dir.path, 'PWNED'));
    controller.projects.set('notes', localProject('notes', { source: 'github', syncStatus: 'synced', cachedHeadSha: cache.head }));
    const second = controller.addTask('claude', '@write CHANGELOG.md=entry', 'notes');
    await waitFor(() => statusOf(second.id) === 'completed', 15_000, 'new project used');
    const report = reportOf(second.id);
    assert.equal(report.workspace?.baseCommit, cache.head);
    assert.equal(report.workspace?.branch, `claude/task-${second.id}`);
    assert.deepEqual(report.workspace?.changedFiles, [{ status: 'A', path: 'CHANGELOG.md' }]);
    assert.ok(report.workspace?.notes?.some((n) => n.includes('symlink')));

    controller.projects.get('notes')!.enabled = false;
    const third = controller.addTask('claude', '@write b.txt=b', 'notes');
    await waitFor(() => statusOf(third.id) === 'failed', 10_000, 'disabled project refused');
    assert.match(reportOf(third.id).message, /not enabled/);
    assert.equal(agentStarted(config, third.id), false);
  });

  it('fails closed when the registry cannot be read', async () => {
    controller.projectsFailWith = 503;
    const config = start('claude');
    const down = controller.addTask('claude', '@write x.txt=x');
    await waitFor(() => statusOf(down.id) === 'failed', 15_000, 'registry outage');
    assert.match(reportOf(down.id).message, /Project registry unavailable.*the task was not run/);
    assert.equal(agentStarted(config, down.id), false);

    controller.projectsFailWith = 403;
    const denied = controller.addTask('claude', '@write x.txt=x');
    await waitFor(() => statusOf(denied.id) === 'failed', 10_000, 'registry denied');
    assert.match(reportOf(denied.id).message, /Project registry unavailable/);

    controller.projectsFailWith = null;
    const ok = controller.addTask('claude', '@write ok.txt=ok');
    await waitFor(() => statusOf(ok.id) === 'completed', 10_000, 'recovers');
  });

  it('refuses a GitHub project that is registered but not synced', async () => {
    controller.projects.set('fresh', localProject('fresh', { source: 'github' }));
    const config = start('codex');
    const task = controller.addTask('codex', '@write x.txt=x', 'fresh');
    await waitFor(() => statusOf(task.id) === 'failed', 10_000, 'unsynced');
    assert.match(reportOf(task.id).message, /has not been synced into the repository cache/);
    assert.equal(agentStarted(config, task.id), false);
  });

  it('gives Claude and Codex separate clones and branches of the same cached project', async () => {
    const cache = await makeCacheRepo(cacheRoot, 'shared', join(dir.path, 'PWNED'));
    controller.projects.set('shared', localProject('shared', { source: 'github', syncStatus: 'synced', cachedHeadSha: cache.head }));
    const claude = start('claude');
    const codex = start('codex');
    const a = controller.addTask('claude', '@write claude.txt=from claude', 'shared');
    const b = controller.addTask('codex', '@write codex.txt=from codex', 'shared');
    await waitFor(() => statusOf(a.id) === 'completed' && statusOf(b.id) === 'completed', 20_000, 'both done');

    const claudeRepo = join(claude.workspaceRoot, 'repos', 'shared.git');
    const codexRepo = join(codex.workspaceRoot, 'repos', 'shared.git');
    assert.notEqual(claudeRepo, codexRepo);
    assert.equal(git(claudeRepo, 'rev-parse', `claude/task-${a.id}`), reportOf(a.id).workspace?.commit);
    assert.equal(git(codexRepo, 'rev-parse', `codex/task-${b.id}`), reportOf(b.id).workspace?.commit);
    // neither worker sees the other's branch or files; the cache and its default branch are untouched
    assert.throws(() => git(claudeRepo, 'rev-parse', '--verify', '--quiet', `codex/task-${b.id}`));
    assert.throws(() => git(codexRepo, 'rev-parse', '--verify', '--quiet', `claude/task-${a.id}`));
    assert.equal(existsSync(join(claude.workspaceRoot, '.worktrees', a.id, 'codex.txt')), false);
    assert.equal(readFileSync(join(codex.workspaceRoot, '.worktrees', b.id, 'codex.txt'), 'utf8'), 'from codex');
    assert.equal(git(cache.path, 'rev-parse', 'refs/heads/main'), cache.head);
    assert.deepEqual(git(cache.path, 'for-each-ref', '--format=%(refname)').split('\n').sort(), ['refs/heads/main', 'refs/tags/v1']);
    assert.equal(existsSync(join(dir.path, 'PWNED')), false);
  });
});
