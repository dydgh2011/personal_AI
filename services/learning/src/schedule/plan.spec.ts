import { addDays, buildPlan, localTime, type Window, type WorkItem } from './plan.js';

const now = { date: '2026-11-24', minutes: 540 };
const windows: Window[] = [
  { weekday: 2, start: '10:00', end: '12:00' },
  { weekday: 3, start: '10:00', end: '12:00' },
];
const task = (id: string, fields: Partial<WorkItem> = {}): WorkItem => ({
  id, kind: 'assignment', title: id, domain: 'Math', goalId: 'math', weeklyMinutes: null,
  priority: 3, minutes: 120, deadline: null, dueDate: null, ...fields,
});

describe('deterministic learning plan', () => {
  it('is independent of input order, respects busy time and carries unfinished work forward', () => {
    const busy = new Map([['2026-11-24', [{ start: 630, end: 660 }]]]);
    const overdue = task('urgent', { deadline: '2026-11-23' });
    const lower = task('ordinary', { priority: 5 });
    const plan = buildPlan(now.date, 'week', now, windows, busy, [lower, overdue]);
    expect(plan).toEqual(buildPlan(now.date, 'week', now, windows, busy, [overdue, lower]));
    expect(plan.days[0].blocks).toMatchObject([{ id: 'urgent', start: '11:10', end: '11:40', deadline: '2026-11-23' }]);
    expect(plan.days[1].blocks).toMatchObject([{ id: 'urgent', minutes: 60 }, { id: 'urgent', minutes: 30 }]);
    expect(plan.remaining).toMatchObject([{ id: 'ordinary', remainingMinutes: 120 }]);
    expect(overdue.deadline).toBe('2026-11-23');
  });

  it('respects a goal’s weekly time, allows other domains, and resets the budget Monday', () => {
    const days: Window[] = [
      { weekday: 2, start: '10:00', end: '13:00' },
      { weekday: 1, start: '10:00', end: '13:00' },
    ];
    const a = task('first', { weeklyMinutes: 30, priority: 5 });
    const b = task('second', { goalId: 'physics', domain: 'Physics', weeklyMinutes: 60 });
    const plan = buildPlan(now.date, 'week', now, days, new Map(), [a, b]);
    expect(plan.days[0].blocks).toMatchObject([{ id: 'first', minutes: 30 }, { id: 'second', minutes: 60 }]);
    expect(plan.days[6].blocks).toMatchObject([{ id: 'first', minutes: 30 }, { id: 'second', minutes: 60 }]);
  });

  it('uses Toronto dates and skips unsafe wall-clock hours on daylight-saving transitions', () => {
    expect(localTime(new Date('2027-01-01T02:59:00Z'))).toEqual({ date: '2026-12-31', minutes: 1319 });
    expect(addDays('2027-03-14', 1)).toBe('2027-03-15');
    for (const date of ['2027-03-14', '2027-11-07']) {
      const plan = buildPlan(date, 'day', { date, minutes: 0 }, [{ weekday: 0, start: '01:00', end: '04:00' }], new Map(), [task('todo')]);
      expect(plan.days[0].blocks).toMatchObject([{ start: '03:00', end: '04:00' }]);
    }
  });
});
