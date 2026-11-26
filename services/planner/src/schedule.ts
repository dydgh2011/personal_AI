// Deterministic day drafting: fits open todos into the free time of one day. No LLM: Hermes
// discusses and edits the draft afterwards with the planner tools, and the owner confirms it.

import type { CheckSettings, Place, Travel } from './checks.js';
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
  /** Events this long or shorter are reminded `shortRemindMinutes` before instead (0 turns it off). */
  shortEventMinutes: number;
  shortRemindMinutes: number;
  /** Proposal checks (checks.ts): sleep window, last bus, places and travel times, events never to overlap. */
  sleepStart: string;
  sleepEnd: string;
  lastBus: CheckSettings['lastBus'];
  homePlace: string;
  places: Place[];
  travel: Travel[];
  protectedEvents: string[];
  /**
   * Final-exam days get no automatic draft (owner decision 2026-11-26): a day with a timed exam event whose
   * title contains one of these words. Kelly's explicit generate still works. [] turns it off.
   */
  noDraftExamWords: string[];
  /** Events whose title contains one of these words get no reminder (meals, breaks, shower, wake-up). */
  quietEvents: string[];
  /** One reminder also lists the events starting within this many minutes after it (0: one reminder per event). */
  bundleMinutes: number;
  /** When the evening draft is posted (HH:MM, 18:00-23:55); null: 30 minutes before sleepStart. */
  draftAt: string | null;
}

/** How many minutes before this event its reminder goes out. */
export function reminderLead(s: Pick<Settings, 'remindMinutes' | 'shortEventMinutes' | 'shortRemindMinutes'>, start: string, end: string | null): number {
  const length = end ? (Date.parse(end) - Date.parse(start)) / 60_000 : Infinity;
  return s.shortEventMinutes > 0 && length <= s.shortEventMinutes ? s.shortRemindMinutes : s.remindMinutes;
}

/** A title containing one of `words` (case-insensitive). */
export function titleHas(title: string, words: string[]): boolean {
  const t = title.toLowerCase();
  return words.some((w) => w && t.includes(w.toLowerCase()));
}

const clampTime = (minutes: number, lo: number, hi: number, fallback: number) => (minutes >= lo && minutes <= hi ? minutes : fallback);

/** Minutes after midnight of the evening draft: draftAt, else 30 minutes before sleepStart (18:00-23:55, else 23:00). */
export function draftMinutes(s: Pick<Settings, 'draftAt' | 'sleepStart'>): number {
  if (s.draftAt) return toMin(s.draftAt);
  return clampTime(toMin(s.sleepStart) - 30, 18 * 60, 23 * 60 + 55, 23 * 60);
}

/** Minutes after midnight of the morning post: sleepEnd (03:00-11:59, else 06:00). */
export function morningMinutes(s: Pick<Settings, 'sleepEnd'>): number {
  return clampTime(toMin(s.sleepEnd), 3 * 60, 12 * 60 - 1, 6 * 60);
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
  shortEventMinutes: 60, // owner 2026-11-25: short events 5 minutes before
  shortRemindMinutes: 5,
  sleepStart: '23:00',
  sleepEnd: '06:00',
  lastBus: null,
  homePlace: '집',
  places: [],
  travel: [],
  protectedEvents: ['exam', 'test', '시험', '기말'],
  noDraftExamWords: ['final', '기말'],
  // meals, breaks, shower, wake-up in the final-exam plan (data/plans/final-exam-2026): no reminder (2026-11-26)
  quietEvents: ['점심', '저녁', '아침', '간식', '쉬기', '샤워', '기상'],
  bundleMinutes: 30,
  draftAt: null,
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
  /** Todos whose whole remaining work is shorter than minBlockMinutes: not placed (no 5-minute crumbs). */
  tooSmall: Array<{ todoId: string; title: string; minutes: number }>;
}

/** Most leftover time put before each block when a gap is shared out (keeps blocks from drifting far apart). */
export const MAX_SPREAD_MINUTES = 60;

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
 * left (all of it on the deadline day); undated work gets at most `undatedDailyMinutes`.
 * Work whose deadline is before `date` is not planned: it was finished and not reported, it was an
 * in-class test, or the deadline moved. The owner decides (DayView.overdue) instead of the planner
 * filling every following day with it (2026-11-26: "FAS Technical Test" kept coming back).
 */
export function shareFor(todo: SchedTodo, date: string, s: Settings): number {
  if (todo.remaining <= 0) return 0;
  if (todo.earliest && daysBetween(date, todo.earliest) > 0) return 0;
  if (!todo.deadline) return Math.min(todo.remaining, s.undatedDailyMinutes);
  if (daysBetween(date, todo.deadline) < 0) return 0;
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
 * never overlapped. `alreadyPlanned` is work minutes those kept blocks already use. `notBefore`
 * (minutes since midnight) is the current time when drafting today: nothing is planned before it.
 *
 * 2026-11-26 review: no block is shorter than minBlockMinutes (a 5-minute "CSC207 A3 Submission" block was
 * drafted), and blocks no longer stack up from dayStart: (1) each chunk goes into the largest free gap left
 * (ties: the earlier one); (2) inside each gap the leftover time is shared out before the blocks (at most
 * MAX_SPREAD_MINUTES each, in 5-minute steps). Deterministic: same input, same draft.
 */
export function draftDay(date: string, s: Settings, busy: Interval[], todos: SchedTodo[], alreadyPlanned = 0, notBefore = 0): DraftResult {
  const window = { start: Math.max(toMin(s.dayStart), Math.ceil(notBefore / 5) * 5), end: toMin(s.dayEnd) };
  const gaps = freeIntervals(window, busy, s.breakMinutes);
  const free = gaps.map((g, i) => ({ start: g.start, end: g.end, gap: i }));
  let budget = Math.max(0, s.maxFocusMinutes - alreadyPlanned);
  const chunks: Array<{ gap: number; length: number; title: string; todoId: string }> = [];
  const unscheduled: DraftResult['unscheduled'] = [];
  const tooSmall: DraftResult['tooSmall'] = [];
  const min = s.minBlockMinutes;

  for (const todo of [...todos].sort(order(date))) {
    let need = shareFor(todo, date, s);
    if (need <= 0) continue;
    const urgent = todo.deadline !== null && daysBetween(date, todo.deadline) <= 0;
    if (need < min) {
      // the day's share is small but the work is not: plan one minimum block; tiny leftover work is not a block
      if (todo.remaining >= min) need = min;
      else {
        tooSmall.push({ todoId: todo.id, title: todo.title, minutes: need });
        continue;
      }
    }
    while (need >= min && budget >= min) {
      const slot = free
        .filter((f) => f.end - f.start >= min)
        .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)[0];
      if (!slot) break;
      let length = Math.min(need, s.maxBlockMinutes, slot.end - slot.start, budget);
      // Never leave a crumb: if the rest would be shorter than a block, shorten this one so the rest is one block
      // (only when that block still fits somewhere today; otherwise the rest waits for another day).
      const rest = need - length;
      if (rest > 0 && rest < min && need - min >= min && budget - (need - min) >= min) {
        const shorter = need - min;
        const leftHere = slot.end - (slot.start + shorter + s.breakMinutes);
        if (leftHere >= min || free.some((f) => f !== slot && f.end - f.start >= min)) length = Math.min(length, shorter);
      }
      chunks.push({ gap: slot.gap, length, title: todo.title, todoId: todo.id });
      need -= length;
      budget -= length;
      // Consume the slot plus a break after the block.
      slot.start = Math.min(slot.end, slot.start + length + s.breakMinutes);
    }
    if (need > 0 && urgent) unscheduled.push({ todoId: todo.id, title: todo.title, minutes: need });
  }

  const blocks: DraftBlock[] = [];
  gaps.forEach((g, i) => {
    const mine = chunks.filter((c) => c.gap === i);
    if (!mine.length) return;
    const used = mine.reduce((sum, c) => sum + c.length, 0) + (mine.length - 1) * s.breakMinutes;
    const spread = Math.min(MAX_SPREAD_MINUTES, Math.floor(Math.max(0, g.end - g.start - used) / (mine.length + 1) / 5) * 5);
    let cursor = g.start + spread;
    for (const c of mine) {
      blocks.push({ start: cursor, end: cursor + c.length, title: c.title, todoId: c.todoId });
      cursor += c.length + s.breakMinutes + spread;
    }
  });
  blocks.sort((a, b) => a.start - b.start);
  return { blocks, unscheduled, tooSmall };
}

function toMin(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function describe(block: DraftBlock): string {
  return `${fromMinutes(block.start)}-${fromMinutes(block.end)} ${block.title}`;
}
