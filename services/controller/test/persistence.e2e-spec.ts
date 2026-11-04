import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createTestApp } from './app.js';
import { testConfig } from './helpers.js';

describe('persistence across restarts', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'controller-e2e-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps tasks and their state after the app is recreated', async () => {
    const config = testConfig({ databasePath: join(dir, 'nested', 'controller.db') });
    const admin = { Authorization: `Bearer ${config.adminToken}` };
    const claude = { Authorization: `Bearer ${config.workers[0].token}` };

    const first = await createTestApp(config);
    const created = await request(first.getHttpServer())
      .post('/tasks')
      .set(admin)
      .send({ agent: 'claude', instruction: 'survive a restart' })
      .expect(201);
    await request(first.getHttpServer()).post('/internal/workers/claim').set(claude).expect(200);
    await first.close();

    const second = await createTestApp(config);
    try {
      const fetched = await request(second.getHttpServer()).get(`/tasks/${created.body.id}`).set(admin).expect(200);
      expect(fetched.body).toMatchObject({
        instruction: 'survive a restart',
        status: 'running',
        claimedBy: 'claude-worker',
      });
      // The claimed task stays claimed: a restart must not hand it out again.
      expect((await request(second.getHttpServer()).post('/internal/workers/claim').set(claude)).body).toEqual({
        task: null,
      });
    } finally {
      await second.close();
    }
  });

  it("keeps registered projects and admin changes after a restart, without re-applying the environment", async () => {
    const config = testConfig({ databasePath: join(dir, "controller.db") });
    const admin = { Authorization: `Bearer ${config.adminToken}` };
    const first = await createTestApp(config);
    await request(first.getHttpServer()).post("/projects").set(admin)
      .send({ id: "notes", source: "local", allowedAgents: ["codex"], enabled: true }).expect(201);
    await request(first.getHttpServer()).patch("/projects/personal-ai").set(admin).send({ enabled: false }).expect(200);
    await first.close();

    const second = await createTestApp(config);
    try {
      const { items } = (await request(second.getHttpServer()).get("/projects").set(admin).expect(200)).body;
      expect(items.map((p: { id: string; enabled: boolean }) => [p.id, p.enabled])).toEqual([
        ["notes", true], ["personal-ai", false], ["sandbox", true],
      ]);
    } finally {
      await second.close();
    }
  });
});
