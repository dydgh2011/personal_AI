import { notFound } from 'next/navigation';
import { Chip, Empty, Meter, Notice, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { ProposalDiffView, RoadmapTree } from '@/components/RoadmapTree';
import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { short, since } from '@/lib/diff';
import { learning, LearningError } from '@/lib/learning';
import type { Goal, LearningStatus, Milestone, MilestoneProgress, Proposal, ProposalDiff, RoadmapDetail, RoadmapVersion } from '@/lib/learning-types';
import { deadlineState, todayIso } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

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
  const ms: { items: Milestone[]; progress: MilestoneProgress | null } = await learning.milestones({ roadmapId: id }).catch(() => ({ items: [], progress: null }));
  const { roadmap, current } = detail;
  const selected = one(sp.proposal);
  let view: ProposalDiff | null = null;
  if (selected && UUID.test(selected)) view = await learning.proposalDiff(id, selected).catch(() => null);
  const editing = one(sp.edit) === '1';
  const pending = proposals.filter((p) => p.state === 'awaiting_user_approval');
  const today = todayIso(new Date(), process.env.TZ || undefined);
  const here = `/learning/roadmaps/${id}`;
  const deadline = deadlineState(goal?.constraints.deadline, today);

  return (
    <>
      <PageHeader
        crumbs={[{ href: '/learning/domains', label: 'Domains & goals' }]}
        title={roadmap.title}
        sub={<>Goal: {goal?.title}{goal?.targetLevel !== null && goal?.targetLevel !== undefined ? ` · target level ${goal.targetLevel}/4` : ''}</>}
        actions={<>
          {roadmap.currentVersion ? <Chip tone="ok">current v{roadmap.currentVersion}</Chip> : <Chip tone="warn">no approved version</Chip>}
          {goal?.constraints.deadline && <Chip tone={deadline?.tone ?? 'muted'} title="Your fixed deadline">deadline {goal.constraints.deadline} · {deadline?.label}</Chip>}
        </>}
      />
      <Flash ok={sp.ok} error={sp.error} />

      {pending.length > 0 && !view && (
        <Notice tone="warn" title={`${pending.length} proposal(s) await your approval.`}>
          {pending.map((p) => <a key={p.id} href={`${here}?proposal=${p.id}`} style={{ marginRight: 10 }}>{p.source} · {short(p.id, 8)}</a>)}
        </Notice>
      )}

      {view && (
        <Panel id="proposal" tone={view.proposal.state === 'awaiting_user_approval' ? 'warn' : view.proposal.state === 'invalid' ? 'bad' : undefined}
          title={<>Proposal {short(view.proposal.id, 8)}</>}
          note={<>{view.proposal.source} · by {view.proposal.createdBy} {since(view.proposal.createdAt)} · base {view.proposal.baseVersionId ? `v${versions.find((v) => v.id === view!.proposal.baseVersionId)?.version ?? '?'}` : 'none'}
            {view.proposal.source === 'ai' && ` · ${view.proposal.provider}/${view.proposal.model} · ${view.proposal.inputTokens ?? '?'}+${view.proposal.outputTokens ?? '?'} tokens · ${view.proposal.costUsd?.toFixed(5) ?? '?'} USD`}</>}
          actions={<Chip status={view.proposal.state} />}>
          <div className={s.form}>
            {view.proposal.validationErrors.length > 0 && (
              <Notice tone="bad" title="Validation failed.">This proposal can never be applied.<ul className={s.bullets}>{view.proposal.validationErrors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}</ul></Notice>
            )}
            {view.stale && view.proposal.state === 'awaiting_user_approval' && <Notice tone="warn" title="Out of date.">The roadmap changed since this proposal was made. Applying it is refused; propose again from the current version.</Notice>}
            <ProposalDiffView data={view} />
            {view.proposal.state === 'awaiting_user_approval' && !view.stale && (
              <form method="post" action={`/api/learning/roadmaps/${id}/apply`} className={s.form}>
                <CsrfField token={session.csrf} />
                <input type="hidden" name="proposalId" value={view.proposal.id} />
                <input type="hidden" name="baseVersionId" value={view.proposal.baseVersionId ?? ''} />
                <label className={s.check}><input type="checkbox" name="confirmed" value="yes" required /> I reviewed these changes; make them version {(roadmap.currentVersion ?? 0) + 1}.</label>
                <div className={s.formActions}><button type="submit" className="approve">Approve as new version</button></div>
              </form>
            )}
            {(view.proposal.state === 'awaiting_user_approval' || view.proposal.state === 'invalid') && (
              <form method="post" action={`/api/learning/roadmaps/${id}/reject`} className={s.formActions}>
                <CsrfField token={session.csrf} />
                <input type="hidden" name="proposalId" value={view.proposal.id} />
                <button type="submit" className="danger">Reject proposal</button>
                <a href={here}>Close</a>
              </form>
            )}
          </div>
        </Panel>
      )}

      <div className={s.split}>
        <div className={s.stack}>
          <Panel title={`Current version${current ? ` · v${current.version}` : ''}`} note="Hierarchy with prerequisites; the list doubles as the accessible view of the graph.">
            {current ? <RoadmapTree content={current.content} /> : <Empty title="No approved version yet">Propose a first version by editing the JSON or with an AI draft.</Empty>}
          </Panel>

          <Panel title="Milestones" note="Roadmap progress = completed milestone weight. It is not mastery." actions={<a className={s.linkBtn} href={`/learning/milestones?roadmapId=${id}#new`}>+ Milestone</a>}>
            {ms.progress && ms.progress.percent !== null
              ? <Meter value={ms.progress.weightCompleted} max={ms.progress.weightTotal} tone="ok" label={`${ms.progress.percent}% of weight`} />
              : <p className={s.hint} style={{ margin: 0 }}>Progress: N/A (no weighted milestones yet)</p>}
            {ms.items.length > 0 && (
              <div className={s.rows} style={{ marginTop: 8 }}>
                {ms.items.map((m) => {
                  const dl = deadlineState(m.deadline.fixed, today);
                  return (
                    <div key={m.id} className={s.row}>
                      <div className={s.rowMain}>
                        <a className={s.rowTitle} href={`/learning/milestones/${m.id}`}>{m.title}</a>
                        <div className={s.rowMeta}>{m.nodeKey && <span className={s.mono}>node {m.nodeKey}</span>}<span>weight {m.weight}</span><span>{m.assignments.passed}/{m.assignments.total} passed</span></div>
                      </div>
                      <div className={s.rowSide}>
                        {m.deadline.fixed && <Chip tone={dl?.tone ?? 'muted'}>{m.deadline.fixed}</Chip>}
                        <Chip status={m.status} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>

        <div className={s.stack}>
          <Panel title="AI draft" note="The draft is only a proposal until you approve it.">
            {status?.ai.configured
              ? <p className={s.hint} style={{ marginTop: 0 }}>{status.ai.provider}/{status.ai.model} · {status.ai.spentUsd.toFixed(4)} / {status.ai.budgetUsd ?? '—'} USD this month.</p>
              : <Notice tone="warn">AI drafts are not configured yet (missing: {status?.ai.missing.join(', ')}). Manual editing works.</Notice>}
            <form method="post" action={`/api/learning/roadmaps/${id}/generate`} className={s.form} style={{ marginTop: 8 }}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="baseVersionId" value={roadmap.currentVersionId ?? ''} />
              <label className={s.field}>Current level<input name="currentLevel" maxLength={1000} placeholder="What you already know" /></label>
              <label className={s.field}>Weekly minutes<input name="weeklyMinutes" type="number" min={0} max={10080} defaultValue={goal?.constraints.weeklyMinutes ?? ''} /></label>
              <label className={s.field}>Notes<textarea name="notes" maxLength={2000} rows={2} placeholder="Equipment, preferences…" /></label>
              <div className={s.formActions}><button type="submit" className="primary" disabled={!status?.ai.configured}>{roadmap.currentVersionId ? 'Draft a revision' : 'Draft a roadmap'}</button></div>
            </form>
          </Panel>

          <Panel title="Edit" id="edit" note="Saving creates a proposal; nothing changes until you approve it.">
            {!editing ? (
              <a className={s.linkBtn} href={`${here}?edit=1#edit`}>Edit content (JSON)…</a>
            ) : (
              <form method="post" action={`/api/learning/roadmaps/${id}/propose`} className={s.form}>
                <CsrfField token={session.csrf} />
                <input type="hidden" name="baseVersionId" value={roadmap.currentVersionId ?? ''} />
                <p className={s.hint} style={{ margin: 0 }}>Nodes: key, type (stage/topic/skill/milestone), title, parentKey, estimateMinutes, skill, resources. Edges: from → to means “from is a prerequisite of to”.</p>
                <textarea name="content" rows={18} className={s.answer} defaultValue={current ? JSON.stringify(current.content, null, 2) : TEMPLATE} spellCheck={false} aria-label="Roadmap JSON" />
                <div className={s.formActions}><button type="submit" className="primary">Propose changes</button><a href={here}>Cancel</a></div>
              </form>
            )}
          </Panel>

          <Panel title="Versions" note="Restoring creates a new version with the old content." flush>
            {versions.length ? (
              <div className={s.rows}>
                {versions.map((v) => (
                  <div key={v.id} className={s.row}>
                    <div className={s.rowMain}>
                      <span className={s.rowTitle}>v{v.version} {v.id === roadmap.currentVersionId && <Chip tone="ok">current</Chip>}</span>
                      <div className={s.rowMeta}><span>{v.approvedBy} · {since(v.approvedAt)}</span><span className={s.mono}>{short(v.contentHash)}</span></div>
                    </div>
                    {v.id !== roadmap.currentVersionId && roadmap.currentVersionId && (
                      <form method="post" action={`/api/learning/roadmaps/${id}/restore`} className={s.inlineForm}>
                        <CsrfField token={session.csrf} />
                        <input type="hidden" name="versionId" value={v.id} />
                        <input type="hidden" name="baseVersionId" value={roadmap.currentVersionId} />
                        <label className={s.check}><input type="checkbox" name="confirmed" value="yes" required /> as new version</label>
                        <button type="submit">Restore</button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            ) : <p className={s.hint} style={{ padding: '0 16px 12px' }}>No versions yet.</p>}
          </Panel>

          <Panel title="Proposals" flush>
            {proposals.length ? (
              <div className={s.rows}>
                {proposals.map((p) => (
                  <div key={p.id} className={s.row}>
                    <div className={s.rowMain}>
                      <a className={s.rowTitle} href={`${here}?proposal=${p.id}`}>{p.source}{p.model ? ` · ${p.model}` : ''} <span className={s.mono}>{short(p.id, 8)}</span></a>
                      <div className={s.rowMeta}><span>{p.createdBy} · {since(p.createdAt)}</span>{p.decidedBy && <span>decided by {p.decidedBy} {since(p.decidedAt)}</span>}</div>
                    </div>
                    <Chip status={p.state} />
                  </div>
                ))}
              </div>
            ) : <p className={s.hint} style={{ padding: '0 16px 12px' }}>No proposals yet.</p>}
          </Panel>
        </div>
      </div>
    </>
  );
}
