import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCalendar, formatPlan, formatReminder, parseCalendar, parsePlan, parseReminder } from './plan-format.js';

const USER = '607593613769179141';
const day = (over: Record<string, unknown> = {}) => ({
  date: '2026-11-23',
  weekday: '월',
  status: 'draft',
  blocks: [{ start: '07:00', end: '08:30', title: '알고리즘 과제' }],
  events: [
    { start: '09:00', end: '11:00', title: 'CSC263 수업', allDay: false },
    { start: null, end: null, title: '휴일', allDay: true },
  ],
  unscheduled: [],
  ...over,
});

describe('plan messages', () => {
  it('tomorrow: calendar events and blocks in time order, how to change and confirm', () => {
    const text = formatPlan(parsePlan({ kind: 'proposal', days: [day()], calendarConnected: true, todayBlocks: [{ start: '10:00', end: '11:00', title: '운동' }] }), USER);
    assert.ok(text.startsWith(`<@${USER}> **📝 내일 11/23(월) 계획 초안**`), text);
    const lines = text.split('\n');
    assert.deepEqual(lines.slice(1, 4), ['📅 종일 휴일', '• 07:00–08:30 알고리즘 과제 ✏️', '📅 09:00–11:00 CSC263 수업']);
    const coloured = formatPlan(parsePlan({ kind: 'today', calendarConnected: true, days: [day({
      blocks: [{ start: '07:00', end: '08:30', title: '복습', category: 'study' }],
      events: [{ start: '09:00', end: '11:00', title: '강의', allDay: false, category: 'class' }, { start: null, end: null, title: '마감: 보고서', allDay: true, category: 'deadline' }],
    })] }), null);
    assert.deepEqual(coloured.split(String.fromCharCode(10)).slice(1, 4), ['🔴 종일 마감' + String.fromCharCode(92) + ': 보고서', '🩵 07:00–08:30 복습 ✏️', '🔵 09:00–11:00 강의']);
    assert.throws(() => parsePlan({ kind: 'today', calendarConnected: true, days: [day({ blocks: [{ start: '07:00', end: '08:00', title: 'x', category: 'evil' }] })] }), /category/);
    assert.match(text, /할 일 합계 1시간 30분/);
    assert.match(text, /오늘 계획했던 일: 운동/);
    assert.match(text, /@Kelly 내일 계획 확정해줘/);
    assert.doesNotMatch(text, /연결되지 않아/);
  });

  it('today and week variants; unscheduled work is flagged', () => {
    const today = formatPlan(parsePlan({ kind: 'today', days: [day({ status: 'confirmed', unscheduled: [{ title: '보고서', minutes: 90 }] })], calendarConnected: false }), USER);
    assert.match(today, /☀️ 오늘 11\/23\(월\) 계획\*\*\n/);
    assert.match(today, /못 넣은 일: 보고서 1시간 30분/);
    assert.match(today, /캘린더 연결해줘/);
    const days = Array.from({ length: 7 }, (_, i) => day({ date: `2026-11-${23 + i}`, weekday: ['월', '화', '수', '목', '금', '토', '일'][i] }));
    const week = formatPlan(parsePlan({ kind: 'week', days, calendarConnected: true }), USER);
    assert.match(week, /다음 주 11\/23\(월\)–11\/29\(일\)/);
    assert.ok(week.length <= 2000);
  });

  it('overdue todos: one line, once per message, optional for older planners (2026-11-26)', () => {
    const overdue = [{ title: 'FAS Technical Test', deadline: '2026-11-26', minutes: 120 }];
    for (const kind of ['today', 'proposal'] as const) {
      const text = formatPlan(parsePlan({ kind, days: [day({ overdue })], calendarConnected: true }), USER);
      assert.match(text, /📌 마감이 지나 자동으로 다시 넣지 않는 할 일: FAS Technical Test \(11\/26까지, 남은 2시간\)/, kind);
    }
    const days = Array.from({ length: 7 }, (_, i) => day({ date: `2026-11-${23 + i}`, weekday: ['월', '화', '수', '목', '금', '토', '일'][i], overdue }));
    const week = formatPlan(parsePlan({ kind: 'week', days, calendarConnected: true }), USER);
    assert.equal(week.split('📌').length - 1, 1);
    assert.doesNotMatch(formatPlan(parsePlan({ kind: 'today', days: [day()], calendarConnected: true }), USER), /📌/);
    assert.throws(() => parsePlan({ kind: 'today', days: [day({ overdue: [{ title: 'x', deadline: '11/26', minutes: 1 }] })], calendarConnected: true }), /deadline/);
    assert.throws(() => parsePlan({ kind: 'today', days: [day({ overdue: [{ title: 'x', deadline: '2026-11-26', minutes: 1, todoId: 'a' }] })], calendarConnected: true }), /Unexpected/);
  });

  it('neutralises markdown, links and mentions in titles', () => {
    const text = formatPlan(parsePlan({ kind: 'today', days: [day({ blocks: [{ start: '07:00', end: '08:00', title: '[클릭](https://evil.example) @everyone **굵게** `x`' }] })], calendarConnected: true }), null);
    assert.doesNotMatch(text, /\[클릭\]\(https:\/\/evil/);
    assert.doesNotMatch(text, /@everyone/);
    assert.doesNotMatch(text, /\*\*굵게\*\*/);
  });

  it('rejects malformed plans', () => {
    for (const p of [
      { kind: 'other', days: [day()], calendarConnected: true },
      { kind: 'today', days: [], calendarConnected: true },
      { kind: 'today', days: [day({ blocks: [{ start: '7:00', end: '08:00', title: 'x' }] })], calendarConnected: true },
      { kind: 'today', days: [day({ extra: 1 })], calendarConnected: true },
      { kind: 'today', days: [day()], calendarConnected: true, content: 'free text' },
    ]) {
      assert.throws(() => parsePlan(p), Error, JSON.stringify(p));
    }
  });
});

describe('reminders and calendar messages', () => {
  it('reminder in Toronto time with location', () => {
    const text = formatReminder(parseReminder({ title: 'CSC263 수업', start: '2026-11-23T14:00:00.000Z', minutesBefore: 15, location: 'BA 1160', fromPlanner: false }), USER);
    assert.match(text, /⏰ 15분 뒤\*\* 09:00 CSC263 수업 · 📍 BA 1160/);
    assert.equal(text.split('\n').length, 1);
  });

  it('a bundled reminder lists the next events (also is optional)', () => {
    const r = parseReminder({
      title: 'S3 · STA256', start: '2026-11-22T17:00:00.000Z', minutesBefore: 5, location: null, fromPlanner: false,
      also: [{ title: 'LeetCode 1문제', start: '2026-11-22T17:20:00.000Z', location: null }, { title: 'C2 · CSC207', start: '2026-11-22T17:30:00.000Z', location: 'UTM 도서관' }],
    });
    const lines = formatReminder(r, null).split('\n');
    assert.deepEqual(lines.slice(1), ['이어서 12:20 LeetCode 1문제', '이어서 12:30 C2 · CSC207 · 📍 UTM 도서관']);
    assert.throws(() => parseReminder({ ...r, also: [{ title: 'x', start: 'soon', location: null }] }), /date-time/);
    assert.throws(() => parseReminder({ ...r, also: [{ title: 'x', start: '2026-11-22T17:20:00Z', location: null, id: 1 }] }), /Unexpected/);
  });

  it('the today message states the real reminder settings, or nothing about reminders', () => {
    const remind = { minutes: 15, shortMinutes: 5, shortEventMinutes: 60, scope: 'all', bundleMinutes: 30, quiet: ['점심', '저녁', '샤워'] };
    const text = formatPlan(parsePlan({ kind: 'today', days: [day()], calendarConnected: true, remind }), USER);
    assert.match(text, /⏰ 일정 15분 전\(1시간 이하 짧은 일정은 5분 전\)에 알려드릴게요\. 30분 안에 이어지는 일정은 한 번에 묶어요\. 제목에 점심·저녁·샤워 중 하나가 들어간 일정은 알리지 않아요\./);
    assert.doesNotMatch(formatPlan(parsePlan({ kind: 'today', days: [day()], calendarConnected: true }), USER), /알려드릴게요/);
    const planner = formatPlan(parsePlan({ kind: 'today', days: [day()], calendarConnected: true, remind: { ...remind, scope: 'planner', bundleMinutes: 0, quiet: [], shortEventMinutes: 0 } }), USER);
    assert.match(planner, /⏰ 계획 블록 15분 전에 알려드릴게요\.$/m);
    assert.throws(() => parsePlan({ kind: 'today', days: [day()], calendarConnected: true, remind: { ...remind, extra: 1 } }), /Unexpected/);
    assert.throws(() => parsePlan({ kind: 'today', days: [day()], calendarConnected: true, remind: { ...remind, minutes: 0 } }), /remind.minutes/);
  });

  it('connect link: only Google\'s consent page', () => {
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123-abc.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1%3A8720%2Foauth%2Fcallback&state=abc';
    const text = formatCalendar(parseCalendar({ status: 'connect', authUrl: url, expiresAt: '2026-11-23T05:15:00Z' }), USER);
    assert.ok(text.includes(`<${url}>`));
    assert.match(text, /이 PC의 브라우저/);
    for (const bad of ['https://evil.example/o/oauth2/v2/auth?x=1234567890123456789012', 'https://accounts.google.com.evil.io/o/oauth2/v2/auth?a=12345678901234567890']) {
      assert.throws(() => parseCalendar({ status: 'connect', authUrl: bad, expiresAt: '2026-11-23T05:15:00Z' }), /Google sign-in URL/);
    }
    assert.match(formatCalendar(parseCalendar({ status: 'connected' }), null), /연결 완료/);
  });
});
