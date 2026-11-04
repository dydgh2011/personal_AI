import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AppConfig } from '../src/config/app-config.js';
import { createTestApp } from './app.js';
import { testConfig } from './helpers.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);

function report(taskId: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: 'agent-worker/v1', taskId, agent: 'claude', outcome: 'completed', message: 'done', exitCode: 0,
    workspace: {
      projectId: 'sandbox', mode: 'write', path: `/workspace/.worktrees/${taskId}`, branch: `claude/task-${taskId}`,
      baseCommit: BASE, commit: HEAD, changedFiles: [{ status: 'A', path: 'index.html' }],
      diff: {
        baseCommit: BASE, headCommit: HEAD, headTree: TREE, commitMessage: 'claude-worker: task (completed)',
        additions: 3, deletions: 0,
        files: [
          { path: 'index.html', status: 'A', additions: 3, deletions: 0, binary: false, sensitive: false },
          { path: 'logo.png', status: 'A', additions: null, deletions: null, binary: true, sensitive: false },
          { path: '.env', status: 'A', additions: 1, deletions: 0, binary: false, sensitive: true },
        ],
        patch: 'diff --git a/index.html b/index.html\n+<h1>hi</h1>\n', patchTruncated: false, omittedFiles: ['logo.png', '.env'],
      },
    },
    ...overrides,
  });
}

describe('Task review and approval', () => {
  let dir: string;
  let config: AppConfig;
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin: Record<string, string>;
  let hermes: Record<string, string>;
  let claude: Record<string, string>;
  let codex: Record<string, string>;

  const boot = async () => {
    app = await createTestApp(config);
    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reviews-'));
    config = testConfig({ databasePath: join(dir, 'controller.db') });
    admin = { Authorization: `Bearer ${config.adminToken}` };
    hermes = { Authorization: `Bearer ${config.delegators[0].token}` };
    claude = { Authorization: `Bearer ${config.workers[0].token}` };
    codex = { Authorization: `Bearer ${config.workers[1].token}` };
    await boot();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A task created by Hermes, claimed and completed by the Claude worker with `result`. */
  const completedTask = async (result?: (id: string) => string) => {
    const task = (await http.post('/tasks').set(hermes).send({ agent: 'claude', projectId: 'sandbox', instruction: 'make a page' }).expect(201)).body;
    await http.post('/internal/workers/claim').set(claude).expect(200);
    await http.post(`/internal/tasks/${task.id}/complete`).set(claude).send({ result: (result ?? report)(task.id) }).expect(200);
    return task.id as string;
  };
  const decide = (id: string, action: 'approve' | 'reject', headSha = HEAD, as = admin) =>
    http.post(`/tasks/${id}/${action}`).set(as).send({ headSha, reason: 'looked fine' });

  it('serves the diff of a completed task and starts the review as awaiting_approval', async () => {
    const id = await completedTask();
    const diff = (await http.get(`/tasks/${id}/diff`).set(admin).expect(200)).body;
    expect(diff).toMatchObject({
      taskId: id, projectId: 'sandbox', agent: 'claude', baseSha: BASE, headSha: HEAD, headTree: TREE,
      additions: 3, deletions: 0, commitMessage: 'claude-worker: task (completed)', tests: null, patchTruncated: false,
      omittedFiles: ['logo.png', '.env'], review: { status: 'awaiting_approval', headSha: HEAD, baseSha: BASE },
    });
    expect(diff.patch).toContain('<h1>hi</h1>');
    expect(diff.files.find((f: { path: string }) => f.path === 'logo.png')).toMatchObject({ binary: true, additions: null });
    expect(diff.files.find((f: { path: string }) => f.path === '.env').sensitive).toBe(true);
    // Hermes (the creator) can read the diff and the review state of a local/public project
    expect((await http.get(`/tasks/${id}/diff`).set(hermes).expect(200)).body.patch).toContain('<h1>hi</h1>');
    expect((await http.get(`/tasks/${id}/review`).set(hermes).expect(200)).body.current.status).toBe('awaiting_approval');
  });

  it('approves exactly the reviewed commit, once', async () => {
    const id = await completedTask();
    await http.get(`/tasks/${id}/diff`).set(admin).expect(200);
    await decide(id, 'approve', 'f'.repeat(40)).expect(409); // not the commit under review
    const approved = (await decide(id, 'approve').expect(200)).body;
    expect(approved).toMatchObject({ status: 'approved', headSha: HEAD, baseSha: BASE, headTree: TREE, decidedBy: 'admin', reason: 'looked fine' });
    expect(approved.decidedAt).toEqual(expect.any(String));
    expect((await decide(id, 'approve').expect(409)).body.message).toMatch(/already approved/);
    expect((await decide(id, 'reject').expect(409)).body.message).toMatch(/already approved/);
  });

  it('serialises concurrent decisions: exactly one wins', async () => {
    const id = await completedTask();
    const results = await Promise.all([decide(id, 'approve'), decide(id, 'reject'), decide(id, 'approve'), decide(id, 'reject')]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  });

  it('rejects with a reason', async () => {
    const id = await completedTask();
    expect((await decide(id, 'reject').expect(200)).body).toMatchObject({ status: 'rejected', reason: 'looked fine' });
  });

  it('invalidates an approval when the task branch points to another commit', async () => {
    const id = await completedTask();
    await decide(id, 'approve').expect(200);
    const moved = 'd'.repeat(40);
    const res = (await http.post(`/internal/tasks/${id}/observed-head`).set(claude).send({ headSha: moved }).expect(200)).body;
    expect(res.matches).toBe(false);
    expect(res.invalidated).toEqual([expect.objectContaining({ headSha: HEAD, status: 'invalidated', decidedBy: 'admin' })]);
    const review = (await http.get(`/tasks/${id}/review`).set(admin).expect(200)).body;
    expect(review.current.status).toBe('invalidated');
    expect(review.current.invalidatedReason).toMatch(/now points to d{40}/);
    await decide(id, 'approve').expect(409);
    // observing the approved commit itself changes nothing
    const id2 = await completedTask();
    await decide(id2, 'approve').expect(200);
    expect((await http.post(`/internal/tasks/${id2}/observed-head`).set(claude).send({ headSha: HEAD }).expect(200)).body)
      .toEqual({ invalidated: [], matches: true });
  });

  it('never lets Hermes or a worker approve, and keeps other tasks private', async () => {
    const id = await completedTask();
    await decide(id, 'approve', HEAD, hermes).expect(403);
    await decide(id, 'reject', HEAD, hermes).expect(403);
    await decide(id, 'approve', HEAD, claude).expect(403);
    await decide(id, 'approve', HEAD, codex).expect(403);
    await http.get(`/tasks/${id}/diff`).set(claude).expect(403);
    await http.post(`/internal/tasks/${id}/observed-head`).set(codex).send({ headSha: HEAD }).expect(404);
    await http.post(`/internal/tasks/${id}/observed-head`).set(hermes).send({ headSha: HEAD }).expect(403);
    // a task Hermes did not create is invisible to it
    const adminTask = (await http.post('/tasks').set(admin).send({ agent: 'claude', projectId: 'sandbox', instruction: 'x' }).expect(201)).body;
    await http.get(`/tasks/${adminTask.id}/diff`).set(hermes).expect(404);
    await http.get('/tasks/00000000-0000-4000-8000-000000000000/diff').set(admin).expect(404);
    await http.get('/tasks/not-a-uuid/diff').set(admin).expect(400);
  });

  it('has no diff for unfinished tasks, read-only runs or reports without a commit', async () => {
    const queued = (await http.post('/tasks').set(admin).send({ agent: 'codex', projectId: 'sandbox', instruction: 'x' }).expect(201)).body;
    expect((await http.get(`/tasks/${queued.id}/diff`).set(admin).expect(404)).body.message).toMatch(/only completed tasks/);
    const noCommit = await completedTask((tid) => report(tid, { workspace: { projectId: 'sandbox', mode: 'write', baseCommit: BASE, commit: null, changedFiles: [] } }));
    expect((await http.get(`/tasks/${noCommit}/diff`).set(admin).expect(404)).body.message).toMatch(/no reviewable commit/);
    // a diff claiming another commit than the report's workspace is ignored, not trusted
    const mismatched = await completedTask((tid) => {
      const r = JSON.parse(report(tid));
      r.workspace.diff.headCommit = 'e'.repeat(40);
      return JSON.stringify(r);
    });
    const d = (await http.get(`/tasks/${mismatched}/diff`).set(admin).expect(200)).body;
    expect(d).toMatchObject({ headSha: HEAD, patch: null, headTree: null });
  });

  it('withholds patch text of private repositories from Hermes but not from the admin', async () => {
    const id = await completedTask();
    // mark the project private through the registry (admin PATCH cannot change visibility; set it directly)
    const { SQLITE_CONNECTION } = await import('../src/database/database.module.js');
    (app.get(SQLITE_CONNECTION) as { prepare(sql: string): { run(...a: unknown[]): unknown } })
      .prepare("UPDATE projects SET visibility = 'private' WHERE id = 'sandbox'").run();
    const forHermes = (await http.get(`/tasks/${id}/diff`).set(hermes).expect(200)).body;
    expect(forHermes.patch).toBeNull();
    expect(forHermes.patchWithheld).toMatch(/private repositories/);
    expect(forHermes.files).toHaveLength(3);
    expect((await http.get(`/tasks/${id}/diff`).set(admin).expect(200)).body.patch).toContain('<h1>hi</h1>');
  });

  it('records the dashboard user as approver and lists the review queue for admins only', async () => {
    const dashboard = { Authorization: `Bearer ${config.dashboardToken}` };
    const a = await completedTask();
    const b = await completedTask();
    expect((await http.get('/reviews?status=awaiting_approval').set(dashboard).expect(200)).body.items.map((r: { taskId: string }) => r.taskId).sort()).toEqual([a, b].sort());
    await http.post(`/tasks/${a}/approve`).set({ ...dashboard, 'X-Approver': 'Bad Name' }).send({ headSha: HEAD }).expect(400);
    const approved = (await http.post(`/tasks/${a}/approve`).set({ ...dashboard, 'X-Approver': 'owner' }).send({ headSha: HEAD }).expect(200)).body;
    expect(approved.decidedBy).toBe('dashboard:owner');
    expect((await decide(b, 'reject').expect(200)).body.decidedBy).toBe('admin');
    expect((await http.get('/reviews?status=approved').set(admin).expect(200)).body.items).toHaveLength(1);
    await http.get('/reviews?status=bogus').set(admin).expect(400);
    await http.get('/reviews').set(hermes).expect(403);
    await http.get('/reviews').set(claude).expect(403);
    // task list filtered by project
    expect((await http.get('/tasks?projectId=sandbox').set(admin).expect(200)).body.total).toBe(2);
    expect((await http.get('/tasks?projectId=personal-ai').set(admin).expect(200)).body.total).toBe(0);
  });

  it('keeps reviews and decisions across a controller restart', async () => {
    const id = await completedTask();
    await decide(id, 'approve').expect(200);
    await app.close();
    await boot();
    const review = (await http.get(`/tasks/${id}/review`).set(admin).expect(200)).body;
    expect(review.current).toMatchObject({ status: 'approved', headSha: HEAD, decidedBy: 'admin' });
    expect(review.history).toHaveLength(1);
  });
});
