import { Chip, CodeExecutionNotice, Empty, Notice, PageHeader, Panel, Tile } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { since } from '@/lib/diff';
import { learning } from '@/lib/learning';
import { IDEA_PRIORITIES, type LearningStatus } from '@/lib/learning-types';
import { deadlineState, todayIso } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

type SP = Promise<Record<string, string | string[] | undefined>>;
const value = <T,>(r: PromiseSettledResult<T>, fallback: T): T => (r.status === 'fulfilled' ? r.value : fallback);

/**
 * Learning overview: what needs the owner, what is next, and four separate measures
 * (roadmap progress, verified mastery, study time, freshness) - never one combined score.
 */
export default async function LearningOverview({ searchParams }: { searchParams: SP }) {
  const [sp, session] = await Promise.all([searchParams, requireSession()]);
  let status: LearningStatus;
  try {
    status = await learning.status();
  } catch (e) {
    return (
      <>
        <PageHeader title="Learning" />
        <Flash ok={sp.ok} error={sp.error} />
        <Unavailable what="Learning service" reason={errorText(e)} />
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
  const overdue = live.filter((m) => m.status !== 'completed' && (deadlineState(m.deadline.fixed, today)?.days ?? 1) < 0);
  const upcoming = live
    .filter((m) => m.status !== 'completed' && (m.deadline.fixed || m.deadline.suggested))
    .sort((a, b) => (a.deadline.fixed ?? a.deadline.suggested ?? '').localeCompare(b.deadline.fixed ?? b.deadline.suggested ?? ''))
    .slice(0, 6);
  const milestoneTitle = new Map(milestones.map((m) => [m.id, m.title]));
  const open = assignments.filter((a) => a.status === 'available' || a.status === 'revision_required').slice(0, 6);
  const roadmapTitle = new Map(roadmaps.map((r) => [r.id, r.title]));

  const attention = [
    { n: c.awaitingDecision ?? 0, text: 'evaluated assignment(s) wait for your pass / revise decision', hint: 'AI never passes anything on its own', href: '/learning/evaluations', tone: 'warn' as const },
    { n: c.pendingProposals, text: 'roadmap proposal(s) wait for approval', hint: 'nothing changes until you approve', href: '/learning/domains#roadmaps', tone: 'warn' as const },
    { n: c.awaitingEvaluation ?? 0, text: 'submission(s) not evaluated yet', hint: 'evaluate yourself or ask the AI for an opinion', href: '/learning/evaluations', tone: 'info' as const },
    { n: c.gapsSuggested ?? 0, text: 'weakness(es) suggested by AI evaluations', hint: 'open or dismiss them', href: '/learning/skills', tone: 'info' as const },
    { n: overdue.length, text: 'milestone(s) past your fixed deadline', hint: 'deadlines are never moved for you', href: '/learning/milestones', tone: 'bad' as const },
    { n: c.evaluationsFailed ?? 0, text: 'failed evaluation(s) on record', hint: 'submissions are kept; retry any time', href: '/learning/evaluations?status=failed', tone: 'muted' as const },
  ].filter((a) => a.n > 0);

  return (
    <>
      <PageHeader
        title="Learning"
        sub="Roadmap progress, verified mastery, study time and freshness are separate measures. Nothing here is combined into one score."
        actions={<><a className={s.linkBtn} href="/api/learning-export">Export JSON</a><a className={`${s.linkBtn} ${s.linkPrimary}`} href="/learning/milestones">Milestones</a></>}
      />
      <Flash ok={sp.ok} error={sp.error} />
      {!l2 && <Notice tone="warn" title="Learning service is on L1.">Milestones, assignments, evaluations and skills appear after the learning service is updated (schema {status.schemaVersion}).</Notice>}

      <div className={s.tiles}>
        <Tile label="Roadmap progress" na={weightTotal === 0} value={weightTotal ? `${Math.round((weightDone / weightTotal) * 100)}%` : 'N/A'}
          note={weightTotal ? `${weightDone} of ${weightTotal} milestone weight completed` : 'no weighted milestones yet'} />
        <Tile label="Verified skills" value={`${c.skillsVerified ?? 0} / ${c.skills ?? 0}`} note={`${c.skillsSelfOnly ?? 0} self-rated only (unverified)`} />
        <Tile label="Study time" na value="N/A" note={<a href="/learning/planner">View planned study time</a>} />
        <Tile label="Freshness" na={verified.length === 0} value={verified.length ? (stale.length ? `${stale.length} to re-check` : 'all fresh') : 'N/A'}
          note={verified.length ? `verified levels older than 90 days need a re-check` : 'no verified levels yet'} />
      </div>

      <div className={s.split}>
        <div className={s.stack}>
          <Panel title="Needs you" note={attention.length ? undefined : 'Nothing is waiting on you right now.'}>
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
            ) : <Empty title="All clear">Capture an idea or open a milestone to keep going.</Empty>}
          </Panel>

          <Panel title="Deadlines" note="Your fixed deadlines first; AI / planner suggestions are shown apart and never applied for you." actions={<a href="/learning/milestones">All milestones →</a>}>
            {upcoming.length ? (
              <div className={s.rows}>
                {upcoming.map((m) => {
                  const fixed = deadlineState(m.deadline.fixed, today);
                  return (
                    <div key={m.id} className={s.row}>
                      <div className={s.rowMain}>
                        <a className={s.rowTitle} href={`/learning/milestones/${m.id}`}>{m.title}</a>
                        <div className={s.rowMeta}><span>{roadmapTitle.get(m.roadmapId) ?? 'roadmap'}</span><span>{m.assignments.passed}/{m.assignments.total} assignments passed</span></div>
                      </div>
                      <div className={s.rowSide}>
                        {m.deadline.fixed ? <Chip tone={fixed?.tone ?? 'muted'}>{m.deadline.fixed} · {fixed?.label}</Chip> : <Chip tone="muted">no fixed deadline</Chip>}
                        {m.deadline.suggested && <Chip tone="warn" title={m.deadline.suggestedReason ?? undefined}>suggested {m.deadline.suggested}</Chip>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <Empty title="No deadlines">Set a deadline on a milestone; it stays exactly as you set it.</Empty>}
          </Panel>

          <Panel title="Continue" note="Open assignments, oldest first." actions={<a href="/learning/milestones">Milestones →</a>}>
            {open.length ? (
              <div className={s.rows}>
                {open.map((a) => (
                  <div key={a.id} className={s.row}>
                    <div className={s.rowMain}>
                      <a className={s.rowTitle} href={`/learning/assignments/${a.id}`}>{a.title}</a>
                      <div className={s.rowMeta}><span>{milestoneTitle.get(a.milestoneId)}</span><span>{a.kind}</span><span>{a.submissions} submission(s)</span></div>
                    </div>
                    <div className={s.rowSide}><Chip status={a.status} /></div>
                  </div>
                ))}
              </div>
            ) : <Empty title="No open assignments">Add assignments to a milestone to practise and get evaluated.</Empty>}
          </Panel>
        </div>

        <div className={s.stack}>
          <Panel title="Quick idea" note="Ideas never enter a roadmap or schedule on their own." id="capture" actions={<a href="/learning/ideas">Inbox ({c.ideasInbox}) →</a>}>
            <form method="post" action="/api/learning/ideas/create" className={s.form}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="returnTo" value="/learning" />
              <label className={s.field}>Idea<input name="text" required maxLength={2000} placeholder="One line is enough" /></label>
              <div className={s.formActions}>
                <select name="priority" defaultValue="normal" aria-label="Priority">{IDEA_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
                <button type="submit" className="primary">Capture</button>
              </div>
            </form>
            {ideas.length > 0 && (
              <div className={s.rows} style={{ marginTop: 10 }}>
                {ideas.slice(0, 4).map((i) => (
                  <div key={i.id} className={s.row}>
                    <div className={s.rowMain}><span style={{ overflowWrap: 'anywhere' }}>{i.text}</span><span className={s.rowMeta}>{since(i.createdAt)}</span></div>
                    {i.priority !== 'normal' && <Chip tone={i.priority === 'high' ? 'warn' : 'muted'}>{i.priority}</Chip>}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Recent evaluations" actions={<a href="/learning/evaluations">All →</a>}>
            {evaluations.length ? (
              <div className={s.stack} style={{ gap: 10 }}>
                {evaluations.map((e) => (
                  <a key={e.id} href={`/learning/evaluations/${e.id}`} className={s.attItem}>
                    <span className={s.attText}>
                      {e.assignmentTitle}
                      <small>r{e.revision} · {e.evaluatorType === 'ai' ? 'AI opinion' : 'you'} · {since(e.createdAt)}</small>
                    </span>
                    <Chip status={e.status === 'completed' ? e.outcome : e.status} />
                  </a>
                ))}
              </div>
            ) : <p className={s.hint}>No evaluations yet.</p>}
          </Panel>

          <Panel title="AI assistance">
            <div className={s.chips} style={{ marginBottom: 6 }}>
              {status.ai.configured ? <Chip tone="ok">on · {status.ai.provider}/{status.ai.model}</Chip> : <Chip tone="muted">not configured</Chip>}
            </div>
            <p className={s.hint} style={{ margin: 0 }}>
              {status.ai.month}: {status.ai.spentUsd.toFixed(4)} / {status.ai.budgetUsd ?? '—'} USD · {status.ai.calls} call(s).
              {!status.ai.configured && ` Missing: ${status.ai.missing.join(', ')}. Roadmap drafts and AI evaluation are refused until then; your own evaluations work.`}
            </p>
          </Panel>
          <CodeExecutionNotice codeExecution={status.codeExecution} />
          <p className={s.hint} style={{ margin: 0 }}>Learning evaluations are never used as approval for GitHub publishing.</p>
        </div>
      </div>
    </>
  );
}
