import type { INestApplication } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { SQLITE_CONNECTION } from '../src/database/database.module.js';
import { createTestApp, FakeClock, randomToken, testConfig } from './helpers.js';

const start = '2026-11-24';
const clock = new FakeClock(new Date('2026-11-24T14:00:00Z'));
const windows = [{ weekday: 2, start: '10:00', end: '12:00' }, { weekday: 3, start: '10:00', end: '12:00' }];

describe('Learning L3 HTTP API', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let owner: Record<string, string>;
  let broker: Record<string, string>;
  let planner: ReturnType<typeof createServer>;
  let writes: unknown[];
  let reserved: Array<{ key: string; minutes: number }>;

  beforeEach(async () => {
    const key = randomToken();
    writes = [];
    reserved = [];
    planner = createServer((req, res) => {
      if (req.headers['x-planner-key'] !== key) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/learning/availability?')) {
        res.end(JSON.stringify({ timeZone: 'America/Toronto', calendarConnected: true, reserved, days: [{ date: start, busy: [{ start: 630, end: 660 }] }] }));
      } else if (req.method === 'POST' && req.url === '/learning/proposals') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          writes.push(JSON.parse(Buffer.concat(chunks).toString()));
          res.end(JSON.stringify({ proposal: { code: 'A', title: 'Study', status: 'draft' } }));
        });
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => planner.listen(0, '127.0.0.1', resolve));
    const config = testConfig({ brokerKey: randomToken(), planner: { url: `http://127.0.0.1:${(planner.address() as AddressInfo).port}`, key } });
    owner = { Authorization: `Bearer ${config.dashboardToken}`, 'X-Approver': 'owner' };
    broker = { 'X-Learning-Key': config.brokerKey! };
    app = await createTestApp(config, clock);
    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());
  });

  afterEach(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => planner.close((error) => error ? reject(error) : resolve()));
  });

  async function seedAssignment(status = 'available') {
    const domain = (await http.post('/domains').set(owner).send({ title: 'Mathematics', status: 'active' }).expect(201)).body;
    const goal = (await http.post('/goals').set(owner).send({ domainId: domain.id, title: 'Calculus' }).expect(201)).body;
    const roadmap = (await http.post('/roadmaps').set(owner).send({ goalId: goal.id, title: 'Calculus roadmap' }).expect(201)).body;
    const milestone = (await http.post('/milestones').set(owner).send({ roadmapId: roadmap.id, title: 'Derivatives', fixedDeadline: '2026-11-23' }).expect(201)).body;
    const assignment = (await http.post('/assignments').set(owner).send({ milestoneId: milestone.id, title: 'Slope exercise', kind: 'text', instructions: 'Explain the method', status }).expect(201)).body;
    return { assignment, milestone, roadmap };
  }

  it('uses separate broker permissions and only sends a planner draft with the existing deadline', async () => {
    const { assignment, milestone, roadmap } = await seedAssignment();
    await http.patch('/schedule/availability').set(owner).send({ windows }).expect(200);
    await http.get('/schedule').expect(401);
    await http.get('/domains').set(broker).expect(200);
    await http.get('/roadmaps').set(broker).expect(200);
    await http.get(`/roadmaps/${roadmap.id}`).set(broker).expect(200);
    await http.get('/status').set(broker).expect(403);
    await http.get('/export').set(broker).expect(403);
    await http.get('/assignments').set(broker).expect(403);
    await http.get('/schedule/status').set(broker).expect(200, { date: start, timeZone: 'America/Toronto', assignmentsOpen: 1, assignmentsOverdue: 1, reviewsDue: 0 });
    expect((await http.get('/schedule').set(broker).expect(200)).body.remaining).toMatchObject([{ id: assignment.id, remainingMinutes: 30 }]);
    await http.post('/domains').set(broker).send({ title: 'Should fail' }).expect(403);
    await http.patch('/schedule/availability').set(broker).send({ windows: [] }).expect(403);
    await http.get('/schedule?period=month').set(broker).expect(400);
    await http.post('/schedule/propose').set(broker).send({ period: 'week', approve: true }).expect(400);
    const scheduled = await http.post('/schedule/propose').set({ ...broker, 'X-Approver': 'spoof' }).send({ period: 'week' }).expect(201);
    expect(scheduled.body.proposal).toMatchObject({ code: 'A', status: 'draft' });
    expect(writes).toMatchObject([{ date: start, period: 'week', items: [
      { date: start, start: '11:10', end: '11:40', task: { key: `assignment:${assignment.id}`, deadline: '2026-11-23' } },
      { date: '2026-11-25', start: '10:00', end: '10:30' },
    ] }]);
    expect((await http.get(`/milestones/${milestone.id}`).set(owner).expect(200)).body.deadline.fixed).toBe('2026-11-23');
    reserved = [{ key: `assignment:${assignment.id}`, minutes: 60 }];
    expect((await http.get('/schedule?period=week').set(owner).expect(200)).body.days.every((day: { blocks: unknown[] }) => day.blocks.length === 0)).toBe(true);
    await http.post('/schedule/propose').set(owner).send({ period: 'week' }).expect(409);
  });

  it('only schedules verified skills and preserves new and old JSON export formats', async () => {
    const db = app.get<Database>(SQLITE_CONNECTION);
    const verified = (await http.post('/skills').set(owner).send({ name: 'Proven technique' }).expect(201)).body;
    const selfOnly = (await http.post('/skills').set(owner).send({ name: 'Self rated only' }).expect(201)).body;
    db.prepare('INSERT INTO skill_mastery (skill_id, verified_level, verified_at, updated_at) VALUES (?, 3, ?, ?)').run(verified.id, '2026-01-01T02:00:00Z', '2026-01-01T02:00:00Z');
    await http.post(`/skills/${selfOnly.id}/self-assessment`).set(owner).send({ level: 4 }).expect(201);
    const invalid = [{ weekday: 2, start: '12:00', end: '09:00' }];
    await http.patch('/schedule/availability').set(owner).send({ windows: invalid }).expect(422);
    await http.patch('/schedule/availability').set(owner).send({ windows: [] }).expect(200, { isDefault: false, windows: [] });
    const plan = (await http.get('/schedule').set(owner).expect(200)).body;
    expect(plan.reviews).toMatchObject([{ id: verified.id, method: 'revalidate', verifiedDate: '2025-12-31', dueDate: '2026-02-14' }]);
    expect(plan.remaining).toMatchObject([{ id: verified.id, kind: 'review', remainingMinutes: 60 }]);
    const exported = (await http.get('/export').set(owner).expect(200)).body;
    expect(exported).toMatchObject({ schemaVersion: 3, scheduleWindows: [] });

    const imported = await createTestApp(testConfig({ dashboardToken: owner.Authorization.slice(7) }), clock);
    try {
      const target = request(imported.getHttpServer());
      await target.post('/import').set(owner).send(exported).expect(200);
      await target.get('/schedule/availability').set(owner).expect(200, { isDefault: false, windows: [] });
    } finally {
      await imported.close();
    }
  });
});
