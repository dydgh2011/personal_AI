import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './app.js';
import { FakeClock, testConfig } from './helpers.js';

describe('Delegator (Hermes) access', () => {
  const config = testConfig();
  const admin = { Authorization: `Bearer ${config.adminToken}` };
  const claude = { Authorization: `Bearer ${config.workers[0].token}` };
  const hermes = { Authorization: `Bearer ${config.delegators[0].token}` };
  let clock: FakeClock;
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    clock = new FakeClock();
    app = await createTestApp(config, clock);
    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());
  });

  afterEach(() => app.close());

  const submit = (body: object, headers: Record<string, string> = hermes) => http.post('/tasks').set(headers).send(body);
  const sandboxTask = { agent: 'codex', projectId: 'sandbox', instruction: 'Create index.html' };

  it('creates tasks in registered projects and records itself as the creator', async () => {
    const res = await submit(sandboxTask).expect(201);
    expect(res.body).toMatchObject({ agent: 'codex', projectId: 'sandbox', status: 'queued', createdBy: 'delegator:hermes' });
    const claudeTask = await submit({ ...sandboxTask, agent: 'claude' }).expect(201);
    expect(claudeTask.body.agent).toBe('claude');
  });

  it('rejects tasks without a project or in unregistered projects', async () => {
    expect((await submit({ agent: 'claude', instruction: 'x' }).expect(400)).body.message).toMatch(/projectId is required/);
    expect((await submit({ ...sandboxTask, projectId: 'secret-repo' }).expect(400)).body.message).toMatch(/Unknown projectId/);
    expect((await submit({ ...sandboxTask, projectId: '../etc' }).expect(400)).body.message).toEqual(
      expect.arrayContaining([expect.stringMatching(/projectId must be a registered project id/)]),
    );
    expect((await submit({ ...sandboxTask, agent: 'gemini' }).expect(400)).body.message).toEqual(
      expect.arrayContaining([expect.stringMatching(/agent must be one of/)]),
    );
    expect((await submit({ ...sandboxTask, createdBy: 'admin' }).expect(400)).body.message).toEqual(
      expect.arrayContaining([expect.stringMatching(/createdBy should not exist/)]),
    );
  });

  it('only lists, shows and cancels its own tasks', async () => {
    const own = (await submit(sandboxTask).expect(201)).body;
    const adminTask = (await submit(sandboxTask, admin).expect(201)).body;
    expect(adminTask.createdBy).toBe('admin');

    const list = (await http.get('/tasks').set(hermes).expect(200)).body;
    expect(list.items.map((t: { id: string }) => t.id)).toEqual([own.id]);
    expect(list.total).toBe(1);
    expect((await http.get('/tasks').set(admin).expect(200)).body.total).toBe(2);

    await http.get(`/tasks/${own.id}`).set(hermes).expect(200);
    await http.get(`/tasks/${adminTask.id}`).set(hermes).expect(404);
    await http.post(`/tasks/${adminTask.id}/cancel`).set(hermes).expect(404);
    expect((await http.get(`/tasks/${adminTask.id}`).set(admin).expect(200)).body.status).toBe('queued');

    const canceled = (await http.post(`/tasks/${own.id}/cancel`).set(hermes).expect(200)).body;
    expect(canceled.outcome).toBe('canceled');
  });

  it('reports cancel_requested for running tasks until the worker confirms', async () => {
    const own = (await submit({ ...sandboxTask, agent: 'claude' }).expect(201)).body;
    await http.post('/internal/workers/claim').set(claude).expect(200);
    const res = (await http.post(`/tasks/${own.id}/cancel`).set(hermes).expect(200)).body;
    expect(res.outcome).toBe('cancel_requested');
    expect(res.task.status).toBe('cancel_requested');
    expect(res.message).toMatch(/not yet confirmed/);
  });

  it('cannot use worker endpoints, and can read system status', async () => {
    await http.post('/internal/workers/claim').set(hermes).expect(403);
    const own = (await submit(sandboxTask).expect(201)).body;
    await http.post(`/internal/tasks/${own.id}/complete`).set(hermes).send({ result: 'x' }).expect(403);

    const status = (await http.get('/system/status').set(hermes).expect(200)).body;
    expect(status.projects).toEqual(['personal-ai', 'sandbox']);
    expect(status.workers.map((w: { workerId: string }) => w.workerId)).toEqual(['claude-worker', 'codex-worker']);
    const text = JSON.stringify(status);
    for (const token of [config.adminToken, config.delegators[0].token, ...config.workers.map((w) => w.token)]) {
      expect(text).not.toContain(token);
    }
  });

  describe('Idempotency-Key', () => {
    const key = { 'Idempotency-Key': 'hermes-auto-0123456789abcdef' };

    it('returns the original task for a repeated request instead of creating another', async () => {
      const first = await submit(sandboxTask, { ...hermes, ...key }).expect(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      const second = await submit(sandboxTask, { ...hermes, ...key }).expect(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.id).toBe(first.body.id);
      expect((await http.get('/tasks').set(hermes).expect(200)).body.total).toBe(1);
    });

    it('serialises concurrent duplicates into one task', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => submit(sandboxTask, { ...hermes, ...key })));
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    });

    it('rejects reusing a key for a different task, and keys are per creator', async () => {
      const first = (await submit(sandboxTask, { ...hermes, ...key }).expect(201)).body;
      await submit({ ...sandboxTask, instruction: 'something else' }, { ...hermes, ...key }).expect(409);
      const adminSame = (await submit(sandboxTask, { ...admin, ...key }).expect(201)).body;
      expect(adminSame.id).not.toBe(first.id);
    });

    it('creates a new task once the window has passed', async () => {
      const first = (await submit(sandboxTask, { ...hermes, ...key }).expect(201)).body;
      clock.advance((config.idempotencyWindowSeconds + 1) * 1000);
      const later = (await submit(sandboxTask, { ...hermes, ...key }).expect(201)).body;
      expect(later.id).not.toBe(first.id);
    });

    it('validates the key format', async () => {
      await submit(sandboxTask, { ...hermes, 'Idempotency-Key': 'short' }).expect(400);
      await submit(sandboxTask, { ...hermes, 'Idempotency-Key': 'has spaces in it' }).expect(400);
    });
  });
});
