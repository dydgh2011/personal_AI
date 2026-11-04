import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './app.js';
import { testConfig } from './helpers.js';

describe('Controller HTTP API', () => {
  const config = testConfig();
  const admin = { Authorization: `Bearer ${config.adminToken}` };
  const claude = { Authorization: `Bearer ${config.workers[0].token}` };
  const codex = { Authorization: `Bearer ${config.workers[1].token}` };
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    app = await createTestApp(config);
    // Listen on a real port so concurrent requests share one server like in production.
    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());
  });

  afterEach(() => app.close());

  const createTask = async (body: object = { agent: 'claude', instruction: 'Add a README' }) => {
    const res = await http.post('/tasks').set(admin).send(body).expect(201);
    return res.body as { id: string; status: string };
  };

  describe('health and status', () => {
    it('serves /health without authentication', async () => {
      const res = await http.get('/health').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('requires the admin token for /system/status', async () => {
      await http.get('/system/status').expect(401);
      await http.get('/system/status').set(claude).expect(403);
      await createTask();
      await http.post('/internal/workers/claim').set(claude).expect(200);

      const res = await http.get('/system/status').set(admin).expect(200);
      expect(res.body.database).toEqual({ status: 'ok' });
      expect(res.body.tasks.total).toBe(1);
      expect(res.body.tasks.byStatus.running).toBe(1);
      expect(res.body.workers).toEqual([
        expect.objectContaining({ agent: 'claude', activeTasks: 1, lastSeenAt: expect.any(String) }),
        expect.objectContaining({ agent: 'codex', activeTasks: 0, lastSeenAt: null }),
      ]);
      expect(JSON.stringify(res.body)).not.toContain(config.adminToken);
    });
  });

  describe('authentication', () => {
    it('rejects task creation without a valid admin token', async () => {
      const body = { agent: 'claude', instruction: 'x' };
      await http.post('/tasks').send(body).expect(401);
      await http.post('/tasks').set({ Authorization: 'Bearer wrong-token' }).send(body).expect(401);
      await http.post('/tasks').set({ Authorization: config.adminToken }).send(body).expect(401);
      await http.post('/tasks').set(claude).send(body).expect(403);
      await http.get('/tasks').expect(401);
      expect((await http.get('/tasks').set(admin).expect(200)).body.total).toBe(0);
    });

    it('rejects the worker API for admin and anonymous callers', async () => {
      await http.post('/internal/workers/claim').expect(401);
      await http.post('/internal/workers/claim').set(admin).expect(403);
    });
  });

  describe('task management', () => {
    it('creates, lists and fetches tasks', async () => {
      const created = await createTask({ agent: 'codex', projectId: 'sandbox', instruction: 'Review PR' });
      expect(created).toMatchObject({ agent: 'codex', projectId: 'sandbox', status: 'queued', result: null });
      await createTask();

      const fetched = await http.get(`/tasks/${created.id}`).set(admin).expect(200);
      expect(fetched.body).toEqual(created);

      const all = await http.get('/tasks').set(admin).expect(200);
      expect(all.body).toMatchObject({ total: 2, limit: 50, offset: 0 });

      const filtered = await http.get('/tasks?agent=codex&status=queued&limit=1').set(admin).expect(200);
      expect(filtered.body.items.map((t: { id: string }) => t.id)).toEqual([created.id]);
    });

    it('validates input', async () => {
      const bad = [
        { agent: 'gpt', instruction: 'x' },
        { agent: 'claude' },
        { agent: 'claude', instruction: '   ' },
        { agent: 'claude', instruction: 'x'.repeat(20_001) },
        { agent: 'claude', instruction: 'x', projectId: '../../etc' },
        { agent: 'claude', instruction: 'x', projectId: 'C:\\Users' },
        { agent: 'claude', instruction: 'x', projectId: 'not-registered' },
        { agent: 'claude', instruction: 'x', status: 'completed' },
      ];
      for (const body of bad) {
        await http.post('/tasks').set(admin).send(body).expect(400);
      }
      await http.get('/tasks?limit=500').set(admin).expect(400);
      await http.get('/tasks?status=bogus').set(admin).expect(400);
      await http.get('/tasks/not-a-uuid').set(admin).expect(400);
      await http.get(`/tasks/${crypto.randomUUID()}`).set(admin).expect(404);
    });

    it('accepts an explicit null projectId', async () => {
      const task = await createTask({ agent: 'claude', instruction: 'x', projectId: null });
      expect(task).toMatchObject({ projectId: null });
    });
  });

  describe('worker claim flow', () => {
    it('gives each worker only its own agent\u2019s tasks', async () => {
      const claudeTask = await createTask({ agent: 'claude', instruction: 'a' });
      const codexTask = await createTask({ agent: 'codex', instruction: 'b' });

      const claimedByCodex = await http.post('/internal/workers/claim').set(codex).expect(200);
      expect(claimedByCodex.body.task).toMatchObject({ id: codexTask.id, status: 'running', claimedBy: 'codex-worker' });

      const claimedByClaude = await http.post('/internal/workers/claim').set(claude).expect(200);
      expect(claimedByClaude.body.task.id).toBe(claudeTask.id);

      expect((await http.post('/internal/workers/claim').set(claude).expect(200)).body).toEqual({ task: null });
    });

    it('never lets two concurrent claims take the same task', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 3; i++) ids.add((await createTask()).id);

      const responses = await Promise.all(
        Array.from({ length: 12 }, () => http.post('/internal/workers/claim').set(claude)),
      );
      const claimed = responses.map((r) => r.body.task?.id).filter(Boolean);

      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(claimed).toHaveLength(3);
      expect(new Set(claimed)).toEqual(ids);
    });

    it('completes and fails tasks with stored results', async () => {
      const ok = await createTask();
      const bad = await createTask();
      await http.post('/internal/workers/claim').set(claude).expect(200);
      await http.post('/internal/workers/claim').set(claude).expect(200);

      await http.post(`/internal/tasks/${ok.id}/complete`).set(claude).send({}).expect(400);
      const completed = await http
        .post(`/internal/tasks/${ok.id}/complete`)
        .set(claude)
        .send({ result: '변경 완료' })
        .expect(200);
      expect(completed.body.task).toMatchObject({ status: 'completed', result: '변경 완료' });

      const failed = await http.post(`/internal/tasks/${bad.id}/fail`).set(claude).send({ error: 'tests failed' }).expect(200);
      expect(failed.body.task).toMatchObject({ status: 'failed', error: 'tests failed' });

      // Terminal tasks cannot be reported on again, and other agents cannot see them.
      await http.post(`/internal/tasks/${ok.id}/fail`).set(claude).send({ error: 'x' }).expect(409);
      await http.post(`/internal/tasks/${ok.id}/complete`).set(codex).send({ result: 'x' }).expect(404);

      const stored = await http.get(`/tasks/${ok.id}`).set(admin).expect(200);
      expect(stored.body).toMatchObject({ status: 'completed', result: '변경 완료' });
    });

    it('cannot complete a task that was never claimed', async () => {
      const task = await createTask();
      await http.post(`/internal/tasks/${task.id}/complete`).set(claude).send({ result: 'x' }).expect(409);
    });
  });

  describe('cancellation', () => {
    it('cancels a queued task before any worker sees it', async () => {
      const task = await createTask();
      const res = await http.post(`/tasks/${task.id}/cancel`).set(admin).expect(200);
      expect(res.body).toMatchObject({ outcome: 'canceled', task: { status: 'canceled' } });
      expect((await http.post('/internal/workers/claim').set(claude)).body).toEqual({ task: null });
      await http.post(`/tasks/${task.id}/cancel`).set(admin).expect(409);
    });

    it('turns a running task into cancel_requested and lets the worker confirm', async () => {
      const task = await createTask();
      await http.post('/internal/workers/claim').set(claude).expect(200);

      const beat = await http.post(`/internal/tasks/${task.id}/heartbeat`).set(claude).expect(200);
      expect(beat.body.cancelRequested).toBe(false);

      const cancel = await http.post(`/tasks/${task.id}/cancel`).set(admin).expect(200);
      expect(cancel.body).toMatchObject({ outcome: 'cancel_requested', task: { status: 'cancel_requested', completedAt: null } });
      expect(cancel.body.message).toMatch(/not yet confirmed/);

      const beatAfter = await http.post(`/internal/tasks/${task.id}/heartbeat`).set(claude).expect(200);
      expect(beatAfter.body.cancelRequested).toBe(true);

      const ack = await http.post(`/internal/tasks/${task.id}/cancel-ack`).set(claude).expect(200);
      expect(ack.body.task.status).toBe('canceled');
      await http.post(`/internal/tasks/${task.id}/heartbeat`).set(claude).expect(409);
    });
  });
});
