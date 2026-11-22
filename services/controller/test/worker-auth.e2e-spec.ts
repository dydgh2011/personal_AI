import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './app.js';
import { FakeClock, testConfig } from './helpers.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const URL1 = 'https://claude.com/cai/oauth/authorize?code=true&state=abc';

describe('Worker login sessions', () => {
  const config = testConfig();
  const admin = { Authorization: `Bearer ${config.adminToken}` };
  const claude = { Authorization: `Bearer ${config.workers[0].token}` };
  const codex = { Authorization: `Bearer ${config.workers[1].token}` };
  const hermes = { Authorization: `Bearer ${config.delegators[0].token}` };
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    app = await createTestApp(config, new FakeClock());
    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());
  });
  afterEach(() => app.close());

  const report = (headers: Record<string, string>, body: object) => http.post('/internal/workers/auth').set(headers).send(body);
  const waiting = { id: S1, status: 'waiting_user', loginUrl: URL1, needsCode: true, expiresAt: '2026-01-01T00:15:00.000Z' };

  it('relays a login: worker reports the URL, Hermes sends the code, the worker gets it exactly once', async () => {
    expect((await http.get('/workers/auth').set(hermes).expect(200)).body.items).toEqual([
      { agent: 'claude', loggedIn: null, checkedAt: null, requested: false, session: null },
      { agent: 'codex', loggedIn: null, checkedAt: null, requested: false, session: null },
    ]);
    expect((await report(claude, { loggedIn: false, session: waiting }).expect(200)).body).toEqual({ requested: false, code: null });

    const view = (await http.get('/workers/auth').set(hermes).expect(200)).body.items[0];
    expect(view).toMatchObject({ agent: 'claude', loggedIn: false, session: { id: S1, status: 'waiting_user', loginUrl: URL1, needsCode: true } });
    expect(JSON.stringify(view)).not.toContain('"code"');

    await http.post('/workers/claude/auth/code').set(hermes).send({ code: 'authcode123#state456' }).expect(200);
    // The worker re-reports "waiting_user" for the same session: that must not lose the code.
    const got = (await report(claude, { loggedIn: false, session: waiting }).expect(200)).body;
    expect(got).toEqual({ requested: false, code: 'authcode123#state456' });
    expect((await report(claude, { loggedIn: false, session: waiting }).expect(200)).body.code).toBeNull();
    expect((await http.get('/workers/auth').set(admin).expect(200)).body.items[0].session.status).toBe('verifying');

    await report(claude, { loggedIn: true, session: { id: S1, status: 'succeeded' } }).expect(200);
    expect((await http.get('/workers/auth').set(hermes).expect(200)).body.items[0]).toMatchObject({ loggedIn: true, session: { status: 'succeeded' } });
  });

  it('refuses codes when nothing waits for one, and for device-code logins', async () => {
    await http.post('/workers/claude/auth/code').set(hermes).send({ code: 'authcode123#state456' }).expect(409);
    await report(codex, { loggedIn: false, session: { id: S2, status: 'waiting_user', loginUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHI', needsCode: false } }).expect(200);
    expect((await http.post('/workers/codex/auth/code').set(hermes).send({ code: 'authcode123' }).expect(409)).body.message).toMatch(/no code needs/);
    await http.post('/workers/gemini/auth/code').set(hermes).send({ code: 'authcode123' }).expect(400);
    await http.post('/workers/claude/auth/code').set(hermes).send({ code: 'has spaces in it' }).expect(400);
  });

  it('lets Hermes request a new login, which the worker sees on its next report', async () => {
    await http.post('/workers/claude/auth/start').set(hermes).expect(200);
    expect((await report(claude, { loggedIn: false }).expect(200)).body.requested).toBe(true);
    await report(claude, { loggedIn: false, session: waiting }).expect(200);
    expect((await report(claude, { loggedIn: false, session: waiting }).expect(200)).body.requested).toBe(false);
    await http.post('/workers/claude/auth/start').set(hermes).expect(409);
  });

  it('counts a worker that waits for its login as online and shows its login state in /system/status', async () => {
    const before = (await http.get('/system/status').set(admin).expect(200)).body.workers;
    expect(before.find((w: { agent: string }) => w.agent === 'codex')).toMatchObject({
      lastSeenAt: null,
      login: { loggedIn: null, sessionStatus: null, requested: false },
    });
    await report(codex, { loggedIn: false, session: { id: S2, status: 'failed', message: 'timed out' } }).expect(200);
    const after = (await http.get('/system/status').set(admin).expect(200)).body.workers;
    const codexStatus = after.find((w: { agent: string }) => w.agent === 'codex');
    expect(codexStatus.lastSeenAt).not.toBeNull();
    expect(codexStatus.login).toEqual({ loggedIn: false, sessionStatus: 'failed', requested: false });
  });

  it('keeps the roles apart: workers report only for their own agent, others cannot report', async () => {
    await report(codex, { loggedIn: false, session: waiting }).expect(200);
    const items = (await http.get('/workers/auth').set(admin).expect(200)).body.items;
    expect(items[0].session).toBeNull();
    expect(items[1].session.id).toBe(S1);
    await report(hermes, { loggedIn: true }).expect(403);
    await http.get('/workers/auth').set(claude).expect(403);
    await report(claude, { loggedIn: false, session: { ...waiting, loginUrl: 'http://evil.example/login' } }).expect(400);
  });
});
