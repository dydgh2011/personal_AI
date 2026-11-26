import { Chip, CodeExecutionNotice, Empty, Notice, PageHeader, Panel, Tile } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { since } from '@/lib/diff';
import { learning } from '@/lib/learning';
import { IDEA_PRIORITIES, type LearningStatus } from '@/lib/learning-types';
import { deadlineState, todayIso } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

type SP = Promise<Record<string, string | string[] | undefined>>;
const value = <T,>(r: PromiseSettledResult<T>, fallback: T): T => (r.status === 'fulfilled' ? r.value : fallback);

/**
 * Learning overview: what needs the owner, what is next, and four separate measures
 * (roadmap progress, verified mastery, study time, freshness) - never one combined score.
 */
export default async function LearningOverview({ searchParams }: { searchParams: SP }) {
  const [sp, session, t] = await Promise.all([searchParams, requireSession(), getT()]);
  const o = t.learnOverview;
  let status: LearningStatus;
  try {
    status = await learning.status();
  } catch (e) {
    return (
      <>
        <PageHeader title={t.learn.title} />
        <Flash ok={sp.ok} error={sp.error} />
        <Unavailable t={t} what={t.learn.serviceWhat} reason={errorText(e, t)} />
      </>
    );
  }
  const l2 = status.counts.milestones !== undefined;
  const [roadmapsR, milestonesR, assignmentsR, evaluationsR, skillsR, ideasR] = await Promise.allSettled([
    learning.roadmaps(),
    l2 ? learning.milestones().then((r) => r.items) : [],
    l2 ? learning.assignments().then((r) => r.items) : [],
    l2 ? learning.evaluations({ limit: '3' }).then((r) => r.items) : [],
    l2 ? learning.skills().then((r) => r.items) : [],
    learning.ideas({ state: 'inbox' }),
  ]);
  const roadmaps = value(roadmapsR, []);
  const milestones = value(milestonesR, []);
  const assignments = value(assignmentsR, []);
  const evaluations = value(evaluationsR, []);
  const skills = value(skillsR, []);
  const ideas = value(ideasR, []);
  const c = status.counts;
  const today = todayIso(new Date(), process.env.TZ || undefined);

  const live = milestones.filter((m) => m.status !== 'archived');
  const weightTotal = live.reduce((t, m) => t + m.weight, 0);
  const weightDone = live.filter((m) => m.status === 'completed').reduce((t, m) => t + m.weight, 0);
  const verified = skills.filter((k) => k.mastery.verified);
  const stale = verified.filter((k) => k.mastery.verified!.stale);
  const overdue = live.filter((m) => m.status !== 'completed' && (deadlineState(m.deadline.fixed, today, t)?.days ?? 1) < 0);
  const upcoming = live
    .filter((m) => m.status !== 'completed' && (m.deadline.fixed || m.deadline.suggested))
    .sort((a, b) => (a.deadline.fixed ?? a.deadline.suggested ?? '').localeCompare(b.deadline.fixed ?? b.deadline.suggested ?? ''))
    .slice(0, 6);
  const milestoneTitle = new Map(milestones.map((m) => [m.id, m.title]));
  const open = assignments.filter((a) => a.status === 'available' || a.status === 'revision_required').slice(0, 6);
  const roadmapTitle = new Map(roadmaps.map((r) => [r.id, r.title]));

  const attention = [
    { n: c.awaitingDecision ?? 0, text: o.att.awaitingDecision, hint: o.att.awaitingDecisionHint, href: '/learning/evaluations', tone: 'warn' as const },
    { n: c.pendingProposals, text: o.att.proposals, hint: o.att.proposalsHint, href: '/learning/domains#roadmaps', tone: 'warn' as const },
    { n: c.awaitingEvaluation ?? 0, text: o.att.awaitingEvaluation, hint: o.att.awaitingEvaluationHint, href: '/learning/evaluations', tone: 'info' as const },
    { n: c.gapsSuggested ?? 0, text: o.att.gaps, hint: o.att.gapsHint, href: '/learning/skills', tone: 'info' as const },
    { n: overdue.length, text: o.att.overdue, hint: o.att.overdueHint, href: '/learning/milestones', tone: 'bad' as const },
    { n: c.evaluationsFailed ?? 0, text: o.att.failed, hint: o.att.failedHint, href: '/learning/evaluations?status=failed', tone: 'muted' as const },
  ].filter((a) => a.n > 0);

  return (
    <>
      <PageHeader
        title={t.learn.title}
        sub={o.sub}
        actions={<><a className={s.linkBtn} href="/api/learning-export">{o.exportJson}</a><a className={`${s.linkBtn} ${s.linkPrimary}`} href="/learning/milestones">{o.milestones}</a></>}
      />
      <Flash ok={sp.ok} error={sp.error} />
      {!l2 && <Notice tone="warn" title={o.l1Title}>{o.l1Body(status.schemaVersion)}</Notice>}

      <div className={s.tiles}>
        <Tile label={o.roadmapProgress} na={weightTotal === 0} value={weightTotal ? `${Math.round((weightDone / weightTotal) * 100)}%` : o.na}
          note={weightTotal ? o.weightDone(weightDone, weightTotal) : o.noWeighted} />
        <Tile label={o.verifiedSkills} value={`${c.skillsVerified ?? 0} / ${c.skills ?? 0}`} note={o.selfOnly(c.skillsSelfOnly ?? 0)} />
        <Tile label={o.studyTime} na value={o.na} note={<a href="/learning/planner">{o.viewPlanned}</a>} />
        <Tile label={o.freshness} na={verified.length === 0} value={verified.length ? (stale.length ? o.toRecheck(stale.length) : o.allFresh) : o.na}
          note={verified.length ? o.freshnessNote : o.noVerified} />
      </div>

      <div className={s.split}>
        <div className={s.stack}>
          <Panel title={o.needsYou} note={attention.length ? undefined : o.nothingWaiting}>
            {attention.length > 0 ? (
              <div className={s.attention}>
                {attention.map((a) => (
                  <a key={a.text} href={a.href} className={s.attItem}>
                    <span className={`${s.attNum} ${s[a.tone]}`} style={{ background: 'none', border: 0 }}>{a.n}</span>
                    <span className={s.attText}>{a.text}<small>{a.hint}</small></span>
                    <span className={s.arrow} aria-hidden>→</span>
                  </a>
                ))}
              </div>
            ) : <Empty title={o.allClear}>{o.allClearBody}</Empty>}
          </Panel>

          <Panel title={o.deadlines} note={o.deadlinesNote} actions={<a href="/learning/milestones">{o.allMilestones}</a>}>
            {upcoming.length ? (
              <div className={s.rows}>
                {upcoming.map((m) => {
                  const fixed = deadlineState(m.deadline.fixed, today, t);
                  return (
                    <div key={m.id} className={s.row}>
                      <div className={s.rowMain}>
                        <a className={s.rowTitle} href={`/learning/milestones/${m.id}`}>{m.title}</a>
                        <div className={s.rowMeta}><span>{roadmapTitle.get(m.roadmapId) ?? o.roadmap}</span><span>{o.assignmentsPassed(m.assignments.passed, m.assignments.total)}</span></div>
                      </div>
                      <div className={s.rowSide}>
                        {m.deadline.fixed ? <Chip tone={fixed?.tone ?? 'muted'}>{m.deadline.fixed} · {fixed?.label}</Chip> : <Chip tone="muted">{o.noFixedDeadline}</Chip>}
                        {m.deadline.suggested && <Chip tone="warn" title={m.deadline.suggestedReason ?? undefined}>{o.suggestedDate(m.deadline.suggested)}</Chip>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <Empty title={o.noDeadlines}>{o.noDeadlinesBody}</Empty>}
          </Panel>

          <Panel title={o.continue} note={o.continueNote} actions={<a href="/learning/milestones">{o.milestonesLink}</a>}>
            {open.length ? (
              <div className={s.rows}>
                {open.map((a) => (
                  <div key={a.id} className={s.row}>
                    <div className={s.rowMain}>
                      <a className={s.rowTitle} href={`/learning/assignments/${a.id}`}>{a.title}</a>
                      <div className={s.rowMeta}><span>{milestoneTitle.get(a.milestoneId)}</span><span>{a.kind}</span><span>{o.submissions(a.submissions)}</span></div>
                    </div>
                    <div className={s.rowSide}><Chip t={t} status={a.status} /></div>
                  </div>
                ))}
              </div>
            ) : <Empty title={o.noOpen}>{o.noOpenBody}</Empty>}
          </Panel>
        </div>

        <div className={s.stack}>
          <Panel title={o.quickIdea} note={o.quickIdeaNote} id="capture" actions={<a href="/learning/ideas">{o.inbox(c.ideasInbox)}</a>}>
            <form method="post" action="/api/learning/ideas/create" className={s.form}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="returnTo" value="/learning" />
              <label className={s.field}>{o.idea}<input name="text" required maxLength={2000} placeholder={o.ideaPlaceholder} /></label>
              <div className={s.formActions}>
                <select name="priority" defaultValue="normal" aria-label={o.priority}>{IDEA_PRIORITIES.map((p) => <option key={p} value={p}>{o.priorities[p] ?? p}</option>)}</select>
                <button type="submit" className="primary">{o.capture}</button>
              </div>
            </form>
            {ideas.length > 0 && (
              <div className={s.rows} style={{ marginTop: 10 }}>
                {ideas.slice(0, 4).map((i) => (
                  <div key={i.id} className={s.row}>
                    <div className={s.rowMain}><span style={{ overflowWrap: 'anywhere' }}>{i.text}</span><span className={s.rowMeta}>{since(i.createdAt, t)}</span></div>
                    {i.priority !== 'normal' && <Chip tone={i.priority === 'high' ? 'warn' : 'muted'}>{o.priorities[i.priority] ?? i.priority}</Chip>}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={o.recentEvaluations} actions={<a href="/learning/evaluations">{o.all}</a>}>
            {evaluations.length ? (
              <div className={s.stack} style={{ gap: 10 }}>
                {evaluations.map((e) => (
                  <a key={e.id} href={`/learning/evaluations/${e.id}`} className={s.attItem}>
                    <span className={s.attText}>
                      {e.assignmentTitle}
                      <small>r{e.revision} · {e.evaluatorType === 'ai' ? t.learn.parts.aiOpinion : o.you} · {since(e.createdAt, t)}</small>
                    </span>
                    <Chip t={t} status={e.status === 'completed' ? e.outcome : e.status} />
                  </a>
                ))}
              </div>
            ) : <p className={s.hint}>{o.noEvaluations}</p>}
          </Panel>

          <Panel title={o.aiAssistance}>
            <div className={s.chips} style={{ marginBottom: 6 }}>
              {status.ai.configured ? <Chip tone="ok">{o.aiOn(String(status.ai.provider), String(status.ai.model))}</Chip> : <Chip tone="muted">{o.notConfigured}</Chip>}
            </div>
            <p className={s.hint} style={{ margin: 0 }}>
              {o.aiUsage(status.ai.month, status.ai.spentUsd.toFixed(4), String(status.ai.budgetUsd ?? '—'), status.ai.calls)}
              {!status.ai.configured && o.aiMissing(status.ai.missing.join(', '))}
            </p>
          </Panel>
          <CodeExecutionNotice t={t} codeExecution={status.codeExecution} />
          <p className={s.hint} style={{ margin: 0 }}>{o.notForPublishing}</p>
        </div>
      </div>
    </>
  );
}
