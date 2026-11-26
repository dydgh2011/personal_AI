import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './app.js';
import { FakeClock, testConfig } from './helpers.js';

describe('Model and effort per task (agent defaults)', () => {
  const config = testConfig();
  const admin = { Authorization: `Bearer ${config.adminToken}` };
  const claude = { Authorization: `Bearer ${config.workers[0].token}` };
  const hermes = { Authorization: `Bearer ${config.delegators[0].token}` };
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    app = await createTestApp(config, new FakeClock());
    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());
  });

  afterEach(() => app.close());

  const task = { agent: 'claude', projectId: 'sandbox', instruction: 'Create index.html' };

  it('uses the CLI default until the owner sets one', async () => {
    const list = (await http.get('/agent-defaults').set(hermes).expect(200)).body;
    expect(list.items).toEqual([
      { agent: 'claude', model: null, effort: null, updatedAt: null, updatedBy: null },
      { agent: 'codex', model: null, effort: null, updatedAt: null, updatedBy: null },
    ]);
    expect(list.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    const created = (await http.post('/tasks').set(hermes).send(task).expect(201)).body;
    expect(created).toMatchObject({ model: null, effort: null });
  });

  it('applies the default to new tasks only, and a request overrides it for that task', async () => {
    const before = (await http.post('/tasks').set(hermes).send({ ...task, instruction: 'before' }).expect(201)).body;
    const set = (await http.post('/agent-defaults/claude').set(hermes).send({ model: 'opus', effort: 'high' }).expect(200)).body;
    expect(set).toMatchObject({ agent: 'claude', model: 'opus', effort: 'high', updatedBy: 'delegator:hermes' });

    const after = (await http.post('/tasks').set(hermes).send({ ...task, instruction: 'after' }).expect(201)).body;
    expect(after).toMatchObject({ model: 'opus', effort: 'high' });
    const once = (await http.post('/tasks').set(hermes).send({ ...task, instruction: 'once', effort: 'max' }).expect(201)).body;
    expect(once).toMatchObject({ model: 'opus', effort: 'max' });
    const other = (await http.post('/tasks').set(admin).send({ ...task, instruction: 'x', model: 'claude-sonnet-5-5[1m]' }).expect(201)).body;
    expect(other).toMatchObject({ model: 'claude-sonnet-5-5[1m]', effort: 'high' });
    expect((await http.get(`/tasks/${before.id}`).set(hermes).expect(200)).body).toMatchObject({ model: null, effort: null });

    // Codex keeps its own default; only the given field changes; null goes back to the CLI default.
    expect((await http.post('/tasks').set(hermes).send({ ...task, agent: 'codex', instruction: 'c' }).expect(201)).body.model).toBeNull();
    const effortOnly = (await http.post('/agent-defaults/claude').set(admin).send({ effort: 'low' }).expect(200)).body;
    expect(effortOnly).toMatchObject({ model: 'opus', effort: 'low', updatedBy: 'admin' });
    const cleared = (await http.post('/agent-defaults/claude').set(admin).send({ model: null }).expect(200)).body;
    expect(cleared).toMatchObject({ model: null, effort: 'low' });
  });

  it('hands the stored values to the worker that claims the task', async () => {
    await http.post('/tasks').set(hermes).send({ ...task, model: 'sonnet', effort: 'xhigh' }).expect(201);
    const claimed = (await http.post('/internal/workers/claim').set(claude).expect(200)).body.task;
    expect(claimed).toMatchObject({ model: 'sonnet', effort: 'xhigh' });
  });

  it('rejects bad values', async () => {
    for (const body of [{ model: '--dangerously-skip-permissions' }, { model: 'a b' }, { model: 'x'.repeat(81) }, { effort: 'ultra' }, { effort: 'HIGH' }]) {
      await http.post('/tasks').set(hermes).send({ ...task, ...body }).expect(400);
      await http.post('/agent-defaults/claude').set(hermes).send(body).expect(400);
    }
    await http.post('/agent-defaults/claude').set(hermes).send({}).expect(400);
    await http.post('/agent-defaults/gemini').set(hermes).send({ effort: 'low' }).expect(400);
    await http.post('/agent-defaults/claude').set(hermes).send({ effort: 'low', other: 1 }).expect(400);
    await http.get('/agent-defaults').set(claude).expect(403);
    await http.get('/agent-defaults').expect(401);
  });
});
