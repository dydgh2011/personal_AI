import { Chip, LearningPostFields, Notice, PageHeader, Panel } from '@/components/learning/parts';
import parts from '@/components/learning/learning.module.css';
import s from '@/components/learning/planner.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning } from '@/lib/learning';
import { scheduleDate, scheduleHref, schedulePeriod, SCHEDULE_TZ } from '@/lib/learning-schedule-view';
import type { ScheduleDay, ScheduleItem, ScheduleReview, StudyPlan } from '@/lib/learning-types';
import { todayIso, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';
import type { Dict } from '@/i18n';
import { fmtDateTime } from '@/i18n/format';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

const weekdaysInOrder = [1, 2, 3, 4, 5, 6, 0];

const itemHref = (item: ScheduleItem) => `/learning/${item.kind === 'review' ? 'skills' : 'assignments'}/${item.id}`;
/** A calendar date (no time) in the selected language; UTC so the date never shifts. */
const readableDate = (date: string, t: Dict) => fmtDateTime(t, `${date}T00:00:00Z`, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });

function FocusDay({ t, day, today }: { t: Dict; day: ScheduleDay; today: string }) {
  const k = t.learnPlanner;
  const used = day.availableMinutes ? Math.min(100, day.plannedMinutes * 100 / day.availableMinutes) : 0;
  return (
    <article className={s.day}>
      <header className={s.dayHeader}>
        <div>
          <h3><time dateTime={day.date}>{readableDate(day.date, t)}</time></h3>
          <span className={s.caption}>{k.dayLine(day.plannedMinutes, day.availableMinutes)}</span>
        </div>
        <meter className={s.dayMeter} min={0} max={100} value={used} aria-label={k.shareAria} />
      </header>
      {day.blocks.length > 0 ? (
        <ol className={s.blocks}>
          {day.blocks.map((block) => (
            <li key={`${block.start}/${block.id}`} className={s.block}>
              <span className={s.blockTime}>{block.start}–{block.end}</span>
              <div className={s.blockContent}>
                <a href={itemHref(block)}>{block.title}</a>
                <div className={parts.rowMeta}>
                  <span>{block.kind === 'review' ? k.review : k.assignment}{block.domain ? ` · ${block.domain}` : ''}</span>
                  {block.deadline && <span className={block.deadline < today ? s.overdue : undefined}>{k.fixedDeadline(block.deadline)}</span>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : <p className={s.dayEmpty}>{day.availableMinutes ? k.noBlocks : k.noFreeTime}</p>}
    </article>
  );
}

function ReviewRows({ t, reviews, today }: { t: Dict; reviews: ScheduleReview[]; today: string }) {
  const k = t.learnPlanner;
  return (
    <ul className={s.sidebarList}>
      {reviews.map((review) => (
        <li key={review.id} className={s.sidebarRow}>
          <div>
            <a href={itemHref(review)}>{review.title}</a>
            <span className={s.caption}>{k.verifiedOn(review.verifiedDate)}</span>
          </div>
          <div className={s.reviewAside}>
            <Chip tone={review.method === 'revalidate' ? 'warn' : 'info'}>{review.method === 'revalidate' ? k.recheck : k.practice}</Chip>
            <time dateTime={review.dueDate} className={review.dueDate < today ? s.overdue : s.caption}>{review.dueDate}</time>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function LearningPlanner({ searchParams }: { searchParams: LearningSearchParams }) {
  const [sp, session, t] = await Promise.all([searchParams, requireSession(), getT()]);
  const k = t.learnPlanner;
  const today = todayIso(new Date(), SCHEDULE_TZ);
  const period = schedulePeriod(sp.period);
  const date = scheduleDate(sp.date) ?? today;
  const here = scheduleHref(date, period);
  let plan: StudyPlan | undefined;
  let reason: string | undefined;
  try {
    plan = await learning.schedule(date, period);
  } catch (error) {
    reason = errorText(error, t);
  }
  const lastDate = plan?.days.at(-1)?.date ?? date;
  const planned = plan?.days.reduce((sum, day) => sum + day.plannedMinutes, 0) ?? 0;
  const due = plan?.reviews.filter((r) => r.dueDate <= lastDate) ?? [];
  const upcoming = plan?.reviews.filter((r) => r.dueDate > lastDate) ?? [];
  const calendar = plan?.calendar;
  const canPropose = planned > 0 && (calendar === 'connected' || calendar === 'disconnected');

  return (
    <>
      <PageHeader title={k.title} sub={k.sub} />
      <Flash ok={sp.ok} error={sp.error} />
      <div className={s.toolbar}>
        <nav className={s.switch} aria-label={k.periodAria}>
          <a aria-current={period === 'day' ? 'page' : undefined} href={scheduleHref(date, 'day')}>{k.day}</a>
          <a aria-current={period === 'week' ? 'page' : undefined} href={scheduleHref(date, 'week')}>{k.week}</a>
        </nav>
        <form method="get" action="/learning/planner" className={s.dateForm}>
          <input type="hidden" name="period" value={period} />
          <label className={s.dateLabel}>{k.startDate} <input type="date" name="date" defaultValue={date} min={today} required /></label>
          <button type="submit">{k.go}</button>
          {date !== today && <a href={scheduleHref(today, period)}>{k.today}</a>}
        </form>
        {calendar && <span className={s.calendar}><Chip tone={calendar === 'connected' ? 'ok' : 'warn'}>{k.calendar[calendar] ?? calendar}</Chip></span>}
      </div>
      {!plan ? <Unavailable t={t} what={k.planWhat} reason={reason ?? k.noPlan} /> : (
        <div className={s.grid}>
          <Panel title={period === 'day' ? k.dayPlan : k.weekPlan} note={planned > 0 ? k.proposed(planned) : undefined}
            actions={canPropose ? (
              <form method="post" action="/learning/planner/change">
                <LearningPostFields csrf={session.csrf} returnTo={here} />
                <input type="hidden" name="date" value={date} />
                <input type="hidden" name="period" value={period} />
                <button type="submit" className="primary" name="intent" value="propose">{k.sendDraft}</button>
              </form>
            ) : undefined}
          >
            {calendar !== 'connected' && <Notice tone="warn">
              {calendar === 'disconnected'
                ? k.disconnectedNote
                : k.previewNote}
            </Notice>}
            <div className={s.days}>{plan.days.map((day) => <FocusDay t={t} key={day.date} day={day} today={today} />)}</div>
          </Panel>
          <div className={parts.stack}>
            <Panel title={k.skillReviews}>
              {due.length ? <ReviewRows t={t} reviews={due} today={today} /> : <p className={s.quiet}>{k.noReviews}</p>}
              {upcoming.length > 0 && (
                <details className={s.upcoming}>
                  <summary>{k.upcoming(upcoming.length)}</summary>
                  <ReviewRows t={t} reviews={upcoming} today={today} />
                </details>
              )}
            </Panel>
            {plan.remaining.length > 0 && (
              <Panel title={k.carryOver}>
                <ul className={s.sidebarList}>
                  {plan.remaining.map((item) => (
                    <li key={`${item.kind}/${item.id}`} className={s.sidebarRow}>
                      <div>
                        <a href={itemHref(item)}>{item.title}</a>
                        {item.deadline && <span className={item.deadline < today ? s.overdue : s.caption}>{k.fixedDeadline(item.deadline)}</span>}
                      </div>
                      <span className={s.duration}>{k.minutes(item.remainingMinutes)}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
            <details className={parts.disclosure}>
              <summary>{k.weeklyAvailability}</summary>
              <div className={parts.disclosureBody}>
                <form method="post" action="/learning/planner/change" className={parts.form}>
                  <LearningPostFields csrf={session.csrf} returnTo={here} />
                  <input type="hidden" name="date" value={date} />
                  <input type="hidden" name="period" value={period} />
                  <p className={parts.formHint}>{plan.availability.isDefault ? k.defaultHours : ''}{k.timeHint}</p>
                  {weekdaysInOrder.map((weekday) => {
                    const window = plan.availability.windows.find((w) => w.weekday === weekday);
                    return (
                      <fieldset className={s.availability} key={weekday}>
                        <legend>{k.weekdays[weekday]}</legend>
                        <label className={parts.field}>{k.start}
                          <input name={`start-${weekday}`} defaultValue={window?.start} placeholder="18:00" maxLength={5}
                            pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" aria-label={k.startAria(k.weekdays[weekday])} />
                        </label>
                        <label className={parts.field}>{k.end}
                          <input name={`end-${weekday}`} defaultValue={window?.end} placeholder="21:00" maxLength={5}
                            pattern="(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)" aria-label={k.endAria(k.weekdays[weekday])} />
                        </label>
                      </fieldset>
                    );
                  })}
                  <div className={parts.formActions}><button name="intent" value="availability" type="submit">{k.saveHours}</button></div>
                </form>
              </div>
            </details>
          </div>
        </div>
      )}
    </>
  );
}
