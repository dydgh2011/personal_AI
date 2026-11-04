import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../../test/app.js';
import { FakeClock, testConfig } from '../../test/helpers.js';
import type { WorkerPrincipal } from '../auth/principal.js';
import { TasksService } from './tasks.service.js';

const claudeWorker: WorkerPrincipal = { role: 'worker', agent: 'claude', workerId: 'claude-worker' };
const codexWorker: WorkerPrincipal = { role: 'worker', agent: 'codex', workerId: 'codex-worker' };

describe('TasksService', () => {
  let app: INestApplication;
  let tasks: TasksService;
  let clock: FakeClock;

  beforeEach(async () => {
    clock = new FakeClock();
    app = await createTestApp(testConfig({ leaseSeconds: 600 }), clock);
    tasks = app.get(TasksService);
  });

  afterEach(() => app.close());

  const queue = (agent: 'claude' | 'codex' = 'claude') => tasks.create({ agent, instruction: 'write tests' });

  it('creates queued tasks and rejects unregistered projects', async () => {
    const task = await queue();
    expect(task).toMatchObject({ status: 'queued', projectId: null, attempt: 0, createdAt: clock.now().toISOString() });
    expect((await tasks.create({ agent: 'codex', projectId: 'sandbox', instruction: 'x' })).projectId).toBe('sandbox');
    await expect(tasks.create({ agent: 'codex', projectId: 'unknown', instruction: 'x' })).rejects.toThrow(
      /Unknown projectId/,
    );
  });

  it('sets and renews the lease from the configured duration', async () => {
    const { id } = await queue();
    const claimed = await tasks.claimNext(claudeWorker);
    expect(claimed?.leaseExpiresAt).toBe('2026-01-01T00:10:00.000Z');

    clock.advance(5 * 60_000);
    const renewed = await tasks.heartbeat(claudeWorker, id);
    expect(renewed.leaseExpiresAt).toBe('2026-01-01T00:15:00.000Z');
    expect(renewed.status).toBe('running');
  });

  it('records results and clears the lease on completion', async () => {
    const { id } = await queue();
    await tasks.claimNext(claudeWorker);
    clock.advance(1000);
    const done = await tasks.complete(claudeWorker, id, 'all good');
    expect(done).toMatchObject({
      status: 'completed',
      result: 'all good',
      completedAt: '2026-01-01T00:00:01.000Z',
      leaseExpiresAt: null,
      claimedBy: 'claude-worker',
    });
    await expect(tasks.fail(claudeWorker, id, 'late')).rejects.toThrow(/Cannot fail task .* in status completed/);
  });

  it('hides other agents’ tasks from workers', async () => {
    const { id } = await queue('claude');
    await tasks.claimNext(claudeWorker);
    await expect(tasks.complete(codexWorker, id, 'x')).rejects.toThrow(/not found/);
    expect(await tasks.claimNext(codexWorker)).toBeNull();
  });

  it('rejects reports from a worker that does not hold the claim', async () => {
    const { id } = await queue();
    await tasks.claimNext(claudeWorker);
    const otherClaude: WorkerPrincipal = { ...claudeWorker, workerId: 'claude-worker-2' };
    await expect(tasks.complete(otherClaude, id, 'x')).rejects.toThrow(/not claimed by claude-worker-2/);
  });

  describe('lease expiry', () => {
    const LEASE_MS = 600_000;

    it('rejects every worker report once the lease has run out', async () => {
      const { id } = await queue();
      await tasks.claimNext(claudeWorker);
      clock.advance(LEASE_MS); // exactly at expiry: no longer valid

      await expect(tasks.heartbeat(claudeWorker, id)).rejects.toThrow(/Lease for task .* expired/);
      await expect(tasks.complete(claudeWorker, id, 'late')).rejects.toThrow(/expired/);
      await expect(tasks.fail(claudeWorker, id, 'late')).rejects.toThrow(/expired/);
      expect((await tasks.get(id)).status).toBe('running');
    });

    it('fails expired tasks without re-queuing them, and leaves live leases alone', async () => {
      const stale = await queue();
      await tasks.claimNext(claudeWorker);
      clock.advance(LEASE_MS - 1000);
      const live = await queue();
      await tasks.claimNext(claudeWorker);
      await tasks.cancel(live.id); // cancel_requested tasks expire too, but this one is still live

      clock.advance(1000);
      const expired = await tasks.expireLeases();
      expect(expired.map((t) => t.id)).toEqual([stale.id]);

      const failed = await tasks.get(stale.id);
      expect(failed).toMatchObject({ status: 'failed', leaseExpiresAt: null, claimedBy: 'claude-worker' });
      expect(failed.error).toMatch(/^lease_expired:/);
      expect(await tasks.claimNext(claudeWorker)).toBeNull();
      expect((await tasks.get(live.id)).status).toBe('cancel_requested');

      // A worker that comes back after the sweep is told the task is gone, not "expired".
      await expect(tasks.complete(claudeWorker, stale.id, 'late')).rejects.toThrow(/in status failed/);
      expect(await tasks.expireLeases()).toEqual([]);
    });

    it('keeps a task alive as long as heartbeats renew the lease', async () => {
      const { id } = await queue();
      await tasks.claimNext(claudeWorker);
      for (let i = 0; i < 5; i++) {
        clock.advance(LEASE_MS - 1);
        await tasks.heartbeat(claudeWorker, id);
        expect(await tasks.expireLeases()).toEqual([]);
      }
      expect((await tasks.complete(claudeWorker, id, 'ok')).status).toBe('completed');
    });
  });

  describe('cancel', () => {
    it('cancels a queued task immediately so it is never claimed', async () => {
      const { id } = await queue();
      const result = await tasks.cancel(id);
      expect(result.outcome).toBe('canceled');
      expect(result.task).toMatchObject({ status: 'canceled', completedAt: expect.any(String) });
      expect(await tasks.claimNext(claudeWorker)).toBeNull();
    });

    it('only requests cancellation of a running task, until the worker acknowledges', async () => {
      const { id } = await queue();
      await tasks.claimNext(claudeWorker);

      const requested = await tasks.cancel(id);
      expect(requested.outcome).toBe('cancel_requested');
      expect(requested.task.status).toBe('cancel_requested');
      expect(requested.task.completedAt).toBeNull();
      expect(requested.message).toMatch(/not yet confirmed/);

      const again = await tasks.cancel(id);
      expect(again.outcome).toBe('cancel_already_requested');

      expect((await tasks.heartbeat(claudeWorker, id)).status).toBe('cancel_requested');
      const acknowledged = await tasks.acknowledgeCancel(claudeWorker, id);
      expect(acknowledged).toMatchObject({ status: 'canceled', leaseExpiresAt: null });
    });

    it('keeps the real outcome if the worker finishes before noticing the cancel', async () => {
      const { id } = await queue();
      await tasks.claimNext(claudeWorker);
      await tasks.cancel(id);
      expect((await tasks.complete(claudeWorker, id, 'finished anyway')).status).toBe('completed');
    });

    it('refuses to cancel finished tasks and to acknowledge without a request', async () => {
      const { id } = await queue();
      await tasks.claimNext(claudeWorker);
      await expect(tasks.acknowledgeCancel(claudeWorker, id)).rejects.toThrow(/in status running/);
      await tasks.fail(claudeWorker, id, 'boom');
      await expect(tasks.cancel(id)).rejects.toThrow(/already failed/);
    });
  });
});
