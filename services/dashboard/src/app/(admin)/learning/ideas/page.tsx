import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { since } from '@/lib/diff';
import { learning } from '@/lib/learning';
import { IDEA_PRIORITIES, IDEA_STATES, type Domain, type Idea } from '@/lib/learning-types';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/** Idea Inbox: capture, tag, search, edit, archive. Ideas never enter a roadmap or schedule on their own. */
export default async function IdeasPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp, session] = await Promise.all([searchParams, requireSession()]);
  const q = one(sp.q)?.slice(0, 100);
  const state = IDEA_STATES.includes(one(sp.state) as Idea['state']) ? one(sp.state) : undefined;
  let ideas: Idea[] | null = null;
  let domains: Domain[] = [];
  let error: string | null = null;
  try {
    [ideas, domains] = await Promise.all([learning.ideas({ q, state }), learning.domains()]);
  } catch (e) {
    error = errorText(e);
  }
  const active = domains.filter((d) => d.status !== 'archived');
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Idea Inbox</h1>
        <a href="/learning">← Learning</a>
      </div>
      <Flash ok={sp.ok} error={sp.error} />
      {error && <Unavailable what="Learning service" reason={error} />}

      <form method="post" action="/api/learning/ideas/create" className="filters">
        <CsrfField token={session.csrf} />
        <label style={{ flex: 1, minWidth: 220 }}>New idea<input name="text" required maxLength={2000} /></label>
        <label>Domains<select name="domainIds" multiple size={Math.min(4, Math.max(2, active.length))}>{active.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
        <label>Priority<select name="priority" defaultValue="normal">{IDEA_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
        <button type="submit">Capture</button>
      </form>

      <form method="get" className="filters">
        <label>Search<input name="q" defaultValue={q ?? ''} maxLength={100} /></label>
        <label>State<select name="state" defaultValue={state ?? ''}><option value="">open (not archived)</option>{IDEA_STATES.map((s) => <option key={s}>{s}</option>)}</select></label>
        <button type="submit">Filter</button>
      </form>

      {ideas && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Idea</th><th>Domains</th><th>Captured</th><th>Edit</th></tr></thead>
            <tbody>
              {ideas.map((i) => (
                <tr key={i.id}>
                  <td style={{ minWidth: 220 }}>{i.text}{i.projectIds.length > 0 && <div className="muted">projects: {i.projectIds.join(', ')}</div>}</td>
                  <td>{i.domainIds.map((d) => domains.find((x) => x.id === d)?.title ?? '?').join(', ') || '-'}</td>
                  <td className="muted">{since(i.createdAt)} · {i.source}</td>
                  <td>
                    <form method="post" action={`/api/learning/ideas/${i.id}/update`} className="row">
                      <CsrfField token={session.csrf} />
                      <input type="hidden" name="domainIds-present" value="1" />
                      <input name="text" defaultValue={i.text} maxLength={2000} aria-label="Idea text" />
                      <select name="domainIds" multiple size={2} defaultValue={i.domainIds} aria-label="Domains">{active.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select>
                      <select name="priority" defaultValue={i.priority} aria-label="Priority">{IDEA_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
                      <select name="state" defaultValue={i.state} aria-label="State">{IDEA_STATES.map((s) => <option key={s}>{s}</option>)}</select>
                      <button type="submit">Save</button>
                    </form>
                  </td>
                </tr>
              ))}
              {ideas.length === 0 && <tr><td colSpan={4} className="muted">No ideas match</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
