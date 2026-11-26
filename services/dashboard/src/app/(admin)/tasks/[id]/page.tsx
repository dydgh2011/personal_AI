import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/client';
import { Badge, CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { controller, ControllerError, UUID } from '@/lib/controller';
import { duration, short, since } from '@/lib/diff';
import { parseReport } from '@/lib/report';
import { requireSession } from '@/lib/server';
import { runLabel } from '@/lib/agent-defaults';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

const ACTIVE = ['queued', 'running', 'cancel_requested'];

export default async function TaskPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp, session] = await Promise.all([params, searchParams, requireSession()]);
  if (!UUID.test(id)) notFound();
  let task: Task | null = null;
  let error: string | null = null;
  try {
    task = await controller.task(id);
  } catch (e) {
    if (e instanceof ControllerError && e.status === 404) notFound();
    error = errorText(e);
  }
  if (!task) return <Unavailable what="Task" reason={error ?? 'unknown'} />;

  const report = parseReport(task.result) ?? parseReport(task.error);
  const raw = report ? null : task.result ?? task.error;
  const ws = report?.workspace;
  const canCancel = task.status === 'queued' || task.status === 'running';

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Task <span className="mono">{short(task.id, 8)}</span></h1>
        {ACTIVE.includes(task.status) && <AutoRefresh seconds={3} />}
      </div>
      <Flash ok={sp.ok} error={sp.error} />
      <div className="card">
        <dl className="kv">
          <dt>Id</dt><dd className="mono">{task.id}</dd>
          <dt>Status</dt><dd><Badge value={task.status} /> {report?.outcome && <span className="muted">worker outcome: {report.outcome}</span>}</dd>
          <dt>Agent</dt><dd>{task.agent}{task.claimedBy && <span className="muted"> · {task.claimedBy} · attempt {task.attempt}</span>}</dd>
          <dt>Model · effort</dt><dd>{runLabel(task.model)} · {runLabel(task.effort)}</dd>
          <dt>Project</dt><dd>{task.projectId ?? '-'}</dd>
          <dt>Created</dt><dd title={task.createdAt}>{since(task.createdAt)} <span className="muted">by {task.createdBy ?? 'unknown'}</span></dd>
          <dt>Duration</dt><dd>{duration(task.startedAt, task.completedAt)}{report?.timedOut && <Badge value="failed" />}{report?.timedOut && ' timed out'}</dd>
          <dt>Branch</dt><dd className="mono">{ws?.branch ?? '-'}</dd>
          <dt>Base commit</dt><dd className="mono">{ws?.baseCommit ?? '-'}</dd>
          <dt>Commit</dt><dd className="mono">{ws?.commit ?? '-'} {ws?.commit && <a href={`/reviews/${task.id}`}>review →</a>}</dd>
        </dl>
        {canCancel && (
          <form method="post" action={`/api/tasks/${task.id}/cancel`} className="section">
            <CsrfField token={session.csrf} />
            <button className="danger" type="submit">Cancel task</button>
          </form>
        )}
      </div>

      <div className="section">
        <h2>Instruction</h2>
        <pre className="block">{task.instruction}</pre>
      </div>

      {report && (
        <div className="section">
          <h2>{task.status === 'failed' ? 'Error' : 'Result'}</h2>
          <pre className="block">{report.message || '(empty)'}</pre>
          {report.workspaceError && <div className="warning bad">Workspace error: {report.workspaceError}</div>}
          {ws?.changedFiles && ws.changedFiles.length > 0 && (
            <div className="section">
              <h2>Changed files</h2>
              <pre className="block">{ws.changedFiles.map((f) => `${f.status}\t${f.path}`).join('\n')}</pre>
            </div>
          )}
          {ws?.notes && ws.notes.length > 0 && <div className="muted">{ws.notes.join(' · ')}</div>}
          {report.stderrTail && (
            <details className="section">
              <summary>stderr tail (exit {String(report.exitCode ?? 'n/a')})</summary>
              <pre className="block">{report.stderrTail}</pre>
            </details>
          )}
        </div>
      )}
      {raw && (
        <div className="section">
          <h2>{task.error ? 'Error' : 'Result'}</h2>
          <pre className="block">{raw}</pre>
        </div>
      )}
    </>
  );
}
