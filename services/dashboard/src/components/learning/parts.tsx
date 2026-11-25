import type { ReactNode } from 'react';
import { CsrfField } from '@/components/ui';
import { since } from '@/lib/diff';
import type { CodeExecution, CriterionScore, Evaluation, Evidence, Milestone, SkillMastery } from '@/lib/learning-types';
import { deadlineState, evidenceSource, LEVELS, levelLabel, statusView, type Tone } from '@/lib/learning-view';
import s from './learning.module.css';

const toneClass = (tone: Tone) => s[tone] ?? '';

/** Status as words, tinted by tone (color is never the only signal). */
export function Chip({ status, tone, children, title }: { status?: string | null; tone?: Tone; children?: ReactNode; title?: string }) {
  const view = status !== undefined ? statusView(status) : null;
  return (
    <span className={`${s.chip} ${toneClass(tone ?? view?.tone ?? 'muted')}`} title={title}>
      {children ?? view?.label}
    </span>
  );
}

export function PageHeader({ title, sub, crumbs, actions }: { title: ReactNode; sub?: ReactNode; crumbs?: Array<{ href: string; label: string }>; actions?: ReactNode }) {
  return (
    <header className={s.header}>
      <div style={{ minWidth: 0 }}>
        {crumbs && crumbs.length > 0 && (
          <nav className={s.crumbs} aria-label="Breadcrumb">
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

export function LevelField({ defaultValue }: { defaultValue?: number }) {
  return (
    <label className={s.field}>
      Level
      <select name="level" defaultValue={defaultValue ?? ''} required>
        <option value="" disabled>Choose a level</option>
        {LEVELS.map((level) => <option key={level.level} value={level.level}>{levelLabel(level.level)}</option>)}
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

export function Meter({ value, max, tone, mark, label }: { value: number; max: number; tone?: 'ok' | 'warn' | 'bad'; mark?: number; label?: ReactNode }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const fill = tone === 'ok' ? s.meterOk : tone === 'warn' ? s.meterWarn : tone === 'bad' ? s.meterBad : '';
  return (
    <div className={s.meterRow}>
      <div className={s.meter} role="img" aria-label={`${value} of ${max}`}>
        <div className={`${s.meterFill} ${fill}`} style={{ width: `${pct}%` }} />
        {mark !== undefined && max > 0 && <div className={s.meterMark} style={{ left: `calc(${Math.min(100, (mark / max) * 100)}% - 1px)` }} title={`passing ${mark}`} />}
      </div>
      {label !== undefined && <span className={s.meterLabel}>{label}</span>}
    </div>
  );
}

/** Self-assessment and verified mastery share the same 0–4 scale. */
export function LevelScale({ mastery }: { mastery: SkillMastery }) {
  const { self, verified } = mastery;
  const measures = [
    { name: 'Self-assessment', level: self?.level, label: self ? levelLabel(self.level) : 'not rated', className: s.cellSelf },
    { name: 'Verified', level: verified?.level, label: levelLabel(verified?.level), className: verified?.stale ? s.cellStale : s.cellVerified },
  ];

  return (
    <div className={s.masteryColumns}>
      {measures.map((measure) => (
        <div className={s.levelMeasure} key={measure.name}>
          <span className={s.levelName}>{measure.name}</span>
          <span className={s.cells} aria-hidden>
            {LEVELS.slice(1).map(({ level }) => (
              <span key={level} className={`${s.cell} ${level <= (measure.level ?? 0) ? measure.className : ''}`} />
            ))}
          </span>
          <span className={s.levelWord}>{measure.label}</span>
          {measure.name === 'Verified' && verified?.stale && <Chip tone="warn">Review due</Chip>}
        </div>
      ))}
    </div>
  );
}

/** The owner's fixed deadline and an AI / planner suggestion, side by side and never merged. */
export function DeadlinePair({ deadline, today }: { deadline: Milestone['deadline']; today: string }) {
  const fixed = deadlineState(deadline.fixed, today);
  return (
    <div className={s.deadlines}>
      <div className={s.deadline}>
        <div className={s.deadlineLabel}>Your deadline <Chip tone="accent">fixed</Chip></div>
        {deadline.fixed ? (
          <>
            <div className={s.deadlineDate}>{deadline.fixed}</div>
            <div className={s.chips}>{fixed && <Chip tone={fixed.tone}>{fixed.label}</Chip>}</div>
          </>
        ) : <div className={s.deadlineNone}>none set</div>}
      </div>
      <div className={`${s.deadline} ${s.deadlineSuggested}`}>
        <div className={s.deadlineLabel}>Suggested <Chip tone="warn">{deadline.suggestedSource === 'planner' ? 'planner' : 'AI'} · not applied</Chip></div>
        {deadline.suggested ? (
          <>
            <div className={s.deadlineDate}>{deadline.suggested}</div>
            {deadline.suggestedReason && <div className={s.hint}>{deadline.suggestedReason}</div>}
          </>
        ) : <div className={s.deadlineNone}>no suggestion</div>}
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

export function CodeExecutionNotice({ codeExecution }: { codeExecution?: CodeExecution }) {
  return (
    <Notice tone="info" title="Code is not run.">
      {codeExecution?.reason ?? 'Code submissions are stored and read as text only; an isolated runner is a separate, later decision.'}
    </Notice>
  );
}

export function ScoreList({ scores, passingScore }: { scores: CriterionScore[]; passingScore?: number | null }) {
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
          <Meter value={c.score} max={c.maxScore} tone={c.score >= c.maxScore * 0.7 ? 'ok' : c.score >= c.maxScore * 0.4 ? 'warn' : 'bad'} />
          {c.rationale && <div className={s.scoreWhy}>{c.rationale}</div>}
        </div>
      ))}
      {passingScore !== undefined && passingScore !== null && (
        <div className={s.score}>
          <div className={s.scoreHead}><strong>Total</strong><span className={s.meterLabel}>{Math.round(total * 100) / 100} / {max} · passing {passingScore}</span></div>
          <Meter value={total} max={max} mark={passingScore} tone={total >= passingScore ? 'ok' : 'bad'} />
        </div>
      )}
    </div>
  );
}

const EVIDENCE_LABEL: Record<Evidence['type'], string> = { criterion_score: 'score', excerpt: 'quote', owner_check: 'owner check', reference: 'reference' };

/** Quotes are marked verified only when the server found them in the submission. */
export function EvidenceList({ evidence, files = [] }: { evidence: Evidence[]; files?: Array<{ id: string; name: string }> }) {
  const shown = evidence.filter((e) => e.type !== 'criterion_score');
  if (!shown.length) return <p className={s.hint}>No quotes or checks beyond the criterion scores.</p>;
  return (
    <div className={s.evidence}>
      {shown.map((e) => (
        <div key={e.id}>
          {(e.excerpt || e.note) && <blockquote className={`${s.quote} ${e.type === 'excerpt' && !e.verified ? s.quoteUnverified : ''}`}>{e.excerpt ?? e.note}</blockquote>}
          {e.excerpt && e.note && <p className={s.prose}>{e.note}</p>}
          {e.limitations && <p className={s.hint}>{e.limitations}</p>}
          <div className={s.quoteMeta}>
            <Chip tone="muted">{EVIDENCE_LABEL[e.type]}</Chip>
            {e.type === 'excerpt' && (e.verified ? <Chip tone="ok">found in submission</Chip> : <Chip tone="warn">not found · unverified</Chip>)}
            {e.criterion && <span>criterion {e.criterion}</span>}
            <span>{evidenceSource(e.sourceRef, files)}</span>
            {e.hash && <span className={s.mono} title={e.hash}>sha256 {e.hash.slice(0, 10)}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One evaluation: who, what the rubric says, confidence and limits. */
export function EvaluationSummary({ ev, href }: { ev: Evaluation; href?: string }) {
  return (
    <div className={s.evalCard}>
      <div className={s.evalHead}>
        <div className={s.chips}>
          <Chip tone={ev.evaluatorType === 'ai' ? 'info' : 'accent'}>{ev.evaluatorType === 'ai' ? 'AI opinion' : 'Your evaluation'}</Chip>
          <Chip status={ev.status === 'completed' ? ev.outcome : ev.status} />
          <span className={s.hint}>revision {ev.revision} · {since(ev.createdAt)}</span>
        </div>
        {ev.status === 'completed' && ev.totalScore !== null && <span className={s.big}>{ev.totalScore}<span className={s.hint}> / {ev.maxScore}</span></span>}
      </div>
      {ev.status === 'failed' && (
        <Notice tone="bad" title={ev.error?.code ?? 'FAILED'}>
          {ev.error?.message ?? 'The evaluation failed.'} The submission is unchanged.
        </Notice>
      )}
      {ev.status === 'completed' && (
        <>
          <ScoreList scores={ev.scores} passingScore={ev.passingScore} />
          <div className={s.rowMeta}>
            <span>confidence {ev.confidence === null ? '—' : `${Math.round(ev.confidence * 100)}%`}</span>
            <span>{ev.evidenceCount} evidence item(s)</span>
            {ev.ai?.model && <span>{ev.ai.provider}/{ev.ai.model}{ev.ai.costUsd ? ` · ${ev.ai.costUsd.toFixed(5)} USD` : ''}</span>}
          </div>
          {ev.feedback && <p className={s.prose}>{ev.feedback}</p>}
          {ev.limitations.length > 0 && (
            <div>
              <div className={s.hint}>Limits of this evaluation</div>
              <ul className={s.bullets}>{ev.limitations.map((l, i) => <li key={i} className={s.hint}>{l}</li>)}</ul>
            </div>
          )}
        </>
      )}
      {href && <div><a href={href}>Evidence and details →</a></div>}
    </div>
  );
}
