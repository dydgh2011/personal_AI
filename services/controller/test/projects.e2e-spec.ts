import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AppConfig } from '../src/config/app-config.js';
import { createTestApp } from './app.js';
import { FakeGitHub } from './fake-github.js';
import { testConfig } from './helpers.js';

describe('Project registry and GitHub discovery', () => {
  let github: FakeGitHub;
  let config: AppConfig;
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin: Record<string, string>;
  let hermes: Record<string, string>;
  let claude: Record<string, string>;
  let codex: Record<string, string>;

  const boot = async (overrides: Partial<AppConfig> = {}) => {
    config = testConfig({ github: { apiUrl: github.url, tokenFile: null }, ...overrides });
    admin = { Authorization: `Bearer ${config.adminToken}` };
    hermes = { Authorization: `Bearer ${config.delegators[0].token}` };
    claude = { Authorization: `Bearer ${config.workers[0].token}` };
    codex = { Authorization: `Bearer ${config.workers[1].token}` };
    app = await createTestApp(config);
    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());
  };

  beforeEach(async () => {
    github = new FakeGitHub();
    github.add({ id: 1296269, full_name: 'octocat/Hello-World', default_branch: 'master', head: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d' });
    github.add({ id: 2, full_name: 'octocat/Spoon-Knife' });
    github.add({ id: 3, full_name: 'octocat/linguist' });
    github.add({ id: 4, full_name: 'octocat/secret-plans', private: true });
    await github.start();
    await boot();
  });

  afterEach(async () => {
    await app.close();
    await github.stop();
  });

  const registerHello = (body: object = {}) =>
    http.post('/projects').set(admin).send({ id: 'hello-world', source: 'github', fullName: 'octocat/Hello-World', allowedAgents: ['claude'], ...body });

  describe('registry', () => {
    it('keeps the environment projects as enabled local projects', async () => {
      const { items } = (await http.get('/projects').set(admin).expect(200)).body;
      expect(items.map((p: { id: string }) => p.id)).toEqual(['personal-ai', 'sandbox']);
      expect(items[1]).toMatchObject({ source: 'local', enabled: true, allowCodeChanges: true, allowedAgents: ['claude', 'codex'] });
    });

    it('registers a local project and rejects duplicates', async () => {
      const created = await http.post('/projects').set(admin)
        .send({ id: 'notes', source: 'local', allowedAgents: ['codex'], description: 'scratch' }).expect(201);
      expect(created.body).toMatchObject({ id: 'notes', enabled: false, allowCodeChanges: false, defaultBranch: 'main', remoteUrl: null });
      await http.post('/projects').set(admin).send({ id: 'notes', source: 'local', allowedAgents: ['codex'] }).expect(409);
      await http.post('/projects').set(admin).send({ id: 'sandbox', source: 'local', allowedAgents: ['codex'] }).expect(409);
    });

    it('resolves GitHub projects from the API and rejects the same repository twice', async () => {
      const res = await registerHello().expect(201);
      expect(res.body).toMatchObject({
        id: 'hello-world',
        source: 'github',
        githubRepositoryId: 1296269,
        fullName: 'octocat/Hello-World',
        remoteUrl: 'https://github.com/octocat/Hello-World.git',
        defaultBranch: 'master',
        visibility: 'public',
        authMode: 'none',
        enabled: false,
        allowCodeChanges: false,
        syncStatus: 'not_synced',
      });
      // same repository under another id, differently cased
      const dup = await http.post('/projects').set(admin)
        .send({ id: 'hello-again', source: 'github', fullName: 'OCTOCAT/hello-world', allowedAgents: ['claude'] }).expect(409);
      expect(dup.body.message).toMatch(/already registered as "hello-world"/);
    });

    it('validates input and never accepts a client-supplied remote URL or branch for GitHub projects', async () => {
      await http.post('/projects').set(admin).send({ id: '../etc', source: 'local', allowedAgents: ['claude'] }).expect(400);
      await http.post('/projects').set(admin).send({ id: 'x', source: 'local', allowedAgents: ['gemini'] }).expect(400);
      await http.post('/projects').set(admin).send({ id: 'x', source: 'local', allowedAgents: [] }).expect(400);
      await http.post('/projects').set(admin).send({ id: 'x', source: 'github', allowedAgents: ['claude'] }).expect(400);
      await http.post('/projects').set(admin).send({ id: 'x', source: 'github', fullName: 'a/b', allowedAgents: ['claude'],
        remoteUrl: 'https://user:token@github.com/a/b.git' }).expect(400);
      await registerHello({ defaultBranch: 'evil' }).expect(400);
      await http.post('/projects').set(admin).send({ id: 'x', source: 'local', allowedAgents: ['claude'], defaultBranch: '../main' }).expect(400);
    });

    it('reports GitHub failures: private without credentials, rate limit, unreachable', async () => {
      const priv = await http.post('/projects').set(admin)
        .send({ id: 'secret', source: 'github', fullName: 'octocat/secret-plans', allowedAgents: ['claude'] }).expect(404);
      expect(priv.body.message).toMatch(/not visible with the current credentials/);

      github.rateLimited = 1;
      const limited = await registerHello().expect(429);
      expect(limited.body.message).toMatch(/rate limit/);
      expect(limited.body.rateLimit).toMatchObject({ remaining: 0, resetAt: '2030-01-01T00:00:00.000Z' });

      await github.stop();
      await registerHello().expect(503);
    });

    it('updates mutable fields only', async () => {
      await registerHello().expect(201);
      const res = await http.patch('/projects/hello-world').set(admin)
        .send({ enabled: true, allowedAgents: ['claude', 'codex'], description: 'docs' }).expect(200);
      expect(res.body).toMatchObject({ enabled: true, allowedAgents: ['claude', 'codex'], description: 'docs' });
      await http.patch('/projects/hello-world').set(admin).send({ fullName: 'evil/repo' }).expect(400);
      await http.patch('/projects/hello-world').set(admin).send({ id: 'other' }).expect(400);
      await http.patch('/projects/hello-world').set(admin).send({}).expect(400);
      await http.patch('/projects/nope').set(admin).send({ enabled: true }).expect(404);
    });
  });

  describe('permissions', () => {
    it('lets the delegator read enabled projects only, with a reduced view, and never write', async () => {
      await registerHello().expect(201); // disabled
      const { items } = (await http.get('/projects').set(hermes).expect(200)).body;
      expect(items.map((p: { id: string }) => p.id)).toEqual(['personal-ai', 'sandbox']);
      expect(items[0]).not.toHaveProperty('lastSyncError');
      expect(items[0]).not.toHaveProperty('authMode');
      await http.get('/projects/hello-world').set(hermes).expect(404);
      await http.get('/projects/hello-world/status').set(hermes).expect(404);
      await http.get('/projects/sandbox').set(hermes).expect(200);
      await http.post('/projects').set(hermes).send({ id: 'mine', source: 'local', allowedAgents: ['claude'] }).expect(403);
      await http.patch('/projects/sandbox').set(hermes).send({ enabled: false }).expect(403);
      await http.get('/github/repositories?owner=octocat').set(hermes).expect(403);
      await http.get('/projects').set(claude).expect(403);
      await http.get('/projects').expect(401);
    });

    it('gates tasks on enabled projects and allowed agents', async () => {
      await registerHello().expect(201);
      const task = (agent: string, projectId: string, as = hermes) =>
        http.post('/tasks').set(as).send({ agent, projectId, instruction: 'read the README' });
      expect((await task('claude', 'hello-world').expect(400)).body.message).toMatch(/is disabled/);
      expect((await task('claude', 'hello-world', admin).expect(400)).body.message).toMatch(/is disabled/);
      expect((await task('claude', 'unregistered').expect(400)).body.message).toMatch(/Unknown projectId/);
      await http.patch('/projects/hello-world').set(admin).send({ enabled: true }).expect(200);
      expect((await task('codex', 'hello-world').expect(400)).body.message).toMatch(/Agent codex is not allowed/);
      await task('claude', 'hello-world').expect(201);
      await task('codex', 'sandbox').expect(201);
    });

    it('gives each worker only the enabled projects its agent may use', async () => {
      await registerHello({ enabled: true }).expect(201);
      const forClaude = (await http.get('/internal/projects').set(claude).expect(200)).body.items;
      const forCodex = (await http.get('/internal/projects').set(codex).expect(200)).body.items;
      expect(forClaude.map((p: { id: string }) => p.id)).toEqual(['hello-world', 'personal-ai', 'sandbox']);
      expect(forCodex.map((p: { id: string }) => p.id)).toEqual(['personal-ai', 'sandbox']);
      expect(forClaude[0]).toEqual({
        id: 'hello-world', source: 'github', defaultBranch: 'master', allowCodeChanges: false, cachedHeadSha: null,
        syncStatus: 'not_synced',
        commitStyle: { mode: 'off', guide: null },
        agentInstructions: { rules: '', forbiddenPaths: [] },
      });
      await http.get('/internal/projects').set(hermes).expect(403);
    });

    it('system status lists enabled projects from the registry', async () => {
      await registerHello({ enabled: true }).expect(201);
      expect((await http.get('/system/status').set(hermes).expect(200)).body.projects).toEqual(['hello-world', 'personal-ai', 'sandbox']);
    });
  });

  describe('agent settings (ROADMAP 11, 12)', () => {
    const settings = {
      commitAuthor: { name: 'Dev Owner', email: 'owner@example.com' },
      commitStyle: { mode: 'manual', guide: 'Conventional Commits, lowercase, no period.' },
      agentInstructions: { rules: 'Use TypeScript strict mode.\r\nNo new dependencies.', forbiddenPaths: ['secrets/', '*.pem', 'config/prod/**'] },
    };

    it('starts empty, is set by the admin, and reaches workers without the commit author', async () => {
      const created = (await registerHello({ enabled: true }).expect(201)).body;
      expect(created).toMatchObject({ commitAuthor: null, commitStyle: { mode: 'off', guide: null }, agentInstructions: { rules: '', forbiddenPaths: [] } });

      const updated = (await http.patch('/projects/hello-world').set(admin).send(settings).expect(200)).body;
      expect(updated).toMatchObject({
        commitAuthor: { name: 'Dev Owner', email: 'owner@example.com' },
        commitStyle: { mode: 'manual', guide: 'Conventional Commits, lowercase, no period.' },
        // CRLF from a browser textarea is normalised
        agentInstructions: { rules: 'Use TypeScript strict mode.\nNo new dependencies.', forbiddenPaths: ['secrets/', '*.pem', 'config/prod/**'] },
      });
      expect((await http.get('/projects/hello-world').set(admin).expect(200)).body).toMatchObject({ commitAuthor: settings.commitAuthor });

      const forClaude = (await http.get('/internal/projects').set(claude).expect(200)).body.items[0];
      expect(forClaude.commitStyle).toEqual({ mode: 'manual', guide: 'Conventional Commits, lowercase, no period.' });
      expect(forClaude.agentInstructions.forbiddenPaths).toEqual(['secrets/', '*.pem', 'config/prod/**']);
      expect(forClaude).not.toHaveProperty('commitAuthor');
      expect(JSON.stringify(forClaude)).not.toContain('owner@example.com');

      const forHermes = (await http.get('/projects/hello-world').set(hermes).expect(200)).body;
      for (const key of ['commitAuthor', 'commitStyle', 'agentInstructions']) expect(forHermes).not.toHaveProperty(key);
      expect(JSON.stringify((await http.get('/projects').set(hermes).expect(200)).body)).not.toContain('owner@example.com');

      // other settings are untouched; null clears only the author
      const cleared = (await http.patch('/projects/hello-world').set(admin).send({ commitAuthor: null }).expect(200)).body;
      expect(cleared.commitAuthor).toBeNull();
      expect(cleared.commitStyle.mode).toBe('manual');
      expect(cleared.agentInstructions.forbiddenPaths).toHaveLength(3);
      const auto = (await http.patch('/projects/hello-world').set(admin).send({ commitStyle: { mode: 'auto' } }).expect(200)).body;
      expect(auto.commitStyle).toEqual({ mode: 'auto', guide: null });
    });

    it('only the admin may change them', async () => {
      await registerHello({ enabled: true }).expect(201);
      await http.patch('/projects/hello-world').set(hermes).send(settings).expect(403);
      await http.patch('/projects/hello-world').set(claude).send(settings).expect(403);
      await http.patch('/projects/hello-world').send(settings).expect(401);
    });

    it.each([
      ['manual style without a guide', { commitStyle: { mode: 'manual', guide: '   ' } }],
      ['unknown style mode', { commitStyle: { mode: 'mimic' } }],
      ['style set to null', { commitStyle: null }],
      ['instructions set to null', { agentInstructions: null }],
      ['guide too long', { commitStyle: { mode: 'manual', guide: 'x'.repeat(1001) } }],
      ['control characters in rules', { agentInstructions: { rules: 'a\u0007b', forbiddenPaths: [] } }],
      ['rules too long', { agentInstructions: { rules: 'x'.repeat(4001), forbiddenPaths: [] } }],
      ['too many forbidden paths', { agentInstructions: { rules: '', forbiddenPaths: Array.from({ length: 51 }, (_, i) => `p${i}`) } }],
      ['absolute forbidden path', { agentInstructions: { rules: '', forbiddenPaths: ['/etc/passwd'] } }],
      ['".." forbidden path', { agentInstructions: { rules: '', forbiddenPaths: ['../outside'] } }],
      ['"." segment', { agentInstructions: { rules: '', forbiddenPaths: ['a/./b'] } }],
      ['backslash path', { agentInstructions: { rules: '', forbiddenPaths: ['a\\b'] } }],
      ['empty path', { agentInstructions: { rules: '', forbiddenPaths: [''] } }],
      ['duplicate paths', { agentInstructions: { rules: '', forbiddenPaths: ['a/', 'a/'] } }],
      ['missing forbiddenPaths', { agentInstructions: { rules: 'x' } }],
      ['unknown nested field', { agentInstructions: { rules: '', forbiddenPaths: [], allowedPaths: ['x'] } }],
      ['author name with <>', { commitAuthor: { name: 'A <b>', email: 'a@example.com' } }],
      ['author name with newline', { commitAuthor: { name: 'A\nB', email: 'a@example.com' } }],
      ['author email invalid', { commitAuthor: { name: 'A', email: 'not an email' } }],
      ['author email with >', { commitAuthor: { name: 'A', email: 'a>@example.com' } }],
    ])('rejects %s', async (_label, body) => {
      await registerHello().expect(201);
      const before = (await http.get('/projects/hello-world').set(admin).expect(200)).body;
      await http.patch('/projects/hello-world').set(admin).send(body).expect(400);
      expect((await http.get('/projects/hello-world').set(admin).expect(200)).body).toEqual(before);
    });
  });

  describe('status', () => {
    it('compares the remote default branch with the cached commit', async () => {
      await registerHello({ enabled: true }).expect(201);
      let status = (await http.get('/projects/hello-world/status').set(admin).expect(200)).body;
      expect(status.remote).toMatchObject({
        reachable: true, defaultBranch: 'master', headSha: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d', cacheUpToDate: null,
      });
      expect(status.sync.status).toBe('not_synced');

      await http.patch('/projects/hello-world').set(admin).send({
        syncStatus: 'synced', lastFetchedAt: '2026-10-24T10:00:00.000Z', cachedHeadSha: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d',
      }).expect(200);
      status = (await http.get('/projects/hello-world/status').set(hermes).expect(200)).body;
      expect(status.remote.cacheUpToDate).toBe(true);
      expect(status.sync).toMatchObject({ status: 'synced', cachedHeadSha: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d' });

      // results are cached for 60 s; ?refresh=true asks GitHub again
      github.repos.get('octocat/hello-world')!.head = 'b'.repeat(40);
      expect((await http.get('/projects/hello-world/status').set(admin).expect(200)).body.remote.cacheUpToDate).toBe(true);
      expect((await http.get('/projects/hello-world/status?refresh=true').set(admin).expect(200)).body.remote.cacheUpToDate).toBe(false);
    });

    it('reports an unreachable remote instead of failing, and local projects have no remote', async () => {
      await registerHello({ enabled: true }).expect(201);
      await github.stop();
      const status = (await http.get('/projects/hello-world/status?refresh=true').set(admin).expect(200)).body;
      expect(status.remote).toMatchObject({ reachable: false, headSha: null });
      expect((await http.get('/projects/sandbox/status').set(hermes).expect(200)).body).toMatchObject({ remote: null, acceptsTasks: true });
    });
  });

  describe('GitHub discovery', () => {
    it('follows pagination and marks registered repositories', async () => {
      await registerHello().expect(201);
      const res = (await http.get('/github/repositories?owner=octocat').set(admin).expect(200)).body;
      expect(res).toMatchObject({ authMode: 'none', complete: false, pages: 2, truncated: false });
      expect(res.note).toMatch(/public repositories only/);
      expect(res.repositories.map((r: { fullName: string }) => r.fullName).sort()).toEqual(['octocat/Hello-World', 'octocat/Spoon-Knife', 'octocat/linguist']);
      expect(res.repositories.find((r: { fullName: string }) => r.fullName === 'octocat/Hello-World').registeredProjectId).toBe('hello-world');
      expect(res.rateLimit).toMatchObject({ limit: 60, remaining: 59 });
    });

    it('needs an owner without credentials and rejects bad owners', async () => {
      expect((await http.get('/github/repositories').set(admin).expect(400)).body.message).toMatch(/No GitHub credentials/);
      await http.get('/github/repositories?owner=../../etc').set(admin).expect(400);
      await http.get('/github/repositories?owner=a&org=b').set(admin).expect(400);
    });

    it('waits out a short Retry-After once, then fails on a persistent rate limit', async () => {
      github.rateLimited = 1;
      github.retryAfterSeconds = 1;
      await http.get('/github/repositories?owner=octocat').set(admin).expect(200);
      github.rateLimited = 5;
      github.retryAfterSeconds = 3600;
      await http.get('/github/repositories?owner=octocat').set(admin).expect(429);
    });
  });

  describe('credentials', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'gh-token-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('uses a token file for GitHub only, and never returns or stores the token', async () => {
      const token = 'github_pat_' + 'Z'.repeat(40);
      writeFileSync(join(dir, 'token'), `${token}\n`);
      await app.close();
      await boot({ github: { apiUrl: github.url, tokenFile: join(dir, 'token') } });

      const res = await http.post('/projects').set(admin)
        .send({ id: 'secret', source: 'github', fullName: 'octocat/secret-plans', allowedAgents: ['claude'] }).expect(201);
      expect(res.body).toMatchObject({ visibility: 'private', authMode: 'token', remoteUrl: 'https://github.com/octocat/secret-plans.git' });
      const listed = await http.get('/github/repositories').set(admin).expect(200);
      expect(listed.body.authMode).toBe('token');
      expect(listed.body.repositories).toHaveLength(4);
      const status = await http.get('/projects/secret/status').set(admin).expect(200);

      expect(github.requests.every((r) => r.authorization === `Bearer ${token}`)).toBe(true);
      for (const body of [res.text, listed.text, status.text, (await http.get('/projects').set(admin)).text]) {
        expect(body).not.toContain(token);
      }
    });

    it('refuses to start with an unreadable token file', async () => {
      await app.close();
      await expect(boot({ github: { apiUrl: github.url, tokenFile: join(dir, 'missing') } })).rejects.toThrow(/cannot be read/);
      await boot();
    });
  });
});
