import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AppConfig } from '../src/config/app-config.js';
import { createTestApp } from './app.js';
import { FakeClock, testConfig } from './helpers.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);

function report(taskId: string) {
  return JSON.stringify({
    format: 'agent-worker/v1', taskId, agent: 'claude', outcome: 'completed', message: 'done', exitCode: 0,
    workspace: {
      projectId: 'sandbox', mode: 'write', path: `/workspace/.worktrees/${taskId}`, branch: `claude/task-${taskId}`,
      baseCommit: BASE, commit: HEAD, changedFiles: [{ status: 'A', path: 'index.html' }],
      diff: {
        baseCommit: BASE, headCommit: HEAD, headTree: TREE, commitMessage: 'claude-worker: task (completed)', additions: 3, deletions: 0,
        files: [{ path: 'index.html', status: 'A', additions: 3, deletions: 0, binary: false, sensitive: false }],
        patch: 'diff --git a/index.html b/index.html\n+<h1>hi</h1>\n', patchTruncated: false, omittedFiles: [],
      },
    },
  });
}

describe('Publication requests (Phase E-2A dry-run)', () => {
  let dir: string;
  let config: AppConfig;
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let clock: FakeClock;
  let admin: Record<string, string>;
  let dashboard: Record<string, string>;
  let hermes: Record<string, string>;
  let claude: Record<string, string>;
  let publisher: Record<string, string>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'publications-'));
    config = testConfig({ databasePath: join(dir, 'controller.db') });
    clock = new FakeClock();
    admin = { Authorization: `Bearer ${config.adminToken}` };
    dashboard = { Authorization: `Bearer ${config.dashboardToken}` };
    hermes = { Authorization: `Bearer ${config.delegators[0].token}` };
    claude = { Authorization: `Bearer ${config.workers[0].token}` };
    publisher = { Authorization: `Bearer ${config.publisherToken}` };
    app = await createTestApp(config, clock);
    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const completedTask = async () => {
    const task = (await http.post('/tasks').set(admin).send({ agent: 'claude', projectId: 'sandbox', instruction: 'make a page' }).expect(201)).body;
    await http.post('/internal/workers/claim').set(claude).expect(200);
    await http.post(`/internal/tasks/${task.id}/complete`).set(claude).send({ result: report(task.id) }).expect(200);
    return task.id as string;
  };
  const approve = (id: string) => http.post(`/tasks/${id}/approve`).set(admin).send({ headSha: HEAD }).expect(200);
  const dryRun = (id: string, headSha = HEAD, as = dashboard) =>
    http.post(`/tasks/${id}/publication/dry-run`).set(as).set('X-Approver', 'owner').send({ headSha });

  it('refuses unapproved commits and wrong SHAs', async () => {
    const id = await completedTask();
    expect((await http.get(`/tasks/${id}/publication`).set(admin).expect(200)).body.state).toBe('not_approved');
    expect((await dryRun(id)).status).toBe(409);
    await approve(id);
    expect((await dryRun(id, 'f'.repeat(40))).status).toBe(409);
    expect((await dryRun(id, 'not-a-sha')).status).toBe(400);
    expect((await http.get(`/tasks/${id}/publication`).set(admin).expect(200)).body.state).toBe('approved');
  });

  it('runs the request -> claim -> result cycle and rejects duplicates', async () => {
    const id = await completedTask();
    await approve(id);
    const pub = (await dryRun(id).expect(202)).body;
    expect(pub).toMatchObject({ taskId: id, headSha: HEAD, mode: 'dry-run', status: 'pending', requestedBy: 'dashboard:owner' });
    expect((await dryRun(id)).status).toBe(409); // one in flight per review
    expect((await http.get(`/tasks/${id}/publication`).set(admin)).body.state).toBe('validation_pending');

    const job = (await http.post('/internal/publisher/claim').set(publisher).expect(200)).body.job;
    expect(job.publication).toMatchObject({ id: pub.id, status: 'validating', attempts: 1 });
    expect(job.task).toMatchObject({ id, status: 'completed', agent: 'claude' });
    expect(job.review).toMatchObject({ status: 'approved', headSha: HEAD, baseSha: BASE, headTree: TREE });
    expect(job.reported).toMatchObject({ baseSha: BASE, headSha: HEAD, headTree: TREE, patchRecorded: true, branch: `claude/task-${id}` });
    expect(job.reported.patch).toBeUndefined();
    expect(job.project).toMatchObject({ id: 'sandbox', source: 'local' });
    expect((await http.post('/internal/publisher/claim').set(publisher).expect(200)).body.job).toBeNull();

    const done = (await http.post(`/internal/publisher/publications/${pub.id}/result`).set(publisher)
      .send({ status: 'ready', report: { mode: 'dry-run', gitVerified: true, eligible: true, pushPerformed: false } }).expect(200)).body;
    expect(done).toMatchObject({ status: 'ready', result: { gitVerified: true, pushPerformed: false } });
    // reporting twice is refused
    expect((await http.post(`/internal/publisher/publications/${pub.id}/result`).set(publisher).send({ status: 'failed', report: {} })).status).toBe(409);
    const status = (await http.get(`/tasks/${id}/publication`).set(admin)).body;
    expect(status.state).toBe('ready_to_publish');
    expect(status.history).toHaveLength(1);

    // a new dry-run of the same review is allowed once the previous one finished
    expect((await dryRun(id)).status).toBe(202);
  });

  it('turns a "ready" verdict into failed if the approval changed meanwhile', async () => {
    const id = await completedTask();
    await approve(id);
    const pub = (await dryRun(id).expect(202)).body;
    await http.post('/internal/publisher/claim').set(publisher).expect(200);
    // the branch moved: the approval is invalidated while the publisher is validating
    await http.post(`/internal/tasks/${id}/observed-head`).set(claude).send({ headSha: 'd'.repeat(40) }).expect(200);
    const done = (await http.post(`/internal/publisher/publications/${pub.id}/result`).set(publisher)
      .send({ status: 'ready', report: { gitVerified: true } }).expect(200)).body;
    expect(done.status).toBe('failed');
    expect(done.result.controllerNote).toMatch(/invalidated/);
    expect((await http.get(`/tasks/${id}/publication`).set(admin)).body.state).toBe('not_approved');
  });

  it('re-offers a request whose publisher died, and gives up after 3 attempts', async () => {
    const id = await completedTask();
    await approve(id);
    const pub = (await dryRun(id).expect(202)).body;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = (await http.post('/internal/publisher/claim').set(publisher).expect(200)).body.job;
      expect(job.publication).toMatchObject({ id: pub.id, attempts: attempt });
      expect((await http.post('/internal/publisher/claim').set(publisher)).body.job).toBeNull(); // leased
      clock.advance(6 * 60_000);
    }
    expect((await http.post('/internal/publisher/claim').set(publisher)).body.job).toBeNull();
    const status = (await http.get(`/tasks/${id}/publication`).set(admin)).body;
    expect(status.current).toMatchObject({ status: 'failed', result: { error: expect.stringMatching(/3 attempts/) } });
  });

  it('keeps every other role out', async () => {
    const id = await completedTask();
    await approve(id);
    // Hermes and workers cannot request, read or serve publications
    expect((await dryRun(id, HEAD, hermes)).status).toBe(403);
    expect((await dryRun(id, HEAD, claude)).status).toBe(403);
    expect((await dryRun(id, HEAD, publisher)).status).toBe(403);
    expect((await http.get(`/tasks/${id}/publication`).set(hermes)).status).toBe(403);
    for (const as of [admin, dashboard, hermes, claude]) {
      expect((await http.post('/internal/publisher/claim').set(as)).status).toBe(403);
    }
    // the publisher cannot approve, create tasks, read diffs or act as a worker
    expect((await http.post(`/tasks/${id}/approve`).set(publisher).send({ headSha: HEAD })).status).toBe(403);
    expect((await http.post('/tasks').set(publisher).send({ agent: 'claude', projectId: 'sandbox', instruction: 'x' })).status).toBe(403);
    expect((await http.get(`/tasks/${id}/diff`).set(publisher)).status).toBe(403);
    expect((await http.post('/internal/workers/claim').set(publisher)).status).toBe(403);
    expect((await http.get('/projects').set(publisher)).status).toBe(403);
  });

  it('survives a restart with history and the one-active-request rule intact', async () => {
    const id = await completedTask();
    await approve(id);
    await dryRun(id).expect(202);
    await app.close();
    app = await createTestApp(config, clock);
    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());
    expect((await http.get(`/tasks/${id}/publication`).set(admin)).body.state).toBe('validation_pending');
    expect((await dryRun(id)).status).toBe(409);
  });
});
