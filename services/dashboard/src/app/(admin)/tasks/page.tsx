import { AutoRefresh } from '@/components/client';
import { Badge, CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { getT } from '@/i18n/server';
import { EFFORT_LEVELS, MODEL_HINTS, runLabel } from '@/lib/agent-defaults';
import { controller } from '@/lib/controller';
import { duration, short, since } from '@/lib/diff';
import type { AgentDefaults, Project, TaskList } from '@/lib/types';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const AGENTS = ['claude', 'codex'];
const STATUSES = ['queued', 'running', 'completed', 'failed', 'cancel_requested', 'canceled'];
const PAGE = 50;

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function TasksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp, session, t] = await Promise.all([searchParams, requireSession(), getT()]);
  const k = t.tasks;
  // Only pass through values the controller accepts; anything else is dropped.
  const agent = AGENTS.includes(one(sp.agent) ?? '') ? one(sp.agent) : undefined;
  const status = STATUSES.includes(one(sp.status) ?? '') ? one(sp.status) : undefined;
  const projectId = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(one(sp.projectId) ?? '') ? one(sp.projectId) : undefined;
  const offset = Math.max(0, Number.parseInt(one(sp.offset) ?? '0', 10) || 0);

  let list: TaskList | null = null;
  let error: string | null = null;
  let projects: Project[] = [];
  let defaults: AgentDefaults[] | null = null;
  try {
    [list, projects, defaults] = await Promise.all([
      controller.tasks({ agent, status, projectId, limit: String(PAGE), offset: String(offset) }),
      controller.projects().catch(() => []),
      controller.agentDefaults().catch(() => null),
    ]);
  } catch (e) {
    error = errorText(e, t);
  }
  const link = (o: number) => {
    const p = new URLSearchParams(Object.entries({ agent, status, projectId }).filter(([, v]) => v) as [string, string][]);
    p.set('offset', String(o));
    return `/tasks?${p}`;
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{k.title}</h1>
        <AutoRefresh seconds={5} />
      </div>
      <Flash ok={sp.ok} error={sp.error} />
      <section className="section">
        <h2>{k.defaultsTitle}</h2>
        <p className="muted">{k.defaultsHelp}</p>
        {defaults ? (
          <div className="defaults-grid">
            {defaults.map((d) => (
              <form key={d.agent} method="post" action="/api/agent-defaults" className="card defaults-card">
                <CsrfField token={session.csrf} />
                <input type="hidden" name="agent" value={d.agent} />
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{d.agent}</strong>
                  <span className="muted" title={d.updatedAt ?? undefined}>
                    {d.updatedAt ? k.changedBy(since(d.updatedAt, t), d.updatedBy ?? '-') : k.neverChanged}
                  </span>
                </div>
                <label>
                  {k.model}
                  <input name="model" defaultValue={d.model ?? ''} placeholder={k.cliDefault} maxLength={80} autoComplete="off" spellCheck={false} />
                  <span className="muted">{k.example(MODEL_HINTS[d.agent])}</span>
                </label>
                <label>
                  {k.effort}
                  <select name="effort" defaultValue={d.effort ?? ''}>
                    <option value="">{k.cliDefault}</option>
                    {EFFORT_LEVELS.map((e) => <option key={e}>{e}</option>)}
                  </select>
                </label>
                <button type="submit">{k.save(d.agent)}</button>
              </form>
            ))}
          </div>
        ) : (
          <Unavailable t={t} what={k.defaultsUnavailable} reason={k.noAnswer} />
        )}
      </section>
      <form className="filters" method="get">
        <label>
          {t.common.agent}
          <select name="agent" defaultValue={agent ?? ''}>
            <option value="">{t.common.all}</option>
            {AGENTS.map((a) => <option key={a}>{a}</option>)}
          </select>
        </label>
        <label>
          {t.common.project}
          <select name="projectId" defaultValue={projectId ?? ''}>
            <option value="">{t.common.all}</option>
            {projects.map((p) => <option key={p.id}>{p.id}</option>)}
          </select>
        </label>
        <label>
          {t.common.status}
          <select name="status" defaultValue={status ?? ''}>
            <option value="">{t.common.all}</option>
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <button type="submit">{t.common.filter}</button>
      </form>
      {error && <Unavailable t={t} what={t.overview.taskList} reason={error} />}
      {list && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>{t.common.task}</th><th>{t.common.agent}</th><th>{t.common.project}</th><th>{t.common.status}</th><th>{k.modelEffort}</th><th>{t.common.created}</th><th>{k.duration}</th><th>{k.by}</th><th>{t.common.instruction}</th></tr>
              </thead>
              <tbody>
                {list.items.map((task) => (
                  <tr key={task.id}>
                    <td className="mono"><a href={`/tasks/${task.id}`}>{short(task.id, 8)}</a></td>
                    <td>{task.agent}</td>
                    <td>{task.projectId ?? '-'}</td>
                    <td><Badge value={task.status} /></td>
                    <td className="muted">{runLabel(task.model, t)} · {runLabel(task.effort, t)}</td>
                    <td title={task.createdAt}>{since(task.createdAt, t)}</td>
                    <td>{duration(task.startedAt, task.completedAt, t)}</td>
                    <td className="muted">{task.createdBy ?? '-'}</td>
                    <td className="trunc">{task.instruction}</td>
                  </tr>
                ))}
                {list.items.length === 0 && <tr><td colSpan={9} className="muted">{k.noMatch}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="row section muted">
            {offset > 0 && <a href={link(Math.max(0, offset - PAGE))}>{k.newer}</a>}
            <span>{list.total === 0 ? k.rangeEmpty(list.total) : k.range(offset + 1, offset + list.items.length, list.total)}</span>
            {offset + list.items.length < list.total && <a href={link(offset + PAGE)}>{k.older}</a>}
          </div>
        </>
      )}
    </>
  );
}
