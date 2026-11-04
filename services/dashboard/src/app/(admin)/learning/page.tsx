import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { since } from '@/lib/diff';
import { learning } from '@/lib/learning';
import { DOMAIN_STATUSES, IDEA_PRIORITIES, type Domain, type Goal, type Idea, type LearningStatus, type Roadmap } from '@/lib/learning-types';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function LearningOverview({ searchParams }: { searchParams: SP }) {
  const [sp, session] = await Promise.all([searchParams, requireSession()]);
  let data: { status: LearningStatus; domains: Domain[]; goals: Goal[]; roadmaps: Roadmap[]; ideas: Idea[] } | null = null;
  let error: string | null = null;
  try {
    const [status, domains, goals, roadmaps, ideas] = await Promise.all([learning.status(), learning.domains(), learning.goals(), learning.roadmaps(), learning.ideas({ state: 'inbox' })]);
    data = { status, domains, goals, roadmaps, ideas };
  } catch (e) {
    error = errorText(e);
  }
  if (!data) {
    return (
      <>
        <h1>Learning</h1>
        <Flash ok={sp.ok} error={sp.error} />
        <Unavailable what="Learning service" reason={error ?? 'unknown'} />
      </>
    );
  }
  const { status, domains, goals, roadmaps, ideas } = data;
  const domainTitle = (id: string) => domains.find((d) => d.id === id)?.title ?? '?';
  const goalTitle = (id: string) => goals.find((g) => g.id === id)?.title ?? '?';
  const active = domains.filter((d) => d.status !== 'archived');

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Learning</h1>
        <div className="row"><a href="/learning/ideas">Idea Inbox ({status.counts.ideasInbox})</a><a href="/api/learning-export">Export JSON</a></div>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      <div className="grid">
        <div className="card"><h2>Domains</h2><div className="big">{status.counts.domains}</div></div>
        <div className="card"><h2>Active goals</h2><div className="big">{status.counts.goals}</div></div>
        <div className="card"><h2>Roadmaps</h2><div className="big">{status.counts.roadmaps}</div></div>
        <div className="card"><h2>Awaiting approval</h2><div className="big">{status.counts.pendingProposals}</div><div className="muted">roadmap proposals</div></div>
        <div className="card">
          <h2>AI drafts</h2>
          <span className={`badge ${status.ai.configured ? 'ok' : 'muted'}`}>{status.ai.configured ? `${status.ai.provider} · ${status.ai.model}` : 'not configured'}</span>
          <div className="muted">{status.ai.month}: {status.ai.spentUsd.toFixed(4)} / {status.ai.budgetUsd ?? '—'} USD · {status.ai.calls} call(s)</div>
          {!status.ai.configured && <div className="muted">missing: {status.ai.missing.join(', ')}</div>}
        </div>
      </div>
      <div className="card section muted">
        Progress, verified mastery, study time and review freshness are tracked separately. Milestones, assessments and the planner arrive in L2/L3:
        roadmap progress — N/A (no milestones yet) · verified mastery — N/A · study time — N/A · today&apos;s plan — N/A.
      </div>

      <div className="section">
        <h2>Quick idea</h2>
        <form method="post" action="/api/learning/ideas/create" className="filters">
          <CsrfField token={session.csrf} />
          <input type="hidden" name="returnTo" value="/learning" />
          <label style={{ flex: 1, minWidth: 220 }}>Idea<input name="text" required maxLength={2000} placeholder="One line is enough" /></label>
          <label>Priority<select name="priority" defaultValue="normal">{IDEA_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
          <button type="submit">Capture</button>
        </form>
        {ideas.slice(0, 5).map((i) => <div key={i.id} className="muted">• {i.text} <span className="badge muted">{i.priority}</span> {since(i.createdAt)}</div>)}
      </div>

      <div className="section">
        <h2>Domains</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Domain</th><th>Parent</th><th>Status</th><th>Priority</th><th>Update</th></tr></thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id}>
                  <td><strong>{d.title}</strong>{d.description && <div className="muted">{d.description}</div>}</td>
                  <td>{d.parentId ? domainTitle(d.parentId) : '-'}</td>
                  <td><span className={`badge ${d.status === 'active' ? 'ok' : d.status === 'archived' ? 'muted' : 'info'}`}>{d.status}</span></td>
                  <td>{d.priority}</td>
                  <td>
                    <form method="post" action={`/api/learning/domains/${d.id}/update`} className="row">
                      <CsrfField token={session.csrf} />
                      <select name="status" defaultValue={d.status}>{DOMAIN_STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
                      <select name="priority" defaultValue={String(d.priority)}>{[1, 2, 3, 4, 5].map((p) => <option key={p}>{p}</option>)}</select>
                      <button type="submit">Save</button>
                    </form>
                  </td>
                </tr>
              ))}
              {domains.length === 0 && <tr><td colSpan={5} className="muted">No domains yet</td></tr>}
            </tbody>
          </table>
        </div>
        <form method="post" action="/api/learning/domains/create" className="filters section">
          <CsrfField token={session.csrf} />
          <label>New domain<input name="title" required maxLength={120} /></label>
          <label>Parent<select name="parentId" defaultValue=""><option value="">(top level)</option>{active.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
          <label>Status<select name="status" defaultValue="exploring">{DOMAIN_STATUSES.filter((s) => s !== 'archived').map((s) => <option key={s}>{s}</option>)}</select></label>
          <label>Priority<select name="priority" defaultValue="3">{[1, 2, 3, 4, 5].map((p) => <option key={p}>{p}</option>)}</select></label>
          <button type="submit">Add domain</button>
        </form>
      </div>

      <div className="section">
        <h2>Goals</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Goal</th><th>Domain</th><th>Target level</th><th>Weekly</th><th>Deadline (yours, fixed)</th><th>Status</th></tr></thead>
            <tbody>
              {goals.map((g) => (
                <tr key={g.id}>
                  <td><strong>{g.title}</strong>{g.target && <div className="muted">{g.target}</div>}</td>
                  <td>{domainTitle(g.domainId)}</td>
                  <td>{g.targetLevel ?? '-'} / 4</td>
                  <td>{g.constraints.weeklyMinutes ? `${g.constraints.weeklyMinutes} min` : '-'}</td>
                  <td>{g.constraints.deadline ?? '-'}</td>
                  <td><span className="badge info">{g.status}</span></td>
                </tr>
              ))}
              {goals.length === 0 && <tr><td colSpan={6} className="muted">No goals yet</td></tr>}
            </tbody>
          </table>
        </div>
        {active.length > 0 && (
          <form method="post" action="/api/learning/goals/create" className="filters section">
            <CsrfField token={session.csrf} />
            <label>New goal<input name="title" required maxLength={200} /></label>
            <label>Domain<select name="domainId" required>{active.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
            <label>Target level<select name="targetLevel" defaultValue="2">{[0, 1, 2, 3, 4].map((l) => <option key={l}>{l}</option>)}</select></label>
            <label>Weekly minutes<input name="weeklyMinutes" type="number" min={0} max={10080} /></label>
            <label>Deadline<input name="deadline" type="date" /></label>
            <label style={{ minWidth: 200 }}>Prior knowledge<input name="priorKnowledge" maxLength={2000} /></label>
            <button type="submit">Add goal</button>
          </form>
        )}
      </div>

      <div className="section">
        <h2>Roadmaps</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Roadmap</th><th>Goal</th><th>Current version</th><th>Updated</th></tr></thead>
            <tbody>
              {roadmaps.map((r) => (
                <tr key={r.id}>
                  <td><a href={`/learning/roadmaps/${r.id}`}>{r.title}</a></td>
                  <td>{goalTitle(r.goalId)}</td>
                  <td>{r.currentVersion ? `v${r.currentVersion}` : <span className="muted">none yet</span>}</td>
                  <td>{since(r.updatedAt)}</td>
                </tr>
              ))}
              {roadmaps.length === 0 && <tr><td colSpan={4} className="muted">No roadmaps yet</td></tr>}
            </tbody>
          </table>
        </div>
        {goals.length > 0 && (
          <form method="post" action="/api/learning/roadmaps/create" className="filters section">
            <CsrfField token={session.csrf} />
            <label>New roadmap<input name="title" required maxLength={200} /></label>
            <label>Goal<select name="goalId" required>{goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}</select></label>
            <button type="submit">Create roadmap</button>
          </form>
        )}
      </div>
    </>
  );
}
