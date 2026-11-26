import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/client';
import { Badge, CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { controller, ControllerError, UUID } from '@/lib/controller';
import { duration, short, since } from '@/lib/diff';
import { parseReport } from '@/lib/report';
import { requireSession } from '@/lib/server';
import { runLabel } from '@/lib/agent-defaults';
import { getT } from '@/i18n/server';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

const ACTIVE = ['queued', 'running', 'cancel_requested'];

export default async function TaskPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp, session, t] = await Promise.all([params, searchParams, requireSession(), getT()]);
  const k = t.task;
  if (!UUID.test(id)) notFound();
  let task: Task | null = null;
  let error: string | null = null;
  try {
    task = await controller.task(id);
  } catch (e) {
    if (e instanceof ControllerError && e.status === 404) notFound();
    error = errorText(e, t);
  }
  if (!task) return <Unavailable t={t} what={k.title} reason={error ?? t.common.unknown} />;

  const report = parseReport(task.result) ?? parseReport(task.error);
  const raw = report ? null : task.result ?? task.error;
  const ws = report?.workspace;
  const canCancel = task.status === 'queued' || task.status === 'running';

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{k.title} <span className="mono">{short(task.id, 8)}</span></h1>
        {ACTIVE.includes(task.status) && <AutoRefresh seconds={3} />}
      </div>
      <Flash ok={sp.ok} error={sp.error} />
      <div className="card">
        <dl className="kv">
          <dt>{k.id}</dt><dd className="mono">{task.id}</dd>
          <dt>{t.common.status}</dt><dd><Badge value={task.status} /> {report?.outcome && <span className="muted">{k.workerOutcome(report.outcome)}</span>}</dd>
          <dt>{t.common.agent}</dt><dd>{task.agent}{task.claimedBy && <span className="muted"> · {task.claimedBy} · {k.attempt(task.attempt)}</span>}</dd>
          <dt>{t.tasks.modelEffort}</dt><dd>{runLabel(task.model, t)} · {runLabel(task.effort, t)}</dd>
          <dt>{t.common.project}</dt><dd>{task.projectId ?? '-'}</dd>
          <dt>{t.common.created}</dt><dd title={task.createdAt}>{since(task.createdAt, t)} <span className="muted">{k.createdBy(task.createdBy ?? t.common.unknown)}</span></dd>
          <dt>{t.tasks.duration}</dt><dd>{duration(task.startedAt, task.completedAt, t)}{report?.timedOut && <Badge value="failed" />}{report?.timedOut && k.timedOut}</dd>
          <dt>{t.common.branch}</dt><dd className="mono">{ws?.branch ?? '-'}</dd>
          <dt>{k.baseCommit}</dt><dd className="mono">{ws?.baseCommit ?? '-'}</dd>
          <dt>{k.commit}</dt><dd className="mono">{ws?.commit ?? '-'} {ws?.commit && <a href={`/reviews/${task.id}`}>{k.review}</a>}</dd>
        </dl>
        {canCancel && (
          <form method="post" action={`/api/tasks/${task.id}/cancel`} className="section">
            <CsrfField token={session.csrf} />
            <button className="danger" type="submit">{k.cancel}</button>
          </form>
        )}
      </div>

      <div className="section">
        <h2>{t.common.instruction}</h2>
        <pre className="block">{task.instruction}</pre>
      </div>

      {report && (
        <div className="section">
          <h2>{task.status === 'failed' ? t.common.error : t.common.result}</h2>
          <pre className="block">{report.message || t.common.empty}</pre>
          {report.workspaceError && <div className="warning bad">{k.workspaceError(report.workspaceError)}</div>}
          {ws?.changedFiles && ws.changedFiles.length > 0 && (
            <div className="section">
              <h2>{k.changedFiles}</h2>
              <pre className="block">{ws.changedFiles.map((f) => `${f.status}\t${f.path}`).join('\n')}</pre>
            </div>
          )}
          {ws?.notes && ws.notes.length > 0 && <div className="muted">{ws.notes.join(' · ')}</div>}
          {report.stderrTail && (
            <details className="section">
              <summary>{k.stderrTail(String(report.exitCode ?? 'n/a'))}</summary>
              <pre className="block">{report.stderrTail}</pre>
            </details>
          )}
        </div>
      )}
      {raw && (
        <div className="section">
          <h2>{task.error ? t.common.error : t.common.result}</h2>
          <pre className="block">{raw}</pre>
        </div>
      )}
    </>
  );
}
