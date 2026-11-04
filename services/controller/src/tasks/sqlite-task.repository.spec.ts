import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../database/sqlite-database.js';
import { SqliteTaskRepository } from './sqlite-task.repository.js';
import type { AgentType, Task } from './task.model.js';

let seq = 0;
function newTask(agent: AgentType, overrides: Partial<Task> = {}): Task {
  // Distinct, ordered timestamps so FIFO order is deterministic.
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)).toISOString();
  return {
    id: crypto.randomUUID(),
    agent,
    projectId: null,
    instruction: `do ${agent} work`,
    status: 'queued',
    result: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    claimedBy: null,
    leaseExpiresAt: null,
    attempt: 0,
    createdBy: 'admin',
    idempotencyKey: null,
    ...overrides,
  };
}

const claimFor = (agent: AgentType, workerId = `${agent}-worker`) => ({
  agent,
  workerId,
  now: '2026-01-02T00:00:00.000Z',
  leaseExpiresAt: '2026-01-02T00:15:00.000Z',
});

describe('SqliteTaskRepository', () => {
  let db: Database;
  let repo: SqliteTaskRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteTaskRepository(db);
  });

  afterEach(() => db.close());

  it('round-trips a task', async () => {
    const task = newTask('claude', { projectId: 'sandbox' });
    expect(await repo.create(task)).toEqual(task);
    expect(await repo.findById(task.id)).toEqual(task);
    expect(await repo.findById(crypto.randomUUID())).toBeNull();
  });

  it('claims the oldest queued task of the requested agent only', async () => {
    const codex = await repo.create(newTask('codex'));
    const first = await repo.create(newTask('claude'));
    const second = await repo.create(newTask('claude'));

    const claimed = await repo.claimNext(claimFor('claude'));
    expect(claimed).toMatchObject({
      id: first.id,
      status: 'running',
      claimedBy: 'claude-worker',
      startedAt: '2026-01-02T00:00:00.000Z',
      leaseExpiresAt: '2026-01-02T00:15:00.000Z',
      attempt: 1,
    });
    expect((await repo.claimNext(claimFor('claude')))?.id).toBe(second.id);
    expect(await repo.claimNext(claimFor('claude'))).toBeNull();
    expect((await repo.claimNext(claimFor('codex')))?.id).toBe(codex.id);
  });

  it('applies conditional updates only when every precondition holds', async () => {
    const task = await repo.create(newTask('claude'));
    await repo.claimNext(claimFor('claude'));
    const patch = { status: 'completed' as const, result: 'done', updatedAt: '2026-01-02T01:00:00.000Z' };

    expect(await repo.update(task.id, { from: ['queued'] }, patch)).toBeNull();
    expect(await repo.update(task.id, { from: ['running'], agent: 'codex' }, patch)).toBeNull();
    expect(await repo.update(task.id, { from: ['running'], claimedBy: 'someone-else' }, patch)).toBeNull();
    expect((await repo.findById(task.id))?.status).toBe('running');

    const updated = await repo.update(task.id, { from: ['running'], agent: 'claude', claimedBy: 'claude-worker' }, patch);
    expect(updated).toMatchObject({ status: 'completed', result: 'done' });
    // A second identical update finds the task no longer running.
    expect(await repo.update(task.id, { from: ['running'] }, patch)).toBeNull();
  });

  it('expires only claimed tasks whose lease is due', async () => {
    const queued = await repo.create(newTask('claude'));
    const running = await repo.create(newTask('codex'));
    await repo.claimNext(claimFor('codex')); // lease 00:15

    const early = await repo.expireLeases({ now: '2026-01-02T00:14:59.999Z', error: 'lease_expired: x' });
    expect(early).toEqual([]);
    const due = await repo.expireLeases({ now: '2026-01-02T00:15:00.000Z', error: 'lease_expired: x' });
    expect(due).toEqual([expect.objectContaining({ id: running.id, status: 'failed', error: 'lease_expired: x' })]);
    expect((await repo.findById(queued.id))?.status).toBe('queued');
  });

  it('honours the lease condition on updates', async () => {
    const task = await repo.create(newTask('claude'));
    await repo.claimNext(claimFor('claude')); // lease 00:15
    const patch = { updatedAt: 'now', leaseExpiresAt: '2026-01-02T00:30:00.000Z' };
    expect(await repo.update(task.id, { from: ['running'], leaseActiveAt: '2026-01-02T00:15:00.000Z' }, patch)).toBeNull();
    expect(await repo.update(task.id, { from: ['running'], leaseActiveAt: '2026-01-02T00:14:00.000Z' }, patch)).not.toBeNull();
  });

  it('filters, pages and counts', async () => {
    for (let i = 0; i < 3; i++) await repo.create(newTask('claude'));
    await repo.create(newTask('codex'));
    await repo.claimNext(claimFor('claude'));

    const page = await repo.list({ agent: 'claude', limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items[0].createdAt > page.items[1].createdAt).toBe(true); // newest first

    expect((await repo.list({ status: 'running', limit: 50, offset: 0 })).total).toBe(1);
    expect(await repo.countByAgentAndStatus()).toEqual(
      expect.arrayContaining([
        { agent: 'claude', status: 'queued', count: 2 },
        { agent: 'claude', status: 'running', count: 1 },
        { agent: 'codex', status: 'queued', count: 1 },
      ]),
    );
  });

  it('rejects invalid values at the schema level', async () => {
    expect(() => db.prepare("INSERT INTO tasks (id, agent, instruction, status, created_at, updated_at) VALUES ('x', 'gpt', 'i', 'queued', 'n', 'n')").run()).toThrow(/CHECK/);
  });

  describe('with two connections to the same file', () => {
    let dir: string;
    let dbA: Database;
    let dbB: Database;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'controller-repo-'));
      dbA = openDatabase(join(dir, 'tasks.db'));
      dbB = openDatabase(join(dir, 'tasks.db'));
    });

    afterEach(() => {
      dbA.close();
      dbB.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('never hands the same task to two claimers', async () => {
      const a = new SqliteTaskRepository(dbA);
      const b = new SqliteTaskRepository(dbB);
      const created = [];
      for (let i = 0; i < 20; i++) created.push((await a.create(newTask('claude'))).id);

      const claimed: string[] = [];
      for (let i = 0; i < 25; i++) {
        const repoForTurn = i % 2 === 0 ? a : b;
        const task = await repoForTurn.claimNext(claimFor('claude', i % 2 === 0 ? 'worker-a' : 'worker-b'));
        if (task) claimed.push(task.id);
      }

      expect(claimed).toHaveLength(20);
      expect(new Set(claimed).size).toBe(20);
      expect(claimed.sort()).toEqual(created.sort());
    });
  });
});
