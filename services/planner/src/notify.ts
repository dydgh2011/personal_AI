// Typed events to the notifier (the only service that can post to Discord).

import type { DayView } from './planner.js';
import type { Settings } from './schedule.js';

export interface PlanDay {
  date: string;
  weekday: string;
  status: DayView['status'];
  blocks: Array<{ start: string; end: string; title: string; category: string }>;
  events: Array<{ start: string | null; end: string | null; title: string; allDay: boolean; category: string | null }>;
  unscheduled: Array<{ title: string; minutes: number }>;
  /** Open todos past their deadline (DayView.overdue); sent only when there are some. Needs notifier 2026-11-26+. */
  overdue?: Array<{ title: string; deadline: string; minutes: number }>;
}

export interface PlanMessage {
  kind: 'proposal' | 'week' | 'today';
  days: PlanDay[];
  calendarConnected: boolean;
  /** proposal: what was planned today, so the owner can say what got done. */
  todayBlocks?: Array<{ start: string; end: string; title: string }>;
  /** How reminders work now (the real settings), for the "알려드릴게요" line. Needs notifier 2026-11-26b+. */
  remind?: RemindInfo;
}

export interface RemindInfo {
  minutes: number;
  shortMinutes: number;
  /** 0: no short-event rule. */
  shortEventMinutes: number;
  scope: 'all' | 'planner';
  bundleMinutes: number;
  /** Title words of events without a reminder. */
  quiet: string[];
}

export interface ReminderMessage {
  title: string;
  /** RFC 3339 start. */
  start: string;
  minutesBefore: number;
  location: string | null;
  fromPlanner: boolean;
  /** Events starting soon after this one, reminded together (bundleMinutes). Needs notifier 2026-11-26b+. */
  also?: Array<{ title: string; start: string; location: string | null }>;
}

export function remindInfo(s: Settings): RemindInfo {
  return {
    minutes: s.remindMinutes,
    shortMinutes: s.shortRemindMinutes,
    shortEventMinutes: s.shortEventMinutes,
    scope: s.remindScope,
    bundleMinutes: s.bundleMinutes,
    quiet: s.quietEvents.slice(0, 30),
  };
}

export interface CalendarMessage {
  status: 'connect' | 'connected' | 'failed' | 'disconnected';
  authUrl?: string;
  expiresAt?: string;
  message?: string;
}

export type NotifyEvent =
  | { type: 'plan'; key: string; plan: PlanMessage }
  | { type: 'reminder'; key: string; reminder: ReminderMessage }
  | { type: 'calendar'; key: string; calendar: CalendarMessage };

export type Notify = (event: NotifyEvent) => Promise<'delivered' | 'duplicate'>;

export function planDay(view: DayView): PlanDay {
  return {
    date: view.date,
    weekday: view.weekday,
    status: view.status,
    blocks: view.blocks.map((b) => ({ start: b.start, end: b.end, title: b.title, category: b.category })),
    events: view.events.map((e) => ({ start: e.start, end: e.end, title: e.title, allDay: e.allDay, category: e.category })),
    unscheduled: view.unscheduled.map((u) => ({ title: u.title, minutes: u.minutes })),
    ...(view.overdue.length ? { overdue: view.overdue.slice(0, 20).map((o) => ({ title: o.title, deadline: o.deadline, minutes: Math.min(o.minutes, 6000) })) } : {}),
  };
}

export class NotifyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function notifierClient(url: string, key: string, timeoutMs = 15_000): Notify {
  return async (event) => {
    let res: Response;
    try {
      res = await fetch(`${url}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Notifier-Key': key },
        body: JSON.stringify(event),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new NotifyError(0, 'Notifier unreachable');
    }
    const body = (await res.json().catch(() => ({}))) as { duplicate?: boolean; message?: string };
    if (res.status === 200 && body.duplicate) return 'duplicate';
    if (res.status === 201) return 'delivered';
    throw new NotifyError(res.status, `Notifier answered ${res.status}: ${body.message ?? ''}`);
  };
}
