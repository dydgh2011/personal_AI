import { notFound } from 'next/navigation';
import { ProposalDiffView, RoadmapTree } from '@/components/RoadmapTree';
import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { short, since } from '@/lib/diff';
import { learning, LearningError } from '@/lib/learning';
import type { Goal, LearningStatus, Proposal, ProposalDiff, RoadmapDetail, RoadmapVersion } from '@/lib/learning-types';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const STATE_TONE: Record<Proposal['state'], string> = { awaiting_user_approval: 'warn', applied: 'ok', rejected: 'muted', invalid: 'bad' };

const TEMPLATE = JSON.stringify({
  nodes: [
    { key: 'basics', type: 'stage', title: 'Basics', estimateMinutes: null },
    { key: 'first-topic', type: 'topic', title: 'First topic', parentKey: 'basics', estimateMinutes: 60, skill: null },
  ],
  edges: [],
}, null, 2);

export default async function RoadmapPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp, session] = await Promise.all([params, searchParams, requireSession()]);
  if (!UUID.test(id)) notFound();
  let detail: RoadmapDetail;
  let goal: Goal | null = null;
  let versions: RoadmapVersion[] = [];
  let proposals: Proposal[] = [];
  let status: LearningStatus | null = null;
  try {
    detail = await learning.roadmap(id);
    [goal, versions, proposals, status] = await Promise.all([learning.goal(detail.roadmap.goalId), learning.versions(id), learning.proposals(id), learning.status()]);
  } catch (e) {
    if (e instanceof LearningError && e.status === 404) notFound();
    return <Unavailable what="Learning service" reason={errorText(e)} />;
  }
  const { roadmap, current } = detail;
  const selected = one(sp.proposal);
  let view: ProposalDiff | null = null;
  if (selected && UUID.test(selected)) view = await learning.proposalDiff(id, selected).catch(() => null);
  const editing = one(sp.edit) === '1';
  const pending = proposals.filter((p) => p.state === 'awaiting_user_approval');

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{roadmap.title}</h1>
        <a href="/learning">← Learning</a>
      </div>
      <Flash ok={sp.ok} error={sp.error} />
      <div className="card">
        <dl className="kv">
          <dt>Goal</dt><dd>{goal?.title} {goal?.targetLevel !== null && goal?.targetLevel !== undefined && <span className="muted">(target level {goal.targetLevel}/4)</span>}</dd>
          <dt>Deadline</dt><dd>{goal?.constraints.deadline ? <>{goal.constraints.deadline} <span className="badge muted">yours · fixed</span></> : '-'}</dd>
          <dt>Current version</dt><dd>{roadmap.currentVersion ? `v${roadmap.currentVersion}` : <span className="muted">none yet — propose a first version below</span>}</dd>
          <dt>Pending proposals</dt><dd>{pending.length ? pending.map((p) => <a key={p.id} href={`?proposal=${p.id}#proposal`} style={{ marginRight: 8 }}>{p.source} {short(p.id, 8)}</a>) : '-'}</dd>
        </dl>
      </div>

      {view && (
        <div id="proposal" className="card section" style={{ borderColor: view.proposal.state === 'awaiting_user_approval' ? 'var(--warn)' : undefined }}>
          <h2>Proposal {short(view.proposal.id, 8)}</h2>
          <div className="row">
            <span className={`badge ${STATE_TONE[view.proposal.state]}`}>{view.proposal.state}</span>
            <span className="muted">{view.proposal.source} · by {view.proposal.createdBy} {since(view.proposal.createdAt)} · base {view.proposal.baseVersionId ? `v${versions.find((v) => v.id === view!.proposal.baseVersionId)?.version ?? '?'}` : 'none'}</span>
            {view.proposal.source === 'ai' && <span className="muted">· {view.proposal.provider}/{view.proposal.model} · {view.proposal.inputTokens ?? '?'}+{view.proposal.outputTokens ?? '?'} tokens · {view.proposal.costUsd?.toFixed(5) ?? '?'} USD</span>}
          </div>
          {view.proposal.validationErrors.length > 0 && (
            <div className="warning bad">Validation failed — this proposal can never be applied:<ul>{view.proposal.validationErrors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}</ul></div>
          )}
          {view.stale && view.proposal.state === 'awaiting_user_approval' && <div className="warning">The roadmap changed since this proposal was made (based on another version). Applying it is refused; propose again from the current version.</div>}
          <ProposalDiffView data={view} />
          {view.proposal.state === 'awaiting_user_approval' && !view.stale && (
            <form method="post" action={`/api/learning/roadmaps/${id}/apply`} className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="proposalId" value={view.proposal.id} />
              <input type="hidden" name="baseVersionId" value={view.proposal.baseVersionId ?? ''} />
              <label className="row"><input type="checkbox" name="confirmed" value="yes" required /> I reviewed these changes; make them version {(roadmap.currentVersion ?? 0) + 1}.</label>
              <div className="row"><button type="submit" className="approve">Approve as new version</button></div>
            </form>
          )}
          {(view.proposal.state === 'awaiting_user_approval' || view.proposal.state === 'invalid') && (
            <form method="post" action={`/api/learning/roadmaps/${id}/reject`} className="section">
              <CsrfField token={session.csrf} />
              <input type="hidden" name="proposalId" value={view.proposal.id} />
              <button type="submit" className="danger">Reject proposal</button> <a href={`/learning/roadmaps/${id}`}>Close</a>
            </form>
          )}
        </div>
      )}

      <div className="section">
        <h2>Current version {current ? `(v${current.version})` : ''}</h2>
        {current ? <div className="card"><RoadmapTree content={current.content} /></div> : <div className="card muted">No approved version yet.</div>}
      </div>

      <div className="grid section" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <div className="card">
          <h2>AI draft</h2>
          {status?.ai.configured ? (
            <div className="muted">{status.ai.provider}/{status.ai.model} · {status.ai.spentUsd.toFixed(4)} / {status.ai.budgetUsd} USD this month. The draft is only a proposal until you approve it.</div>
          ) : (
            <div className="warning">AI drafts are not configured yet (missing: {status?.ai.missing.join(', ')}). Manual editing works.</div>
          )}
          <form method="post" action={`/api/learning/roadmaps/${id}/generate`} className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <CsrfField token={session.csrf} />
            <input type="hidden" name="baseVersionId" value={roadmap.currentVersionId ?? ''} />
            <label>Current level<input name="currentLevel" maxLength={1000} placeholder="What you already know" /></label>
            <label>Weekly minutes<input name="weeklyMinutes" type="number" min={0} max={10080} defaultValue={goal?.constraints.weeklyMinutes ?? ''} /></label>
            <label>Notes<textarea name="notes" maxLength={2000} rows={2} placeholder="Equipment, preferences…" /></label>
            <div><button type="submit" disabled={!status?.ai.configured}>{roadmap.currentVersionId ? 'Draft a revision' : 'Draft a roadmap'}</button></div>
          </form>
        </div>
        <div className="card">
          <h2>Edit</h2>
          {!editing ? (
            <a className="btn" href={`/learning/roadmaps/${id}?edit=1#edit`}>Edit content (JSON)…</a>
          ) : (
            <form id="edit" method="post" action={`/api/learning/roadmaps/${id}/propose`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="baseVersionId" value={roadmap.currentVersionId ?? ''} />
              <div className="muted">Nodes: key, type (stage/topic/skill/milestone), title, parentKey, estimateMinutes, skill, resources. Edges: from → to means &quot;from is a prerequisite of to&quot;. Saving creates a proposal; nothing changes until you approve it.</div>
              <textarea name="content" rows={18} className="mono" defaultValue={current ? JSON.stringify(current.content, null, 2) : TEMPLATE} spellCheck={false} />
              <div className="row"><button type="submit">Propose changes</button><a href={`/learning/roadmaps/${id}`}>Cancel</a></div>
            </form>
          )}
        </div>
      </div>

      <div className="section">
        <h2>Versions</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Version</th><th>Approved</th><th>Hash</th><th>Restore</th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td>v{v.version}{v.id === roadmap.currentVersionId && <span className="badge ok"> current</span>}</td>
                  <td>{v.approvedBy} {since(v.approvedAt)}</td>
                  <td className="mono">{short(v.contentHash)}</td>
                  <td>
                    {v.id !== roadmap.currentVersionId && roadmap.currentVersionId && (
                      <form method="post" action={`/api/learning/roadmaps/${id}/restore`} className="row">
                        <CsrfField token={session.csrf} />
                        <input type="hidden" name="versionId" value={v.id} />
                        <input type="hidden" name="baseVersionId" value={roadmap.currentVersionId} />
                        <label className="row"><input type="checkbox" name="confirmed" value="yes" required /> restore as new version</label>
                        <button type="submit">Restore</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
              {versions.length === 0 && <tr><td colSpan={4} className="muted">No versions yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <h2>Proposals</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Proposal</th><th>Source</th><th>State</th><th>Created</th><th>Decided</th></tr></thead>
            <tbody>
              {proposals.map((p) => (
                <tr key={p.id}>
                  <td className="mono"><a href={`?proposal=${p.id}#proposal`}>{short(p.id, 8)}</a></td>
                  <td>{p.source}{p.model ? ` (${p.model})` : ''}</td>
                  <td><span className={`badge ${STATE_TONE[p.state]}`}>{p.state}</span></td>
                  <td>{p.createdBy} {since(p.createdAt)}</td>
                  <td className="muted">{p.decidedBy ? `${p.decidedBy} ${since(p.decidedAt)}` : '-'}</td>
                </tr>
              ))}
              {proposals.length === 0 && <tr><td colSpan={5} className="muted">No proposals yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
