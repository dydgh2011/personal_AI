// Scheduled flows (coded, no LLM):
//   Mon-Sat 23:00  draft tomorrow (unless confirmed) and post it for discussion
//   Sun     23:00  draft next Monday-Sunday and post the week
//   05:00          post today's plan (confirmed or not) with a mention
//   every tick     reminders `remindMinutes` before each calendar event; deadline markers in the calendar
// A job runs once per day (jobs table). If the planner was down at the time, it catches up the
// same evening (23:00-24:00) or morning (05:00-09:00); later it is skipped.

import type { DatabaseSync } from 'node:sqlite';
import { NotifyError, planDay, type Notify } from './notify.js';
import type { Planner } from './planner.js';
import { reminderLead } from './schedule.js';
import { addDays, localParts } from './time.js';

export interface JobsLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export const PROPOSAL_AT = 23 * 60;
export const MORNING_AT = 5 * 60;
const MORNING_UNTIL = 9 * 60;

export class Jobs {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

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

  /** One pass over all jobs. Errors are logged; the job is retried on the next tick. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const local = localParts(new Date(this.now()), this.planner.timeZone);
      if (local.minutes >= PROPOSAL_AT) await this.guard('proposal', () => this.proposal(local.date, local.weekday));
      if (local.minutes >= MORNING_AT && local.minutes < MORNING_UNTIL) await this.guard('morning', () => this.morning(local.date));
      await this.guard('reminders', () => this.reminders());
      await this.guard('deadlines', async () => {
        const changed = await this.planner.syncDeadlines();
        if (changed) this.logger.info('Deadline markers synced', { changed });
      });
    } finally {
      this.running = false;
    }
  }

  private async guard(job: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn('Job failed; retrying on the next tick', { job, error: (error as Error).message });
    }
  }

  /** Sends one event; a 400 (the event itself is invalid) is logged and not retried. */
  private async send(event: Parameters<Notify>[0]): Promise<boolean> {
    try {
      const result = await this.notify(event);
      this.logger.info('Notified', { type: event.type, key: event.key, result });
      return true;
    } catch (error) {
      if (error instanceof NotifyError && error.status === 400) {
        this.logger.warn('Notifier rejected the event; not retrying', { type: event.type, key: event.key, error: error.message });
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
      await this.planner.generate(from, days, 'system', { skipConfirmed: true });
      this.mark(`gen:${key}`);
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
    // No plan because the 23:00 draft did not run (planner down): draft today now.
    if (view.status === 'none') view = (await this.planner.generate(today, 1, 'system'))[0];
    // Nothing planned and nothing in the calendar: no 05:00 ping for an empty day.
    if (!view.blocks.length && !view.events.length && !view.unscheduled.length) {
      this.logger.info('Morning plan skipped: the day is empty', { date: today });
      this.mark(key);
      return;
    }
    const sent = await this.send({
      type: 'plan',
      key: `plan:today:${today}`,
      plan: { kind: 'today', days: [planDay(view)], calendarConnected: view.calendarConnected },
    });
    if (sent) this.mark(key);
  }

  async reminders(): Promise<void> {
    const s = this.planner.settings();
    const events = await this.planner.upcoming(Math.max(s.remindMinutes, s.shortRemindMinutes) + 1);
    for (const e of events) {
      if (!e.start) continue;
      if (s.remindScope === 'planner' && !e.plannerBlockId) continue;
      const minutesLeft = (Date.parse(e.start) - this.now()) / 60_000;
      if (minutesLeft > reminderLead(s, e.start, e.end)) continue;
      const key = `reminder:${e.id}:${e.start}`;
      if (this.db.prepare('SELECT 1 FROM reminders WHERE key = ?').get(key)) continue;
      const sent = await this.send({
        type: 'reminder',
        key: `reminder:${e.id.slice(0, 80)}:${Date.parse(e.start)}`,
        reminder: { title: e.summary, start: e.start, minutesBefore: Math.max(1, Math.round(minutesLeft)), location: e.location, fromPlanner: !!e.plannerBlockId },
      });
      if (sent) this.db.prepare('INSERT OR IGNORE INTO reminders (key, sent_at) VALUES (?, ?)').run(key, new Date(this.now()).toISOString());
    }
    const weekAgo = new Date(this.now() - 7 * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM reminders WHERE sent_at < ?').run(weekAgo);
  }
}
