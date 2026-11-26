import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GoogleConnection } from './connection.js';
import { planChecks, type CheckEvent, type CheckItem } from './checks.js';
import { transaction } from './db.js';
import { CATEGORIES, CATEGORY_LABEL, GoogleError, isCategory, type CalendarApi, type CalendarEvent, type Category, type EventInput, type Timing } from './google.js';
import { DEFAULT_SETTINGS, draftDay, titleHas, type Interval, type SchedTodo, type Settings } from './schedule.js';
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

/** A drafted block taken out because its todo was finished or dropped. */
export interface DroppedBlock {
  date: string;
  start: string;
  end: string;
  title: string;
  /** It was in the calendar: the next confirm of that day deletes the event. */
  inCalendar: boolean;
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
  /** The owner's latest report on this block (day view only). */
  reported?: ReportMark;
}

/** What the owner reported about a planned item: shown in the day view next to it. */
export interface ReportMark {
  reportId: number;
  status: ReportStatus;
  minutes: number | null;
  actualStart: string | null;
  actualEnd: string | null;
}

export type ReportStatus = 'done' | 'partial' | 'skipped' | 'late';
const REPORT_STATUSES: ReportStatus[] = ['done', 'partial', 'skipped', 'late'];

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
  /** An all-day "시험(이날)" marker the planner keeps for an exam event (change the exam event). */
  examMarker: boolean;
  /** The owner's latest report on this event. */
  reported?: ReportMark;
}

/** Something already planned in the time of a new or moved event. */
export interface Overlap {
  kind: 'event' | 'block';
  /** The day it overlaps on (a repeating event is checked on every occurrence in the horizon). */
  date: string;
  id: string;
  title: string;
  start: string;
  end: string;
  category: Category | null;
  location: string | null;
  repeating: boolean;
  /** replace=true removes it: plan blocks and one-off events; never classes, exams, travel or repeating events. */
  replaceable: boolean;
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
  /**
   * Open todos whose deadline is before this day. They are not planned any more (shareFor); the owner
   * says whether they are done, get a new deadline or are dropped. Only for today and later days.
   */
  overdue: Array<{ todoId: string; title: string; deadline: string; minutes: number }>;
  warnings: string[];
  calendarConnected: boolean;
  /** Set by a scheduled draft that left this day alone: the final exam on it (owner decision 2026-11-26). */
  noAutoDraft?: string;
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
  protectedEvents: (v) => words(v, 'protectedEvents'),
  noDraftExamWords: (v) => words(v, 'noDraftExamWords'),
  quietEvents: (v) => words(v, 'quietEvents'),
  bundleMinutes: (v) => int(v, 'bundleMinutes', 0, 180),
  draftAt: (v) => {
    if (v === null) return null;
    const t = time(v, 'draftAt');
    if (toMinutes(t) < 18 * 60 || toMinutes(t) > 23 * 60 + 55) throw bad('draftAt must be between 18:00 and 23:55 (or null: 30 minutes before sleepStart)');
    return t;
  },
};

function words(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.length > 30) throw bad(`${field} must list up to 30 words`);
  return v.map((w, i) => text(w, `${field}[${i + 1}]`, 60)!);
}

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

  /**
   * A new todo. An exam-like title (an exam or quiz sitting, not its preparation) comes back with a warning:
   * the sitting is an event (category class), only the preparation is a todo (2026-11-26: "FAS Technical Test"
   * as a 120-minute todo was planned again every day).
   */
  addTodo(body: Record<string, unknown>, actor: Actor): Todo & { warnings?: string[] } {
    const todo = this.insertTodo(body, actor);
    if (!(EXAM_TITLE.test(todo.title) || SITTING_TITLE.test(todo.title)) || STUDY_TITLE.test(todo.title)) return todo;
    return {
      ...todo,
      warnings: [
        `"${todo.title}" looks like an exam or quiz sitting. A sitting is an event, not a todo: add it with event_add ` +
          '(category class, its real date and time) and keep only the preparation as a todo (e.g. "… 대비", with a deadline ' +
          'before the sitting). Tell the owner and ask whether to archive this todo.',
      ],
    };
  }

  private insertTodo(body: Record<string, unknown>, actor: Actor): Todo {
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

  updateTodo(id: string, body: Record<string, unknown>, actor: Actor): Todo & { droppedBlocks?: DroppedBlock[] } {
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
    return this.withDropped(id, actor);
  }

  /** The todo after a change; when it is no longer open, its drafted blocks from now on go (dropClosedTodoBlocks). */
  private withDropped(id: string, actor: Actor): Todo & { droppedBlocks?: DroppedBlock[] } {
    const dropped = this.dropClosedTodoBlocks(actor, id);
    const todo = toTodo(this.todoRow(id));
    return dropped.length ? { ...todo, droppedBlocks: dropped } : todo;
  }

  /**
   * Blocks the planner drafted (origin auto) for todos that are done or archived, from now on, leave the
   * plan (2026-11-26: finished "Final Exam Prep" todos kept their blocks on later days, and confirming
   * such a day would have written them to the calendar). Never-synced blocks are deleted; synced ones are
   * marked removed, so the next confirm deletes their calendar events, like block_remove. Blocks the owner
   * placed or moved (origin manual) stay. Runs on every todo status change and on every jobs tick.
   */
  dropClosedTodoBlocks(actor: Actor, todoId?: string): DroppedBlock[] {
    const clock = localParts(new Date(this.now()), this.timeZone);
    const rows = this.db
      .prepare(
        `SELECT b.*, t.status AS todo_status FROM blocks b JOIN todos t ON t.id = b.todo_id
         WHERE b.removed = 0 AND b.origin = 'auto' AND t.status != 'open' AND (b.date > ? OR (b.date = ? AND b.start >= ?))
         ${todoId ? 'AND t.id = ?' : ''} ORDER BY b.date, b.start`,
      )
      .all(...[clock.date, clock.date, clock.time, ...(todoId ? [todoId] : [])]) as unknown as Array<BlockRow & { todo_status: string }>;
    if (!rows.length) return [];
    transaction(this.db, () => {
      for (const r of rows) {
        if (r.google_event_id) this.db.prepare('UPDATE blocks SET removed = 1, updated_at = ? WHERE id = ?').run(this.iso(), r.id);
        else this.db.prepare('DELETE FROM blocks WHERE id = ?').run(r.id);
        this.markEdited(r.date);
        this.log(actor, 'remove', 'block', r.id, {
          date: r.date, start: r.start, end: r.end, title: r.title, todoId: r.todo_id, category: r.category,
          inCalendar: r.google_event_id !== null, reason: `todo ${r.todo_status}`,
        });
      }
    });
    return rows.map((r) => ({ date: r.date, start: r.start, end: r.end, title: r.title, inCalendar: r.google_event_id !== null }));
  }

  /**
   * Records progress (minutes spent); marks the todo done only with `done` (2026-11-26: "2시간 했어" is not
   * "finished" even when it reaches the estimate; the display notes when the estimate is used up).
   */
  progressTodo(id: string, minutes: number | undefined, done: boolean, actor: Actor): Todo & { droppedBlocks?: DroppedBlock[] } {
    const row = this.todoRow(id);
    const add = minutes === undefined ? 0 : int(minutes, 'minutes', 0, 24 * 60);
    const total = Math.min(row.done_minutes + add, 100 * 60);
    const finished = done;
    transaction(this.db, () => {
      this.db
        .prepare('UPDATE todos SET done_minutes = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(finished ? Math.max(total, row.done_minutes) : total, finished ? 'done' : row.status, this.iso(), id);
      this.log(actor, finished ? 'complete' : 'progress', 'todo', id, { addedMinutes: add, doneMinutes: total, title: row.title });
    });
    return this.withDropped(id, actor);
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
  async generate(from: string, days: number, actor: Actor, options: { skipConfirmed?: boolean; skipExamDays?: boolean } = {}): Promise<DayView[]> {
    date(from, 'date');
    int(days, 'days', 1, 14);
    if (daysBetween(this.today(), from) < 0) throw bad('Cannot plan a day in the past');
    const all = Array.from({ length: days }, (_, i) => addDays(from, i));
    // The scheduled 23:00 drafts never undo a plan the owner already confirmed.
    const candidates = options.skipConfirmed ? all.filter((d) => this.plan(d)?.status !== 'confirmed') : all;
    const cal = await this.cal();
    const eventsByDay = new Map<string, CalendarEvent[]>();
    if (cal) for (const d of candidates) eventsByDay.set(d, await this.calendarEvents(cal, d));
    const s = this.settings();
    // Scheduled drafts leave final-exam days alone (owner decision 2026-11-26): no new auto blocks; drafted auto
    // blocks that are not in the calendar leave the draft (like any redraft). Kelly's own generate still plans them.
    const examDays = new Map<string, string>();
    if (options.skipExamDays) {
      for (const d of candidates) {
        const exam = examDayTitle(eventsByDay.get(d) ?? [], s);
        if (exam) examDays.set(d, exam);
      }
      this.leaveExamDays(examDays, actor);
    }
    const dates = candidates.filter((d) => !examDays.has(d));
    // Redrafting today (e.g. "오늘 계획 다시 짜줘" at 15:00) only plans the rest of the day: blocks that
    // already started stay as they were, and nothing new goes before now (2026-11-26).
    const clock = localParts(new Date(this.now()), this.timeZone);
    const fromTime = (d: string) => (d === clock.date ? clock.time : '00:00');
    const notBefore = (d: string) => (d === clock.date ? clock.minutes : 0);

    transaction(this.db, () => {
      // Replace auto blocks: never-synced ones are deleted, synced ones are marked for removal.
      for (const d of dates) {
        this.db.prepare("DELETE FROM blocks WHERE date = ? AND start >= ? AND origin = 'auto' AND google_event_id IS NULL").run(d, fromTime(d));
        this.db.prepare("UPDATE blocks SET removed = 1, updated_at = ? WHERE date = ? AND start >= ? AND origin = 'auto'").run(this.iso(), d, fromTime(d));
      }
      const targets = new Set(dates);
      const remaining = new Map<string, number>();
      const todos = this.listTodos('open');
      for (const t of todos) remaining.set(t.id, t.estimateMinutes - t.doneMinutes - this.plannedElsewhere(t.id, targets));

      for (const d of dates) {
        const kept = this.blocks(d);
        const busy = [...this.busyFrom(eventsByDay.get(d) ?? [], d), ...kept.map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) }))];
        const keptMinutes = kept.reduce((sum, b) => sum + toMinutes(b.end) - toMinutes(b.start), 0);
        // Time of kept blocks that is already over is not counted as done (only todo_progress does that).
        const ahead = (b: BlockRow) => Math.max(0, toMinutes(b.end) - Math.max(toMinutes(b.start), notBefore(d)));
        const sched: SchedTodo[] = todos.map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          remaining: (remaining.get(t.id) ?? 0) - kept.filter((b) => b.todo_id === t.id).reduce((x, b) => x + ahead(b), 0),
          kind: t.kind,
          deadline: t.deadline,
          earliest: t.earliest,
          createdAt: t.createdAt,
        }));
        const draft = draftDay(d, s, busy, sched, keptMinutes, notBefore(d));
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
          ...(draft.tooSmall.length ? { tooSmall: draft.tooSmall } : {}),
          wasConfirmed,
          calendarEvents: (eventsByDay.get(d) ?? []).length,
        });
      }
    });
    const views: DayView[] = [];
    for (const d of all) {
      const view = await this.day(d, { events: eventsByDay.get(d), reconcile: !dates.includes(d) });
      const exam = examDays.get(d);
      views.push(exam ? { ...view, noAutoDraft: exam } : view);
    }
    return views;
  }

  /** Final-exam days in a scheduled draft: drafted auto blocks not in the calendar go; nothing new is planned. */
  private leaveExamDays(examDays: Map<string, string>, actor: Actor) {
    if (!examDays.size) return;
    const clock = localParts(new Date(this.now()), this.timeZone);
    transaction(this.db, () => {
      for (const [d, exam] of examDays) {
        const from = d === clock.date ? clock.time : '00:00';
        const rows = this.db
          .prepare("SELECT * FROM blocks WHERE date = ? AND start >= ? AND origin = 'auto' AND google_event_id IS NULL AND removed = 0 ORDER BY start")
          .all(d, from) as unknown as BlockRow[];
        this.db.prepare("DELETE FROM blocks WHERE date = ? AND start >= ? AND origin = 'auto' AND google_event_id IS NULL").run(d, from);
        this.log(actor, 'skip', 'plan', d, {
          reason: 'final exam day: no automatic draft',
          exam,
          removedDraftBlocks: rows.map((r) => ({ start: r.start, end: r.end, title: r.title, todoId: r.todo_id })),
        });
      }
    });
  }

  /** The final exam on `day` (title), if the Kelly calendar has one; null otherwise or without a calendar. */
  async finalExamOn(day: string): Promise<string | null> {
    const cal = await this.cal();
    if (!cal) return null;
    return examDayTitle(await this.calendarEvents(cal, day), this.settings());
  }

  /** A line in change_log about a scheduled job (e.g. a post it skipped on purpose). */
  logJob(action: string, key: string, detail: Record<string, unknown>) {
    this.log('system', action, 'job', key, detail);
  }

  /**
   * A failure, in change_log (action "fail"): which stage, the error code and status, a short message; never
   * secrets (Google and notifier messages carry none). Owner rule: keep every record, failures included.
   */
  recordFailure(actor: Actor, entity: string, entityId: string | null, stage: string, error: unknown, extra: Record<string, unknown> = {}) {
    try {
      this.log(actor, 'fail', entity, entityId, { stage, ...errorInfo(error), ...extra });
    } catch {
      // the record of a failure must never cause another one
    }
  }

  /** Runs one Google write; a failure is recorded with its stage before it is thrown again. */
  private async gwrite<T>(stage: string, entityId: string | null, extra: Record<string, unknown>, actor: Actor, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.recordFailure(actor, 'calendar', entityId, stage, error, extra);
      throw error;
    }
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
    const marks = this.reportMarks(day);
    const withMark = <T extends { id: string }>(x: T): T => (marks.has(x.id) ? { ...x, reported: marks.get(x.id) } : x);
    const blocks = rows.map((r) => withMark(toBlock(r)));
    const eventViews: EventView[] = (events ?? [])
      .filter((e) => !e.plannerBlockId && !e.declined)
      .map((e) => {
        const c = this.clip(e, day);
        return withMark({
          id: e.id,
          seriesId: e.recurringEventId,
          start: c ? fromMinutes(c.start) : null,
          end: c ? fromMinutes(c.end) : null,
          title: e.summary,
          allDay: e.allDay,
          location: e.location,
          category: e.category,
          deadline: e.deadlineTodoId !== null,
          examMarker: e.examSourceId !== null,
        } as EventView);
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
      overdue:
        daysBetween(this.today(), day) < 0
          ? []
          : this.listTodos('open')
              .filter((t) => t.deadline !== null && t.deadline < day)
              .map((t) => ({ todoId: t.id, title: t.title, deadline: t.deadline!, minutes: Math.max(0, t.estimateMinutes - t.doneMinutes) })),
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

  /**
   * Refuses a time that has passed (2026-11-26: an event went into a past date unnoticed). Grace: a start up to
   * PAST_GRACE_MINUTES ago counts as now ("지금부터"). allowPast: the owner said on purpose it is in the past.
   * A repeating event is refused only when the whole series is over.
   */
  private refusePast(timing: Timing, recurrence: string[] | null, allowPast: boolean, what: string) {
    if (allowPast) return;
    const now = localParts(new Date(this.now()), this.timeZone);
    let problem: string | null = null;
    if (recurrence) {
      const until = untilDate(recurrence, this.timeZone);
      if (until && until < now.date) problem = `the series ends on ${until}, which is in the past`;
    } else if (timing.date < now.date) problem = `${timing.date} is in the past (today is ${now.date})`;
    else if (timing.kind === 'timed' && timing.date === now.date && toMinutes(timing.start) < now.minutes - PAST_GRACE_MINUTES) {
      problem = `${timing.start} today has already passed (now ${now.time})`;
    }
    if (problem) {
      throw new PlannerError(400, 'past_time', `${what}: ${problem}. Nothing was written. Check the date with the owner; if they want ` +
        'to record something in the past on purpose, call again with allowPast (allow_past) = true.');
    }
  }

  addBlock(body: Record<string, unknown>, actor: Actor): Block {
    only(body, ['date', 'start', 'end', 'title', 'todoId', 'category', 'allowPast']);
    const d = date(body.date, 'date');
    if (body.category !== undefined && !isCategory(body.category)) throw bad(`category must be one of ${CATEGORIES.join(', ')}`);
    if (daysBetween(this.today(), d) < 0) throw bad('Cannot plan a day in the past');
    const start = time(body.start, 'start');
    const end = time(body.end, 'end');
    this.checkTimes(start, end);
    this.refusePast({ kind: 'timed', date: d, start, end }, null, flag(body.allowPast, 'allowPast'), 'A plan block');
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

  /**
   * Moves, resizes or renames a block. The answer lists what the new time overlaps (`overlaps`); dryRun writes
   * nothing, so Kelly can ask first like block_add (2026-11-26: overlaps showed only at confirm).
   */
  async updateBlock(id: string, body: Record<string, unknown>, actor: Actor): Promise<Block & { overlaps: Overlap[]; dryRun?: true }> {
    only(body, ['date', 'start', 'end', 'title', 'dryRun', 'allowPast']);
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
    const moved = d !== row.date || start !== row.start || end !== row.end;
    if (moved) this.refusePast({ kind: 'timed', date: d, start, end }, null, flag(body.allowPast, 'allowPast'), 'Moving a plan block');
    const overlaps = moved ? await this.overlaps({ kind: 'timed', date: d, start, end }, { blockId: id }) : [];
    if (flag(body.dryRun, 'dryRun')) return { ...toBlock(row), date: d, start, end, title, overlaps, dryRun: true };
    transaction(this.db, () => {
      // A manual edit makes the block the owner's: regeneration keeps it.
      this.db
        .prepare("UPDATE blocks SET date = ?, start = ?, end = ?, title = ?, origin = 'manual', updated_at = ? WHERE id = ?")
        .run(d, start, end, title, this.iso(), id);
      this.markEdited(row.date);
      if (d !== row.date) this.markEdited(d);
      this.log(actor, 'update', 'block', id, { before: { date: row.date, start: row.start, end: row.end, title: row.title }, after: { date: d, start, end, title }, overlaps });
    });
    return { ...toBlock(this.blockRow(id)), overlaps };
  }

  removeBlock(id: string, actor: Actor, reason?: string): void {
    const row = this.blockRow(id);
    transaction(this.db, () => {
      if (row.google_event_id) this.db.prepare('UPDATE blocks SET removed = 1, updated_at = ? WHERE id = ?').run(this.iso(), id);
      else this.db.prepare('DELETE FROM blocks WHERE id = ?').run(id);
      this.markEdited(row.date);
      this.log(actor, 'remove', 'block', id, {
        date: row.date, start: row.start, end: row.end, title: row.title, todoId: row.todo_id, category: row.category, ...(reason ? { reason } : {}),
      });
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
      let current: BlockRow | null = null;
      try {
        for (const r of this.blocks(d, true)) {
          current = r;
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
      } catch (error) {
        // Partial write (2026-11-26 review): every write above is already recorded on its block, so confirming
        // again continues where it stopped. The owner sees what went in and what did not.
        const failed = current ? `${current.removed ? 'delete' : current.google_event_id ? 'update' : 'add'} ${current.start}-${current.end} ${current.title}` : null;
        const info = errorInfo(error);
        this.log(actor, 'fail', 'plan', d, { stage: 'confirm', written, failed, confirmedBefore: result.map((v) => v.date), ...info });
        throw new PlannerError(502, 'calendar_partial',
          `Google Calendar failed while confirming ${d} (${info.message}). ` +
          `${result.length ? `Already confirmed: ${result.map((v) => v.date).join(', ')}. ` : ''}` +
          `Written for ${d}: ${written.length ? written.join('; ') : 'nothing'}. Not written: ${failed ?? 'unknown'} and the rest of that day` +
          `${unique.length > result.length + 1 ? ` and ${unique.slice(result.length + 1).join(', ')}` : ''}. ` +
          'Tell the owner exactly this; calling confirm again with the same dates continues where it stopped.');
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

  /**
   * Fixed events the owner asked for, written straight to the managed calendar.
   * dryRun: nothing is written; returns what is already planned in that time (overlaps).
   * replace: after writing, removes the replaceable overlaps (the owner said the new event replaces them).
   */
  async addEvent(
    body: Record<string, unknown>,
    actor: Actor,
  ): Promise<{ id: string; title: string; category: Category; when: string; overlaps: Overlap[]; replaced: Overlap[]; dryRun?: true }> {
    const { dryRun, replace, allowPast, rest } = runFlags(body);
    const spec = this.eventSpec(rest);
    this.refusePast(spec.timing, spec.recurrence, allowPast, `"${spec.title}"`);
    const cal = await this.requireCal();
    const overlaps = await this.overlaps(spec.timing, {}, spec.recurrence);
    const when = describeWhen(spec.timing, spec.recurrence, this.timeZone);
    if (dryRun) return { id: '', title: spec.title, category: spec.category, when, overlaps, replaced: [], dryRun: true };
    const id = await this.gwrite('event_add', null, { title: spec.title, timing: spec.timing }, actor, () => cal.insertEvent(specInput(spec)));
    this.log(actor, 'create', 'event', id, {
      title: spec.title, category: spec.category, timing: spec.timing, recurrence: spec.recurrence, location: spec.location, notes: spec.notes,
      overlaps, replace, ...(allowPast ? { allowPast } : {}),
    });
    const replaced = replace ? await this.replaceOverlaps(overlaps, actor, id) : [];
    return { id, title: spec.title, category: spec.category, when, overlaps, replaced };
  }

  /**
   * Timed events and plan blocks that share time with `timing` (all-day items never count). A repeating event
   * (`recurrence`) is checked on every occurrence from today up to OVERLAP_HORIZON_DAYS ahead (2026-11-26: only
   * the first date was checked, so a weekly Friday event missed the 12/11 exam); each overlap names its date.
   */
  async overlaps(timing: Timing, skip: { eventId?: string; blockId?: string; seriesId?: string } = {}, recurrence: string[] | null = null): Promise<Overlap[]> {
    if (timing.kind !== 'timed') return [];
    const today = this.today();
    const from = timing.date > today ? timing.date : today;
    const dates = recurrence?.length
      ? occurrences(recurrence, timing.date, from, addDays(from, OVERLAP_HORIZON_DAYS), this.timeZone)
      : [timing.date];
    if (!dates.length) return [];
    const cal = await this.cal();
    const events = cal
      ? (await cal.listEvents(this.dayRange(dates[0]).timeMin, this.dayRange(dates[dates.length - 1]).timeMax)).filter((e) => e.status !== 'cancelled')
      : [];
    const lo = toMinutes(timing.start);
    const hi = timing.endDate && timing.endDate !== timing.date ? 24 * 60 : toMinutes(timing.end);
    const out: Overlap[] = [];
    for (const d of dates) {
      for (const e of events) {
        if (e.allDay || e.plannerBlockId || e.declined || e.deadlineTodoId || e.examSourceId) continue;
        if (e.id === skip.eventId || (skip.seriesId && (e.id === skip.seriesId || e.recurringEventId === skip.seriesId))) continue;
        const c = this.clip(e, d);
        if (!c || !(c.start < hi && lo < c.end)) continue;
        const repeating = e.recurringEventId !== null;
        const replaceable = !repeating && e.category !== 'class' && !EXAM_TITLE.test(e.summary) && !TRAVEL_TITLE.test(e.summary);
        out.push({ kind: 'event', date: d, id: e.id, title: e.summary, start: fromMinutes(c.start), end: fromMinutes(c.end), category: e.category, location: e.location, repeating, replaceable });
      }
      for (const b of this.blocks(d)) {
        if (b.id === skip.blockId || !(toMinutes(b.start) < hi && lo < toMinutes(b.end))) continue;
        out.push({ kind: 'block', date: d, id: b.id, title: b.title, start: b.start, end: b.end, category: b.category, location: null, repeating: false, replaceable: true });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || toMinutes(a.start) - toMinutes(b.start));
  }

  /** Removes the replaceable overlaps; every removal is logged with what was removed and why. */
  private async replaceOverlaps(overlaps: Overlap[], actor: Actor, by: string): Promise<Overlap[]> {
    const replaced: Overlap[] = [];
    for (const o of overlaps.filter((x) => x.replaceable)) {
      if (o.kind === 'block') this.removeBlock(o.id, actor, `replaced by event ${by}`);
      else await this.removeEvent(o.id, { scope: 'this' }, actor, `replaced by event ${by}`);
      replaced.push(o);
    }
    return replaced;
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
    if (event.examSourceId) throw bad('This is an exam-day marker the planner keeps: change the exam event itself instead');
    if (scope === 'series') {
      const seriesId = event.recurrence ? event.id : event.recurringEventId;
      if (!seriesId) throw bad('This event does not repeat: use scope "this"');
      const master = seriesId === event.id ? event : await cal.getEvent(seriesId);
      if (!master) throw new PlannerError(404, 'not_found', 'The repeating series was not found');
      return master;
    }
    return event;
  }

  async updateEvent(
    id: string,
    raw: Record<string, unknown>,
    actor: Actor,
  ): Promise<{ id: string; scope: string; overlaps: Overlap[]; replaced: Overlap[]; dryRun?: true }> {
    const { dryRun, replace, allowPast, rest: body } = runFlags(raw);
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
        timing = movedTiming(current, {
          date: body.date === undefined ? undefined : date(body.date, 'date'),
          start: body.start === undefined ? undefined : time(body.start, 'start'),
          end: body.end === undefined ? undefined : time(body.end, 'end'),
        });
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
    const moved = timing !== current;
    const rule = scope === 'series' ? (input.recurrence ?? event.recurrence) : null;
    if (moved || repeatChange) this.refusePast(timing, rule, allowPast, `Moving "${event.summary}"`);
    const overlaps = moved || repeatChange
      ? await this.overlaps(timing, scope === 'series' ? { seriesId: event.id } : { eventId: id }, rule)
      : [];
    if (dryRun) return { id: event.id, scope, overlaps, replaced: [], dryRun: true };
    await this.gwrite('event_update', event.id, { title: event.summary, scope }, actor, () => cal.patchEvent(event.id, input));
    this.log(actor, 'update', 'event', event.id, {
      scope,
      before: { title: event.summary, timing: current, category: event.category, location: event.location, notes: event.description },
      after: { title: input.summary, timing, category: input.category, location: input.location, notes: input.description, ...(repeatChange ? { recurrence: input.recurrence } : {}) },
      overlaps, replace, ...(allowPast ? { allowPast } : {}),
    });
    const replaced = replace ? await this.replaceOverlaps(overlaps, actor, event.id) : [];
    return { id: event.id, scope, overlaps, replaced };
  }

  async removeEvent(id: string, body: Record<string, unknown>, actor: Actor, reason?: string): Promise<{ removed: string; scope: string }> {
    only(body, ['scope']);
    const scope = (body.scope ?? 'this') as 'this' | 'series';
    if (scope !== 'this' && scope !== 'series') throw bad('scope must be "this" or "series"');
    const cal = await this.requireCal();
    const event = await this.editable(cal, id, scope);
    await this.gwrite('event_remove', event.id, { title: event.summary, scope }, actor, () => cal.deleteEvent(event.id));
    // Everything needed to put it back is kept in the log (owner rule 2026-11-25: keep every record).
    this.log(actor, 'remove', 'event', event.id, {
      scope, title: event.summary, timing: this.eventTiming(event), category: event.category, location: event.location,
      notes: event.description, recurrence: event.recurrence, seriesId: event.recurringEventId, ...(reason ? { reason } : {}),
    });
    return { removed: event.id, scope };
  }

  private eventTiming(e: CalendarEvent): Timing {
    if (e.allDay) return { kind: 'allDay', date: e.date!, endDate: e.endDate ?? addDays(e.date!, 1) };
    const s = localParts(new Date(e.start!), this.timeZone);
    const t = localParts(new Date(e.end!), this.timeZone);
    return t.date === s.date ? { kind: 'timed', date: s.date, start: s.time, end: t.time } : { kind: 'timed', date: s.date, start: s.time, end: t.time, endDate: t.date };
  }

  // ---- "넣어줘": one todo at the owner's time, straight into the calendar ----------------------

  /**
   * Schedules an open todo at the time the owner gave and writes just that block to the calendar, linked to the
   * todo (2026-11-26: "넣어줘" needed todo -> generate -> confirm of a whole day, and Kelly tried to confirm the wrong
   * date). dryRun: nothing is written; the block and what it overlaps come back for the owner to see.
   */
  async scheduleTodo(id: string, body: Record<string, unknown>, actor: Actor): Promise<{ todo: Todo; block: Block | { date: string; start: string; end: string; title: string; category: Category }; overlaps: Overlap[]; dryRun?: true }> {
    only(body, ['date', 'start', 'end', 'dryRun', 'allowPast']);
    const row = this.todoRow(id);
    if (row.status !== 'open') throw new PlannerError(409, 'conflict', `Todo "${row.title}" is ${row.status}; only open todos can be scheduled`);
    const d = date(body.date, 'date');
    if (daysBetween(this.today(), d) < 0) throw bad('Cannot schedule a todo on a day in the past');
    const start = time(body.start, 'start');
    const end = time(body.end, 'end');
    this.checkTimes(start, end);
    const timing: Timing = { kind: 'timed', date: d, start, end };
    this.refusePast(timing, null, flag(body.allowPast, 'allowPast'), `"${row.title}"`);
    const category = KIND_CATEGORY[row.kind];
    const overlaps = await this.overlaps(timing);
    if (flag(body.dryRun, 'dryRun')) return { todo: toTodo(row), block: { date: d, start, end, title: row.title, category }, overlaps, dryRun: true };
    const cal = await this.requireCal();
    const blockId = randomUUID();
    const eventId = await this.gwrite('todo_schedule', id, { title: row.title, date: d, start, end }, actor, () =>
      cal.insertEvent({
        summary: row.title,
        description: 'Personal AI 계획 블록. 여기서 옮기거나 지우면 planner도 따라가요.',
        category,
        timing,
        blockId,
      }),
    );
    const now = this.iso();
    transaction(this.db, () => {
      this.db
        .prepare(`INSERT INTO blocks (id, date, start, end, title, todo_id, origin, category, google_event_id, synced_date, synced_start, synced_end, synced_title, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(blockId, d, start, end, row.title, id, category, eventId, d, start, end, row.title, now, now);
      this.log(actor, 'create', 'block', blockId, { date: d, start, end, title: row.title, todoId: id, via: 'todo_schedule', calendarEventId: eventId, overlaps });
    });
    return { todo: toTodo(row), block: toBlock(this.blockRow(blockId)), overlaps };
  }

  // ---- actual times: what really happened (Kelly's main purpose, AGENTS.md) ------------------

  /**
   * Records what really happened with a planned item: when it really started/ended, how long it took, whether it
   * was done, partly done, skipped or late, and the owner's reason. Never overwritten: a correction is a new
   * report (`corrects`). A report on a block linked to a todo adds its minutes to the todo's progress (the
   * difference for a correction); it never completes the todo.
   */
  async addReport(body: Record<string, unknown>, actor: Actor): Promise<{ report: ReportView; todo?: Todo }> {
    only(body, ['eventId', 'blockId', 'title', 'date', 'category', 'plannedStart', 'plannedEnd', 'actualStart', 'actualEnd', 'minutes', 'status', 'percent', 'note', 'corrects']);
    if (!REPORT_STATUSES.includes(body.status as ReportStatus)) throw bad(`status must be one of ${REPORT_STATUSES.join(', ')}`);
    const status = body.status as ReportStatus;
    let corrected: ReportRow | null = null;
    if (body.corrects !== undefined) {
      corrected = (this.db.prepare('SELECT * FROM reports WHERE id = ?').get(int(body.corrects, 'corrects', 1, Number.MAX_SAFE_INTEGER)) as ReportRow | undefined) ?? null;
      if (!corrected) throw new PlannerError(404, 'not_found', `Report ${body.corrects} not found`);
    }
    const item = corrected ? itemOf(corrected) : await this.reportItem(body);
    if (daysBetween(this.today(), item.date) > 0) throw bad('Cannot report on a day that has not come yet');
    const actualStart = body.actualStart === undefined ? null : time(body.actualStart, 'actualStart');
    const actualEnd = body.actualEnd === undefined ? null : time(body.actualEnd, 'actualEnd');
    let minutes = body.minutes === undefined ? null : int(body.minutes, 'minutes', 0, 24 * 60);
    if (minutes === null && actualStart && actualEnd) minutes = (toMinutes(actualEnd) - toMinutes(actualStart) + 24 * 60) % (24 * 60);
    // only the real end given: it started as planned
    if (minutes === null && actualEnd && item.plannedStart && !actualStart) minutes = Math.max(0, toMinutes(actualEnd) - toMinutes(item.plannedStart));
    if (minutes === null && status === 'skipped') minutes = 0;
    if (minutes === null && status === 'done' && item.plannedMinutes !== null) minutes = item.plannedMinutes;
    if (minutes === null) throw bad('Say how long it took: minutes, or actualStart and actualEnd (or for a late item at least actualEnd)');
    const percent = body.percent === undefined ? (status === 'done' || status === 'late' ? 100 : status === 'skipped' ? 0 : null) : int(body.percent, 'percent', 0, 100);
    const note = text(body.note, 'note', MAX_NOTES, false);
    const todo = item.todoId ? (this.db.prepare('SELECT * FROM todos WHERE id = ?').get(item.todoId) as TodoRow | undefined) : undefined;
    const before = corrected && corrected.todo_id === item.todoId ? corrected.todo_minutes : 0;
    const delta = todo ? minutes - before : 0;
    const id = transaction(this.db, () => {
      const r = this.db
        .prepare(`INSERT INTO reports (item_kind, item_id, todo_id, title, category, course, date, planned_start, planned_end, planned_minutes,
                    actual_start, actual_end, minutes, status, percent, note, corrects, todo_minutes, actor, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(item.kind, item.itemId, item.todoId, item.title, item.category, courseOf(item.title), item.date, item.plannedStart, item.plannedEnd,
          item.plannedMinutes, actualStart, actualEnd, minutes, status, percent, note, corrected?.id ?? null, todo ? minutes : 0, actor, this.iso());
      const reportId = Number(r.lastInsertRowid);
      this.log(actor, 'create', 'report', String(reportId), { ...item, actualStart, actualEnd, minutes, status, percent, note, corrects: corrected?.id ?? null });
      if (todo && delta !== 0) {
        const total = Math.max(0, Math.min(100 * 60, todo.done_minutes + delta));
        this.db.prepare('UPDATE todos SET done_minutes = ?, updated_at = ? WHERE id = ?').run(total, this.iso(), todo.id);
        this.log(actor, 'progress', 'todo', todo.id, { title: todo.title, addedMinutes: delta, doneMinutes: total, before: todo.done_minutes, reason: `report #${reportId}` });
      }
      return reportId;
    });
    const report = toReport(this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as unknown as ReportRow);
    return todo ? { report, todo: toTodo(this.todoRow(todo.id)) } : { report };
  }

  /** What a report is about: a block, a Kelly calendar event, or something the owner names (title + date). */
  private async reportItem(body: Record<string, unknown>): Promise<ReportItem> {
    if (body.blockId !== undefined) {
      const row = this.db.prepare('SELECT * FROM blocks WHERE id = ?').get(String(body.blockId)) as BlockRow | undefined;
      if (!row) throw new PlannerError(404, 'not_found', `Block ${body.blockId} not found`);
      return { kind: 'block', itemId: row.id, todoId: row.todo_id, title: row.title, category: row.category, date: row.date, plannedStart: row.start, plannedEnd: row.end, plannedMinutes: toMinutes(row.end) - toMinutes(row.start) };
    }
    if (body.eventId !== undefined) {
      if (typeof body.eventId !== 'string' || !/^[A-Za-z0-9_@.-]{3,300}$/.test(body.eventId)) throw bad('eventId must be an event_id shown by day/week');
      const cal = await this.requireCal();
      const e = await cal.getEvent(body.eventId);
      if (!e || e.status === 'cancelled') throw new PlannerError(404, 'not_found', `Event ${body.eventId} not found in the managed calendar`);
      if (e.plannerBlockId) return this.reportItem({ blockId: e.plannerBlockId });
      const t = this.eventTiming(e);
      if (t.kind !== 'timed') return { kind: 'event', itemId: e.id, todoId: null, title: e.summary, category: e.category, date: t.date, plannedStart: null, plannedEnd: null, plannedMinutes: null };
      const length = Math.round((Date.parse(e.end!) - Date.parse(e.start!)) / 60_000);
      return { kind: 'event', itemId: e.id, todoId: null, title: e.summary, category: e.category, date: t.date, plannedStart: t.start, plannedEnd: t.endDate ? '24:00' : t.end, plannedMinutes: length };
    }
    const title = text(body.title, 'title (or eventId / blockId)', MAX_TITLE)!;
    const d = date(body.date, 'date');
    if (body.category !== undefined && !isCategory(body.category)) throw bad(`category must be one of ${CATEGORIES.join(', ')}`);
    const ps = body.plannedStart === undefined ? null : time(body.plannedStart, 'plannedStart');
    const pe = body.plannedEnd === undefined ? null : time(body.plannedEnd, 'plannedEnd');
    if (ps && pe) this.checkTimes(ps, pe);
    return { kind: 'other', itemId: null, todoId: null, title, category: (body.category as Category | undefined) ?? null, date: d, plannedStart: ps, plannedEnd: pe, plannedMinutes: ps && pe ? toMinutes(pe) - toMinutes(ps) : null };
  }

  /** The latest report per item of a day (the day view marks reported items). */
  private reportMarks(day: string): Map<string, ReportMark> {
    const rows = this.db.prepare('SELECT * FROM reports WHERE date = ? AND item_id IS NOT NULL ORDER BY id').all(day) as unknown as ReportRow[];
    const out = new Map<string, ReportMark>();
    for (const r of rows) out.set(r.item_id!, { reportId: r.id, status: r.status, minutes: r.minutes, actualStart: r.actual_start, actualEnd: r.actual_end });
    return out;
  }

  /** Reports of a day or a range (newest last), corrected ones included and marked. */
  reports(from: string, to: string): ReportView[] {
    const rows = this.db.prepare('SELECT * FROM reports WHERE date BETWEEN ? AND ? ORDER BY date, id').all(from, to) as unknown as ReportRow[];
    const corrected = new Set(rows.map((r) => r.corrects).filter((x): x is number => x !== null));
    return rows.map((r) => ({ ...toReport(r), ...(corrected.has(r.id) ? { correctedLater: true } : {}) }));
  }

  /**
   * The owner's real pace over the last `days` days: actual minutes against planned minutes, by category and by
   * course code (STA256, CSC207, ...). Corrected reports count only in their latest version. Partly done work
   * counts against the planned share it covered (percent); without a percent it is left out of the ratio.
   */
  pace(days = 28): PaceView {
    int(days, 'days', 1, 365);
    const to = this.today();
    const from = addDays(to, -(days - 1));
    const rows = (this.db.prepare('SELECT * FROM reports WHERE date BETWEEN ? AND ? ORDER BY id').all(from, to) as unknown as ReportRow[]);
    const superseded = new Set(rows.map((r) => r.corrects).filter((x): x is number => x !== null));
    const live = rows.filter((r) => !superseded.has(r.id));
    const group = (key: (r: ReportRow) => string | null) => {
      const map = new Map<string, ReportRow[]>();
      for (const r of live) {
        const k = key(r);
        if (k === null) continue;
        map.set(k, [...(map.get(k) ?? []), r]);
      }
      return [...map.entries()].map(([k, rs]) => paceGroup(k, rs)).sort((a, b) => b.reports - a.reports || a.key.localeCompare(b.key));
    };
    return { from, to, days, overall: paceGroup('all', live), byCategory: group((r) => r.category ?? 'none'), byCourse: group((r) => r.course) };
  }

  // ---- agenda: what is coming (exams, deadlines) ------------------------------------------

  /**
   * Upcoming exams (exam events in the Kelly calendar, with their exam-day markers), deadlines of open todos and
   * overdue todos for the next `days` days, sorted (2026-11-24: "첫 기말이 언제야" was answered from one course).
   */
  async agenda(days = 30): Promise<{ from: string; to: string; calendarConnected: boolean; items: AgendaItem[] }> {
    int(days, 'days', 1, 180);
    const today = this.today();
    const last = addDays(today, days - 1);
    const items: AgendaItem[] = [];
    const cal = await this.cal();
    const exams = new Set<string>();
    if (cal) {
      const events = (await cal.listEvents(this.dayRange(today).timeMin, this.dayRange(last).timeMax)).filter((e) => e.status !== 'cancelled');
      for (const e of events.filter(isExamEvent)) {
        const t = this.eventTiming(e) as Extract<Timing, { kind: 'timed' }>;
        exams.add(e.id);
        items.push({ kind: 'exam', date: t.date, start: t.start, end: t.end, title: e.summary, label: examMarkerTitle(e.summary, t.start, t.end).replace(/^시험\(이날\): /, ''), eventId: e.id, location: e.location, daysLeft: daysBetween(today, t.date) });
      }
      for (const e of events) {
        if (!e.allDay || !e.examSourceId || exams.has(e.examSourceId) || !e.date) continue;
        items.push({ kind: 'exam_marker', date: e.date, title: e.summary, daysLeft: daysBetween(today, e.date) });
      }
    } else {
      const rows = this.db.prepare('SELECT date, title FROM exam_markers WHERE date BETWEEN ? AND ?').all(today, last) as Array<{ date: string; title: string }>;
      for (const r of rows) items.push({ kind: 'exam_marker', date: r.date, title: r.title, daysLeft: daysBetween(today, r.date) });
    }
    for (const t of this.listTodos('open')) {
      if (!t.deadline || t.deadline > last) continue;
      const left = Math.max(0, t.estimateMinutes - t.doneMinutes);
      items.push({ kind: t.deadline < today ? 'overdue' : 'deadline', date: t.deadline, title: t.title, todoId: t.id, minutesLeft: left, daysLeft: daysBetween(today, t.deadline) });
    }
    const order = { overdue: 0, exam: 1, exam_marker: 1, deadline: 2 } as const;
    items.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || (a.start ?? '').localeCompare(b.start ?? ''));
    return { from: today, to: last, calendarConnected: cal !== null, items };
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

  // ---- exam-day markers ------------------------------------------------------------------

  /**
   * Keeps one all-day "시험(이날): STA256 기말 17:00–20:00" event for every timed exam or quiz in the
   * Kelly calendar (owner request 2026-11-25: like the deadline markers, for every exam and quiz from now
   * on). An all-day event with exactly that title on that day is adopted instead of duplicated.
   * The marker follows the exam when it moves and goes away when the exam is removed.
   */
  async syncExamMarkers(): Promise<number> {
    const cal = await this.cal();
    if (!cal) return 0;
    const today = this.today();
    const events = await cal.listEvents(toInstant(addDays(today, -1), '00:00', this.timeZone).toISOString(),
      toInstant(addDays(today, EXAM_MARKER_DAYS), '00:00', this.timeZone).toISOString());
    const live = events.filter((e) => e.status !== 'cancelled');
    const sources = live.filter((e) => isExamEvent(e));
    const rows = this.db.prepare('SELECT * FROM exam_markers').all() as Array<{ source_event_id: string; marker_event_id: string; date: string; title: string; synced: string }>;
    const byId = new Map(rows.map((r) => [r.source_event_id, r]));
    const now = this.iso();
    let changed = 0;
    for (const e of sources) {
      const t = this.eventTiming(e) as Extract<Timing, { kind: 'timed' }>;
      const title = examMarkerTitle(e.summary, t.start, t.end);
      const synced = `${t.date}|${title}|${EXAM_MARKER_FORMAT}`;
      const row = byId.get(e.id);
      if (row && row.synced === synced) continue;
      const input: EventInput = {
        summary: title,
        description: `Personal AI 시험 표시: 이 날 시험이 있어요 (${t.start}–${t.end}, 원래 일정 "${e.summary}"). 시험 일정을 바꾸면 이 표시도 따라 바뀌어요.`,
        location: e.location,
        category: 'class',
        timing: { kind: 'allDay', date: t.date, endDate: addDays(t.date, 1) },
        examSourceId: e.id,
      };
      let markerId = row?.marker_event_id ?? null;
      let action = 'update';
      if (!markerId) {
        // adopt an all-day event the owner (or Claude Code) already added with the same title
        const same = live.find((x) => x.allDay && x.date === t.date && x.summary === title && !x.examSourceId && !x.deadlineTodoId);
        markerId = same?.id ?? null;
        action = same ? 'adopt' : 'create';
      }
      if (markerId && (await cal.getEvent(markerId))) await cal.patchEvent(markerId, input);
      else {
        markerId = await cal.insertEvent(input);
        if (action === 'update') action = 'recreate';
      }
      this.db
        .prepare(`INSERT INTO exam_markers (source_event_id, marker_event_id, date, title, synced, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(source_event_id) DO UPDATE SET marker_event_id = excluded.marker_event_id, date = excluded.date, title = excluded.title,
                    synced = excluded.synced, updated_at = excluded.updated_at`)
        .run(e.id, markerId, t.date, title, synced, now, now);
      this.log('system', action, 'exam_marker', markerId, { source: e.id, sourceTitle: e.summary, date: t.date, title, before: row ? { date: row.date, title: row.title } : null });
      changed++;
    }
    // the exam was removed (or is no longer an exam): its marker goes too; past exams keep theirs
    const current = new Set(sources.map((e) => e.id));
    for (const r of rows) {
      if (current.has(r.source_event_id) || daysBetween(today, r.date) < 0) continue;
      const source = await cal.getEvent(r.source_event_id);
      if (source && source.status !== 'cancelled' && isExamEvent(source)) continue; // outside the window, still there
      const marker = await cal.getEvent(r.marker_event_id);
      if (marker && marker.status !== 'cancelled') await cal.deleteEvent(r.marker_event_id);
      this.db.prepare('DELETE FROM exam_markers WHERE source_event_id = ?').run(r.source_event_id);
      this.log('system', 'remove', 'exam_marker', r.marker_event_id, { source: r.source_event_id, date: r.date, title: r.title, reason: 'exam event removed or changed' });
      changed++;
    }
    return changed;
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
        eventId = await this.gwrite('proposal_apply', code, { n: row.n, title: spec.title, written: written.map((w) => w.n) }, actor, () => cal.insertEvent(specInput(spec)));
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
const EXAM_MARKER_FORMAT = 'v1';
const EXAM_MARKER_DAYS = 120;
/** Exams and quizzes (titles in the Kelly calendar), not study sessions about them. */
export const EXAM_TITLE = /final exam|midterm|term test|\btest\s*\d|\bquiz\b|\bexam\b|기말|중간고사|시험|퀴즈/i;
/** Also a sitting when it is a todo title ("FAS Technical Test"); not used for exam markers. */
const SITTING_TITLE = /\btest\b|\bmidterm\b|\bquiz/i;
/** Getting somewhere cannot be replaced by something else at that time. */
const TRAVEL_TITLE = /이동|출발|travel|commute|\bbus\b|버스/i;
const STUDY_TITLE = /대비|준비|공부|복습|오답|훑기|지난|기출|풀기|연습|정리|study|review|prep|practice|이동|도착|대기/i;

/** A timed exam or quiz in the Kelly calendar (category class or task; never a plan block or a marker). */
export function isExamEvent(e: CalendarEvent): boolean {
  if (e.allDay || e.plannerBlockId || e.deadlineTodoId || e.examSourceId || e.declined) return false;
  if (e.category !== null && e.category !== 'class' && e.category !== 'task') return false;
  return EXAM_TITLE.test(e.summary) && !STUDY_TITLE.test(e.summary) && !e.summary.startsWith('시험(이날)');
}

/** "STA256H5 Final Exam", 17:00, 20:00 -> "시험(이날): STA256 기말 17:00–20:00" (the format the owner picked). */
export function examMarkerTitle(summary: string, start: string, end: string): string {
  const code = /\b([A-Z]{3}\d{3})/.exec(summary)?.[1];
  const quiz = /\bquiz\s*(\d+)|퀴즈\s*(\d+)/i.exec(summary);
  const test = /\b(?:term\s*)?test\s*(\d+)/i.exec(summary);
  const kind = /final|기말/i.test(summary) ? '기말'
    : /midterm|중간/i.test(summary) ? '중간고사'
    : quiz ? `퀴즈 ${quiz[1] ?? quiz[2]}`
    : /quiz|퀴즈/i.test(summary) ? '퀴즈'
    : test ? `Test ${test[1]}`
    : '시험';
  const what = code ? `${code} ${kind}` : summary.trim().slice(0, 80);
  return `시험(이날): ${what} ${start}–${end}`;
}

/** dryRun / replace / allowPast flags of event_add and event_update, taken out before the field check. */
function runFlags(body: Record<string, unknown>): { dryRun: boolean; replace: boolean; allowPast: boolean; rest: Record<string, unknown> } {
  const { dryRun, replace, allowPast, ...rest } = body ?? {};
  return { dryRun: flag(dryRun, 'dryRun'), replace: flag(replace, 'replace'), allowPast: flag(allowPast, 'allowPast'), rest };
}

function flag(value: unknown, field: string): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw bad(`${field} must be true or false`);
  return value === true;
}

/** A start up to this many minutes ago still counts as "now" (refusePast). */
const PAST_GRACE_MINUTES = 15;
/** A repeating event is checked for overlaps on its occurrences up to this many days ahead. */
export const OVERLAP_HORIZON_DAYS = 120;

/** Error code, status and a short message of a failure (for change_log; never secrets). */
export function errorInfo(error: unknown): { code: string; status: number | null; message: string } {
  const e = error as { code?: unknown; status?: unknown; reconnect?: unknown; message?: unknown; name?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : null;
  const code = error instanceof GoogleError ? (error.reconnect ? 'calendar_not_connected' : 'calendar_error')
    : typeof e?.code === 'string' ? e.code
    : typeof e?.name === 'string' ? e.name : 'error';
  const message = String(e?.message ?? error).replace(/[\r\n\t]+/g, ' ').slice(0, 300);
  return { code, status, message };
}

/** The final exam among a day's events (owner decision 2026-11-26: no automatic draft on that day). */
export function examDayTitle(events: CalendarEvent[], s: Pick<Settings, 'noDraftExamWords'>): string | null {
  if (!s.noDraftExamWords.length) return null;
  return events.find((e) => e.status !== 'cancelled' && isExamEvent(e) && titleHas(e.summary, s.noDraftExamWords))?.summary ?? null;
}

/** Course code in a title: "S3 · STA256 연속확률변수" -> STA256. */
export function courseOf(title: string): string | null {
  return /\b([A-Z]{3}\d{3})/.exec(title)?.[1] ?? null;
}

/**
 * The new timing of a timed event when date, start and/or end change. The length is kept when only the start
 * (or the date) moves, across midnight too (2026-11-26: moving an overnight event by its start failed with
 * "start must be before end"). An end at or before the start means the next day only for an overnight event.
 */
export function movedTiming(current: Extract<Timing, { kind: 'timed' }>, change: { date?: string; start?: string; end?: string }): Extract<Timing, { kind: 'timed' }> {
  const d = change.date ?? current.date;
  const start = change.start ?? current.start;
  const nights = current.endDate ? daysBetween(current.date, current.endDate) : 0;
  const length = nights * 24 * 60 + toMinutes(current.end) - toMinutes(current.start);
  let end: string;
  let extra = 0;
  if (change.end !== undefined) {
    end = change.end;
    if (toMinutes(end) <= toMinutes(start)) {
      if (!nights) throw bad('start must be before end');
      extra = 1;
    }
  } else if (change.start !== undefined) {
    const total = toMinutes(start) + length;
    extra = Math.floor(total / (24 * 60));
    end = fromMinutes(total % (24 * 60));
    if (extra && total % (24 * 60) === 0 && extra === 1 && !nights) {
      // ends exactly at midnight: keep it on the same day as before ("24:00")
      extra = 0;
      end = '24:00';
    }
  } else {
    end = current.end;
    extra = nights;
  }
  if (!extra) {
    if (toMinutes(start) >= toMinutes(end)) throw bad('start must be before end');
    return { kind: 'timed', date: d, start, end };
  }
  return { kind: 'timed', date: d, start, end, endDate: addDays(d, extra) };
}

/**
 * Local dates of a series written by repeatRule (DAILY, WEEKLY+BYDAY, MONTHLY by date or nth weekday, YEARLY;
 * INTERVAL, UNTIL, COUNT) from `first`, keeping those within [from, to]. COUNT counts from the first date.
 */
export function occurrences(recurrence: string[], first: string, from: string, to: string, timeZone: string, max = 400): string[] {
  const rule = recurrence.find((l) => l.startsWith('RRULE:'));
  if (!rule) return first >= from && first <= to ? [first] : [];
  const f = Object.fromEntries(rule.slice(6).split(';').map((p) => p.split('=') as [string, string]));
  const interval = Number(f.INTERVAL ?? 1);
  const count = f.COUNT ? Number(f.COUNT) : Number.POSITIVE_INFINITY;
  const until = f.UNTIL ? untilLocal(f.UNTIL, timeZone) : null;
  const last = until && until < to ? until : to;
  const byDay: string[] = (f.BYDAY ?? '').split(',').filter(Boolean);
  const [fy, fm, fd] = first.split('-').map(Number);
  const mondayIndex = (d: string) => Math.floor((daysBetween('2000-01-03', d)) / 7); // 2000-01-03 was a Monday
  const matches = (d: string): boolean => {
    const [y, m, day] = d.split('-').map(Number);
    switch (f.FREQ) {
      case 'DAILY':
        return daysBetween(first, d) % interval === 0;
      case 'WEEKLY': {
        const days = byDay.length ? byDay : [BYDAY[weekdayOf(first)]];
        return days.includes(BYDAY[weekdayOf(d)]) && (mondayIndex(d) - mondayIndex(first)) % interval === 0;
      }
      case 'MONTHLY': {
        if (((y - fy) * 12 + m - fm) % interval !== 0) return false;
        const nth = byDay.length ? /^(-?\d)([A-Z]{2})$/.exec(byDay[0]) : null;
        if (!nth) return day === fd;
        if (BYDAY[weekdayOf(d)] !== nth[2]) return false;
        const n = Number(nth[1]);
        return n > 0 ? Math.ceil(day / 7) === n : Number(addDays(d, 7).slice(5, 7)) !== m;
      }
      case 'YEARLY':
        return (y - fy) % interval === 0 && m === fm && day === fd;
      default:
        return d === first;
    }
  };
  const out: string[] = [];
  let seen = 0;
  for (let d = first, i = 0; d <= last && seen < count && out.length < max && i < 20_000; d = addDays(d, 1), i++) {
    if (!matches(d)) continue;
    seen++;
    if (d >= from) out.push(d);
  }
  return out;
}

interface ReportRow {
  id: number;
  item_kind: 'event' | 'block' | 'other';
  item_id: string | null;
  todo_id: string | null;
  title: string;
  category: Category | null;
  course: string | null;
  date: string;
  planned_start: string | null;
  planned_end: string | null;
  planned_minutes: number | null;
  actual_start: string | null;
  actual_end: string | null;
  minutes: number | null;
  status: ReportStatus;
  percent: number | null;
  note: string | null;
  corrects: number | null;
  todo_minutes: number;
  actor: string;
  created_at: string;
}

interface ReportItem {
  kind: 'event' | 'block' | 'other';
  itemId: string | null;
  todoId: string | null;
  title: string;
  category: Category | null;
  date: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  plannedMinutes: number | null;
}

export interface ReportView {
  id: number;
  itemKind: 'event' | 'block' | 'other';
  itemId: string | null;
  todoId: string | null;
  title: string;
  category: Category | null;
  course: string | null;
  date: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  plannedMinutes: number | null;
  actualStart: string | null;
  actualEnd: string | null;
  minutes: number | null;
  status: ReportStatus;
  percent: number | null;
  note: string | null;
  corrects: number | null;
  createdAt: string;
  correctedLater?: true;
}

export interface PaceGroup {
  key: string;
  reports: number;
  done: number;
  partial: number;
  skipped: number;
  late: number;
  /** Planned minutes of the work that was done (partly done: the share in percent). */
  plannedMinutes: number;
  actualMinutes: number;
  /** actual / planned: 1.3 means it took 30% longer than planned. null: nothing to compare. */
  ratio: number | null;
  /** Average minutes the real end was after the planned end (negative: earlier). */
  endDelayMinutes: number | null;
}

export interface PaceView {
  from: string;
  to: string;
  days: number;
  overall: PaceGroup;
  byCategory: PaceGroup[];
  byCourse: PaceGroup[];
}

export interface AgendaItem {
  kind: 'exam' | 'exam_marker' | 'deadline' | 'overdue';
  date: string;
  start?: string;
  end?: string;
  title: string;
  label?: string;
  eventId?: string;
  location?: string | null;
  todoId?: string;
  minutesLeft?: number;
  daysLeft: number;
}

function itemOf(r: ReportRow): ReportItem {
  return { kind: r.item_kind, itemId: r.item_id, todoId: r.todo_id, title: r.title, category: r.category, date: r.date, plannedStart: r.planned_start, plannedEnd: r.planned_end, plannedMinutes: r.planned_minutes };
}

function toReport(r: ReportRow): ReportView {
  return {
    id: r.id, itemKind: r.item_kind, itemId: r.item_id, todoId: r.todo_id, title: r.title, category: r.category, course: r.course, date: r.date,
    plannedStart: r.planned_start, plannedEnd: r.planned_end, plannedMinutes: r.planned_minutes, actualStart: r.actual_start, actualEnd: r.actual_end,
    minutes: r.minutes, status: r.status, percent: r.percent, note: r.note, corrects: r.corrects, createdAt: r.created_at,
  };
}

function paceGroup(key: string, rows: ReportRow[]): PaceGroup {
  let planned = 0;
  let actual = 0;
  const delays: number[] = [];
  for (const r of rows) {
    if (r.actual_end && r.planned_end) delays.push(toMinutes(r.actual_end) - toMinutes(r.planned_end));
    if (r.status === 'skipped' || !r.planned_minutes || r.minutes === null || !r.percent) continue;
    planned += (r.planned_minutes * r.percent) / 100;
    actual += r.minutes;
  }
  const count = (s: ReportStatus) => rows.filter((r) => r.status === s).length;
  return {
    key, reports: rows.length, done: count('done'), partial: count('partial'), skipped: count('skipped'), late: count('late'),
    plannedMinutes: Math.round(planned), actualMinutes: actual,
    ratio: planned > 0 ? Math.round((actual / planned) * 100) / 100 : null,
    endDelayMinutes: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null,
  };
}

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
      const sa = timed[a].spec;
      const sb = timed[b].spec;
      let shared: string[];
      if (!sa.recurrence !== !sb.recurrence) {
        // a one-off item (date) against a repeating one: does the series fall on that date? (2026-11-26)
        const [one, series] = sa.recurrence ? [sb, sa] : [sa, sb];
        shared = occurrences(series.recurrence!, series.timing.date, one.timing.date, one.timing.date, 'America/Toronto').length ? [one.timing.date] : [];
      } else {
        const dx = occurrenceDays(sa);
        const dy = occurrenceDays(sb);
        shared = [...dx].filter((d) => dy.has(d));
      }
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
