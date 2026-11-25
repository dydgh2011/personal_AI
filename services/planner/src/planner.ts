import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GoogleConnection } from './connection.js';
import { planChecks, type CheckEvent, type CheckItem } from './checks.js';
import { transaction } from './db.js';
import { CATEGORIES, CATEGORY_LABEL, GoogleError, isCategory, type CalendarApi, type CalendarEvent, type Category, type EventInput, type Timing } from './google.js';
import { DEFAULT_SETTINGS, draftDay, type Interval, type SchedTodo, type Settings } from './schedule.js';
import {
  addDays,
  daysBetween,
  fromMinutes,
  isValidDate,
  isValidTime,
  KOREAN_WEEKDAYS,
  localParts,
  toInstant,
  toMinutes,
  weekdayOf,
} from './time.js';

export class PlannerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const bad = (message: string) => new PlannerError(400, 'invalid_request', message);

export type Actor = 'hermes' | 'system' | 'calendar' | 'learning';

interface LearningTask { key: string; deadline: string | null; estimateMinutes: number; priority: number }
export type TodoKind = 'task' | 'study' | 'habit';

export interface Todo {
  id: string;
  title: string;
  notes: string | null;
  kind: TodoKind;
  priority: number;
  estimateMinutes: number;
  doneMinutes: number;
  deadline: string | null;
  earliest: string | null;
  status: 'open' | 'done' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface Block {
  id: string;
  date: string;
  start: string;
  end: string;
  title: string;
  todoId: string | null;
  origin: 'auto' | 'manual';
  category: Category;
  inCalendar: boolean;
  /** Changed since the last confirm (or never confirmed). */
  pending: boolean;
}

export interface EventView {
  /** Google event id (an instance id for recurring events). */
  id: string;
  /** Series id when the event repeats. */
  seriesId: string | null;
  start: string | null; // HH:MM local on this date (null: all-day)
  end: string | null;
  title: string;
  allDay: boolean;
  location: string | null;
  category: Category | null;
  /** A deadline marker the planner keeps for a todo (change the todo, not the event). */
  deadline: boolean;
}

export type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'yearly';
const REPEATS: Repeat[] = ['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'];
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const KIND_CATEGORY: Record<TodoKind, Category> = { task: 'task', study: 'study', habit: 'routine' };
export const MANAGED_CALENDAR_NAME = 'Kelly';

export interface DayView {
  date: string;
  weekday: string;
  status: 'none' | 'draft' | 'confirmed';
  /** Confirmed plan with edits not yet written to the calendar. */
  pendingChanges: boolean;
  blocks: Block[];
  /** The owner's other calendar events (classes, appointments...). */
  events: EventView[];
  unscheduled: Array<{ todoId: string; title: string; minutes: number }>;
  warnings: string[];
  calendarConnected: boolean;
}

interface BlockRow {
  id: string;
  date: string;
  start: string;
  end: string;
  title: string;
  todo_id: string | null;
  origin: 'auto' | 'manual';
  category: Category;
  removed: number;
  google_event_id: string | null;
  synced_date: string | null;
  synced_start: string | null;
  synced_end: string | null;
  synced_title: string | null;
}

interface TodoRow {
  id: string;
  title: string;
  notes: string | null;
  kind: TodoKind;
  priority: number;
  estimate_minutes: number;
  done_minutes: number;
  deadline: string | null;
  earliest: string | null;
  status: Todo['status'];
  created_at: string;
  updated_at: string;
}

const MAX_TITLE = 200;
const MAX_NOTES = 2000;

function text(value: unknown, field: string, max: number, required = true): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw bad(`${field} must be text`);
  const v = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!v && required) throw bad(`${field} must not be blank`);
  if (v.length > max) throw bad(`${field} is longer than ${max} characters`);
  return v || null;
}

function int(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw bad(`${field} must be a whole number between ${min} and ${max}`);
  }
  return value;
}

function date(value: unknown, field: string): string {
  if (!isValidDate(value)) throw bad(`${field} must be a date YYYY-MM-DD`);
  return value;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return date(value, field);
}

function time(value: unknown, field: string): string {
  if (!isValidTime(value)) throw bad(`${field} must be a time HH:MM (00:00-24:00)`);
  return value;
}

function only(body: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw bad(`Unexpected fields: ${extra.join(', ')}`);
}

const SETTING_RULES: Record<keyof Settings, (v: unknown) => unknown> = {
  dayStart: (v) => time(v, 'dayStart'),
  dayEnd: (v) => time(v, 'dayEnd'),
  maxFocusMinutes: (v) => int(v, 'maxFocusMinutes', 30, 960),
  breakMinutes: (v) => int(v, 'breakMinutes', 0, 60),
  maxBlockMinutes: (v) => int(v, 'maxBlockMinutes', 15, 240),
  minBlockMinutes: (v) => int(v, 'minBlockMinutes', 10, 120),
  undatedDailyMinutes: (v) => int(v, 'undatedDailyMinutes', 15, 600),
  remindMinutes: (v) => int(v, 'remindMinutes', 1, 120),
  remindScope: (v) => {
    if (v !== 'all' && v !== 'planner') throw bad('remindScope must be "all" or "planner"');
    return v;
  },
  shortEventMinutes: (v) => int(v, 'shortEventMinutes', 0, 240),
  shortRemindMinutes: (v) => int(v, 'shortRemindMinutes', 1, 120),
  sleepStart: (v) => time(v, 'sleepStart'),
  sleepEnd: (v) => time(v, 'sleepEnd'),
  lastBus: (v) => {
    if (v === null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) throw bad('lastBus must be {weekday, saturday, sunday} (HH:MM) or null');
    const o = v as Record<string, unknown>;
    only(o, ['weekday', 'saturday', 'sunday']);
    return { weekday: time(o.weekday, 'lastBus.weekday'), saturday: time(o.saturday, 'lastBus.saturday'), sunday: time(o.sunday, 'lastBus.sunday') };
  },
  homePlace: (v) => text(v, 'homePlace', 40),
  places: (v) => {
    if (!Array.isArray(v) || v.length > 30) throw bad('places must list up to 30 {name, match[]}');
    return v.map((p, i) => {
      if (!p || typeof p !== 'object') throw bad(`places[${i + 1}] must be {name, match[]}`);
      const o = p as Record<string, unknown>;
      only(o, ['name', 'match']);
      if (!Array.isArray(o.match) || !o.match.length || o.match.length > 20) throw bad(`places[${i + 1}].match must list 1-20 words`);
      return { name: text(o.name, `places[${i + 1}].name`, 40)!, match: o.match.map((m, j) => text(m, `places[${i + 1}].match[${j + 1}]`, 60)!) };
    });
  },
  travel: (v) => {
    if (!Array.isArray(v) || v.length > 60) throw bad('travel must list up to 60 {from, to, minutes}');
    return v.map((t, i) => {
      if (!t || typeof t !== 'object') throw bad(`travel[${i + 1}] must be {from, to, minutes}`);
      const o = t as Record<string, unknown>;
      only(o, ['from', 'to', 'minutes']);
      return { from: text(o.from, `travel[${i + 1}].from`, 40)!, to: text(o.to, `travel[${i + 1}].to`, 40)!, minutes: int(o.minutes, `travel[${i + 1}].minutes`, 0, 600) };
    });
  },
  protectedEvents: (v) => {
    if (!Array.isArray(v) || v.length > 30) throw bad('protectedEvents must list up to 30 words');
    return v.map((w, i) => text(w, `protectedEvents[${i + 1}]`, 60)!);
  },
};

/**
 * The planner: todos, per-day plans (draft -> confirmed) and the sync of confirmed plans to
 * Google Calendar, which stays the source of truth (changes made there are read back).
 * Every change is written to change_log with who made it.
 */
export class Planner {
  constructor(
    private readonly db: DatabaseSync,
    readonly google: GoogleConnection,
    readonly timeZone: string,
    private readonly now: () => number = Date.now,
  ) {}

  // ---- managed calendar -----------------------------------------------------------------

  private verified: { id: string; at: number } | null = null;
  private ensuring: Promise<string> | null = null;
  private applyingProposal = false;

  private meta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /**
   * The calendar the planner owns ("Kelly"), created on first use. Every plan block, deadline
   * marker and fixed event lives there; the owner's other calendars are only read by the import.
   */
  async cal(): Promise<CalendarApi | null> {
    const account = this.google.account();
    if (!account) return null;
    const known = this.meta('managed_calendar_id');
    if (known && this.verified?.id === known && this.now() - this.verified.at < 10 * 60_000) return account.calendar(known);
    this.ensuring ??= (async () => {
      const list = await account.calendarList();
      let id = this.meta('managed_calendar_id');
      if (!id || !list.some((c) => c.id === id)) {
        const name = this.meta('managed_calendar_name') ?? MANAGED_CALENDAR_NAME;
        id = await account.createCalendar(name, 'Personal AI(Kelly)가 관리하는 캘린더. 계획·마감·고정 일정이 모두 여기 있어요.');
        transaction(this.db, () => {
          this.setMeta('managed_calendar_id', id!);
          this.setMeta('managed_calendar_name', name);
          // Events of a previous (deleted) managed calendar are gone: forget their ids.
          this.db.prepare('UPDATE blocks SET google_event_id = NULL, synced_date = NULL, synced_start = NULL, synced_end = NULL, synced_title = NULL').run();
          this.db.prepare('DELETE FROM blocks WHERE removed = 1').run();
          this.db.prepare('UPDATE todos SET deadline_event_id = NULL, deadline_synced = NULL').run();
          this.db.prepare('DELETE FROM imported').run();
          this.log('system', 'create', 'calendar', id, { name, reason: known ? 'the managed calendar was missing' : 'first use' });
        });
      }
      this.verified = { id: id!, at: this.now() };
      return id!;
    })().finally(() => {
      this.ensuring = null;
    });
    return account.calendar(await this.ensuring);
  }

  managedCalendar(): { name: string; created: boolean } {
    return { name: this.meta('managed_calendar_name') ?? MANAGED_CALENDAR_NAME, created: this.meta('managed_calendar_id') !== null };
  }

  // ---- clock ----------------------------------------------------------------------------

  today(): string {
    return localParts(new Date(this.now()), this.timeZone).date;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private log(actor: Actor, action: string, entity: string, entityId: string | null, detail: unknown) {
    this.db
      .prepare('INSERT INTO change_log (ts, actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.iso(), actor, action, entity, entityId, JSON.stringify(detail));
  }

  changes(limit = 30): Array<{ ts: string; actor: string; action: string; entity: string; entityId: string | null; detail: unknown }> {
    const rows = this.db.prepare('SELECT * FROM change_log ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 200)) as Array<
      Record<string, string>
    >;
    return rows.map((r) => ({ ts: r.ts, actor: r.actor, action: r.action, entity: r.entity, entityId: r.entity_id, detail: JSON.parse(r.detail) }));
  }

  // ---- settings -------------------------------------------------------------------------

  settings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  updateSettings(body: Record<string, unknown>, actor: Actor): Settings {
    only(body, Object.keys(SETTING_RULES));
    const next = { ...this.settings() };
    for (const [key, value] of Object.entries(body)) (next as Record<string, unknown>)[key] = SETTING_RULES[key as keyof Settings](value);
    if (toMinutes(next.dayStart) >= toMinutes(next.dayEnd)) throw bad('dayStart must be before dayEnd');
    if (next.minBlockMinutes > next.maxBlockMinutes) throw bad('minBlockMinutes must not exceed maxBlockMinutes');
    const before = this.settings();
    transaction(this.db, () => {
      for (const key of Object.keys(body)) {
        this.db
          .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(key, JSON.stringify((next as Record<string, unknown>)[key]));
      }
      this.log(actor, 'update', 'settings', null, { before: pick(before, Object.keys(body)), after: pick(next, Object.keys(body)) });
    });
    return next;
  }

  // ---- todos ----------------------------------------------------------------------------

  private todoRow(id: string): TodoRow {
    const row = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as TodoRow | undefined;
    if (!row) throw new PlannerError(404, 'not_found', `Todo ${id} not found`);
    return row;
  }

  listTodos(status: 'open' | 'done' | 'all' = 'open'): Todo[] {
    const rows = (
      status === 'all'
        ? this.db.prepare("SELECT * FROM todos WHERE status != 'archived' ORDER BY created_at").all()
        : this.db.prepare('SELECT * FROM todos WHERE status = ? ORDER BY created_at').all(status)
    ) as unknown as TodoRow[];
    return rows.map(toTodo);
  }

  addTodo(body: Record<string, unknown>, actor: Actor): Todo {
    only(body, ['title', 'notes', 'kind', 'priority', 'estimateMinutes', 'deadline', 'earliest']);
    const kind = body.kind ?? 'task';
    if (kind !== 'task' && kind !== 'study' && kind !== 'habit') throw bad('kind must be task, study or habit');
    const todo = {
      id: randomUUID(),
      title: text(body.title, 'title', MAX_TITLE)!,
      notes: text(body.notes, 'notes', MAX_NOTES, false),
      kind,
      priority: body.priority === undefined ? 2 : int(body.priority, 'priority', 1, 3),
      estimate: int(body.estimateMinutes, 'estimateMinutes', 5, 100 * 60),
      deadline: optionalDate(body.deadline, 'deadline'),
      earliest: optionalDate(body.earliest, 'earliest'),
    };
    const now = this.iso();
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO todos (id, title, notes, kind, priority, estimate_minutes, deadline, earliest, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(todo.id, todo.title, todo.notes, todo.kind, todo.priority, todo.estimate, todo.deadline, todo.earliest, now, now);
      this.log(actor, 'create', 'todo', todo.id, { ...todo });
    });
    return toTodo(this.todoRow(todo.id));
  }

  updateTodo(id: string, body: Record<string, unknown>, actor: Actor): Todo {
    only(body, ['title', 'notes', 'kind', 'priority', 'estimateMinutes', 'deadline', 'earliest', 'doneMinutes', 'status']);
    const row = this.todoRow(id);
    const sets: Record<string, unknown> = {};
    if ('title' in body) sets.title = text(body.title, 'title', MAX_TITLE);
    if ('notes' in body) sets.notes = text(body.notes, 'notes', MAX_NOTES, false);
    if ('kind' in body) {
      if (!['task', 'study', 'habit'].includes(body.kind as string)) throw bad('kind must be task, study or habit');
      sets.kind = body.kind;
    }
    if ('priority' in body) sets.priority = int(body.priority, 'priority', 1, 3);
    if ('estimateMinutes' in body) sets.estimate_minutes = int(body.estimateMinutes, 'estimateMinutes', 5, 100 * 60);
    if ('deadline' in body) sets.deadline = optionalDate(body.deadline, 'deadline');
    if ('earliest' in body) sets.earliest = optionalDate(body.earliest, 'earliest');
    if ('doneMinutes' in body) sets.done_minutes = int(body.doneMinutes, 'doneMinutes', 0, 100 * 60);
    if ('status' in body) {
      if (!['open', 'done', 'archived'].includes(body.status as string)) throw bad('status must be open, done or archived');
      sets.status = body.status;
    }
    if (!Object.keys(sets).length) throw bad('Nothing to change');
    const before = toTodo(row);
    transaction(this.db, () => {
      const cols = Object.keys(sets);
      this.db
        .prepare(`UPDATE todos SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...(cols.map((c) => sets[c]) as Array<string | number | null>), this.iso(), id);
      const after = toTodo(this.todoRow(id));
      this.log(actor, 'update', 'todo', id, { changes: diff(before, after) });
    });
    return toTodo(this.todoRow(id));
  }

  /** Records progress (minutes spent); marks the todo done when `done` or the estimate is reached. */
  progressTodo(id: string, minutes: number | undefined, done: boolean, actor: Actor): Todo {
    const row = this.todoRow(id);
    const add = minutes === undefined ? 0 : int(minutes, 'minutes', 0, 24 * 60);
    const total = Math.min(row.done_minutes + add, 100 * 60);
    const finished = done || total >= row.estimate_minutes;
    transaction(this.db, () => {
      this.db
        .prepare('UPDATE todos SET done_minutes = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(finished ? Math.max(total, row.done_minutes) : total, finished ? 'done' : row.status, this.iso(), id);
      this.log(actor, finished ? 'complete' : 'progress', 'todo', id, { addedMinutes: add, doneMinutes: total, title: row.title });
    });
    return toTodo(this.todoRow(id));
  }

  // ---- calendar reads -------------------------------------------------------------------

  private dayRange(day: string): { timeMin: string; timeMax: string } {
    return {
      timeMin: toInstant(day, '00:00', this.timeZone).toISOString(),
      timeMax: toInstant(addDays(day, 1), '00:00', this.timeZone).toISOString(),
    };
  }

  /** The part of an event that falls on `day`, in local minutes. */
  private clip(e: CalendarEvent, day: string): Interval | null {
    if (e.allDay || !e.start || !e.end) return null;
    const dayStart = toInstant(day, '00:00', this.timeZone).getTime();
    const dayEnd = toInstant(addDays(day, 1), '00:00', this.timeZone).getTime();
    const s = Math.max(Date.parse(e.start), dayStart);
    const t = Math.min(Date.parse(e.end), dayEnd);
    if (t <= s) return null;
    return { start: Math.round((s - dayStart) / 60_000), end: Math.round((t - dayStart) / 60_000) };
  }

  private async calendarEvents(cal: CalendarApi, day: string): Promise<CalendarEvent[]> {
    const { timeMin, timeMax } = this.dayRange(day);
    return (await cal.listEvents(timeMin, timeMax)).filter((e) => e.status !== 'cancelled');
  }

  /** Owner's own events that block time (not the planner's, not free, not declined). */
  private busyFrom(events: CalendarEvent[], day: string): Interval[] {
    return events
      .filter((e) => !e.plannerBlockId && !e.transparent && !e.declined)
      .map((e) => this.clip(e, day))
      .filter((i): i is Interval => i !== null);
  }

  /**
   * Only wall-clock busy intervals leave the Planner. This read must not create a calendar,
   * reconcile the database, or return titles and personal event details to Learning.
   */
  async learningAvailability(start: string, days: number) {
    const known = this.meta('managed_calendar_id');
    const cal = known ? this.google.account()?.calendar(known) : undefined;
    const last = addDays(start, days - 1);
    const events = cal ? await cal.listEvents(this.dayRange(start).timeMin, this.dayRange(last).timeMax) : [];
    return {
      timeZone: this.timeZone,
      calendarConnected: !!cal,
      reserved: this.learningReservations(),
      days: Array.from({ length: days }, (_, index) => {
        const date = addDays(start, index);
        return { date, busy: this.learningBusy(events, date) };
      }),
    };
  }

  private learningReservations() {
    const references = this.db.prepare(`
      SELECT DISTINCT json_extract(spec, '$.learningTask.key') AS key
      FROM proposal_items WHERE event_id IS NOT NULL AND json_type(spec, '$.learningTask.key') = 'text'
    `).all() as Array<{ key: string }>;
    const now = localParts(new Date(this.now()), this.timeZone);
    const rows = this.db.prepare(`
      SELECT date, start, end FROM blocks WHERE todo_id = ? AND removed = 0 AND date >= ?
    `);
    return references.map(({ key }) => {
      const blocks = rows.all(stableUuid(`learning-todo:${key}`), now.date) as Array<{ date: string; start: string; end: string }>;
      const minutes = blocks.reduce((sum, block) => {
        const start = block.date === now.date ? Math.max(now.minutes, toMinutes(block.start)) : toMinutes(block.start);
        return sum + Math.max(0, toMinutes(block.end) - start);
      }, 0);
      return { key, minutes };
    }).filter((item) => item.minutes > 0);
  }

  private learningBusy(events: CalendarEvent[], date: string, ignore = new Set<string>()): Interval[] {
    const { timeMin, timeMax } = this.dayRange(date);
    const begin = Date.parse(timeMin);
    const end = Date.parse(timeMax);
    const blocks = this.blocks(date).map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) }));
    for (const event of events) {
      if (ignore.has(event.id) || event.status === 'cancelled' || event.transparent || event.declined || event.deadlineTodoId) continue;
      if (event.allDay) {
        if (event.date && event.endDate && event.date <= date && date < event.endDate) blocks.push({ start: 0, end: 1440 });
        continue;
      }
      if (!event.start || !event.end) continue;
      const from = Math.max(begin, Date.parse(event.start));
      const to = Math.min(end, Date.parse(event.end));
      if (!(to > from)) continue;
      const start = from === begin ? 0 : localParts(new Date(from), this.timeZone).minutes;
      const finish = to === end ? 1440 : localParts(new Date(to), this.timeZone).minutes + (to % 60_000 === 0 ? 0 : 1);
      if (finish > start) blocks.push({ start, end: finish });
    }
    return blocks;
  }

  // ---- plans ----------------------------------------------------------------------------

  private blocks(day: string, includeRemoved = false): BlockRow[] {
    return this.db
      .prepare(`SELECT * FROM blocks WHERE date = ? ${includeRemoved ? '' : 'AND removed = 0'} ORDER BY start`)
      .all(day) as unknown as BlockRow[];
  }

  private plan(day: string): { status: 'draft' | 'confirmed'; unscheduled: string } | undefined {
    return this.db.prepare('SELECT status, unscheduled FROM plans WHERE date = ?').get(day) as
      | { status: 'draft' | 'confirmed'; unscheduled: string }
      | undefined;
  }

  private touchPlan(day: string, status: 'draft' | 'confirmed', extra: { generated?: boolean; unscheduled?: unknown } = {}) {
    const now = this.iso();
    this.db
      .prepare(
        `INSERT INTO plans (date, status, generated_at, confirmed_at, unscheduled, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET status = excluded.status,
           generated_at = COALESCE(excluded.generated_at, plans.generated_at),
           confirmed_at = COALESCE(excluded.confirmed_at, plans.confirmed_at),
           unscheduled = CASE WHEN ? THEN excluded.unscheduled ELSE plans.unscheduled END,
           updated_at = excluded.updated_at`,
      )
      .run(
        day,
        status,
        extra.generated ? now : null,
        status === 'confirmed' ? now : null,
        JSON.stringify(extra.unscheduled ?? []),
        now,
        extra.unscheduled !== undefined ? 1 : 0,
      );
  }

  /** A plan that was confirmed and is edited again goes back to draft until it is confirmed. */
  private markEdited(day: string) {
    const p = this.plan(day);
    this.touchPlan(day, 'draft');
    if (p?.status === 'confirmed') this.log('system', 'reopen', 'plan', day, { reason: 'edited after confirmation' });
  }

  private plannedElsewhere(todoId: string, except: Set<string>): number {
    const rows = this.db
      .prepare('SELECT date, start, end FROM blocks WHERE todo_id = ? AND removed = 0 AND date >= ?')
      .all(todoId, this.today()) as Array<{ date: string; start: string; end: string }>;
    return rows.filter((r) => !except.has(r.date)).reduce((sum, r) => sum + toMinutes(r.end) - toMinutes(r.start), 0);
  }

  /**
   * Drafts `days` consecutive days starting at `from`: replaces the auto-planned blocks of those
   * days (manual blocks stay), working around the owner's calendar events. Confirmed days become
   * drafts again; their calendar events are updated only on the next confirm.
   */
  async generate(from: string, days: number, actor: Actor, options: { skipConfirmed?: boolean } = {}): Promise<DayView[]> {
    date(from, 'date');
    int(days, 'days', 1, 14);
    if (daysBetween(this.today(), from) < 0) throw bad('Cannot plan a day in the past');
    const all = Array.from({ length: days }, (_, i) => addDays(from, i));
    // The scheduled 23:00 drafts never undo a plan the owner already confirmed.
    const dates = options.skipConfirmed ? all.filter((d) => this.plan(d)?.status !== 'confirmed') : all;
    const cal = await this.cal();
    const eventsByDay = new Map<string, CalendarEvent[]>();
    if (cal) for (const d of dates) eventsByDay.set(d, await this.calendarEvents(cal, d));
    const s = this.settings();

    transaction(this.db, () => {
      // Replace auto blocks: never-synced ones are deleted, synced ones are marked for removal.
      for (const d of dates) {
        this.db.prepare("DELETE FROM blocks WHERE date = ? AND origin = 'auto' AND google_event_id IS NULL").run(d);
        this.db.prepare("UPDATE blocks SET removed = 1, updated_at = ? WHERE date = ? AND origin = 'auto'").run(this.iso(), d);
      }
      const targets = new Set(dates);
      const remaining = new Map<string, number>();
      const todos = this.listTodos('open');
      for (const t of todos) remaining.set(t.id, t.estimateMinutes - t.doneMinutes - this.plannedElsewhere(t.id, targets));

      for (const d of dates) {
        const kept = this.blocks(d);
        const busy = [...this.busyFrom(eventsByDay.get(d) ?? [], d), ...kept.map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) }))];
        const keptMinutes = kept.reduce((sum, b) => sum + toMinutes(b.end) - toMinutes(b.start), 0);
        const sched: SchedTodo[] = todos.map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          remaining: (remaining.get(t.id) ?? 0) - kept.filter((b) => b.todo_id === t.id).reduce((x, b) => x + toMinutes(b.end) - toMinutes(b.start), 0),
          kind: t.kind,
          deadline: t.deadline,
          earliest: t.earliest,
          createdAt: t.createdAt,
        }));
        const draft = draftDay(d, s, busy, sched, keptMinutes);
        const now = this.iso();
        for (const b of draft.blocks) {
          const id = randomUUID();
          const kind = todos.find((t) => t.id === b.todoId)?.kind ?? 'task';
          this.db
            .prepare(
              `INSERT INTO blocks (id, date, start, end, title, todo_id, origin, category, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?)`,
            )
            .run(id, d, fromMinutes(b.start), fromMinutes(b.end), b.title, b.todoId, KIND_CATEGORY[kind], now, now);
          remaining.set(b.todoId, (remaining.get(b.todoId) ?? 0) - (b.end - b.start));
        }
        const wasConfirmed = this.plan(d)?.status === 'confirmed';
        this.touchPlan(d, 'draft', { generated: true, unscheduled: draft.unscheduled });
        this.log(actor, 'generate', 'plan', d, {
          blocks: draft.blocks.map((b) => `${fromMinutes(b.start)}-${fromMinutes(b.end)} ${b.title}`),
          unscheduled: draft.unscheduled,
          wasConfirmed,
          calendarEvents: (eventsByDay.get(d) ?? []).length,
        });
      }
    });
    const views: DayView[] = [];
    for (const d of all) views.push(await this.day(d, { events: eventsByDay.get(d), reconcile: !dates.includes(d) }));
    return views;
  }

  /** The plan of one day with the owner's calendar events. Reads calendar changes back first. */
  async day(day: string, options: { events?: CalendarEvent[]; reconcile?: boolean } = {}): Promise<DayView> {
    date(day, 'date');
    const warnings: string[] = [];
    let cal: CalendarApi | null = null;
    try {
      cal = await this.cal();
    } catch (error) {
      warnings.push(`Google Calendar could not be read: ${(error as Error).message}`);
    }
    let events = options.events;
    if (cal) {
      try {
        if (options.reconcile !== false) await this.reconcile(cal, day);
        events ??= await this.calendarEvents(cal, day);
      } catch (error) {
        warnings.push(`Google Calendar could not be read: ${(error as Error).message}`);
      }
    }
    const plan = this.plan(day);
    const rows = this.blocks(day);
    const removedSynced = (this.db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE date = ? AND removed = 1').get(day) as { n: number }).n;
    const blocks = rows.map((r) => toBlock(r));
    const eventViews: EventView[] = (events ?? [])
      .filter((e) => !e.plannerBlockId && !e.declined)
      .map((e) => {
        const c = this.clip(e, day);
        return {
          id: e.id,
          seriesId: e.recurringEventId,
          start: c ? fromMinutes(c.start) : null,
          end: c ? fromMinutes(c.end) : null,
          title: e.summary,
          allDay: e.allDay,
          location: e.location,
          category: e.category,
          deadline: e.deadlineTodoId !== null,
        };
      });
    const busy = this.busyFrom(events ?? [], day);
    for (let i = 0; i < blocks.length; i++) {
      const a = blocks[i];
      for (const b of blocks.slice(i + 1)) {
        if (toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end)) warnings.push(`"${a.title}" overlaps "${b.title}"`);
      }
      const clash = busy.find((x) => toMinutes(a.start) < x.end && x.start < toMinutes(a.end));
      if (clash) warnings.push(`"${a.title}" (${a.start}-${a.end}) overlaps a calendar event at ${fromMinutes(clash.start)}`);
    }
    return {
      date: day,
      weekday: KOREAN_WEEKDAYS[weekdayOf(day)],
      status: plan ? plan.status : 'none',
      pendingChanges: plan?.status === 'draft' && (blocks.some((b) => b.inCalendar) || removedSynced > 0),
      blocks,
      events: eventViews,
      unscheduled: plan ? JSON.parse(plan.unscheduled) : [],
      warnings,
      calendarConnected: cal !== null,
    };
  }

  private blockRow(id: string): BlockRow {
    const row = this.db.prepare('SELECT * FROM blocks WHERE id = ? AND removed = 0').get(id) as BlockRow | undefined;
    if (!row) throw new PlannerError(404, 'not_found', `Block ${id} not found`);
    return row;
  }

  private checkTimes(start: string, end: string) {
    if (toMinutes(start) >= toMinutes(end)) throw bad('start must be before end');
  }

  addBlock(body: Record<string, unknown>, actor: Actor): Block {
    only(body, ['date', 'start', 'end', 'title', 'todoId', 'category']);
    const d = date(body.date, 'date');
    if (body.category !== undefined && !isCategory(body.category)) throw bad(`category must be one of ${CATEGORIES.join(', ')}`);
    if (daysBetween(this.today(), d) < 0) throw bad('Cannot plan a day in the past');
    const start = time(body.start, 'start');
    const end = time(body.end, 'end');
    this.checkTimes(start, end);
    let title = text(body.title, 'title', MAX_TITLE, false);
    const todoId = body.todoId === undefined || body.todoId === null ? null : String(body.todoId);
    const todo = todoId ? this.todoRow(todoId) : null;
    if (todo) title ??= todo.title;
    if (!title) throw bad('title is required (or a todoId)');
    const category: Category = (body.category as Category | undefined) ?? (todo ? KIND_CATEGORY[todo.kind] : 'task');
    const id = randomUUID();
    const now = this.iso();
    transaction(this.db, () => {
      this.db
        .prepare(`INSERT INTO blocks (id, date, start, end, title, todo_id, origin, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`)
        .run(id, d, start, end, title, todoId, category, now, now);
      this.markEdited(d);
      this.log(actor, 'create', 'block', id, { date: d, start, end, title, todoId });
    });
    return toBlock(this.blockRow(id));
  }

  updateBlock(id: string, body: Record<string, unknown>, actor: Actor): Block {
    only(body, ['date', 'start', 'end', 'title']);
    const row = this.blockRow(id);
    const d = body.date === undefined ? row.date : date(body.date, 'date');
    if (daysBetween(this.today(), d) < 0) throw bad('Cannot move a block into the past');
    const start = body.start === undefined ? row.start : time(body.start, 'start');
    // Moving the start keeps the length unless an end is given.
    const end =
      body.end !== undefined
        ? time(body.end, 'end')
        : body.start !== undefined
          ? fromMinutes(Math.min(24 * 60, toMinutes(start) + toMinutes(row.end) - toMinutes(row.start)))
          : row.end;
    this.checkTimes(start, end);
    const title = body.title === undefined ? row.title : text(body.title, 'title', MAX_TITLE)!;
    transaction(this.db, () => {
      // A manual edit makes the block the owner's: regeneration keeps it.
      this.db
        .prepare("UPDATE blocks SET date = ?, start = ?, end = ?, title = ?, origin = 'manual', updated_at = ? WHERE id = ?")
        .run(d, start, end, title, this.iso(), id);
      this.markEdited(row.date);
      if (d !== row.date) this.markEdited(d);
      this.log(actor, 'update', 'block', id, { before: { date: row.date, start: row.start, end: row.end, title: row.title }, after: { date: d, start, end, title } });
    });
    return toBlock(this.blockRow(id));
  }

  removeBlock(id: string, actor: Actor): void {
    const row = this.blockRow(id);
    transaction(this.db, () => {
      if (row.google_event_id) this.db.prepare('UPDATE blocks SET removed = 1, updated_at = ? WHERE id = ?').run(this.iso(), id);
      else this.db.prepare('DELETE FROM blocks WHERE id = ?').run(id);
      this.markEdited(row.date);
      this.log(actor, 'remove', 'block', id, { date: row.date, start: row.start, end: row.end, title: row.title });
    });
  }

  /**
   * Confirms the plans of `dates`: checks them, then writes them to Google Calendar (insert new
   * blocks, update moved ones, delete removed ones). Needs a connected calendar.
   */
  async confirm(dates: string[], actor: Actor): Promise<DayView[]> {
    if (!Array.isArray(dates) || dates.length < 1 || dates.length > 14) throw bad('dates must list 1-14 dates');
    const unique = [...new Set(dates.map((d) => date(d, 'dates[]')))].sort();
    for (const d of unique) if (daysBetween(this.today(), d) < 0) throw bad(`${d} is in the past`);
    const cal = await this.cal();
    if (!cal) throw new PlannerError(409, 'calendar_not_connected', 'Google Calendar is not connected: connect it first (calendar_connect)');

    // Check everything before writing anything.
    const problems: string[] = [];
    for (const d of unique) {
      if (!this.plan(d)) problems.push(`${d}: no plan yet (generate it first)`);
      const view = await this.day(d);
      problems.push(...view.warnings.map((w) => `${d}: ${w}`));
    }
    if (problems.length) throw new PlannerError(409, 'plan_conflict', `Cannot confirm yet: ${problems.join('; ')}`);

    const result: DayView[] = [];
    for (const d of unique) {
      const written: string[] = [];
      for (const r of this.blocks(d, true)) {
        if (r.removed) {
          if (r.google_event_id) await cal.deleteEvent(r.google_event_id);
          this.db.prepare('DELETE FROM blocks WHERE id = ?').run(r.id);
          written.push(`deleted ${r.start}-${r.end} ${r.title}`);
          continue;
        }
        const input: EventInput = {
          summary: r.title,
          description: 'Personal AI 계획 블록. 여기서 옮기거나 지우면 planner도 따라가요.',
          category: r.category,
          timing: { kind: 'timed', date: r.date, start: r.start, end: r.end },
          blockId: r.id,
        };
        if (!r.google_event_id) {
          const eventId = await cal.insertEvent(input);
          this.db.prepare('UPDATE blocks SET google_event_id = ? WHERE id = ?').run(eventId, r.id);
          written.push(`added ${r.start}-${r.end} ${r.title}`);
        } else if (r.synced_date !== r.date || r.synced_start !== r.start || r.synced_end !== r.end || r.synced_title !== r.title) {
          await cal.patchEvent(r.google_event_id, input);
          written.push(`updated ${r.start}-${r.end} ${r.title}`);
        } else {
          continue;
        }
        this.db
          .prepare('UPDATE blocks SET synced_date = date, synced_start = start, synced_end = end, synced_title = title WHERE id = ?')
          .run(r.id);
      }
      this.touchPlan(d, 'confirmed');
      this.log(actor, 'confirm', 'plan', d, { calendar: written });
      result.push(await this.day(d, { reconcile: false }));
    }
    return result;
  }

  /**
   * Google Calendar is the source of truth: when the owner moved, renamed or deleted a planner
   * event there, the block follows (only for blocks without unconfirmed local edits).
   */
  private async reconcile(cal: CalendarApi, day: string): Promise<void> {
    const synced = this.blocks(day).filter(
      (r) => r.google_event_id && r.synced_date === r.date && r.synced_start === r.start && r.synced_end === r.end && r.synced_title === r.title,
    );
    if (!synced.length) return;
    const events = new Map((await this.calendarEvents(cal, day)).map((e) => [e.id, e]));
    for (const r of synced) {
      const e = events.get(r.google_event_id!) ?? (await cal.getEvent(r.google_event_id!));
      if (!e || e.status === 'cancelled') {
        this.db.prepare('DELETE FROM blocks WHERE id = ?').run(r.id);
        this.log('calendar', 'remove', 'block', r.id, { date: r.date, start: r.start, end: r.end, title: r.title, reason: 'deleted in Google Calendar' });
        continue;
      }
      if (!e.start || !e.end) continue;
      const s = localParts(new Date(e.start), this.timeZone);
      const t = localParts(new Date(e.end), this.timeZone);
      const end = t.date === s.date ? t.time : '24:00';
      if (s.date !== r.date || s.time !== r.start || end !== r.end || e.summary !== r.title) {
        this.db
          .prepare(
            'UPDATE blocks SET date = ?, start = ?, end = ?, title = ?, synced_date = ?, synced_start = ?, synced_end = ?, synced_title = ?, updated_at = ? WHERE id = ?',
          )
          .run(s.date, s.time, end, e.summary, s.date, s.time, end, e.summary, this.iso(), r.id);
        this.log('calendar', 'update', 'block', r.id, {
          before: { date: r.date, start: r.start, end: r.end, title: r.title },
          after: { date: s.date, start: s.time, end, title: e.summary },
          reason: 'changed in Google Calendar',
        });
      }
    }
  }

  /** Upcoming timed events (for reminders), from the calendar. */
  async upcoming(withinMinutes: number): Promise<CalendarEvent[]> {
    const cal = await this.cal();
    if (!cal) return [];
    const from = new Date(this.now());
    const to = new Date(this.now() + withinMinutes * 60_000);
    const events = await cal.listEvents(from.toISOString(), to.toISOString());
    return events.filter((e) => e.status !== 'cancelled' && !e.allDay && !e.declined && e.start && Date.parse(e.start) > this.now());
  }

  // ---- fixed events (classes, appointments, routines, birthdays) -------------------------

  private async requireCal(): Promise<CalendarApi> {
    const cal = await this.cal();
    if (!cal) throw new PlannerError(409, 'calendar_not_connected', 'Google Calendar is not connected: connect it first (calendar_connect)');
    return cal;
  }

  /** Validates one fixed-event spec: the same fields for event_add and proposal items. */
  private eventSpec(body: Record<string, unknown>): EventSpec {
    only(body, EVENT_FIELDS);
    const title = text(body.title, 'title', MAX_TITLE)!;
    if (!isCategory(body.category) || body.category === 'deadline') throw bad(`category must be one of ${CATEGORIES.filter((c) => c !== 'deadline').join(', ')}`);
    const timing = this.timing(body);
    return {
      title,
      category: body.category,
      timing,
      recurrence: repeatRule(body, timing, this.timeZone),
      location: text(body.location, 'location', 200, false),
      notes: text(body.notes, 'notes', MAX_NOTES, false),
    };
  }

  /** Fixed events the owner asked for, written straight to the managed calendar. */
  async addEvent(body: Record<string, unknown>, actor: Actor): Promise<{ id: string; title: string; category: Category; when: string }> {
    const spec = this.eventSpec(body);
    const cal = await this.requireCal();
    const id = await cal.insertEvent(specInput(spec));
    this.log(actor, 'create', 'event', id, { title: spec.title, category: spec.category, timing: spec.timing, recurrence: spec.recurrence });
    return { id, title: spec.title, category: spec.category, when: describeWhen(spec.timing, spec.recurrence, this.timeZone) };
  }

  /** timed: date + start + end (end after midnight: endDate); all-day: date (+ endDate, inclusive). */
  private timing(body: Record<string, unknown>): Timing {
    const d = date(body.date, 'date');
    if (body.allDay === true) {
      const last = body.endDate === undefined ? d : date(body.endDate, 'endDate');
      if (daysBetween(d, last) < 0) throw bad('endDate must not be before date');
      return { kind: 'allDay', date: d, endDate: addDays(last, 1) };
    }
    const start = time(body.start, 'start');
    const end = time(body.end, 'end');
    if (body.endDate !== undefined) {
      const endDate = date(body.endDate, 'endDate');
      if (daysBetween(d, endDate) < 0 || (endDate === d && toMinutes(start) >= toMinutes(end))) throw bad('the event must end after it starts');
      return { kind: 'timed', date: d, start, end, endDate };
    }
    this.checkTimes(start, end);
    return { kind: 'timed', date: d, start, end };
  }

  private async editable(cal: CalendarApi, id: string, scope: 'this' | 'series'): Promise<CalendarEvent> {
    if (!/^[A-Za-z0-9_@.-]{3,300}$/.test(id)) throw bad('event_id must be an id shown by day/week');
    const event = await cal.getEvent(id);
    if (!event || event.status === 'cancelled') throw new PlannerError(404, 'not_found', `Event ${id} not found in the managed calendar`);
    if (event.plannerBlockId) throw bad('This is a plan block: use block_update / block_remove');
    if (event.deadlineTodoId) throw bad('This is a deadline marker: change the todo (todo_update) instead');
    if (scope === 'series') {
      const seriesId = event.recurrence ? event.id : event.recurringEventId;
      if (!seriesId) throw bad('This event does not repeat: use scope "this"');
      const master = seriesId === event.id ? event : await cal.getEvent(seriesId);
      if (!master) throw new PlannerError(404, 'not_found', 'The repeating series was not found');
      return master;
    }
    return event;
  }

  async updateEvent(id: string, body: Record<string, unknown>, actor: Actor): Promise<{ id: string; scope: string }> {
    only(body, ['title', 'date', 'start', 'end', 'category', 'location', 'notes', 'scope', 'repeat', ...REPEAT_FIELDS]);
    const scope = (body.scope ?? 'this') as 'this' | 'series';
    if (scope !== 'this' && scope !== 'series') throw bad('scope must be "this" (one occurrence) or "series" (every occurrence)');
    const repeatChange = body.repeat !== undefined || REPEAT_FIELDS.some((k) => body[k] !== undefined);
    if (repeatChange && body.repeat === undefined) throw bad('To change how an event repeats, give the whole rule: repeat (+ interval, repeatDays, monthlyBy, until or count)');
    if (scope === 'series' && body.date !== undefined) throw bad('A whole series cannot move to another date; change the times, or remove it and add a new one');
    const cal = await this.requireCal();
    const event = await this.editable(cal, id, scope);
    if (repeatChange && scope === 'this' && event.recurringEventId) throw bad('This is one occurrence of a repeating event: use scope "series" to change how it repeats');
    if (repeatChange && body.repeat === 'none' && (event.recurrence || event.recurringEventId)) throw bad('To stop a repeating event, give an until date (or remove the series)');
    const current = this.eventTiming(event);
    let timing: Timing = current;
    if (body.date !== undefined || body.start !== undefined || body.end !== undefined) {
      if (current.kind === 'allDay') {
        if (body.start !== undefined || body.end !== undefined) throw bad('An all-day event has no times');
        const d = date(body.date, 'date');
        timing = { kind: 'allDay', date: d, endDate: addDays(d, daysBetween(current.date, current.endDate)) };
      } else {
        const d = body.date === undefined ? current.date : date(body.date, 'date');
        const start = body.start === undefined ? current.start : time(body.start, 'start');
        const length = toMinutes(current.end) - toMinutes(current.start);
        const end = body.end !== undefined ? time(body.end, 'end') : body.start !== undefined ? fromMinutes(Math.min(24 * 60, toMinutes(start) + length)) : current.end;
        this.checkTimes(start, end);
        timing = { kind: 'timed', date: d, start, end };
      }
    }
    if (body.category !== undefined && (!isCategory(body.category) || body.category === 'deadline')) throw bad('category is invalid');
    const input: EventInput = {
      summary: body.title === undefined ? event.summary : text(body.title, 'title', MAX_TITLE)!,
      description: body.notes === undefined ? event.description : text(body.notes, 'notes', MAX_NOTES, false),
      location: body.location === undefined ? event.location : text(body.location, 'location', 200, false),
      category: (body.category as Category | undefined) ?? event.category ?? 'personal',
      timing,
      recurrence: repeatChange ? repeatRule(body, timing, this.timeZone) : scope === 'series' ? event.recurrence : undefined,
      importedFrom: event.importedFrom ?? undefined,
    };
    await cal.patchEvent(event.id, input);
    this.log(actor, 'update', 'event', event.id, {
      scope,
      before: { title: event.summary, timing: current, category: event.category, location: event.location },
      after: { title: input.summary, timing, category: input.category, location: input.location, ...(repeatChange ? { recurrence: input.recurrence } : {}) },
    });
    return { id: event.id, scope };
  }

  async removeEvent(id: string, body: Record<string, unknown>, actor: Actor): Promise<{ removed: string; scope: string }> {
    only(body, ['scope']);
    const scope = (body.scope ?? 'this') as 'this' | 'series';
    if (scope !== 'this' && scope !== 'series') throw bad('scope must be "this" or "series"');
    const cal = await this.requireCal();
    const event = await this.editable(cal, id, scope);
    await cal.deleteEvent(event.id);
    this.log(actor, 'remove', 'event', event.id, { scope, title: event.summary, timing: this.eventTiming(event), category: event.category });
    return { removed: event.id, scope };
  }

  private eventTiming(e: CalendarEvent): Timing {
    if (e.allDay) return { kind: 'allDay', date: e.date!, endDate: e.endDate ?? addDays(e.date!, 1) };
    const s = localParts(new Date(e.start!), this.timeZone);
    const t = localParts(new Date(e.end!), this.timeZone);
    return t.date === s.date ? { kind: 'timed', date: s.date, start: s.time, end: t.time } : { kind: 'timed', date: s.date, start: s.time, end: t.time, endDate: t.date };
  }

  // ---- deadline markers ---------------------------------------------------------------------

  /**
   * Keeps one all-day "마감(이날까지): <todo>" event per open todo with a deadline. Called by the jobs loop.
   * The title says "by this day" because Kelly once read a marker as the day the work (a quiz) happens.
   * MARKER_FORMAT is part of the synced key, so changing the title format re-patches every marker once.
   */
  async syncDeadlines(): Promise<number> {
    const rows = this.db
      .prepare("SELECT id, title, deadline, status, deadline_event_id, deadline_synced FROM todos WHERE deadline_event_id IS NOT NULL OR (status = 'open' AND deadline IS NOT NULL)")
      .all() as Array<{ id: string; title: string; deadline: string | null; status: string; deadline_event_id: string | null; deadline_synced: string | null }>;
    const wantedOf = (r: { status: string; deadline: string | null; title: string }) =>
      r.status === 'open' && r.deadline ? `${r.deadline}|${r.title}|${MARKER_FORMAT}` : null;
    const pending = rows.filter((r) => {
      const wanted = wantedOf(r);
      return wanted !== r.deadline_synced || (wanted !== null && !r.deadline_event_id);
    });
    if (!pending.length) return 0;
    const cal = await this.cal();
    if (!cal) return 0;
    for (const r of pending) {
      const wanted = wantedOf(r);
      if (wanted) {
        const input: EventInput = {
          summary: deadlineTitle(r.title),
          description: 'Personal AI 마감 표시: 이 날까지 끝내야 하는 일이에요 (이 날 하는 일정이 아님). 마감을 바꾸려면 Kelly에게 말해주세요.',
          category: 'deadline',
          timing: { kind: 'allDay', date: r.deadline!, endDate: addDays(r.deadline!, 1) },
          deadlineTodoId: r.id,
        };
        let eventId = r.deadline_event_id;
        if (eventId) await cal.patchEvent(eventId, input);
        else eventId = await cal.insertEvent(input);
        this.db.prepare('UPDATE todos SET deadline_event_id = ?, deadline_synced = ? WHERE id = ?').run(eventId, wanted, r.id);
      } else {
        if (r.deadline_event_id) await cal.deleteEvent(r.deadline_event_id);
        this.db.prepare('UPDATE todos SET deadline_event_id = NULL, deadline_synced = NULL WHERE id = ?').run(r.id);
      }
    }
    return pending.length;
  }

  // ---- reference: the owner's old calendars, read-only ----------------------------------

  /** The owner's calendars (read-only), except the managed one. */
  async calendars(): Promise<Array<{ name: string; primary: boolean; accessRole: string }>> {
    const account = this.google.account();
    if (!account) throw new PlannerError(409, 'calendar_not_connected', 'Google Calendar is not connected: connect it first (calendar_connect)');
    const managed = this.meta('managed_calendar_id');
    return (await account.calendarList()).filter((c) => c.id !== managed).map((c) => ({ name: c.summary, primary: c.primary, accessRole: c.accessRole }));
  }

  /**
   * Copies the events of the owner's old calendars into the planner's reference store (raw, as
   * read). They are information about the owner, never written to the Kelly calendar as they are.
   */
  async referenceSync(body: Record<string, unknown>, actor: Actor): Promise<{ calendars: Array<{ name: string; events: number; repeating: number }>; from: string; to: string }> {
    only(body, ['calendars', 'from', 'to']);
    const account = this.google.account();
    if (!account) throw new PlannerError(409, 'calendar_not_connected', 'Google Calendar is not connected: connect it first (calendar_connect)');
    const managed = this.meta('managed_calendar_id');
    const list = (await account.calendarList()).filter((c) => c.id !== managed);
    let chosen = list.filter((c) => c.accessRole === 'owner');
    if (body.calendars !== undefined) {
      if (!Array.isArray(body.calendars) || !body.calendars.length || body.calendars.length > 30) throw bad('calendars must list 1-30 calendar names');
      chosen = body.calendars.map((name) => {
        const match = list.find((c) => c.summary.trim().toLowerCase() === String(name).trim().toLowerCase());
        if (!match) throw bad(`No calendar named "${name}". Calendars: ${list.map((c) => c.summary).join(', ')}`);
        return match;
      });
    }
    const from = body.from === undefined ? addDays(this.today(), -365) : date(body.from, 'from');
    const to = body.to === undefined ? addDays(this.today(), 365) : date(body.to, 'to');
    if (daysBetween(from, to) < 1 || daysBetween(from, to) > 4 * 366) throw bad('from must be before to, at most 4 years apart');
    const timeMin = toInstant(from, '00:00', this.timeZone).toISOString();
    const timeMax = toInstant(to, '00:00', this.timeZone).toISOString();
    const summary: Array<{ name: string; events: number; repeating: number }> = [];
    for (const c of chosen) {
      const events = (await account.listSeries(c.id, timeMin, timeMax)).filter((e) => e.status !== 'cancelled' && (e.allDay ? e.date : e.start));
      const now = this.iso();
      transaction(this.db, () => {
        for (const e of events) {
          const title = cleanTitle(e.summary);
          this.db
            .prepare(
              `INSERT INTO reference_events (source_calendar, source_event_id, title, timing, recurrence, location, description, raw, first_seen, last_seen)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(source_calendar, source_event_id) DO UPDATE SET title = excluded.title, timing = excluded.timing,
                 recurrence = excluded.recurrence, location = excluded.location, description = excluded.description,
                 raw = excluded.raw, last_seen = excluded.last_seen`,
            )
            .run(c.summary, e.id, title, JSON.stringify(this.eventTiming(e)), e.recurrence ? JSON.stringify(e.recurrence) : null, e.location ? cleanTitle(e.location) : null, e.description, JSON.stringify(e), now, now);
        }
      });
      summary.push({ name: c.summary, events: events.length, repeating: events.filter((e) => e.recurrence?.length).length });
    }
    this.log(actor, 'sync', 'reference', null, { calendars: summary, from, to });
    return { calendars: summary, from, to };
  }

  /** Searches the reference store (old calendars): by calendar, words in the title, dates, repeating or not. */
  referenceSearch(body: Record<string, unknown>): { items: ReferenceItem[]; total: number } {
    only(body, ['calendar', 'text', 'from', 'to', 'repeating', 'limit']);
    const limit = body.limit === undefined ? 50 : int(body.limit, 'limit', 1, 300);
    const words = body.text === undefined ? [] : String(text(body.text, 'text', 100)).toLowerCase().split(/\s+/);
    const from = body.from === undefined ? null : date(body.from, 'from');
    const to = body.to === undefined ? null : date(body.to, 'to');
    if (body.repeating !== undefined && typeof body.repeating !== 'boolean') throw bad('repeating must be true or false');
    const rows = this.db.prepare('SELECT source_calendar, title, timing, recurrence, location FROM reference_events ORDER BY source_calendar, title').all() as Array<{
      source_calendar: string;
      title: string;
      timing: string;
      recurrence: string | null;
      location: string | null;
    }>;
    const items: ReferenceItem[] = [];
    for (const r of rows) {
      if (body.calendar !== undefined && r.source_calendar.toLowerCase() !== String(body.calendar).trim().toLowerCase()) continue;
      const lower = r.title.toLowerCase();
      if (words.some((w) => !lower.includes(w))) continue;
      const timing = JSON.parse(r.timing) as Timing;
      const recurrence = r.recurrence ? (JSON.parse(r.recurrence) as string[]) : null;
      const repeats = !!recurrence?.length;
      if (body.repeating !== undefined && body.repeating !== repeats) continue;
      const until = recurrence ? untilDate(recurrence, this.timeZone) : null;
      const last = repeats ? until : timing.kind === 'allDay' ? addDays(timing.endDate, -1) : (timing.endDate ?? timing.date);
      if (from && last && daysBetween(from, last) < 0) continue;
      if (to && daysBetween(timing.date, to) < 0) continue;
      items.push({ calendar: r.source_calendar, title: r.title, when: describeWhen(timing, recurrence, this.timeZone), repeats, location: r.location, hint: suggestCategory(r.source_calendar, r.title) });
    }
    return { items: items.slice(0, limit), total: items.length };
  }

  // ---- proposals: drafts of fixed events the owner picks from ---------------------------

  private proposalRow(code: string): { id: number; title: string; notes: string | null; status: string } {
    const id = codeToId(code);
    const row = id === null ? undefined : (this.db.prepare('SELECT id, title, notes, status FROM proposals WHERE id = ?').get(id) as { id: number; title: string; notes: string | null; status: string } | undefined);
    if (!row) throw new PlannerError(404, 'not_found', `Proposal ${code} not found`);
    return row;
  }

  private itemSpecs(items: unknown, field: string): Array<Record<string, unknown>> {
    if (!Array.isArray(items) || !items.length || items.length > 60) throw bad(`${field} must list 1-60 events`);
    return items.map((item, i) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) throw bad(`${field}[${i + 1}] must be an event object`);
      try {
        this.eventSpec(item as Record<string, unknown>);
      } catch (error) {
        throw bad(`${field}[${i + 1}]: ${(error as Error).message}`);
      }
      return item as Record<string, unknown>;
    });
  }

  /** A named draft set of fixed events (e.g. "루틴 시안 A: 아침형"). Nothing is in the calendar yet. */
  createProposal(body: Record<string, unknown>, actor: Actor): ProposalView {
    only(body, ['title', 'notes', 'items']);
    const title = text(body.title, 'title', MAX_TITLE)!;
    const notes = text(body.notes, 'notes', MAX_NOTES, false);
    const items = this.itemSpecs(body.items, 'items');
    return this.saveProposal(title, notes, items, actor);
  }

  /** Called only with Learning's scoped key. Event and todo details remain in a draft together. */
  createLearningProposal(body: Record<string, unknown>): ProposalView {
    only(body, ['date', 'period', 'items']);
    const start = date(body.date, 'date');
    if (start < this.today()) throw new PlannerError(409, 'conflict', 'This learning plan is in the past');
    const period = body.period;
    if (period !== 'day' && period !== 'week') throw bad('period must be day or week');
    const end = addDays(start, period === 'day' ? 0 : 6);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 60) throw bad('items must list 1-60 learning blocks');
    const items = body.items.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad('Each learning block must be an object');
      const row = item as Record<string, unknown>;
      only(row, ['title', 'date', 'start', 'end', 'task']);
      const plannedDate = date(row.date, 'item.date');
      if (plannedDate < start || plannedDate > end) throw bad('Learning block lies outside the requested period');
      const title = text(row.title, 'item.title', MAX_TITLE)!;
      const event = { category: 'study', title, date: plannedDate, start: time(row.start, 'item.start'), end: time(row.end, 'item.end') };
      this.eventSpec(event);
      return { ...event, learningTask: this.learningTask(row.task) };
    });
    const title = period === 'day' ? `학습 계획 · ${start}` : `학습 계획 · ${start} ~ ${end}`;
    const notes = '사용자가 고른 블록을 승인하면 학습 할 일과 Kelly 일정이 함께 등록됩니다. 기존 할 일과 고정 마감은 그대로 유지합니다.';
    const requestKey = createHash('sha256').update(JSON.stringify({ start, period, items })).digest('hex');
    return this.saveProposal(title, notes, items, 'learning', requestKey);
  }

  private learningTask(value: unknown): LearningTask {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('Each learning block needs a task');
    const task = value as Record<string, unknown>;
    only(task, ['key', 'estimateMinutes', 'priority', 'deadline']);
    const key = text(task.key, 'task.key', 90)!;
    const { kind, id, due } = /^(?<kind>assignment|review):(?<id>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?::(?<due>\d{4}-\d{2}-\d{2}))?$/
      .exec(key)?.groups ?? {};
    if (!id || (kind === 'review' ? !isValidDate(due) : due !== undefined)) throw bad('Invalid learning task reference');
    const deadline = optionalDate(task.deadline, 'task.deadline');
    if (kind === 'review' && deadline !== null) throw bad('A review date cannot become a user deadline');
    return { key, deadline, estimateMinutes: int(task.estimateMinutes, 'task.estimateMinutes', 5, 6000), priority: int(task.priority, 'task.priority', 1, 3) };
  }

  private proposedEvent(fields: Record<string, unknown>): { spec: EventSpec; task: LearningTask | null } {
    const { learningTask, ...event } = fields;
    if (learningTask === undefined) return { spec: this.eventSpec(event), task: null };
    if (event.allDay || event.endDate) throw bad('Learning blocks must start and end on the same study day');
    const spec = this.eventSpec(event.end === '24:00'
      ? { ...event, end: '00:00', endDate: addDays(date(event.date, 'item.date'), 1) }
      : event);
    if (spec.timing.kind !== 'timed' || spec.recurrence) throw bad('Learning blocks must be timed and cannot repeat');
    return { spec, task: this.learningTask(learningTask) };
  }

  private saveProposal(title: string, notes: string | null, items: Array<Record<string, unknown>>, actor: Actor, requestKey?: string): ProposalView {
    const now = this.iso();
    const id = transaction(this.db, () => {
      if (requestKey) {
        const existing = this.db.prepare(`
          SELECT p.id FROM change_log l
          JOIN proposals p ON p.id = json_extract(l.detail, '$.proposalId')
          WHERE l.entity = 'learning_proposal' AND l.entity_id = ? AND p.status <> 'discarded'
          ORDER BY p.id DESC LIMIT 1
        `).get(requestKey) as { id: number } | undefined;
        if (existing) return existing.id;
      }
      const result = this.db.prepare("INSERT INTO proposals (title, notes, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)").run(title, notes, now, now);
      const pid = Number(result.lastInsertRowid);
      items.forEach((spec, i) => this.db.prepare('INSERT INTO proposal_items (proposal_id, n, spec) VALUES (?, ?, ?)').run(pid, i + 1, JSON.stringify(spec)));
      this.log(actor, 'create', 'proposal', idToCode(pid), { title, notes, items });
      if (requestKey) this.log(actor, 'create', 'learning_proposal', requestKey, { proposalId: pid });
      return pid;
    });
    return this.proposal(idToCode(id));
  }

  proposals(status: 'draft' | 'all' = 'draft'): Array<{ code: string; title: string; status: string; items: number; applied: number }> {
    const rows = this.db
      .prepare(`SELECT p.id, p.title, p.status, COUNT(i.n) AS items, COUNT(i.event_id) AS applied FROM proposals p LEFT JOIN proposal_items i ON i.proposal_id = p.id ${status === 'all' ? '' : "WHERE p.status = 'draft'"} GROUP BY p.id ORDER BY p.id`)
      .all() as Array<{ id: number; title: string; status: string; items: number; applied: number }>;
    return rows.map((r) => ({ code: idToCode(r.id), title: r.title, status: r.status, items: r.items, applied: r.applied }));
  }

  /**
   * proposal() plus the code checks (checks.ts) against the owner's settings, the calendar of the same days
   * and open todos. Only items not yet written are checked. If the calendar cannot be read, says so.
   */
  async checkedProposal(code: string): Promise<ProposalView> {
    const view = this.proposal(code);
    if (view.status !== 'draft') return view;
    const p = this.proposalRow(code);
    const rows = this.db.prepare('SELECT spec, event_id FROM proposal_items WHERE proposal_id = ? ORDER BY n').all(p.id) as Array<{ spec: string; event_id: string | null }>;
    const items: CheckItem[] = [];
    for (const r of rows) {
      if (r.event_id) continue;
      const { spec } = this.proposedEvent(JSON.parse(r.spec));
      const t = spec.timing as { kind: string; date: string; start?: string; end?: string; endDate?: string };
      if (t.kind !== 'timed' || spec.recurrence || t.endDate) continue;
      items.push({ title: spec.title, date: t.date, start: t.start!, end: t.end!, location: spec.location ?? null });
    }
    if (!items.length) return view;
    const dates = [...new Set(items.map((i) => i.date))];
    const existing: CheckEvent[] = [];
    try {
      const cal = await this.cal();
      if (cal) {
        for (const d of dates) {
          for (const e of await this.calendarEvents(cal, d)) {
            if (e.allDay || e.declined || e.deadlineTodoId) continue;
            const c = this.clip(e, d);
            if (c) existing.push({ title: e.summary, date: d, start: fromMinutes(c.start), end: fromMinutes(c.end), location: e.location, category: e.category });
          }
        }
      }
    } catch (error) {
      view.warnings.push(`Google Calendar could not be read for the checks: ${(error as Error).message}`);
    }
    const todos = this.listTodos('open').map((t) => ({ title: t.title, deadline: t.deadline }));
    view.warnings.push(...planChecks(items, existing, todos, this.settings()));
    return view;
  }

  proposal(code: string): ProposalView {
    const p = this.proposalRow(code);
    const rows = this.db.prepare('SELECT n, spec, event_id FROM proposal_items WHERE proposal_id = ? ORDER BY n').all(p.id) as Array<{ n: number; spec: string; event_id: string | null }>;
    const items = rows.map((r) => {
      const { spec, task } = this.proposedEvent(JSON.parse(r.spec));
      return {
        n: r.n, title: spec.title, category: spec.category, when: describeWhen(spec.timing, spec.recurrence, this.timeZone),
        location: spec.location, applied: r.event_id !== null, spec,
        ...(task ? { todo: { title: spec.title, estimateMinutes: task.estimateMinutes, deadline: task.deadline } } : {}),
      };
    });
    return {
      code: idToCode(p.id),
      title: p.title,
      notes: p.notes,
      status: p.status,
      items: items.map(({ spec: _spec, ...rest }) => rest),
      warnings: overlapWarnings(items.map((i) => ({ n: i.n, title: i.title, spec: i.spec }))),
    };
  }

  /** Edits a draft: rename, add items, change fields of items (merged), remove items. */
  editProposal(code: string, body: Record<string, unknown>, actor: Actor): ProposalView {
    only(body, ['title', 'notes', 'add', 'update', 'remove']);
    const p = this.proposalRow(code);
    if (p.status !== 'draft') throw new PlannerError(409, 'conflict', `Proposal ${code} is ${p.status}; make a new one`);
    const add = body.add === undefined ? [] : this.itemSpecs(body.add, 'add');
    const remove = body.remove === undefined ? [] : body.remove;
    if (!Array.isArray(remove) || remove.some((n) => !Number.isInteger(n))) throw bad('remove must list item numbers');
    const updates = body.update === undefined ? [] : body.update;
    if (!Array.isArray(updates)) throw bad('update must list {n, ...fields to change}');
    const changed: Array<{ n: number; spec: Record<string, unknown> }> = [];
    for (const u of updates) {
      if (typeof u !== 'object' || u === null || !Number.isInteger((u as { n?: unknown }).n)) throw bad('each update is {n, ...fields to change}');
      const { n, ...fields } = u as Record<string, unknown> & { n: number };
      const row = this.db.prepare('SELECT spec, event_id FROM proposal_items WHERE proposal_id = ? AND n = ?').get(p.id, n) as { spec: string; event_id: string | null } | undefined;
      if (!row) throw new PlannerError(404, 'not_found', `Proposal ${code} has no item ${n}`);
      if (row.event_id) throw new PlannerError(409, 'conflict', `Item ${n} is already in the calendar; change it with event_update`);
      if ('learningTask' in fields) throw bad('Learning task references cannot be edited');
      const spec = mergeSpec(JSON.parse(row.spec), fields);
      try {
        this.proposedEvent(spec);
      } catch (error) {
        throw bad(`update ${n}: ${(error as Error).message}`);
      }
      changed.push({ n, spec });
    }
    transaction(this.db, () => {
      if (body.title !== undefined) this.db.prepare('UPDATE proposals SET title = ? WHERE id = ?').run(text(body.title, 'title', MAX_TITLE), p.id);
      if (body.notes !== undefined) this.db.prepare('UPDATE proposals SET notes = ? WHERE id = ?').run(text(body.notes, 'notes', MAX_NOTES, false), p.id);
      for (const c of changed) this.db.prepare('UPDATE proposal_items SET spec = ? WHERE proposal_id = ? AND n = ?').run(JSON.stringify(c.spec), p.id, c.n);
      for (const n of remove as number[]) this.db.prepare('DELETE FROM proposal_items WHERE proposal_id = ? AND n = ? AND event_id IS NULL').run(p.id, n);
      const next = ((this.db.prepare('SELECT MAX(n) AS m FROM proposal_items WHERE proposal_id = ?').get(p.id) as { m: number | null }).m ?? 0) + 1;
      add.forEach((spec, i) => this.db.prepare('INSERT INTO proposal_items (proposal_id, n, spec) VALUES (?, ?, ?)').run(p.id, next + i, JSON.stringify(spec)));
      this.db.prepare('UPDATE proposals SET updated_at = ? WHERE id = ?').run(this.iso(), p.id);
      this.log(actor, 'update', 'proposal', code, { title: body.title, notes: body.notes, added: add, updated: changed, removed: remove });
    });
    return this.proposal(code);
  }

  /** Writes the chosen items (default: all not yet written) into the Kelly calendar. */
  async applyProposal(code: string, body: Record<string, unknown>, actor: Actor): Promise<ProposalView & { written: Array<{ n: number; title: string }> }> {
    if (this.applyingProposal) throw new PlannerError(409, 'conflict', 'A proposal is already being applied');
    this.applyingProposal = true;
    try {
      return await this.writeProposal(code, body, actor);
    } finally {
      this.applyingProposal = false;
    }
  }

  private learningEventId(proposal: number, number: number): string {
    return `learning${createHash('sha256').update(`${proposal}:${number}`).digest('hex')}`;
  }

  private async writeProposal(code: string, body: Record<string, unknown>, actor: Actor): Promise<ProposalView & { written: Array<{ n: number; title: string }> }> {
    only(body, ['items']);
    const p = this.proposalRow(code);
    if (p.status === 'discarded') throw new PlannerError(409, 'conflict', `Proposal ${code} was discarded`);
    const rows = this.db.prepare('SELECT n, spec, event_id FROM proposal_items WHERE proposal_id = ? ORDER BY n').all(p.id) as Array<{ n: number; spec: string; event_id: string | null }>;
    let chosen = rows.filter((r) => !r.event_id);
    if (body.items !== undefined) {
      if (!Array.isArray(body.items) || !body.items.length || body.items.some((n) => !Number.isInteger(n))) throw bad('items must list item numbers');
      const missing = (body.items as number[]).filter((n) => !rows.some((r) => r.n === n));
      if (missing.length) throw new PlannerError(404, 'not_found', `Proposal ${code} has no item ${missing.join(', ')}`);
      chosen = chosen.filter((r) => (body.items as number[]).includes(r.n));
    }
    if (!chosen.length) throw bad('Nothing left to write: those items are already in the calendar');
    const cal = await this.requireCal();
    const selected = chosen.map((row) => ({ row, ...this.proposedEvent(JSON.parse(row.spec)) }));
    const learning = selected.flatMap(({ row, spec, task }) => task && spec.timing.kind === 'timed' ? [{
      n: row.n, date: spec.timing.date, start: toMinutes(spec.timing.start),
      end: spec.timing.endDate ? 1440 : toMinutes(spec.timing.end),
      eventId: this.learningEventId(p.id, row.n),
    }] : []);
    const previous = new Set<string>();
    const now = localParts(new Date(this.now()), this.timeZone);
    for (const day of new Set(learning.map((b) => b.date))) {
      const blocks = learning.filter((b) => b.date === day);
      const events = await this.calendarEvents(cal, day);
      const own = new Set(blocks.map((b) => b.eventId));
      for (const event of events) if (own.has(event.id)) previous.add(event.id);
      const busy = this.learningBusy(events, day, own);
      for (const b of blocks) {
        if (previous.has(b.eventId)) continue;
        if (day < now.date || (day === now.date && b.start <= now.minutes) || busy.some((i) => b.start < i.end && i.start < b.end)) {
          throw new PlannerError(409, 'plan_conflict', 'A learning block now overlaps another event or is in the past. Review the draft before applying it.');
        }
        busy.push(b);
      }
    }

    const written: Array<{ n: number; title: string }> = [];
    for (const { row, spec, task } of selected) {
      let eventId: string;
      if (task && spec.timing.kind === 'timed') {
        const id = this.learningEventId(p.id, row.n);
        const blockId = stableUuid(`learning-block:${p.id}:${row.n}`);
        if (previous.has(id)) {
          eventId = id;
        } else {
          try {
            eventId = await cal.insertEvent({ ...specInput(spec), id, blockId });
          } catch (error) {
            const exists = error instanceof GoogleError && error.status === 409 ? await cal.getEvent(id) : null;
            if (!exists || exists.status === 'cancelled' || exists.plannerBlockId !== blockId) throw error;
            eventId = id;
          }
        }
        const { date, start, end, endDate } = spec.timing;
        const ending = endDate ? '24:00' : end;
        transaction(this.db, () => {
          const todoId = stableUuid(`learning-todo:${task.key}`);
          const now = this.iso();
          const inserted = this.db.prepare(`
            INSERT INTO todos (id, title, kind, priority, estimate_minutes, deadline, created_at, updated_at)
            VALUES (?, ?, 'study', ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
          `).run(todoId, spec.title, task.priority, task.estimateMinutes, task.deadline, now, now);
          if (inserted.changes) this.log(actor, 'create', 'todo', todoId, { fromProposal: code, title: spec.title, deadline: task.deadline });
          this.db.prepare(`
            INSERT INTO blocks (id, date, start, end, title, todo_id, origin, category, google_event_id,
              synced_date, synced_start, synced_end, synced_title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(blockId, date, start, ending, spec.title, todoId, spec.category, eventId, date, start, ending, spec.title, now, now);
          if (!this.plan(date)) this.touchPlan(date, 'confirmed');
          this.db.prepare('UPDATE proposal_items SET event_id = ? WHERE proposal_id = ? AND n = ?').run(eventId, p.id, row.n);
          this.log(actor, 'create', 'event', eventId, { fromProposal: code, n: row.n, title: spec.title, category: spec.category, timing: spec.timing });
        });
      } else {
        eventId = await cal.insertEvent(specInput(spec));
        this.db.prepare('UPDATE proposal_items SET event_id = ? WHERE proposal_id = ? AND n = ?').run(eventId, p.id, row.n);
        this.log(actor, 'create', 'event', eventId, { fromProposal: code, n: row.n, title: spec.title, category: spec.category, timing: spec.timing, recurrence: spec.recurrence });
      }
      written.push({ n: row.n, title: spec.title });
    }
    const left = (this.db.prepare('SELECT COUNT(*) AS c FROM proposal_items WHERE proposal_id = ? AND event_id IS NULL').get(p.id) as { c: number }).c;
    this.db.prepare('UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?').run(left ? 'draft' : 'applied', this.iso(), p.id);
    return { ...this.proposal(code), written };
  }

  discardProposal(code: string, actor: Actor): { code: string; status: string } {
    const p = this.proposalRow(code);
    if (p.status !== 'draft') throw new PlannerError(409, 'conflict', `Proposal ${code} is ${p.status}`);
    this.db.prepare("UPDATE proposals SET status = 'discarded', updated_at = ? WHERE id = ?").run(this.iso(), p.id);
    this.log(actor, 'discard', 'proposal', code, { title: p.title });
    return { code, status: 'discarded' };
  }
}

/** Stable UUIDs keep retried proposals linked to the same local rows. */
function stableUuid(name: string): string {
  const bytes = createHash('sha256').update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function toTodo(r: TodoRow): Todo {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    kind: r.kind,
    priority: r.priority,
    estimateMinutes: r.estimate_minutes,
    doneMinutes: r.done_minutes,
    deadline: r.deadline,
    earliest: r.earliest,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toBlock(r: BlockRow): Block {
  return {
    id: r.id,
    date: r.date,
    start: r.start,
    end: r.end,
    title: r.title,
    todoId: r.todo_id,
    origin: r.origin,
    category: r.category,
    inCalendar: r.google_event_id !== null,
    pending: r.synced_date !== r.date || r.synced_start !== r.start || r.synced_end !== r.end || r.synced_title !== r.title,
  };
}

function pick<T extends object>(obj: T, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, (obj as Record<string, unknown>)[k]]));
}

function diff(before: object, after: object): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(after)) {
    const old = (before as Record<string, unknown>)[k];
    if (k !== 'updatedAt' && JSON.stringify(old) !== JSON.stringify(v)) out[k] = { from: old, to: v };
  }
  return out;
}

// ---- calendar helpers ---------------------------------------------------------------------

/** A validated fixed event (event_add, proposal items). */
export interface EventSpec {
  title: string;
  category: Category;
  timing: Timing;
  recurrence: string[] | null;
  location: string | null;
  notes: string | null;
}

const EVENT_FIELDS = ['title', 'date', 'start', 'end', 'endDate', 'allDay', 'category', 'location', 'notes', 'repeat', 'interval', 'repeatDays', 'monthlyBy', 'until', 'count'];
const REPEAT_FIELDS = ['interval', 'repeatDays', 'monthlyBy', 'until', 'count'];

function specInput(spec: EventSpec): EventInput {
  return { summary: spec.title, description: spec.notes, location: spec.location, category: spec.category, timing: spec.timing, recurrence: spec.recurrence };
}

export interface ReferenceItem {
  calendar: string;
  title: string;
  when: string;
  repeats: boolean;
  location: string | null;
  /** Category the title/calendar suggests (only a hint: the old calendars were not kept tidy). */
  hint: Category;
}

export interface ProposalView {
  code: string;
  title: string;
  notes: string | null;
  status: string;
  items: Array<{
    n: number; title: string; category: Category; when: string; location: string | null; applied: boolean;
    todo?: { title: string; estimateMinutes: number; deadline: string | null };
  }>;
  warnings: string[];
}

/** Version of the deadline marker title (see syncDeadlines). */
const MARKER_FORMAT = 'v2';

export function deadlineTitle(todoTitle: string): string {
  return `마감(이날까지): ${todoTitle}`;
}

export function cleanTitle(title: string): string {
  return title.replace(/[\s\x00-\x1f]+/g, ' ').trim() || '(제목 없음)';
}

/** Proposal codes: 1 -> A, 26 -> Z, 27 -> AA. */
export function idToCode(id: number): string {
  let s = '';
  for (let n = id; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function codeToId(code: string): number | null {
  if (!/^[A-Z]{1,3}$/.test(code)) return null;
  return [...code].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
}

/** Changes on top of a stored item: switching all-day/timed or the repeat kind drops the fields that no longer apply. */
function mergeSpec(spec: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const next = { ...spec, ...fields };
  if (fields.allDay === true) {
    delete next.start;
    delete next.end;
  }
  if (fields.start !== undefined || fields.end !== undefined) delete next.allDay;
  if (fields.repeat !== undefined) for (const k of REPEAT_FIELDS) if (!(k in fields)) delete next[k];
  if (fields.until !== undefined) delete next.count;
  if (fields.count !== undefined) delete next.until;
  for (const [k, v] of Object.entries(fields)) if (v === null) delete next[k];
  return next;
}

/**
 * RRULE from fixed repeat options (no free-form rules from the LLM):
 * repeat daily|weekdays|weekly|biweekly|monthly|yearly, interval (every N), repeatDays (weekly),
 * monthlyBy date|weekday ("2nd Tuesday"), until (date) or count (times).
 */
export function repeatRule(body: Record<string, unknown>, timing: Timing, timeZone: string): string[] | null {
  const repeat = (body.repeat ?? 'none') as Repeat;
  if (!REPEATS.includes(repeat)) throw bad(`repeat must be one of ${REPEATS.join(', ')}`);
  const extras = REPEAT_FIELDS.filter((k) => body[k] !== undefined);
  if (repeat === 'none') {
    if (extras.length) throw bad(`${extras.join(', ')} only go with a repeat`);
    return null;
  }
  if (repeat === 'biweekly' && body.interval !== undefined) throw bad('biweekly already means every 2 weeks; use weekly with interval instead');
  const interval = repeat === 'biweekly' ? 2 : body.interval === undefined ? 1 : int(body.interval, 'interval', 1, 99);
  const weekly = repeat === 'weekly' || repeat === 'biweekly';
  if (body.repeatDays !== undefined && !weekly) throw bad('repeatDays only goes with repeat weekly or biweekly');
  if (body.monthlyBy !== undefined && repeat !== 'monthly') throw bad('monthlyBy only goes with repeat monthly');
  if (body.until !== undefined && body.count !== undefined) throw bad('give until or count, not both');

  const parts: string[] = [];
  const startDay = BYDAY[weekdayOf(timing.date)];
  switch (repeat) {
    case 'daily':
      parts.push('FREQ=DAILY');
      break;
    case 'weekdays':
      parts.push('FREQ=WEEKLY', 'BYDAY=MO,TU,WE,TH,FR');
      break;
    case 'weekly':
    case 'biweekly': {
      const days = body.repeatDays;
      let byDay = [startDay];
      if (days !== undefined) {
        if (!Array.isArray(days) || !days.length || days.some((d) => !BYDAY.includes(String(d)))) throw bad(`repeatDays must list days like ["MO","WE"] (${BYDAY.join(', ')})`);
        byDay = BYDAY.filter((d) => days.includes(d));
      }
      parts.push('FREQ=WEEKLY', `BYDAY=${byDay.join(',')}`);
      break;
    }
    case 'monthly': {
      parts.push('FREQ=MONTHLY');
      const by = body.monthlyBy ?? 'date';
      if (by !== 'date' && by !== 'weekday') throw bad('monthlyBy must be "date" (same day number) or "weekday" (e.g. 2nd Tuesday)');
      if (by === 'weekday') {
        const day = Number(timing.date.slice(8, 10));
        const lastWeek = Number(addDays(timing.date, 7).slice(5, 7)) !== Number(timing.date.slice(5, 7));
        const nth = Math.ceil(day / 7);
        parts.push(`BYDAY=${nth >= 5 || (nth === 4 && lastWeek) ? -1 : nth}${startDay}`);
      }
      break;
    }
    case 'yearly':
      parts.push('FREQ=YEARLY');
      break;
  }
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (body.until !== undefined) {
    const until = date(body.until, 'until');
    if (daysBetween(timing.date, until) < 0) throw bad('until must not be before the first date');
    // Timed series: UNTIL in UTC at the end of that local day; all-day series: the date itself.
    parts.push(
      timing.kind === 'allDay'
        ? `UNTIL=${until.replace(/-/g, '')}`
        : `UNTIL=${new Date(toInstant(addDays(until, 1), '00:00', timeZone).getTime() - 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    );
  }
  if (body.count !== undefined) parts.push(`COUNT=${int(body.count, 'count', 1, 999)}`);
  return [`RRULE:${parts.join(';')}`];
}

const DAY_KO: Record<string, string> = { SU: '일', MO: '월', TU: '화', WE: '수', TH: '목', FR: '금', SA: '토' };
const NTH_KO: Record<string, string> = { '1': '첫째', '2': '둘째', '3': '셋째', '4': '넷째', '-1': '마지막' };

function shortDate(d: string): string {
  const [, m, day] = d.split('-').map(Number);
  return `${m}/${day}(${KOREAN_WEEKDAYS[weekdayOf(d)]})`;
}

/** Local date of an RRULE UNTIL value (UTC date-time or plain date). */
function untilLocal(value: string, timeZone: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value);
  if (!m) return value;
  if (!m[4] || m[7] !== 'Z') return `${m[1]}-${m[2]}-${m[3]}`;
  return localParts(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])), timeZone).date;
}

/** Last date of a series from its UNTIL, or null (no end / COUNT). */
export function untilDate(recurrence: string[], timeZone = 'America/Toronto'): string | null {
  const rule = recurrence.find((l) => l.startsWith('RRULE:'));
  const m = rule && /UNTIL=([0-9TZ]+)/.exec(rule);
  return m ? untilLocal(m[1], timeZone) : null;
}

/** "매주 월·수 10:00–11:00 (9/8부터, 12/10까지)", "2주마다 화", "매달 둘째 화요일", "매년 3/14 종일". */
export function describeWhen(timing: Timing, recurrence: string[] | null, timeZone = 'America/Toronto'): string {
  const clock = timing.kind === 'timed' ? `${timing.start}–${timing.end}` : '종일';
  const rule = recurrence?.find((l) => l.startsWith('RRULE:'));
  if (!rule) {
    if (timing.kind === 'allDay' && daysBetween(timing.date, timing.endDate) > 1) return `${shortDate(timing.date)}–${shortDate(addDays(timing.endDate, -1))} 종일`;
    return `${shortDate(timing.date)} ${clock}`;
  }
  const f = Object.fromEntries(rule.slice(6).split(';').map((p) => p.split('=') as [string, string]));
  const interval = Number(f.INTERVAL ?? 1);
  const order = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const byDay: string[] = (f.BYDAY ?? '').split(',').filter(Boolean);
  const days = byDay
    .map((d) => d.slice(-2))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((d) => DAY_KO[d] ?? d)
    .join('·');
  const [, m, d] = timing.date.split('-').map(Number);
  let head: string;
  switch (f.FREQ) {
    case 'DAILY':
      head = interval > 1 ? `${interval}일마다` : '매일';
      break;
    case 'WEEKLY':
      head = `${interval > 1 ? `${interval}주마다` : '매주'} ${days || KOREAN_WEEKDAYS[weekdayOf(timing.date)]}`;
      break;
    case 'MONTHLY': {
      const every = interval > 1 ? `${interval}달마다` : '매달';
      const nth = byDay.length ? /^(-?\d)([A-Z]{2})$/.exec(byDay[0]) : null;
      head = nth ? `${every} ${NTH_KO[nth[1]] ?? nth[1]} ${DAY_KO[nth[2]]}요일` : `${every} ${d}일`;
      break;
    }
    case 'YEARLY':
      head = interval > 1 ? `${interval}년마다 ${m}/${d}` : `매년 ${m}/${d}`;
      break;
    default:
      head = '반복';
  }
  const last = f.UNTIL ? untilLocal(f.UNTIL, timeZone) : null;
  const until = last
    ? `, ${last.slice(0, 4) !== timing.date.slice(0, 4) ? `${last.slice(0, 4)}/` : ''}${Number(last.slice(5, 7))}/${Number(last.slice(8, 10))}까지`
    : f.COUNT
      ? `, ${f.COUNT}회`
      : '';
  return `${head} ${clock} (${shortDate(timing.date)}부터${until})`;
}

/** Weekdays an item occurs on (approximate for monthly/yearly: the first date's weekday). */
function occurrenceDays(spec: EventSpec): Set<string> {
  const rule = spec.recurrence?.find((l) => l.startsWith('RRULE:'));
  if (!rule) return new Set([`${spec.timing.date}`]);
  if (rule.includes('FREQ=DAILY')) return new Set(BYDAY);
  const by = /BYDAY=([A-Z,]+)/.exec(rule);
  if (rule.includes('FREQ=WEEKLY') && by) return new Set(by[1].split(','));
  return new Set([BYDAY[weekdayOf(spec.timing.date)]]);
}

/** Timed items of one proposal that would sit on top of each other. */
function overlapWarnings(items: Array<{ n: number; title: string; spec: EventSpec }>): string[] {
  const out: string[] = [];
  const timed = items.filter((i) => i.spec.timing.kind === 'timed' && !(i.spec.timing as { endDate?: string }).endDate);
  for (let a = 0; a < timed.length; a++) {
    for (let b = a + 1; b < timed.length; b++) {
      const x = timed[a].spec.timing as { start: string; end: string };
      const y = timed[b].spec.timing as { start: string; end: string };
      if (!(toMinutes(x.start) < toMinutes(y.end) && toMinutes(y.start) < toMinutes(x.end))) continue;
      const dx = occurrenceDays(timed[a].spec);
      const dy = occurrenceDays(timed[b].spec);
      const shared = [...dx].filter((d) => dy.has(d));
      if (shared.length) out.push(`${timed[a].n} "${timed[a].title}"와(과) ${timed[b].n} "${timed[b].title}"이(가) 시간이 겹쳐요 (${shared.map((d) => DAY_KO[d] ?? shortDate(d)).join('·')})`);
    }
  }
  return out;
}

/** Category suggested from the source calendar's name, then the title. */
export function suggestCategory(calendar: string, title: string): Category {
  const c = calendar.toLowerCase();
  if (/birth|생일|anniversar|기념/.test(c)) return 'birthday';
  if (/class|lecture|course|수업|강의/.test(c)) return 'class';
  // r[ou]{1,3}n?tine also catches typos such as "Rountine".
  if (/r[ou]{1,3}n?tine|루틴|habit|습관|workout|gym|운동/.test(c)) return 'routine';
  if (/univ|school|uoft|학교|대학/.test(c)) return /lec|tut|lab|class|수업|강의|[a-z]{3}\d{3}/i.test(title) ? 'class' : 'study';
  if (/study|공부/.test(c)) return 'study';
  const t = title.toLowerCase();
  if (/birthday|생일/.test(t)) return 'birthday';
  if (/\bgym\b|workout|exercise|운동|헬스|\bsleep\b|breakfast|lunch|dinner|shower|수면|아침|점심|저녁|샤워/.test(t)) return 'routine';
  if (/\b[a-z]{3}\d{3}|lecture|tutorial|lab|수업|강의/.test(t)) return 'class';
  return 'personal';
}

export function categoryLabel(c: Category | null): string {
  return c ? CATEGORY_LABEL[c] : '분류 없음';
}

export { GoogleError };
