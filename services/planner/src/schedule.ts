// Deterministic day drafting: fits open todos into the free time of one day. No LLM: Hermes
// discusses and edits the draft afterwards with the planner tools, and the owner confirms it.

import { daysBetween, fromMinutes } from './time.js';

export interface Settings {
  /** Earliest time a block may start (local HH:MM). */
  dayStart: string;
  /** Latest time a block may end. */
  dayEnd: string;
  /** Cap on the minutes of planned work per day. */
  maxFocusMinutes: number;
  /** Gap kept between blocks and around calendar events. */
  breakMinutes: number;
  /** Longest single block; longer work is split. */
  maxBlockMinutes: number;
  /** Shortest block worth planning. */
  minBlockMinutes: number;
  /** Cap per day for a todo without a deadline (keeps a day varied). */
  undatedDailyMinutes: number;
  /** Minutes before an event the Discord reminder goes out. */
  remindMinutes: number;
  /** all: every timed calendar event; planner: only blocks the planner put in the calendar. */
  remindScope: 'all' | 'planner';
}

export const DEFAULT_SETTINGS: Settings = {
  dayStart: '07:00',
  dayEnd: '22:30',
  maxFocusMinutes: 480,
  breakMinutes: 10,
  maxBlockMinutes: 90,
  minBlockMinutes: 25,
  undatedDailyMinutes: 120,
  remindMinutes: 15,
  remindScope: 'all',
};

export interface Interval {
  start: number; // minutes since local midnight
  end: number;
}

export interface SchedTodo {
  id: string;
  title: string;
  priority: number;
  /** Minutes still to plan (estimate - done - already planned on other days). */
  remaining: number;
  deadline: string | null;
  earliest: string | null;
  createdAt: string;
  kind?: string;
}

export interface DraftBlock {
  start: number;
  end: number;
  title: string;
  todoId: string;
}

export interface DraftResult {
  blocks: DraftBlock[];
  /** Work that should happen today (deadline-driven) but did not fit. */
  unscheduled: Array<{ todoId: string; title: string; minutes: number }>;
}

const round15 = (minutes: number) => Math.ceil(minutes / 15) * 15;

/** Free intervals of [dayStart, dayEnd] after removing `busy`, each padded by the break. */
export function freeIntervals(window: Interval, busy: Interval[], pad: number): Interval[] {
  const sorted = busy
    .map((b) => ({ start: Math.max(window.start, b.start - pad), end: Math.min(window.end, b.end + pad) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const free: Interval[] = [];
  let cursor = window.start;
  for (const b of sorted) {
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  return free;
}

/**
 * How many minutes of `todo` belong on `date`: deadline work is spread evenly over the days
 * left (overdue work all today); undated work gets at most `undatedDailyMinutes`.
 */
export function shareFor(todo: SchedTodo, date: string, s: Settings): number {
  if (todo.remaining <= 0) return 0;
  if (todo.earliest && daysBetween(date, todo.earliest) > 0) return 0;
  if (!todo.deadline) return Math.min(todo.remaining, s.undatedDailyMinutes);
  const daysLeft = daysBetween(date, todo.deadline) + 1;
  if (daysLeft <= 1) return todo.remaining;
  const even = round15(todo.remaining / daysLeft);
  return Math.min(todo.remaining, Math.max(even, s.minBlockMinutes));
}

function order(date: string) {
  return (a: SchedTodo, b: SchedTodo) => {
    const da = a.deadline ? daysBetween(date, a.deadline) : Number.POSITIVE_INFINITY;
    const db = b.deadline ? daysBetween(date, b.deadline) : Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.createdAt.localeCompare(b.createdAt);
  };
}

/**
 * Drafts one day. `busy` holds calendar events and blocks that stay (manual ones); they are
 * never overlapped. `alreadyPlanned` is work minutes those kept blocks already use.
 */
export function draftDay(date: string, s: Settings, busy: Interval[], todos: SchedTodo[], alreadyPlanned = 0): DraftResult {
  const window = { start: toMin(s.dayStart), end: toMin(s.dayEnd) };
  let free = freeIntervals(window, busy, s.breakMinutes);
  let budget = Math.max(0, s.maxFocusMinutes - alreadyPlanned);
  const blocks: DraftBlock[] = [];
  const unscheduled: DraftResult['unscheduled'] = [];

  for (const todo of [...todos].sort(order(date))) {
    let need = shareFor(todo, date, s);
    if (need <= 0) continue;
    const urgent = todo.deadline !== null && daysBetween(date, todo.deadline) <= 0;
    while (need > 0 && budget > 0) {
      const minChunk = Math.min(need, s.minBlockMinutes);
      const slot = free.find((f) => f.end - f.start >= minChunk);
      if (!slot) break;
      const length = Math.min(need, s.maxBlockMinutes, slot.end - slot.start, budget);
      if (length < minChunk) break;
      blocks.push({ start: slot.start, end: slot.start + length, title: todo.title, todoId: todo.id });
      need -= length;
      budget -= length;
      // Consume the slot plus a break after the block.
      free = free
        .map((f) => (f === slot ? { start: Math.min(f.end, slot.start + length + s.breakMinutes), end: f.end } : f))
        .filter((f) => f.end - f.start > 0);
    }
    if (need > 0 && urgent) unscheduled.push({ todoId: todo.id, title: todo.title, minutes: need });
  }
  blocks.sort((a, b) => a.start - b.start);
  return { blocks, unscheduled };
}

function toMin(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function describe(block: DraftBlock): string {
  return `${fromMinutes(block.start)}-${fromMinutes(block.end)} ${block.title}`;
}
