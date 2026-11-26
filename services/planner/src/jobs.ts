// Scheduled flows (coded, no LLM):
//   Mon-Sat draftAt (default 30 min before sleepStart, 22:30)  draft tomorrow (unless confirmed) and post it
//   Sun     draftAt                                            draft next Monday-Sunday and post the week
//   sleepEnd (default 06:00)                                   post today's plan (confirmed or not) with a mention
//   every tick     drafted blocks of finished todos leave the plan; reminders before each calendar event (quiet
//                  events skipped, events close together in one message); deadline and exam-day markers
// Final-exam days (owner decision 2026-11-26): the scheduled drafts plan nothing on them, and tomorrow's draft
// message is not posted when tomorrow is one. The morning message still shows that day's calendar.
// A job runs once per day (jobs table, keys proposal:<evening date> and morning:<date>, the same keys as before
// the times moved, so a day's job never runs twice). If the planner was down at the time, it catches up the same
// evening (until midnight) or within MORNING_WINDOW minutes after the morning time; later it is skipped.
// Failures are recorded in change_log (action "fail", once per job and error every 10 minutes) and in the log file.

import type { DatabaseSync } from 'node:sqlite';
import { NotifyError, planDay, remindInfo, type Notify } from './notify.js';
import type { Planner } from './planner.js';
import { draftMinutes, morningMinutes, reminderLead, titleHas } from './schedule.js';
import { addDays, localParts } from './time.js';

export interface JobsLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** Minutes after the morning time in which a missed morning message is still sent. */
export const MORNING_WINDOW = 4 * 60;
/** The same job failing the same way is recorded again after this long. */
const FAILURE_REPEAT_MS = 10 * 60_000;
/** At most this many events listed with one reminder. */
const MAX_BUNDLED = 5;

export class Jobs {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly failures = new Map<string, { sig: string; at: number }>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly planner: Planner,
    private readonly notify: Notify,
    private readonly logger: JobsLogger,
    private readonly now: () => number = Date.now,
  ) {}

  start(intervalMs: number): void {
    const run = () => {
      void this.tick().finally(() => {
        this.timer = setTimeout(run, intervalMs);
      });
    };
    this.timer = setTimeout(run, 2000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private done(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM jobs WHERE key = ?').get(key);
  }

  private mark(key: string): void {
    this.db.prepare('INSERT OR IGNORE INTO jobs (key, ran_at) VALUES (?, ?)').run(key, new Date(this.now()).toISOString());
  }

  /** One pass over all jobs. Errors are logged and recorded; the job is retried on the next tick. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const local = localParts(new Date(this.now()), this.planner.timeZone);
      const s = this.planner.settings();
      if (local.minutes >= draftMinutes(s)) await this.guard('proposal', () => this.proposal(local.date, local.weekday));
      const morningAt = morningMinutes(s);
      if (local.minutes >= morningAt && local.minutes < morningAt + MORNING_WINDOW) await this.guard('morning', () => this.morning(local.date));
      await this.guard('closed-todo-blocks', async () => {
        const dropped = this.planner.dropClosedTodoBlocks('system');
        if (dropped.length) this.logger.info('Dropped plan blocks of finished todos', { count: dropped.length });
      });
      await this.guard('reminders', () => this.reminders());
      await this.guard('deadlines', async () => {
        const changed = await this.planner.syncDeadlines();
        if (changed) this.logger.info('Deadline markers synced', { changed });
      });
      await this.guard('exam-markers', async () => {
        const changed = await this.planner.syncExamMarkers();
        if (changed) this.logger.info('Exam-day markers synced', { changed });
      });
    } finally {
      this.running = false;
    }
  }

  private async guard(job: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      if (this.failures.delete(job)) this.planner.logJob('recover', job, { reason: 'ran again without error' });
    } catch (error) {
      this.logger.warn('Job failed; retrying on the next tick', { job, error: (error as Error).message });
      const status = (error as { status?: unknown }).status;
      const sig = `${String(status)}|${(error as Error).message}`;
      const prev = this.failures.get(job);
      if (!prev || prev.sig !== sig || this.now() - prev.at >= FAILURE_REPEAT_MS) {
        this.failures.set(job, { sig, at: this.now() });
        this.planner.recordFailure('system', 'job', job, job, error);
      }
    }
  }

  /** Sends one event; a 400 (the event itself is invalid) is logged, recorded and not retried. */
  private async send(event: Parameters<Notify>[0]): Promise<boolean> {
    try {
      const result = await this.notify(event);
      this.logger.info('Notified', { type: event.type, key: event.key, result });
      return true;
    } catch (error) {
      if (error instanceof NotifyError && error.status === 400) {
        this.logger.warn('Notifier rejected the event; not retrying', { type: event.type, key: event.key, error: error.message });
        this.planner.recordFailure('system', 'notify', event.key, `notify ${event.type}`, error, { retried: false });
        return true;
      }
      throw error;
    }
  }

  async proposal(today: string, weekday: number): Promise<void> {
    const key = `proposal:${today}`;
    if (this.done(key)) return;
    const weekly = weekday === 0;
    const from = addDays(today, 1);
    const days = weekly ? 7 : 1;
    if (!this.done(`gen:${key}`)) {
      await this.planner.generate(from, days, 'system', { skipConfirmed: true, skipExamDays: true });
      this.mark(`gen:${key}`);
    }
    if (!weekly) {
      const exam = await this.planner.finalExamOn(from);
      if (exam) {
        // owner decision 2026-11-26: no automatic draft (and no draft message) for a final-exam day
        this.logger.info('Draft message skipped: final exam day', { date: from, exam });
        this.planner.logJob('skip', key, { date: from, reason: 'final exam day: no draft message', exam });
        this.mark(key);
        return;
      }
    }
    const views = [];
    for (let i = 0; i < days; i++) views.push(await this.planner.day(addDays(from, i)));
    const todayView = await this.planner.day(today);
    const sent = await this.send({
      type: 'plan',
      key: `plan:${weekly ? 'week' : 'proposal'}:${from}`,
      plan: {
        kind: weekly ? 'week' : 'proposal',
        days: views.map(planDay),
        calendarConnected: views[0]?.calendarConnected ?? false,
        todayBlocks: todayView.blocks.map((b) => ({ start: b.start, end: b.end, title: b.title })),
      },
    });
    if (sent) this.mark(key);
  }

  async morning(today: string): Promise<void> {
    const key = `morning:${today}`;
    if (this.done(key)) return;
    let view = await this.planner.day(today);
    // No plan because the evening draft did not run (planner down): draft today now (not on a final-exam day).
    if (view.status === 'none') view = (await this.planner.generate(today, 1, 'system', { skipExamDays: true }))[0];
    // Nothing planned and nothing in the calendar: no morning ping for an empty day.
    if (!view.blocks.length && !view.events.length && !view.unscheduled.length) {
      this.logger.info('Morning plan skipped: the day is empty', { date: today });
      this.mark(key);
      return;
    }
    const sent = await this.send({
      type: 'plan',
      key: `plan:today:${today}`,
      plan: { kind: 'today', days: [planDay(view)], calendarConnected: view.calendarConnected, remind: remindInfo(this.planner.settings()) },
    });
    if (sent) this.mark(key);
  }

  /**
   * Reminders (2026-11-26: ~15 events a day meant a ping every 30 minutes): events whose title has a quietEvents
   * word get none; when one is due, the events starting within bundleMinutes after it go in the same message and
   * get no reminder of their own.
   */
  async reminders(): Promise<void> {
    const s = this.planner.settings();
    const lookahead = Math.max(s.remindMinutes, s.shortRemindMinutes) + 1 + s.bundleMinutes;
    const events = (await this.planner.upcoming(lookahead))
      .filter((e) => e.start && (s.remindScope !== 'planner' || e.plannerBlockId) && !titleHas(e.summary, s.quietEvents))
      .sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!));
    const keyOf = (e: (typeof events)[number]) => `reminder:${e.id}:${e.start}`;
    const sentBefore = (e: (typeof events)[number]) => !!this.db.prepare('SELECT 1 FROM reminders WHERE key = ?').get(keyOf(e));
    for (const e of events) {
      if (sentBefore(e)) continue;
      const minutesLeft = (Date.parse(e.start!) - this.now()) / 60_000;
      if (minutesLeft > reminderLead(s, e.start!, e.end)) continue;
      const at = Date.parse(e.start!);
      const also = s.bundleMinutes > 0
        ? events.filter((x) => x !== e && !sentBefore(x) && Date.parse(x.start!) >= at && Date.parse(x.start!) - at <= s.bundleMinutes * 60_000).slice(0, MAX_BUNDLED)
        : [];
      const sent = await this.send({
        type: 'reminder',
        key: `reminder:${e.id.slice(0, 80)}:${at}`,
        reminder: {
          title: e.summary, start: e.start!, minutesBefore: Math.max(1, Math.round(minutesLeft)), location: e.location, fromPlanner: !!e.plannerBlockId,
          ...(also.length ? { also: also.map((x) => ({ title: x.summary, start: x.start!, location: x.location })) } : {}),
        },
      });
      if (!sent) continue;
      // Kept as a record of what was reminded (no clean-up: owner rule "keep every record").
      const insert = this.db.prepare('INSERT OR IGNORE INTO reminders (key, sent_at) VALUES (?, ?)');
      for (const x of [e, ...also]) insert.run(keyOf(x), new Date(this.now()).toISOString());
    }
  }
}
