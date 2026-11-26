import { AutoRefresh } from '@/components/client';
import { Badge, Card, errorText, Unavailable } from '@/components/ui';
import type { Dict } from '@/i18n';
import { getT } from '@/i18n/server';
import { controller } from '@/lib/controller';
import { short, since } from '@/lib/diff';
import { workerState } from '@/lib/report';
import type { Review, SystemStatus, TaskList } from '@/lib/types';
import { resourceProvider } from '@/modules/resources';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

async function settle<T>(p: Promise<T>, t: Dict): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error: errorText(error, t) };
  }
}

export default async function Overview() {
  await requireSession();
  const t = await getT();
  const o = t.overview;
  const [status, recent, awaiting, resources] = await Promise.all([
    settle(controller.systemStatus(), t),
    settle<TaskList>(controller.tasks({ limit: '10' }), t),
    settle<Review[]>(controller.reviews('awaiting_approval'), t),
    resourceProvider ? settle(resourceProvider.sample(), t) : Promise.resolve(null),
  ]);
  const s: SystemStatus | null = status.ok ? status.value.data : null;
  const hermes = s?.services.find((x) => x.name === 'hermes');
  const by = s?.tasks.byStatus;
  const count = (k: string) => (by ? String(by[k] ?? 0) : t.common.unknown);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{o.title}</h1>
        <AutoRefresh seconds={10} />
      </div>
      {!status.ok && <Unavailable t={t} what={o.controller} reason={status.error} />}

      <div className="grid">
        <Card title={o.controller}>
          <Badge value={s ? s.controller.status : 'unreachable'} />{' '}
          <span className="muted">{o.db}</span> <Badge value={s?.database.status} />
          <div className="muted">
            {status.ok ? o.controllerLine(status.value.ms, s!.controller.version, Math.round(s!.controller.uptimeSeconds / 60)) : o.responseUnknown}
          </div>
        </Card>
        <Card title="Hermes">
          <Badge value={hermes?.status ?? 'unknown'} />
          <div className="muted">
            {hermes?.latencyMs !== undefined ? o.hermesProbed(hermes.latencyMs) : hermes?.error ?? o.notProbed}
          </div>
        </Card>
        {(s?.workers ?? [{ agent: 'claude' }, { agent: 'codex' }]).map((w) => {
          const worker = 'workerId' in w ? w : null;
          return (
            <Card key={w.agent} title={o.worker(w.agent)}>
              <Badge value={worker ? workerState(worker.lastSeenAt) : 'unknown'} />
              <div className="muted">
                {worker ? o.workerLine(since(worker.lastSeenAt, t), worker.queuedTasks, worker.activeTasks) : o.statusUnknown}
              </div>
            </Card>
          );
        })}
      </div>

      <div className="grid section">
        <Card title={o.running}><div className="big">{count('running')}</div></Card>
        <Card title={o.queued}><div className="big">{count('queued')}</div></Card>
        <Card title={o.completed}><div className="big">{count('completed')}</div></Card>
        <Card title={o.failed}><div className="big">{count('failed')}</div></Card>
        <Card title={o.awaitingApproval}>
          <div className="big">{awaiting.ok ? <a href="/reviews">{awaiting.value.length}</a> : t.common.unknown}</div>
          {!awaiting.ok && <div className="muted">{awaiting.error}</div>}
        </Card>
      </div>

      <div className="section">
        <h2>{o.recentTasks}</h2>
        {recent.ok ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>{t.common.task}</th><th>{t.common.agent}</th><th>{t.common.project}</th><th>{t.common.status}</th><th>{t.common.created}</th><th>{t.common.instruction}</th></tr>
              </thead>
              <tbody>
                {recent.value.items.map((task) => (
                  <tr key={task.id}>
                    <td className="mono"><a href={`/tasks/${task.id}`}>{short(task.id, 8)}</a></td>
                    <td>{task.agent}</td>
                    <td>{task.projectId ?? '-'}</td>
                    <td><Badge value={task.status} /></td>
                    <td>{since(task.createdAt, t)}</td>
                    <td className="trunc">{task.instruction}</td>
                  </tr>
                ))}
                {recent.value.items.length === 0 && <tr><td colSpan={6} className="muted">{o.noTasks}</td></tr>}
              </tbody>
            </table>
          </div>
        ) : (
          <Unavailable t={t} what={o.taskList} reason={recent.error} />
        )}
      </div>

      <div className="section">
        <h2>{o.hostResources}</h2>
        <div className="card muted">
          {resources === null
            ? o.notCollected
            : resources.ok
              ? resources.value.map((r) => `${r.label}: ${r.value}`).join(' · ')
              : o.resourcesUnavailable(resources.error)}
        </div>
      </div>
    </>
  );
}
