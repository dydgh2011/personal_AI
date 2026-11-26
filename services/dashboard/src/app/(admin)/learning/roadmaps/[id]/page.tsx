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
import { getT } from '@/i18n/server';

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
  const [{ id }, sp, session, t] = await Promise.all([params, searchParams, requireSession(), getT()]);
  const k = t.learnRoadmap;
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
    return <Unavailable t={t} what={t.learn.serviceWhat} reason={errorText(e, t)} />;
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
  const deadline = deadlineState(goal?.constraints.deadline, today, t);

  return (
    <>
      <PageHeader
        crumbsLabel={t.common.breadcrumb}
        crumbs={[{ href: '/learning/domains', label: t.learnDomains.title }]}
        title={roadmap.title}
        sub={<>{k.goal(goal?.title ?? '?')}{goal?.targetLevel !== null && goal?.targetLevel !== undefined ? k.targetLevel(goal.targetLevel) : ''}</>}
        actions={<>
          {roadmap.currentVersion ? <Chip tone="ok">{k.currentV(roadmap.currentVersion)}</Chip> : <Chip tone="warn">{k.noApproved}</Chip>}
          {goal?.constraints.deadline && <Chip tone={deadline?.tone ?? 'muted'} title={k.yourFixedDeadline}>{k.deadline(goal.constraints.deadline, deadline?.label ?? '')}</Chip>}
        </>}
      />
      <Flash ok={sp.ok} error={sp.error} />

      {pending.length > 0 && !view && (
        <Notice tone="warn" title={k.pendingProposals(pending.length)}>
          {pending.map((p) => <a key={p.id} href={`${here}?proposal=${p.id}`} style={{ marginRight: 10 }}>{p.source} · {short(p.id, 8)}</a>)}
        </Notice>
      )}

      {view && (
        <Panel id="proposal" tone={view.proposal.state === 'awaiting_user_approval' ? 'warn' : view.proposal.state === 'invalid' ? 'bad' : undefined}
          title={k.proposal(short(view.proposal.id, 8))}
          note={<>{k.proposalMeta(view.proposal.source, view.proposal.createdBy, since(view.proposal.createdAt, t), view.proposal.baseVersionId ? `v${versions.find((v) => v.id === view!.proposal.baseVersionId)?.version ?? '?'}` : k.none)}
            {view.proposal.source === 'ai' && k.aiMeta(String(view.proposal.provider), String(view.proposal.model), String(view.proposal.inputTokens ?? '?'), String(view.proposal.outputTokens ?? '?'), view.proposal.costUsd?.toFixed(5) ?? '?')}</>}
          actions={<Chip t={t} status={view.proposal.state} />}>
          <div className={s.form}>
            {view.proposal.validationErrors.length > 0 && (
              <Notice tone="bad" title={k.validationFailed}>{k.neverApplied}<ul className={s.bullets}>{view.proposal.validationErrors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}</ul></Notice>
            )}
            {view.stale && view.proposal.state === 'awaiting_user_approval' && <Notice tone="warn" title={k.outOfDate}>{k.outOfDateBody}</Notice>}
            <ProposalDiffView t={t} data={view} />
            {view.proposal.state === 'awaiting_user_approval' && !view.stale && (
              <form method="post" action={`/api/learning/roadmaps/${id}/apply`} className={s.form}>
                <CsrfField token={session.csrf} />
                <input type="hidden" name="proposalId" value={view.proposal.id} />
                <input type="hidden" name="baseVersionId" value={view.proposal.baseVersionId ?? ''} />
                <label className={s.check}><input type="checkbox" name="confirmed" value="yes" required /> {k.confirmApply((roadmap.currentVersion ?? 0) + 1)}</label>
                <div className={s.formActions}><button type="submit" className="approve">{k.approve}</button></div>
              </form>
            )}
            {(view.proposal.state === 'awaiting_user_approval' || view.proposal.state === 'invalid') && (
              <form method="post" action={`/api/learning/roadmaps/${id}/reject`} className={s.formActions}>
                <CsrfField token={session.csrf} />
                <input type="hidden" name="proposalId" value={view.proposal.id} />
                <button type="submit" className="danger">{k.reject}</button>
                <a href={here}>{k.close}</a>
              </form>
            )}
          </div>
        </Panel>
      )}

      <div className={s.split}>
        <div className={s.stack}>
          <Panel title={k.current(current?.version ?? null)} note={k.currentNote}>
            {current ? <RoadmapTree t={t} content={current.content} /> : <Empty title={k.noApprovedTitle}>{k.noApprovedBody}</Empty>}
          </Panel>

          <Panel title={k.milestones} note={k.milestonesNote} actions={<a className={s.linkBtn} href={`/learning/milestones?roadmapId=${id}#new`}>{k.newMilestone}</a>}>
            {ms.progress && ms.progress.percent !== null
              ? <Meter t={t} value={ms.progress.weightCompleted} max={ms.progress.weightTotal} tone="ok" label={k.ofWeight(ms.progress.percent)} />
              : <p className={s.hint} style={{ margin: 0 }}>{k.progressNa}</p>}
            {ms.items.length > 0 && (
              <div className={s.rows} style={{ marginTop: 8 }}>
                {ms.items.map((m) => {
                  const dl = deadlineState(m.deadline.fixed, today, t);
                  return (
                    <div key={m.id} className={s.row}>
                      <div className={s.rowMain}>
                        <a className={s.rowTitle} href={`/learning/milestones/${m.id}`}>{m.title}</a>
                        <div className={s.rowMeta}>{m.nodeKey && <span className={s.mono}>{k.node(m.nodeKey)}</span>}<span>{k.weight(m.weight)}</span><span>{k.passed(m.assignments.passed, m.assignments.total)}</span></div>
                      </div>
                      <div className={s.rowSide}>
                        {m.deadline.fixed && <Chip tone={dl?.tone ?? 'muted'}>{m.deadline.fixed}</Chip>}
                        <Chip t={t} status={m.status} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>

        <div className={s.stack}>
          <Panel title={k.aiDraft} note={k.aiDraftNote}>
            {status?.ai.configured
              ? <p className={s.hint} style={{ marginTop: 0 }}>{k.aiThisMonth(String(status.ai.provider), String(status.ai.model), status.ai.spentUsd.toFixed(4), String(status.ai.budgetUsd ?? '—'))}</p>
              : <Notice tone="warn">{k.aiNotConfigured(status?.ai.missing.join(', ') ?? '?')}</Notice>}
            <form method="post" action={`/api/learning/roadmaps/${id}/generate`} className={s.form} style={{ marginTop: 8 }}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="baseVersionId" value={roadmap.currentVersionId ?? ''} />
              <label className={s.field}>{k.currentLevel}<input name="currentLevel" maxLength={1000} placeholder={k.currentLevelPlaceholder} /></label>
              <label className={s.field}>{k.weeklyMinutes}<input name="weeklyMinutes" type="number" min={0} max={10080} defaultValue={goal?.constraints.weeklyMinutes ?? ''} /></label>
              <label className={s.field}>{k.notes}<textarea name="notes" maxLength={2000} rows={2} placeholder={k.notesPlaceholder} /></label>
              <div className={s.formActions}><button type="submit" className="primary" disabled={!status?.ai.configured}>{roadmap.currentVersionId ? k.draftRevision : k.draftRoadmap}</button></div>
            </form>
          </Panel>

          <Panel title={k.edit} id="edit" note={k.editNote}>
            {!editing ? (
              <a className={s.linkBtn} href={`${here}?edit=1#edit`}>{k.editJson}</a>
            ) : (
              <form method="post" action={`/api/learning/roadmaps/${id}/propose`} className={s.form}>
                <CsrfField token={session.csrf} />
                <input type="hidden" name="baseVersionId" value={roadmap.currentVersionId ?? ''} />
                <p className={s.hint} style={{ margin: 0 }}>{k.jsonHelp}</p>
                <textarea name="content" rows={18} className={s.answer} defaultValue={current ? JSON.stringify(current.content, null, 2) : TEMPLATE} spellCheck={false} aria-label={k.jsonAria} />
                <div className={s.formActions}><button type="submit" className="primary">{k.propose}</button><a href={here}>{t.common.cancel}</a></div>
              </form>
            )}
          </Panel>

          <Panel title={k.versions} note={k.versionsNote} flush>
            {versions.length ? (
              <div className={s.rows}>
                {versions.map((v) => (
                  <div key={v.id} className={s.row}>
                    <div className={s.rowMain}>
                      <span className={s.rowTitle}>v{v.version} {v.id === roadmap.currentVersionId && <Chip tone="ok">{k.currentChip}</Chip>}</span>
                      <div className={s.rowMeta}><span>{v.approvedBy} · {since(v.approvedAt, t)}</span><span className={s.mono}>{short(v.contentHash)}</span></div>
                    </div>
                    {v.id !== roadmap.currentVersionId && roadmap.currentVersionId && (
                      <form method="post" action={`/api/learning/roadmaps/${id}/restore`} className={s.inlineForm}>
                        <CsrfField token={session.csrf} />
                        <input type="hidden" name="versionId" value={v.id} />
                        <input type="hidden" name="baseVersionId" value={roadmap.currentVersionId} />
                        <label className={s.check}><input type="checkbox" name="confirmed" value="yes" required /> {k.asNewVersion}</label>
                        <button type="submit">{k.restore}</button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            ) : <p className={s.hint} style={{ padding: '0 16px 12px' }}>{k.noVersions}</p>}
          </Panel>

          <Panel title={k.proposals} flush>
            {proposals.length ? (
              <div className={s.rows}>
                {proposals.map((p) => (
                  <div key={p.id} className={s.row}>
                    <div className={s.rowMain}>
                      <a className={s.rowTitle} href={`${here}?proposal=${p.id}`}>{p.source}{p.model ? ` · ${p.model}` : ''} <span className={s.mono}>{short(p.id, 8)}</span></a>
                      <div className={s.rowMeta}><span>{p.createdBy} · {since(p.createdAt, t)}</span>{p.decidedBy && <span>{k.decidedBy(p.decidedBy, since(p.decidedAt, t))}</span>}</div>
                    </div>
                    <Chip t={t} status={p.state} />
                  </div>
                ))}
              </div>
            ) : <p className={s.hint} style={{ padding: '0 16px 12px' }}>{k.noProposals}</p>}
          </Panel>
        </div>
      </div>
    </>
  );
}
