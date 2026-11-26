import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { WorkerConfig } from './config.js';
import { ControllerClient } from './controller-client.js';
import type { WorkerReport } from './executor.js';
import { silentLogger } from './logger.js';
import { ClaudeRunner } from './runners/claude-runner.js';
import { InstanceLock, LockError, WorkerState } from './state.js';
import { FakeController } from './testing/fake-controller.js';
import { tempDir, testConfig, waitFor } from './testing/helpers.js';
import { Worker } from './worker.js';
import { Workspace } from './workspace.js';

describe('Worker (fake controller + fake Claude CLI)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let controller: FakeController;
  let config: WorkerConfig;
  let worker: Worker | null;
  let running: Promise<void> | null;

  const start = (overrides: Partial<WorkerConfig> = {}) => {
    config = { ...testConfig(dir.path, { controllerUrl: controller.url }), ...overrides };
    worker = new Worker({
      config,
      client: new ControllerClient(config.controllerUrl, config.token, 2000),
      workspace: new Workspace(config),
      runner: new ClaudeRunner(config.agentCommand),
      state: new WorkerState(config.stateDir),
      lock: new InstanceLock(config.stateDir),
      logger: silentLogger,
    });
    running = worker.run();
    return running;
  };
  const statusOf = (id: string) => controller.tasks.get(id)!.status;
  const reportOf = (raw: string | null) => JSON.parse(raw!) as WorkerReport;
  const callsFor = (id: string, action: string) => controller.calls.filter((c) => c.includes(`${id}/${action}`)).length;

  beforeEach(async () => {
    dir = await tempDir('worker-');
    controller = new FakeController();
    await controller.start();
    worker = null;
    running = null;
  });

  afterEach(async () => {
    worker?.stop();
    await running?.catch(() => {});
    await controller.stop();
    await dir.cleanup();
  });

  it('polls while idle and only claims tasks of its own agent', async () => {
    const codexTask = controller.addTask('codex', '@write x.txt=x');
    void start();
    await waitFor(() => controller.calls.filter((c) => c.endsWith('/claim')).length >= 3, 5000, 'idle polls');
    assert.equal(statusOf(codexTask.id), 'queued');
  });

  it('runs a task in its worktree, commits the result and reports completed', async () => {
    const task = controller.addTask('claude', 'Create a page\n@write index.html=<h1>Hello</h1>\n@dump .agent-env.json');
    void start();
    await waitFor(() => statusOf(task.id) === 'completed', 10_000, 'completion');

    const report = reportOf(controller.tasks.get(task.id)!.result);
    assert.equal(report.format, 'agent-worker/v1');
    assert.equal(report.outcome, 'completed');
    assert.equal(report.exitCode, 0);
    assert.equal(report.agentDetails.sessionId, task.id);
    assert.equal(report.workspace?.branch, `claude/task-${task.id}`);
    assert.deepEqual(report.workspace?.changedFiles.map((f) => f.path).sort(), ['.agent-env.json', 'index.html']);

    const worktree = join(config.workspaceRoot, '.worktrees', task.id);
    assert.equal(readFileSync(join(worktree, 'index.html'), 'utf8'), '<h1>Hello</h1>');
    assert.equal(existsSync(join(config.workspaceRoot, 'sandbox', 'index.html')), false, 'main checkout untouched');

    const dump = JSON.parse(readFileSync(join(worktree, '.agent-env.json'), 'utf8')) as { argv: string[]; envKeys: string[] };
    assert.ok(!dump.envKeys.includes('CONTROLLER_WORKER_TOKEN'));
    assert.ok(dump.argv.includes('--restricted'));
    assert.ok(!dump.argv.some((a) => a.includes('dangerously')));

    const branchLog = execFileSync('git', ['log', '-1', '--format=%s', `claude/task-${task.id}`], {
      cwd: join(config.workspaceRoot, 'sandbox'),
      encoding: 'utf8',
    });
    assert.match(branchLog, /claude-worker: task .* \(completed\)/);
    assert.ok(existsSync(join(config.stateDir, 'reports', `${task.id}.json`)), 'local report kept');
  });

  it('reports failed with the exit code and stderr when the CLI fails', async () => {
    const task = controller.addTask('claude', '@exit 3');
    void start();
    await waitFor(() => statusOf(task.id) === 'failed', 10_000, 'failure');
    const report = reportOf(controller.tasks.get(task.id)!.error);
    assert.equal(report.outcome, 'failed');
    assert.equal(report.exitCode, 3);
    assert.match(report.stderrTail, /fake-claude stderr line/);
  });

  it('starts the CLI with the task model and effort and records them in the report', async () => {
    const task = controller.addTask('claude', '@write a.txt=a' + String.fromCharCode(10) + '@dump .agent-env.json', 'sandbox', { model: 'opus', effort: 'high' });
    void start();
    await waitFor(() => statusOf(task.id) === 'completed', 10_000, 'completion');
    const dump = JSON.parse(readFileSync(join(config.workspaceRoot, '.worktrees', task.id, '.agent-env.json'), 'utf8')) as { argv: string[] };
    assert.equal(dump.argv[dump.argv.indexOf('--model') + 1], 'opus');
    assert.equal(dump.argv[dump.argv.indexOf('--effort') + 1], 'high');
    assert.deepEqual(reportOf(controller.tasks.get(task.id)!.result).run, { model: 'opus', effort: 'high' });
  });

  it('fails a task with an invalid model or effort without starting the CLI', async () => {
    const flag = controller.addTask('claude', '@write a=b', 'sandbox', { model: '--dangerously-skip-permissions' });
    const effort = controller.addTask('claude', '@write a=b', 'sandbox', { effort: 'ultra' });
    void start();
    await waitFor(() => statusOf(flag.id) === 'failed' && statusOf(effort.id) === 'failed', 10_000, 'rejections');
    const report = reportOf(controller.tasks.get(flag.id)!.error);
    assert.match(report.message, /invalid model/);
    assert.equal(report.exitCode, null);
    assert.deepEqual(report.run, { model: null, effort: null });
    assert.match(reportOf(controller.tasks.get(effort.id)!.error).message, /invalid effort/);
  });

  it('fails tasks it must not run without starting the CLI', async () => {
    const noProject = controller.addTask('claude', '@write a=b', null);
    const unknown = controller.addTask('claude', '@write a=b', 'other');
    void start();
    await waitFor(() => statusOf(noProject.id) === 'failed' && statusOf(unknown.id) === 'failed', 10_000, 'rejections');
    assert.match(reportOf(controller.tasks.get(noProject.id)!.error).message, /no projectId/);
    assert.match(reportOf(controller.tasks.get(unknown.id)!.error).message, /not enabled/);
  });

  it('stops the CLI and acknowledges when cancellation is requested', async () => {
    const task = controller.addTask('claude', '@write partial.txt=half done\n@sleep 30000');
    void start();
    await waitFor(() => statusOf(task.id) === 'running', 5000, 'claim');
    await waitFor(() => existsSync(join(config.workspaceRoot, '.worktrees', task.id, 'partial.txt')), 5000, 'partial work');
    const requestedAt = Date.now();
    controller.requestCancel(task.id);
    await waitFor(() => statusOf(task.id) === 'canceled', 10_000, 'cancel-ack');
    assert.ok(Date.now() - requestedAt < 5000, 'stopped promptly');
    assert.equal(callsFor(task.id, 'complete') + callsFor(task.id, 'fail'), 0);

    // partial work is preserved on the task branch, not deleted
    const files = execFileSync('git', ['show', '--name-only', '--format=', `claude/task-${task.id}`], {
      cwd: join(config.workspaceRoot, 'sandbox'),
      encoding: 'utf8',
    });
    assert.match(files, /partial\.txt/);
  });

  it('stops without reporting when the controller says it no longer owns the task', async () => {
    const task = controller.addTask('claude', '@sleep 30000');
    void start();
    await waitFor(() => statusOf(task.id) === 'running', 5000, 'claim');
    controller.expireLease(task.id);
    const next = controller.addTask('claude', '@write next.txt=ok');
    await waitFor(() => statusOf(next.id) === 'completed', 10_000, 'worker moves on');
    assert.equal(callsFor(task.id, 'complete') + callsFor(task.id, 'fail'), 0);
    assert.equal(controller.tasks.get(task.id)!.error, 'lease_expired: test');
  });

  it('stops the CLI and reports interrupted when the worker shuts down mid-task', async () => {
    const task = controller.addTask('claude', '@write wip.txt=wip\n@sleep 30000');
    const done = start();
    await waitFor(() => existsSync(join(config.workspaceRoot, '.worktrees', task.id, 'wip.txt')), 5000, 'agent running');
    worker!.stop();
    await done;
    assert.equal(statusOf(task.id), 'failed');
    const report = reportOf(controller.tasks.get(task.id)!.error);
    assert.equal(report.outcome, 'interrupted');
    assert.deepEqual(report.workspace?.changedFiles.map((f) => f.path), ['wip.txt']);
    assert.equal(await new WorkerState(config.stateDir).readCurrentTask(), null);
  });

  it('kills a task that exceeds its timeout and reports it as failed', async () => {
    const task = controller.addTask('claude', '@sleep 30000');
    void start({ taskTimeoutMs: 300 });
    await waitFor(() => statusOf(task.id) === 'failed', 10_000, 'timeout');
    const report = reportOf(controller.tasks.get(task.id)!.error);
    assert.equal(report.timedOut, true);
    assert.match(report.message, /Timed out/);
  });

  it('keeps running through a controller outage and reconnects', async () => {
    controller.failWith = 503;
    void start();
    await waitFor(() => controller.calls.length >= 2, 10_000, 'retries during outage');
    const task = controller.addTask('claude', '@write after-outage.txt=ok');
    controller.failWith = null;
    await waitFor(() => statusOf(task.id) === 'completed', 15_000, 'completion after outage');
  });

  it('reports a task interrupted by a restart as failed and does not re-run it', async () => {
    const task = controller.addTask('claude', '@write never.txt=x');
    task.status = 'running';
    task.claimedBy = 'claude-worker';
    const state = new WorkerState(join(dir.path, 'state'));
    await state.init();
    await state.saveCurrentTask({ taskId: task.id, startedAt: new Date().toISOString(), workspace: null });

    void start();
    await waitFor(() => statusOf(task.id) === 'failed', 10_000, 'recovery report');
    assert.equal(reportOf(controller.tasks.get(task.id)!.error).outcome, 'interrupted');
    // The worker clears its state file after the report request returns, so wait for it.
    await waitFor(async () => (await state.readCurrentTask()) === null, 5000, 'state cleared');
    assert.equal(existsSync(join(config.workspaceRoot, '.worktrees', task.id)), false, 'not re-run');
  });

  it('refuses to start a second worker on the same state directory', async () => {
    void start();
    await waitFor(() => controller.calls.length > 0, 5000, 'first worker');
    const second = new Worker({
      config,
      client: new ControllerClient(config.controllerUrl, config.token),
      workspace: new Workspace(config),
      runner: new ClaudeRunner(config.agentCommand),
      state: new WorkerState(config.stateDir),
      lock: new InstanceLock(config.stateDir),
      logger: silentLogger,
    });
    await assert.rejects(second.run(), LockError);
  });

  it('takes over a stale lock left by a crashed process', async () => {
    const state = new WorkerState(join(dir.path, 'state'));
    await state.init();
    await writeFile(join(dir.path, 'state', 'worker.lock'), JSON.stringify({ pid: 999_999_999, hostname: (await import('node:os')).hostname() }));
    void start();
    await waitFor(() => controller.calls.length > 0, 5000, 'worker with recovered lock');
  });
});
