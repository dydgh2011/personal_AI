import { AutoRefresh } from '@/components/client';
import { Badge, errorText, Flash, Unavailable } from '@/components/ui';
import { controller } from '@/lib/controller';
import { duration, short, since } from '@/lib/diff';
import type { Project, TaskList } from '@/lib/types';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const AGENTS = ['claude', 'codex'];
const STATUSES = ['queued', 'running', 'completed', 'failed', 'cancel_requested', 'canceled'];
const PAGE = 50;

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function TasksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp] = await Promise.all([searchParams, requireSession()]);
  // Only pass through values the controller accepts; anything else is dropped.
  const agent = AGENTS.includes(one(sp.agent) ?? '') ? one(sp.agent) : undefined;
  const status = STATUSES.includes(one(sp.status) ?? '') ? one(sp.status) : undefined;
  const projectId = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(one(sp.projectId) ?? '') ? one(sp.projectId) : undefined;
  const offset = Math.max(0, Number.parseInt(one(sp.offset) ?? '0', 10) || 0);

  let list: TaskList | null = null;
  let error: string | null = null;
  let projects: Project[] = [];
  try {
    [list, projects] = await Promise.all([
      controller.tasks({ agent, status, projectId, limit: String(PAGE), offset: String(offset) }),
      controller.projects().catch(() => []),
    ]);
  } catch (e) {
    error = errorText(e);
  }
  const link = (o: number) => {
    const p = new URLSearchParams(Object.entries({ agent, status, projectId }).filter(([, v]) => v) as [string, string][]);
    p.set('offset', String(o));
    return `/tasks?${p}`;
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Tasks</h1>
        <AutoRefresh seconds={5} />
      </div>
      <Flash ok={sp.ok} error={sp.error} />
      <form className="filters" method="get">
        <label>
          Agent
          <select name="agent" defaultValue={agent ?? ''}>
            <option value="">all</option>
            {AGENTS.map((a) => <option key={a}>{a}</option>)}
          </select>
        </label>
        <label>
          Project
          <select name="projectId" defaultValue={projectId ?? ''}>
            <option value="">all</option>
            {projects.map((p) => <option key={p.id}>{p.id}</option>)}
          </select>
        </label>
        <label>
          Status
          <select name="status" defaultValue={status ?? ''}>
            <option value="">all</option>
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <button type="submit">Filter</button>
      </form>
      {error && <Unavailable what="Task list" reason={error} />}
      {list && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Task</th><th>Agent</th><th>Project</th><th>Status</th><th>Created</th><th>Duration</th><th>By</th><th>Instruction</th></tr>
              </thead>
              <tbody>
                {list.items.map((t) => (
                  <tr key={t.id}>
                    <td className="mono"><a href={`/tasks/${t.id}`}>{short(t.id, 8)}</a></td>
                    <td>{t.agent}</td>
                    <td>{t.projectId ?? '-'}</td>
                    <td><Badge value={t.status} /></td>
                    <td title={t.createdAt}>{since(t.createdAt)}</td>
                    <td>{duration(t.startedAt, t.completedAt)}</td>
                    <td className="muted">{t.createdBy ?? '-'}</td>
                    <td className="trunc">{t.instruction}</td>
                  </tr>
                ))}
                {list.items.length === 0 && <tr><td colSpan={8} className="muted">No tasks match</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="row section muted">
            {offset > 0 && <a href={link(Math.max(0, offset - PAGE))}>← newer</a>}
            <span>{list.total === 0 ? '0' : `${offset + 1}–${offset + list.items.length}`} of {list.total}</span>
            {offset + list.items.length < list.total && <a href={link(offset + PAGE)}>older →</a>}
          </div>
        </>
      )}
    </>
  );
}
