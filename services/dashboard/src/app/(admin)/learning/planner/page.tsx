import { Chip, LearningPostFields, Notice, PageHeader, Panel } from '@/components/learning/parts';
import parts from '@/components/learning/learning.module.css';
import s from '@/components/learning/planner.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning } from '@/lib/learning';
import { scheduleDate, scheduleHref, schedulePeriod, SCHEDULE_TZ } from '@/lib/learning-schedule-view';
import type { ScheduleDay, ScheduleItem, ScheduleReview, StudyPlan } from '@/lib/learning-types';
import { todayIso, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekdaysInOrder = [1, 2, 3, 4, 5, 6, 0];
const dayLabel = new Intl.DateTimeFormat('en-CA', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });

const itemHref = (item: ScheduleItem) => `/learning/${item.kind === 'review' ? 'skills' : 'assignments'}/${item.id}`;
const readableDate = (date: string) => dayLabel.format(new Date(`${date}T00:00:00Z`));

function FocusDay({ day, today }: { day: ScheduleDay; today: string }) {
  const used = day.availableMinutes ? Math.min(100, day.plannedMinutes * 100 / day.availableMinutes) : 0;
  return (
    <article className={s.day}>
      <header className={s.dayHeader}>
        <div>
          <h3><time dateTime={day.date}>{readableDate(day.date)}</time></h3>
          <span className={s.caption}>{day.plannedMinutes} min planned · {day.availableMinutes} min available</span>
        </div>
        <meter className={s.dayMeter} min={0} max={100} value={used} aria-label="Share of free time planned" />
      </header>
      {day.blocks.length > 0 ? (
        <ol className={s.blocks}>
          {day.blocks.map((block) => (
            <li key={`${block.start}/${block.id}`} className={s.block}>
              <span className={s.blockTime}>{block.start}–{block.end}</span>
              <div className={s.blockContent}>
                <a href={itemHref(block)}>{block.title}</a>
                <div className={parts.rowMeta}>
                  <span>{block.kind === 'review' ? 'Review' : 'Assignment'}{block.domain ? ` · ${block.domain}` : ''}</span>
                  {block.deadline && <span className={block.deadline < today ? s.overdue : undefined}>Fixed deadline {block.deadline}</span>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : <p className={s.dayEmpty}>{day.availableMinutes ? 'No study blocks for this day.' : 'No free study time for this day.'}</p>}
    </article>
  );
}

function ReviewRows({ reviews, today }: { reviews: ScheduleReview[]; today: string }) {
  return (
    <ul className={s.sidebarList}>
      {reviews.map((review) => (
        <li key={review.id} className={s.sidebarRow}>
          <div>
            <a href={itemHref(review)}>{review.title}</a>
            <span className={s.caption}>Verified {review.verifiedDate}</span>
          </div>
          <div className={s.reviewAside}>
            <Chip tone={review.method === 'revalidate' ? 'warn' : 'info'}>{review.method === 'revalidate' ? 'Recheck' : 'Practice'}</Chip>
            <time dateTime={review.dueDate} className={review.dueDate < today ? s.overdue : s.caption}>{review.dueDate}</time>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function LearningPlanner({ searchParams }: { searchParams: LearningSearchParams }) {
  const [sp, session] = await Promise.all([searchParams, requireSession()]);
  const today = todayIso(new Date(), SCHEDULE_TZ);
  const period = schedulePeriod(sp.period);
  const date = scheduleDate(sp.date) ?? today;
  const here = scheduleHref(date, period);
  let plan: StudyPlan | undefined;
  let reason: string | undefined;
  try {
    plan = await learning.schedule(date, period);
  } catch (error) {
    reason = errorText(error);
  }
  const lastDate = plan?.days.at(-1)?.date ?? date;
  const planned = plan?.days.reduce((sum, day) => sum + day.plannedMinutes, 0) ?? 0;
  const due = plan?.reviews.filter((r) => r.dueDate <= lastDate) ?? [];
  const upcoming = plan?.reviews.filter((r) => r.dueDate > lastDate) ?? [];
  const calendar = plan?.calendar;
  const canPropose = planned > 0 && (calendar === 'connected' || calendar === 'disconnected');
  const calendarText = {
    connected: 'Kelly calendar connected',
    disconnected: 'Kelly calendar disconnected',
    unconfigured: 'Planner not configured',
    unavailable: 'Planner unavailable',
  } as const;

  return (
    <>
      <PageHeader title="Study planner" sub="Plan assignments and skill reviews in your available time. Times are in America/Toronto." />
      <Flash ok={sp.ok} error={sp.error} />
      <div className={s.toolbar}>
        <nav className={s.switch} aria-label="Plan period">
          <a aria-current={period === 'day' ? 'page' : undefined} href={scheduleHref(date, 'day')}>Day</a>
          <a aria-current={period === 'week' ? 'page' : undefined} href={scheduleHref(date, 'week')}>Week</a>
        </nav>
        <form method="get" action="/learning/planner" className={s.dateForm}>
          <input type="hidden" name="period" value={period} />
          <label className={s.dateLabel}>Start date <input type="date" name="date" defaultValue={date} min={today} required /></label>
          <button type="submit">Go</button>
          {date !== today && <a href={scheduleHref(today, period)}>Today</a>}
        </form>
        {calendar && <span className={s.calendar}><Chip tone={calendar === 'connected' ? 'ok' : 'warn'}>{calendarText[calendar]}</Chip></span>}
      </div>
      {!plan ? <Unavailable what="Study plan" reason={reason ?? 'Learning service did not return a plan'} /> : (
        <div className={s.grid}>
          <Panel title={period === 'day' ? 'Day plan' : '7-day plan'} note={planned > 0 ? `${planned} min of proposed study time` : undefined}
            actions={canPropose ? (
              <form method="post" action="/learning/planner/change">
                <LearningPostFields csrf={session.csrf} returnTo={here} />
                <input type="hidden" name="date" value={date} />
                <input type="hidden" name="period" value={period} />
                <button type="submit" className="primary" name="intent" value="propose">Send draft to Planner</button>
              </form>
            ) : undefined}
          >
            {calendar !== 'connected' && <Notice tone="warn">
              {calendar === 'disconnected'
                ? 'Calendar events are unavailable. Connect Kelly before approving a draft.'
                : 'This preview uses your saved hours. Sending a draft requires the Planner service.'}
            </Notice>}
            <div className={s.days}>{plan.days.map((day) => <FocusDay key={day.date} day={day} today={today} />)}</div>
          </Panel>
          <div className={parts.stack}>
            <Panel title="Skill reviews">
              {due.length ? <ReviewRows reviews={due} today={today} /> : <p className={s.quiet}>No reviews due in this period.</p>}
              {upcoming.length > 0 && (
                <details className={s.upcoming}>
                  <summary>Upcoming ({upcoming.length})</summary>
                  <ReviewRows reviews={upcoming} today={today} />
                </details>
              )}
            </Panel>
            {plan.remaining.length > 0 && (
              <Panel title="Carry over">
                <ul className={s.sidebarList}>
                  {plan.remaining.map((item) => (
                    <li key={`${item.kind}/${item.id}`} className={s.sidebarRow}>
                      <div>
                        <a href={itemHref(item)}>{item.title}</a>
                        {item.deadline && <span className={item.deadline < today ? s.overdue : s.caption}>Fixed deadline {item.deadline}</span>}
                      </div>
                      <span className={s.duration}>{item.remainingMinutes} min</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
            <details className={parts.disclosure}>
              <summary>Weekly availability</summary>
              <div className={parts.disclosureBody}>
                <form method="post" action="/learning/planner/change" className={parts.form}>
                  <LearningPostFields csrf={session.csrf} returnTo={here} />
                  <input type="hidden" name="date" value={date} />
                  <input type="hidden" name="period" value={period} />
                  <p className={parts.formHint}>{plan.availability.isDefault ? 'Default hours. ' : ''}Use 24-hour times. Leave both fields blank for a day off.</p>
                  {weekdaysInOrder.map((weekday) => {
                    const window = plan.availability.windows.find((w) => w.weekday === weekday);
                    return (
                      <fieldset className={s.availability} key={weekday}>
                        <legend>{weekdays[weekday]}</legend>
                        <label className={parts.field}>Start
                          <input name={`start-${weekday}`} defaultValue={window?.start} placeholder="18:00" maxLength={5}
                            pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" aria-label={`${weekdays[weekday]} start`} />
                        </label>
                        <label className={parts.field}>End
                          <input name={`end-${weekday}`} defaultValue={window?.end} placeholder="21:00" maxLength={5}
                            pattern="(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)" aria-label={`${weekdays[weekday]} end`} />
                        </label>
                      </fieldset>
                    );
                  })}
                  <div className={parts.formActions}><button name="intent" value="availability" type="submit">Save hours</button></div>
                </form>
              </div>
            </details>
          </div>
        </div>
      )}
    </>
  );
}
