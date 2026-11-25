// Code checks on a draft of calendar items (proposals): what a low-cost model got wrong when it wrote a
// schedule in prose (2026-11-25): study after an exam that ends at 20:00, a 40-minute leg used for a 90-minute
// trip, a deadline in the period left out. The planner reports these as warnings; Kelly fixes them or tells
// the owner why not. Pure functions: the caller passes the items, the calendar events and the todos.

import { toMinutes } from './time.js';

export interface Place {
  /** Name used in the travel table, e.g. "집", "UTM", "Sheridan". */
  name: string;
  /** Case-insensitive pieces of an event location that mean this place, e.g. ["UTM", "도서관", "Davis"]. */
  match: string[];
}

export interface Travel {
  from: string;
  to: string;
  minutes: number;
}

export interface CheckSettings {
  /** Sleep window, local HH:MM (the start may be before midnight and the end after it). */
  sleepStart: string;
  sleepEnd: string;
  /** Last bus home by day type, local HH:MM; a time before 12:00 means after midnight. null: no check. */
  lastBus: { weekday: string; saturday: string; sunday: string } | null;
  /** Place that counts as home (no last-bus check there). */
  homePlace: string;
  places: Place[];
  travel: Travel[];
  /** Calendar events whose title contains one of these must not be overlapped (exams, required classes). */
  protectedEvents: string[];
}

export interface CheckItem {
  title: string;
  date: string;
  start: string;
  end: string;
  location: string | null;
}

export interface CheckEvent extends CheckItem {
  category: string | null;
}

export interface CheckTodo {
  title: string;
  deadline: string | null;
}

const WEEKDAY = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday

export function placeOf(location: string | null, places: Place[]): string | null {
  if (!location) return null;
  const l = location.toLowerCase();
  for (const p of places) if (p.match.some((m) => m && l.includes(m.toLowerCase()))) return p.name;
  return null;
}

function travelMinutes(a: string, b: string, travel: Travel[]): number | null {
  const t = travel.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a));
  return t ? t.minutes : null;
}

function isProtected(title: string, words: string[]): boolean {
  const t = title.toLowerCase();
  return words.some((w) => w && t.includes(w.toLowerCase()));
}

function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
}

/**
 * Warnings for new items against the owner's rules and the calendar of the same days.
 * Existing class events that are not protected are ignored (the owner keeps them but does not attend).
 */
export function planChecks(items: CheckItem[], existing: CheckEvent[], todos: CheckTodo[], s: CheckSettings): string[] {
  const out: string[] = [];
  const sleepStart = toMinutes(s.sleepStart);
  const sleepEnd = toMinutes(s.sleepEnd);
  const dates = [...new Set(items.map((i) => i.date))].sort();

  for (const item of items) {
    const a = toMinutes(item.start);
    const b = toMinutes(item.end);
    // Sleep: [sleepStart, 24:00) and [00:00, sleepEnd) when the window crosses midnight.
    const asleep = sleepStart > sleepEnd ? a < sleepEnd || b > sleepStart : a < sleepEnd && b > sleepStart;
    if (asleep) out.push(`${item.date} "${item.title}" (${item.start}-${item.end})이(가) 수면 시간(${s.sleepStart}–${s.sleepEnd})과 겹쳐요`);

    const place = placeOf(item.location, s.places);
    if (s.lastBus && place && place !== s.homePlace) {
      const wd = WEEKDAY(item.date);
      const last = wd === 6 ? s.lastBus.saturday : wd === 0 ? s.lastBus.sunday : s.lastBus.weekday;
      let lastMin = toMinutes(last);
      if (lastMin < 12 * 60) lastMin += 24 * 60;
      if (b > lastMin) out.push(`${item.date} "${item.title}"이(가) 막차(${last}) 뒤에 끝나요 — 막차 전에 집으로 출발해야 해요`);
    }

    for (const e of existing) {
      if (e.date !== item.date || !overlaps(item, e)) continue;
      if (isProtected(e.title, s.protectedEvents)) {
        out.push(`${item.date} "${item.title}" (${item.start}-${item.end})이(가) 꼭 지켜야 하는 일정 "${e.title}" (${e.start}-${e.end})과 겹쳐요`);
      } else if (e.category !== 'class') {
        out.push(`${item.date} "${item.title}" (${item.start}-${item.end})이(가) 이미 있는 일정 "${e.title}" (${e.start}-${e.end})과 겹쳐요`);
      }
    }
  }

  // Travel: consecutive located entries of a day (new items + kept calendar events) at different places.
  for (const d of dates) {
    const kept = existing.filter((e) => e.date === d && (e.category !== 'class' || isProtected(e.title, s.protectedEvents)));
    const day = [...items.filter((i) => i.date === d), ...kept]
      .map((e) => ({ ...e, place: placeOf(e.location, s.places) }))
      .filter((e) => e.place)
      .sort((x, y) => toMinutes(x.start) - toMinutes(y.start));
    for (let i = 0; i + 1 < day.length; i++) {
      const x = day[i];
      const y = day[i + 1];
      if (x.place === y.place) continue;
      const need = travelMinutes(x.place!, y.place!, s.travel);
      if (need === null) continue;
      const gap = toMinutes(y.start) - toMinutes(x.end);
      if (gap < need) out.push(`${d} "${x.title}"(${x.place}, ${x.end} 끝) → "${y.title}"(${y.place}, ${y.start} 시작): 이동에 ${need}분이 필요한데 ${Math.max(gap, 0)}분뿐이에요`);
    }
  }

  // Deadlines inside the period: remind, so a draft does not leave them out.
  if (dates.length) {
    const first = dates[0];
    const last = dates[dates.length - 1];
    for (const t of todos) {
      if (!t.deadline || t.deadline < first || t.deadline > last) continue;
      const covered = items.some((i) => i.title.toLowerCase().includes(t.title.toLowerCase()));
      if (!covered) out.push(`이 기간에 마감인 할 일 "${t.title}" (${t.deadline}까지)이 시안에 없어요 — 넣거나 이미 끝났는지 확인하세요`);
    }
  }
  return out;
}
