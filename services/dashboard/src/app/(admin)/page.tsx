import { AutoRefresh } from '@/components/client';
import { Badge, Card, errorText, Unavailable } from '@/components/ui';
import { controller } from '@/lib/controller';
import { short, since } from '@/lib/diff';
import { workerState } from '@/lib/report';
import type { Review, SystemStatus, TaskList } from '@/lib/types';
import { resourceProvider } from '@/modules/resources';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

export default async function Overview() {
  await requireSession();
  const [status, recent, awaiting, resources] = await Promise.all([
    settle(controller.systemStatus()),
    settle<TaskList>(controller.tasks({ limit: '10' })),
    settle<Review[]>(controller.reviews('awaiting_approval')),
    resourceProvider ? settle(resourceProvider.sample()) : Promise.resolve(null),
  ]);
  const s: SystemStatus | null = status.ok ? status.value.data : null;
  const hermes = s?.services.find((x) => x.name === 'hermes');
  const by = s?.tasks.byStatus;
  const count = (k: string) => (by ? String(by[k] ?? 0) : 'unknown');

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Overview</h1>
        <AutoRefresh seconds={10} />
      </div>
      {!status.ok && <Unavailable what="Controller" reason={status.error} />}

      <div className="grid">
        <Card title="Controller">
          <Badge value={s ? s.controller.status : 'unreachable'} />{' '}
          <span className="muted">db</span> <Badge value={s?.database.status} />
          <div className="muted">
            {status.ok ? `${status.value.ms} ms · v${s!.controller.version} · up ${Math.round(s!.controller.uptimeSeconds / 60)} min` : 'response time unknown'}
          </div>
        </Card>
        <Card title="Hermes">
          <Badge value={hermes?.status ?? 'unknown'} />
          <div className="muted">
            {hermes?.latencyMs !== undefined ? `${hermes.latencyMs} ms (probed by controller)` : hermes?.error ?? 'not probed'}
          </div>
        </Card>
        {(s?.workers ?? [{ agent: 'claude' }, { agent: 'codex' }]).map((w) => {
          const worker = 'workerId' in w ? w : null;
          return (
            <Card key={w.agent} title={`${w.agent} worker`}>
              <Badge value={worker ? workerState(worker.lastSeenAt) : 'unknown'} />
              <div className="muted">
                {worker ? `last poll ${since(worker.lastSeenAt)} · queued ${worker.queuedTasks} · active ${worker.activeTasks}` : 'status unknown'}
              </div>
            </Card>
          );
        })}
      </div>

      <div className="grid section">
        <Card title="Running"><div className="big">{count('running')}</div></Card>
        <Card title="Queued"><div className="big">{count('queued')}</div></Card>
        <Card title="Completed"><div className="big">{count('completed')}</div></Card>
        <Card title="Failed"><div className="big">{count('failed')}</div></Card>
        <Card title="Awaiting approval">
          <div className="big">{awaiting.ok ? <a href="/reviews">{awaiting.value.length}</a> : 'unknown'}</div>
          {!awaiting.ok && <div className="muted">{awaiting.error}</div>}
        </Card>
      </div>

      <div className="section">
        <h2>Recent tasks</h2>
        {recent.ok ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Task</th><th>Agent</th><th>Project</th><th>Status</th><th>Created</th><th>Instruction</th></tr>
              </thead>
              <tbody>
                {recent.value.items.map((t) => (
                  <tr key={t.id}>
                    <td className="mono"><a href={`/tasks/${t.id}`}>{short(t.id, 8)}</a></td>
                    <td>{t.agent}</td>
                    <td>{t.projectId ?? '-'}</td>
                    <td><Badge value={t.status} /></td>
                    <td>{since(t.createdAt)}</td>
                    <td className="trunc">{t.instruction}</td>
                  </tr>
                ))}
                {recent.value.items.length === 0 && <tr><td colSpan={6} className="muted">No tasks</td></tr>}
              </tbody>
            </table>
          </div>
        ) : (
          <Unavailable what="Task list" reason={recent.error} />
        )}
      </div>

      <div className="section">
        <h2>Host resources</h2>
        <div className="card muted">
          {resources === null
            ? 'CPU / RAM / GPU / disk: not collected (reserved for the Server Monitoring module).'
            : resources.ok
              ? resources.value.map((r) => `${r.label}: ${r.value}`).join(' · ')
              : `unavailable: ${resources.error}`}
        </div>
      </div>
    </>
  );
}
