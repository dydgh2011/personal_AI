/**
 * Planner messages: day/week plans, reminders and the Google Calendar connection.
 * Titles come from the owner's todos and calendar (possibly typed by an LLM), so they are
 * escaped: no markdown, no links, no mentions beyond the owner (allowed_mentions).
 */

import { torontoClock, ValidationError } from './format.js';

const DISCORD_LIMIT = 2000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
/** Google's OAuth consent page only. */
const GOOGLE_AUTH_URL = /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[A-Za-z0-9._~%&=+:/-]{20,2000}$/;

export interface PlanDay {
  date: string;
  weekday: string;
  status: 'none' | 'draft' | 'confirmed';
  blocks: Array<{ start: string; end: string; title: string; category?: Category }>;
  events: Array<{ start: string | null; end: string | null; title: string; allDay: boolean; category?: Category | null }>;
  unscheduled: Array<{ title: string; minutes: number }>;
  /** Open todos past their deadline: the planner no longer plans them; the owner says what to do (2026-11-26). */
  overdue?: Array<{ title: string; deadline: string; minutes: number }>;
}

export interface PlanMessage {
  kind: 'proposal' | 'week' | 'today';
  days: PlanDay[];
  calendarConnected: boolean;
  todayBlocks?: Array<{ start: string; end: string; title: string }>;
  /** The planner's real reminder settings (2026-11-26); without it the message says nothing about reminders. */
  remind?: RemindInfo;
}

export interface RemindInfo {
  minutes: number;
  shortMinutes: number;
  shortEventMinutes: number;
  scope: 'all' | 'planner';
  bundleMinutes: number;
  quiet: string[];
}

export interface ReminderMessage {
  title: string;
  start: string;
  minutesBefore: number;
  location: string | null;
  fromPlanner: boolean;
  /** Events starting soon after this one, reminded in the same message (2026-11-26). */
  also?: Array<{ title: string; start: string; location: string | null }>;
}

export interface CalendarMessage {
  status: 'connect' | 'connected' | 'failed' | 'disconnected';
  authUrl?: string;
  expiresAt?: string;
  message?: string;
}

/** Same categories (and colours) as the planner's calendar events; the dot matches the colour. */
const CATEGORY_DOT = { class: '🔵', study: '🩵', task: '🟡', deadline: '🔴', routine: '🟢', personal: '🟣', birthday: '🩷' } as const;
type Category = keyof typeof CATEGORY_DOT;

function category(value: unknown, field: string): Category | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !Object.hasOwn(CATEGORY_DOT, value)) throw new ValidationError(`${field} is not a known category`);
  return value as Category;
}

// ---- validation -------------------------------------------------------------------------

function obj(value: unknown, field: string, allowed: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError(`${field} must be an object`);
  const o = value as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ValidationError(`Unexpected ${field} fields: ${extra.join(', ')}`);
  return o;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new ValidationError(`${field} must be text up to ${max} characters`);
  return value;
}

function list<T>(value: unknown, field: string, max: number, item: (v: unknown, i: number) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new ValidationError(`${field} must be a list of at most ${max}`);
  return value.map(item);
}

function time(value: unknown, field: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !TIME.test(value)) throw new ValidationError(`${field} must be HH:MM`);
  return value;
}

function slot(v: unknown, field: string) {
  const b = obj(v, field, ['start', 'end', 'title', 'category']);
  const c = category(b.category, `${field}.category`);
  return { start: time(b.start, `${field}.start`)!, end: time(b.end, `${field}.end`)!, title: text(b.title, `${field}.title`, 200), ...(c ? { category: c } : {}) };
}

export function parsePlan(value: unknown): PlanMessage {
  const p = obj(value, 'plan', ['kind', 'days', 'calendarConnected', 'todayBlocks', 'remind']);
  if (p.kind !== 'proposal' && p.kind !== 'week' && p.kind !== 'today') throw new ValidationError('plan.kind must be proposal, week or today');
  if (typeof p.calendarConnected !== 'boolean') throw new ValidationError('plan.calendarConnected must be a boolean');
  const days = list(p.days, 'plan.days', 14, (v, i) => {
    const d = obj(v, `plan.days[${i}]`, ['date', 'weekday', 'status', 'blocks', 'events', 'unscheduled', 'overdue']);
    if (typeof d.date !== 'string' || !DATE.test(d.date)) throw new ValidationError('day.date must be YYYY-MM-DD');
    if (typeof d.weekday !== 'string' || !WEEKDAYS.includes(d.weekday)) throw new ValidationError('day.weekday is invalid');
    if (d.status !== 'none' && d.status !== 'draft' && d.status !== 'confirmed') throw new ValidationError('day.status is invalid');
    return {
      date: d.date,
      weekday: d.weekday,
      status: d.status as PlanDay['status'],
      blocks: list(d.blocks, 'day.blocks', 40, (b, j) => slot(b, `blocks[${j}]`)),
      events: list(d.events, 'day.events', 40, (e, j) => {
        const ev = obj(e, `events[${j}]`, ['start', 'end', 'title', 'allDay', 'category']);
        if (typeof ev.allDay !== 'boolean') throw new ValidationError('event.allDay must be a boolean');
        return {
          start: time(ev.start, 'event.start', true),
          end: time(ev.end, 'event.end', true),
          title: text(ev.title, 'event.title', 200),
          allDay: ev.allDay,
          category: category(ev.category, 'event.category'),
        };
      }),
      unscheduled: list(d.unscheduled, 'day.unscheduled', 20, (u, j) => {
        const x = obj(u, `unscheduled[${j}]`, ['title', 'minutes']);
        if (typeof x.minutes !== 'number' || !Number.isInteger(x.minutes) || x.minutes < 0 || x.minutes > 6000) throw new ValidationError('unscheduled.minutes is invalid');
        return { title: text(x.title, 'unscheduled.title', 200), minutes: x.minutes };
      }),
      ...(d.overdue === undefined ? {} : {
        overdue: list(d.overdue, 'day.overdue', 20, (o, j) => {
          const x = obj(o, `overdue[${j}]`, ['title', 'deadline', 'minutes']);
          if (typeof x.deadline !== 'string' || !DATE.test(x.deadline)) throw new ValidationError('overdue.deadline must be YYYY-MM-DD');
          if (typeof x.minutes !== 'number' || !Number.isInteger(x.minutes) || x.minutes < 0 || x.minutes > 6000) throw new ValidationError('overdue.minutes is invalid');
          return { title: text(x.title, 'overdue.title', 200), deadline: x.deadline, minutes: x.minutes };
        }),
      }),
    };
  });
  if (days.length < 1) throw new ValidationError('plan.days must not be empty');
  const todayBlocks = p.todayBlocks === undefined ? undefined : list(p.todayBlocks, 'plan.todayBlocks', 40, (b, j) => slot(b, `todayBlocks[${j}]`));
  return { kind: p.kind, days, calendarConnected: p.calendarConnected, todayBlocks, ...(p.remind === undefined ? {} : { remind: parseRemind(p.remind) }) };
}

function whole(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ValidationError(`${field} must be a whole number ${min}-${max}`);
  return value;
}

function parseRemind(value: unknown): RemindInfo {
  const r = obj(value, 'plan.remind', ['minutes', 'shortMinutes', 'shortEventMinutes', 'scope', 'bundleMinutes', 'quiet']);
  if (r.scope !== 'all' && r.scope !== 'planner') throw new ValidationError('remind.scope must be all or planner');
  return {
    minutes: whole(r.minutes, 'remind.minutes', 1, 240),
    shortMinutes: whole(r.shortMinutes, 'remind.shortMinutes', 1, 240),
    shortEventMinutes: whole(r.shortEventMinutes, 'remind.shortEventMinutes', 0, 240),
    scope: r.scope,
    bundleMinutes: whole(r.bundleMinutes, 'remind.bundleMinutes', 0, 240),
    quiet: list(r.quiet, 'remind.quiet', 30, (w, i) => text(w, `remind.quiet[${i}]`, 60)),
  };
}

function dateTime(value: unknown, field: string): string {
  const s = text(value, field, 40);
  if (Number.isNaN(Date.parse(s))) throw new ValidationError(`${field} must be a date-time`);
  return s;
}

export function parseReminder(value: unknown): ReminderMessage {
  const r = obj(value, 'reminder', ['title', 'start', 'minutesBefore', 'location', 'fromPlanner', 'also']);
  const start = text(r.start, 'reminder.start', 40);
  if (Number.isNaN(Date.parse(start))) throw new ValidationError('reminder.start must be a date-time');
  if (typeof r.minutesBefore !== 'number' || !Number.isInteger(r.minutesBefore) || r.minutesBefore < 0 || r.minutesBefore > 240) {
    throw new ValidationError('reminder.minutesBefore is invalid');
  }
  if (typeof r.fromPlanner !== 'boolean') throw new ValidationError('reminder.fromPlanner must be a boolean');
  return {
    title: text(r.title, 'reminder.title', 200),
    start,
    minutesBefore: r.minutesBefore,
    location: r.location === null || r.location === undefined ? null : text(r.location, 'reminder.location', 200),
    fromPlanner: r.fromPlanner,
    ...(r.also === undefined ? {} : {
      also: list(r.also, 'reminder.also', 10, (a, i) => {
        const x = obj(a, `reminder.also[${i}]`, ['title', 'start', 'location']);
        return {
          title: text(x.title, 'also.title', 200),
          start: dateTime(x.start, 'also.start'),
          location: x.location === null || x.location === undefined ? null : text(x.location, 'also.location', 200),
        };
      }),
    }),
  };
}

export function parseCalendar(value: unknown): CalendarMessage {
  const c = obj(value, 'calendar', ['status', 'authUrl', 'expiresAt', 'message']);
  if (!['connect', 'connected', 'failed', 'disconnected'].includes(c.status as string)) throw new ValidationError('calendar.status is invalid');
  const out: CalendarMessage = { status: c.status as CalendarMessage['status'] };
  if (c.status === 'connect') {
    if (typeof c.authUrl !== 'string' || !GOOGLE_AUTH_URL.test(c.authUrl)) throw new ValidationError('calendar.authUrl must be a Google sign-in URL');
    out.authUrl = c.authUrl;
    const expires = text(c.expiresAt, 'calendar.expiresAt', 40);
    if (Number.isNaN(Date.parse(expires))) throw new ValidationError('calendar.expiresAt must be a date-time');
    out.expiresAt = expires;
  }
  if (c.message !== undefined) out.message = text(c.message, 'calendar.message', 300);
  return out;
}

// ---- rendering --------------------------------------------------------------------------

/** One line of plain text: markdown, links and mentions neutralised. */
function plain(s: string, max = 120): string {
  const flat = s
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/`/g, 'ʹ')
    .replace(/@/g, '@​')
    .replace(/https?:\/\//gi, (m) => m.replace('//', '/​/'))
    .replace(/([\\*_~|>#[\]()<:-])/g, '\\$1')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function shortDate(date: string, weekday: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}/${d}(${weekday})`;
}

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h}시간 ${m}분` : h ? `${h}시간` : `${m}분`;
}

function plannedMinutes(day: PlanDay): number {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return day.blocks.reduce((sum, b) => sum + toMin(b.end) - toMin(b.start), 0);
}

/** Calendar events and planner blocks of one day, in time order. */
function dayLines(day: PlanDay, maxLines: number): string[] {
  const rows: Array<{ sort: string; line: string }> = [];
  // Fixed events: their colour dot (📅 when uncategorised). Plan blocks: the dot, or • .
  for (const e of day.events) {
    const mark = e.category ? CATEGORY_DOT[e.category] : '📅';
    if (e.allDay) rows.push({ sort: '00:00', line: `${mark} 종일 ${plain(e.title)}` });
    else rows.push({ sort: e.start ?? '00:00', line: `${mark} ${e.start}–${e.end} ${plain(e.title)}` });
  }
  for (const b of day.blocks) rows.push({ sort: b.start, line: `${b.category ? CATEGORY_DOT[b.category] : '•'} ${b.start}–${b.end} ${plain(b.title)} ✏️` });
  rows.sort((a, b) => a.sort.localeCompare(b.sort));
  const lines = rows.map((r) => r.line);
  if (!lines.length) lines.push('(계획된 일이 없어요)');
  if (lines.length > maxLines) return [...lines.slice(0, maxLines), `… 외 ${lines.length - maxLines}개`];
  return lines;
}

function unscheduledLine(day: PlanDay): string | null {
  if (!day.unscheduled.length) return null;
  return `⚠️ 시간이 모자라 못 넣은 일: ${day.unscheduled.map((u) => `${plain(u.title, 60)} ${hours(u.minutes)}`).join(', ')}`;
}

/** Overdue todos of these days, each once (a week lists the same todo on every day). */
function overdueLine(days: PlanDay[]): string | null {
  const seen = new Map<string, { title: string; deadline: string; minutes: number }>();
  for (const d of days) for (const o of d.overdue ?? []) seen.set(`${o.deadline}|${o.title}`, o);
  if (!seen.size) return null;
  const items = [...seen.values()].slice(0, 8).map((o) => {
    const [, m, day] = o.deadline.split('-').map(Number);
    return `${plain(o.title, 60)} (${m}/${day}까지${o.minutes ? `, 남은 ${hours(o.minutes)}` : ''})`;
  });
  const more = seen.size > 8 ? ` 외 ${seen.size - 8}개` : '';
  return `📌 마감이 지나 자동으로 다시 넣지 않는 할 일: ${items.join(', ')}${more} — 끝냈으면 "끝냈어", 아니면 새 마감이나 그만둘지 Kelly에게 알려주세요.`;
}

function fit(lines: string[]): string {
  const text = lines.join('\n');
  return text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 1)}…` : text;
}

export function formatPlan(p: PlanMessage, mentionUserId: string | null): string {
  const mention = mentionUserId ? `<@${mentionUserId}> ` : '';
  const lines: string[] = [];
  if (p.kind === 'today') {
    const day = p.days[0];
    lines.push(`${mention}**☀️ 오늘 ${shortDate(day.date, day.weekday)} 계획**${day.status === 'confirmed' ? '' : ' · 아직 확정 전'}`);
    lines.push(...dayLines(day, 30));
    const total = plannedMinutes(day);
    if (total) lines.push(`할 일 합계 ${hours(total)}`);
    const u = unscheduledLine(day);
    if (u) lines.push(u);
    const o = overdueLine([day]);
    if (o) lines.push(o);
    if (day.status !== 'confirmed') lines.push('괜찮으면 `@Kelly 오늘 계획 확정해줘`, 바꿀 게 있으면 Kelly에게 말해주세요.');
    if (p.remind) lines.push(remindLine(p.remind));
  } else if (p.kind === 'proposal') {
    const day = p.days[0];
    lines.push(`${mention}**📝 내일 ${shortDate(day.date, day.weekday)} 계획 초안**${day.status === 'confirmed' ? ' · 이미 확정됨' : ''}`);
    lines.push(...dayLines(day, 25));
    const total = plannedMinutes(day);
    if (total) lines.push(`할 일 합계 ${hours(total)}`);
    const u = unscheduledLine(day);
    if (u) lines.push(u);
    const o = overdueLine([day]);
    if (o) lines.push(o);
    if (p.todayBlocks?.length) {
      lines.push('');
      lines.push(`오늘 계획했던 일: ${p.todayBlocks.slice(0, 8).map((b) => plain(b.title, 40)).join(', ')} — 끝낸 일이 있으면 Kelly에게 알려주세요.`);
    }
    lines.push('');
    lines.push(
      day.status === 'confirmed'
        ? '바꿀 게 있으면 Kelly에게 말해주세요.'
        : '바꿀 게 있으면 Kelly에게 말해주세요(예: `@Kelly 내일 운동 7시로 옮겨줘`). 괜찮으면 `@Kelly 내일 계획 확정해줘` — 확정하면 Google Calendar에 들어가요.',
    );
  } else {
    lines.push(`${mention}**🗓️ 다음 주 ${shortDate(p.days[0].date, p.days[0].weekday)}–${shortDate(p.days.at(-1)!.date, p.days.at(-1)!.weekday)} 계획 초안**`);
    for (const day of p.days) {
      lines.push('');
      const total = plannedMinutes(day);
      lines.push(`**${shortDate(day.date, day.weekday)}**${day.status === 'confirmed' ? ' (확정)' : ''}${total ? ` · 할 일 ${hours(total)}` : ''}`);
      lines.push(...dayLines(day, 8));
      const u = unscheduledLine(day);
      if (u) lines.push(u);
    }
    const o = overdueLine(p.days);
    if (o) lines.push('', o);
    lines.push('');
    lines.push('바꿀 게 있으면 Kelly에게 말해주세요. 괜찮으면 `@Kelly 다음 주 계획 확정해줘` — 확정하면 Google Calendar에 들어가요.');
  }
  if (!p.calendarConnected) lines.push('ℹ️ Google Calendar가 아직 연결되지 않아 캘린더 일정은 빠져 있어요. `@Kelly 캘린더 연결해줘`');
  return fit(lines);
}

/**
 * How reminders work, from the planner's real settings (2026-11-26: the fixed "일정 15분 전에" was wrong for
 * short events, quiet events and bundling).
 */
function remindLine(r: RemindInfo): string {
  const which = r.scope === 'planner' ? '계획 블록' : '일정';
  const when = r.shortEventMinutes > 0 && r.shortMinutes !== r.minutes
    ? `${r.minutes}분 전(${hours(r.shortEventMinutes)} 이하 짧은 일정은 ${r.shortMinutes}분 전)`
    : `${r.minutes}분 전`;
  const parts = [`${which} ${when}에 알려드릴게요.`];
  if (r.bundleMinutes > 0) parts.push(`${r.bundleMinutes}분 안에 이어지는 일정은 한 번에 묶어요.`);
  if (r.quiet.length) {
    const shown = r.quiet.slice(0, 8).map((w) => plain(w, 20)).join('·');
    parts.push(`제목에 ${shown}${r.quiet.length > 8 ? ' 등' : ''} 중 하나가 들어간 일정은 알리지 않아요.`);
  }
  return `⏰ ${parts.join(' ')}`;
}

export function formatReminder(r: ReminderMessage, mentionUserId: string | null): string {
  const at = torontoClock(r.start);
  const where = r.location ? ` · 📍 ${plain(r.location, 80)}` : '';
  const lines = [`${mentionUserId ? `<@${mentionUserId}> ` : ''}**⏰ ${r.minutesBefore}분 뒤** ${at} ${plain(r.title)}${where}`];
  for (const x of r.also ?? []) lines.push(`이어서 ${torontoClock(x.start)} ${plain(x.title)}${x.location ? ` · 📍 ${plain(x.location, 80)}` : ''}`);
  return fit(lines);
}

export function formatCalendar(c: CalendarMessage, mentionUserId: string | null): string {
  const mention = mentionUserId ? `<@${mentionUserId}> ` : '';
  if (c.status === 'connect') {
    const until = torontoClock(c.expiresAt!);
    return fit([
      `${mention}**🔗 Google Calendar 연결**`,
      `1. **이 PC의 브라우저**에서 아래 링크를 열고 Google 계정으로 로그인하세요 (${until}까지):`,
      `<${c.authUrl}>`,
      '2. "확인되지 않은 앱" 화면이 나오면 **고급 → (안전하지 않음)으로 이동**을 누르고, 캘린더 권한을 허용하세요.',
      '3. "연결됐어요" 페이지가 나오면 끝이에요. 로그인이 끝나면 PC의 127.0.0.1로 돌아오기 때문에 휴대폰에서는 마지막 단계가 안 돼요.',
    ]);
  }
  if (c.status === 'connected') return fit([`${mention}**✅ Google Calendar 연결 완료** — 이제 캘린더 일정을 피해서 계획하고, 확정한 계획은 캘린더에 들어가요.`]);
  const why = c.message ? `\n내용: ${plain(c.message, 300)}` : '';
  return fit([`${mention}**⚠️ Google Calendar 연결이 ${c.status === 'failed' ? '실패했어요' : '끊겼어요'}**${why}\n\`@Kelly 캘린더 연결해줘\`라고 보내면 새 링크를 드릴게요.`]);
}
