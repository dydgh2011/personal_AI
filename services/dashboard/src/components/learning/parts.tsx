import type { ReactNode } from 'react';
import { CsrfField } from '@/components/ui';
import type { Dict } from '@/i18n';
import { since } from '@/lib/diff';
import type { CodeExecution, CriterionScore, Evaluation, Evidence, Milestone, SkillMastery } from '@/lib/learning-types';
import { deadlineState, evidenceSource, LEVELS, levelLabel, statusView, type Tone } from '@/lib/learning-view';
import s from './learning.module.css';

const toneClass = (tone: Tone) => s[tone] ?? '';

type ChipProps =
  | { status: string | null | undefined; t: Dict; tone?: Tone; children?: ReactNode; title?: string }
  | { status?: undefined; t?: Dict; tone?: Tone; children: ReactNode; title?: string };

/** Status as words, tinted by tone (color is never the only signal). A status needs the dictionary. */
export function Chip({ status, t, tone, children, title }: ChipProps) {
  const view = t && status !== undefined ? statusView(status, t) : null;
  return (
    <span className={`${s.chip} ${toneClass(tone ?? view?.tone ?? 'muted')}`} title={title}>
      {children ?? view?.label}
    </span>
  );
}

export function PageHeader({ title, sub, crumbs, actions, crumbsLabel }: { title: ReactNode; sub?: ReactNode; crumbs?: Array<{ href: string; label: string }>; actions?: ReactNode; crumbsLabel?: string }) {
  return (
    <header className={s.header}>
      <div style={{ minWidth: 0 }}>
        {crumbs && crumbs.length > 0 && (
          <nav className={s.crumbs} aria-label={crumbsLabel}>
            {crumbs.map((c, i) => (
              <span key={c.href} className={s.crumbs}>
                {i > 0 && <span aria-hidden>›</span>}
                <a href={c.href}>{c.label}</a>
              </span>
            ))}
          </nav>
        )}
        <h1>{title}</h1>
        {sub && <p className={s.sub}>{sub}</p>}
      </div>
      {actions && <div className={s.actions}>{actions}</div>}
    </header>
  );
}

export function Panel({ title, note, actions, children, flush, tone, id }: { title?: ReactNode; note?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; tone?: 'warn' | 'bad'; id?: string }) {
  const cls = [s.panel, flush ? s.panelFlush : '', tone === 'warn' ? s.panelWarn : tone === 'bad' ? s.panelBad : ''].join(' ');
  return (
    <section className={cls} id={id}>
      {(title || actions) && (
        <div className={s.panelHead}>
          <div>
            {title && <h2 className={s.panelTitle}>{title}</h2>}
            {note && <p className={s.panelNote}>{note}</p>}
          </div>
          {actions && <div className={s.actions}>{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function LearningPostFields({ csrf, returnTo }: { csrf: string; returnTo: string }) {
  return (
    <>
      <CsrfField token={csrf} />
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  );
}

export function LevelField({ t, defaultValue }: { t: Dict; defaultValue?: number }) {
  return (
    <label className={s.field}>
      {t.learn.parts.level}
      <select name="level" defaultValue={defaultValue ?? ''} required>
        <option value="" disabled>{t.learn.parts.chooseLevel}</option>
        {LEVELS.map((level) => <option key={level} value={level}>{levelLabel(level, t)}</option>)}
      </select>
    </label>
  );
}

export function Tile({ label, value, note, na }: { label: string; value: ReactNode; note?: ReactNode; na?: boolean }) {
  return (
    <div className={s.tile}>
      <span className={s.tileLabel}>{label}</span>
      <span className={na ? s.tileValueNa : s.tileValue}>{value}</span>
      {note && <span className={s.tileNote}>{note}</span>}
    </div>
  );
}

export function Meter({ t, value, max, tone, mark, label }: { t: Dict; value: number; max: number; tone?: 'ok' | 'warn' | 'bad'; mark?: number; label?: ReactNode }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const fill = tone === 'ok' ? s.meterOk : tone === 'warn' ? s.meterWarn : tone === 'bad' ? s.meterBad : '';
  return (
    <div className={s.meterRow}>
      <div className={s.meter} role="img" aria-label={t.learn.parts.meter(value, max)}>
        <div className={`${s.meterFill} ${fill}`} style={{ width: `${pct}%` }} />
        {mark !== undefined && max > 0 && <div className={s.meterMark} style={{ left: `calc(${Math.min(100, (mark / max) * 100)}% - 1px)` }} title={t.learn.parts.passing(mark)} />}
      </div>
      {label !== undefined && <span className={s.meterLabel}>{label}</span>}
    </div>
  );
}

/** Self-assessment and verified mastery share the same 0–4 scale. */
export function LevelScale({ t, mastery }: { t: Dict; mastery: SkillMastery }) {
  const { self, verified } = mastery;
  const p = t.learn.parts;
  const measures = [
    { key: 'self', name: p.selfAssessment, level: self?.level, label: self ? levelLabel(self.level, t) : p.notRated, className: s.cellSelf },
    { key: 'verified', name: p.verified, level: verified?.level, label: levelLabel(verified?.level, t), className: verified?.stale ? s.cellStale : s.cellVerified },
  ];

  return (
    <div className={s.masteryColumns}>
      {measures.map((measure) => (
        <div className={s.levelMeasure} key={measure.key}>
          <span className={s.levelName}>{measure.name}</span>
          <span className={s.cells} aria-hidden>
            {LEVELS.slice(1).map((level) => (
              <span key={level} className={`${s.cell} ${level <= (measure.level ?? 0) ? measure.className : ''}`} />
            ))}
          </span>
          <span className={s.levelWord}>{measure.label}</span>
          {measure.key === 'verified' && verified?.stale && <Chip tone="warn">{p.reviewDue}</Chip>}
        </div>
      ))}
    </div>
  );
}

/** The owner's fixed deadline and an AI / planner suggestion, side by side and never merged. */
export function DeadlinePair({ t, deadline, today }: { t: Dict; deadline: Milestone['deadline']; today: string }) {
  const p = t.learn.parts;
  const fixed = deadlineState(deadline.fixed, today, t);
  return (
    <div className={s.deadlines}>
      <div className={s.deadline}>
        <div className={s.deadlineLabel}>{p.yourDeadline} <Chip tone="accent">{p.fixed}</Chip></div>
        {deadline.fixed ? (
          <>
            <div className={s.deadlineDate}>{deadline.fixed}</div>
            <div className={s.chips}>{fixed && <Chip tone={fixed.tone}>{fixed.label}</Chip>}</div>
          </>
        ) : <div className={s.deadlineNone}>{p.noneSet}</div>}
      </div>
      <div className={`${s.deadline} ${s.deadlineSuggested}`}>
        <div className={s.deadlineLabel}>{p.suggested} <Chip tone="warn">{p.suggestedBy(deadline.suggestedSource === 'planner' ? 'planner' : 'ai')}</Chip></div>
        {deadline.suggested ? (
          <>
            <div className={s.deadlineDate}>{deadline.suggested}</div>
            {deadline.suggestedReason && <div className={s.hint}>{deadline.suggestedReason}</div>}
          </>
        ) : <div className={s.deadlineNone}>{p.noSuggestion}</div>}
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={s.empty}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Notice({ tone, title, children }: { tone?: 'warn' | 'bad' | 'info'; title?: string; children: ReactNode }) {
  const cls = tone === 'warn' ? s.noticeWarn : tone === 'bad' ? s.noticeBad : tone === 'info' ? s.noticeInfo : '';
  return (
    <div className={`${s.notice} ${cls}`} role={tone === 'bad' ? 'alert' : undefined}>
      {title && <strong>{title}</strong>}
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

export function CodeExecutionNotice({ t, codeExecution }: { t: Dict; codeExecution?: CodeExecution }) {
  return (
    <Notice tone="info" title={t.learn.parts.codeNotRun}>
      {codeExecution?.reason ?? t.learn.parts.codeNotRunDefault}
    </Notice>
  );
}

export function ScoreList({ t, scores, passingScore }: { t: Dict; scores: CriterionScore[]; passingScore?: number | null }) {
  if (!scores.length) return null;
  const total = scores.reduce((t, x) => t + x.score, 0);
  const max = scores.reduce((t, x) => t + x.maxScore, 0);
  return (
    <div className={s.scores}>
      {scores.map((c) => (
        <div key={c.criterion} className={s.score}>
          <div className={s.scoreHead}>
            <strong>{c.title}</strong>
            <span className={s.meterLabel}>{c.score} / {c.maxScore}</span>
          </div>
          <Meter t={t} value={c.score} max={c.maxScore} tone={c.score >= c.maxScore * 0.7 ? 'ok' : c.score >= c.maxScore * 0.4 ? 'warn' : 'bad'} />
          {c.rationale && <div className={s.scoreWhy}>{c.rationale}</div>}
        </div>
      ))}
      {passingScore !== undefined && passingScore !== null && (
        <div className={s.score}>
          <div className={s.scoreHead}><strong>{t.learn.parts.total}</strong><span className={s.meterLabel}>{t.learn.parts.totalLine(Math.round(total * 100) / 100, max, passingScore)}</span></div>
          <Meter t={t} value={total} max={max} mark={passingScore} tone={total >= passingScore ? 'ok' : 'bad'} />
        </div>
      )}
    </div>
  );
}

/** Quotes are marked verified only when the server found them in the submission. */
export function EvidenceList({ t, evidence, files = [] }: { t: Dict; evidence: Evidence[]; files?: Array<{ id: string; name: string }> }) {
  const p = t.learn.parts;
  const shown = evidence.filter((e) => e.type !== 'criterion_score');
  if (!shown.length) return <p className={s.hint}>{p.noQuotes}</p>;
  return (
    <div className={s.evidence}>
      {shown.map((e) => (
        <div key={e.id}>
          {(e.excerpt || e.note) && <blockquote className={`${s.quote} ${e.type === 'excerpt' && !e.verified ? s.quoteUnverified : ''}`}>{e.excerpt ?? e.note}</blockquote>}
          {e.excerpt && e.note && <p className={s.prose}>{e.note}</p>}
          {e.limitations && <p className={s.hint}>{e.limitations}</p>}
          <div className={s.quoteMeta}>
            <Chip tone="muted">{p.evidenceType[e.type] ?? e.type}</Chip>
            {e.type === 'excerpt' && (e.verified ? <Chip tone="ok">{p.foundInSubmission}</Chip> : <Chip tone="warn">{p.notFoundUnverified}</Chip>)}
            {e.criterion && <span>{p.criterion(e.criterion)}</span>}
            <span>{evidenceSource(e.sourceRef, files, t)}</span>
            {e.hash && <span className={s.mono} title={e.hash}>sha256 {e.hash.slice(0, 10)}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One evaluation: who, what the rubric says, confidence and limits. */
export function EvaluationSummary({ t, ev, href }: { t: Dict; ev: Evaluation; href?: string }) {
  const p = t.learn.parts;
  return (
    <div className={s.evalCard}>
      <div className={s.evalHead}>
        <div className={s.chips}>
          <Chip tone={ev.evaluatorType === 'ai' ? 'info' : 'accent'}>{ev.evaluatorType === 'ai' ? p.aiOpinion : p.yourEvaluation}</Chip>
          <Chip t={t} status={ev.status === 'completed' ? ev.outcome : ev.status} />
          <span className={s.hint}>{p.revision(ev.revision, since(ev.createdAt, t))}</span>
        </div>
        {ev.status === 'completed' && ev.totalScore !== null && <span className={s.big}>{ev.totalScore}<span className={s.hint}> / {ev.maxScore}</span></span>}
      </div>
      {ev.status === 'failed' && (
        <Notice tone="bad" title={ev.error?.code ?? 'FAILED'}>
          {ev.error?.message ?? p.evalFailed}{p.submissionUnchanged}
        </Notice>
      )}
      {ev.status === 'completed' && (
        <>
          <ScoreList t={t} scores={ev.scores} passingScore={ev.passingScore} />
          <div className={s.rowMeta}>
            <span>{p.confidence(ev.confidence === null ? '—' : `${Math.round(ev.confidence * 100)}%`)}</span>
            <span>{p.evidenceCount(ev.evidenceCount)}</span>
            {ev.ai?.model && <span>{ev.ai.provider}/{ev.ai.model}{ev.ai.costUsd ? ` · ${ev.ai.costUsd.toFixed(5)} USD` : ''}</span>}
          </div>
          {ev.feedback && <p className={s.prose}>{ev.feedback}</p>}
          {ev.limitations.length > 0 && (
            <div>
              <div className={s.hint}>{p.limits}</div>
              <ul className={s.bullets}>{ev.limitations.map((l, i) => <li key={i} className={s.hint}>{l}</li>)}</ul>
            </div>
          )}
        </>
      )}
      {href && <div><a href={href}>{p.details}</a></div>}
    </div>
  );
}
