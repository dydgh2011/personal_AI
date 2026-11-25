import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from './api.js';
import { GoogleConnection } from './connection.js';
import { openDatabase } from './db.js';
import { parseClientFile, SCOPES, type CalendarApi, type CalendarEvent, type EventInput, type GoogleAccount } from './google.js';
import { Jobs } from './jobs.js';
import type { NotifyEvent } from './notify.js';
import { Planner, PlannerError } from './planner.js';
import { planChecks } from './checks.js';
import { DEFAULT_SETTINGS, draftDay, freeIntervals, reminderLead, shareFor } from './schedule.js';
import { addDays, localParts, toInstant } from './time.js';

const TZ = 'America/Toronto';
const silent = { info: () => {}, warn: () => {} };

/** In-memory Google calendar. */
class FakeCalendar implements CalendarApi {
  events = new Map<string, CalendarEvent>();
  private static n = 0;
  constructor(readonly summary = 'Kelly') {}
  add(summary: string, date: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): string {
    const id = `ev${++FakeCalendar.n}`;
    this.events.set(id, {
      id,
      status: 'confirmed',
      summary,
      start: toInstant(date, start, TZ).toISOString(),
      end: toInstant(date, end, TZ).toISOString(),
      allDay: false,
      date: null,
      endDate: null,
      location: null,
      description: null,
      transparent: false,
      declined: false,
      category: null,
      recurrence: null,
      recurringEventId: null,
      plannerBlockId: null,
      deadlineTodoId: null,
      importedFrom: null,
      ...extra,
    });
    return id;
  }
  private fromInput(i: EventInput): Partial<CalendarEvent> {
    const t = i.timing;
    const timing =
      t.kind === 'timed'
        ? { start: toInstant(t.date, t.start, TZ).toISOString(), end: toInstant(t.endDate ?? t.date, t.end, TZ).toISOString(), allDay: false, date: null, endDate: null }
        : { start: null, end: null, allDay: true, date: t.date, endDate: t.endDate };
    return {
      summary: i.summary,
      ...timing,
      location: i.location ?? null,
      description: i.description ?? null,
      category: i.category,
      ...(i.recurrence !== undefined ? { recurrence: i.recurrence } : {}),
      plannerBlockId: i.blockId ?? null,
      deadlineTodoId: i.deadlineTodoId ?? null,
      importedFrom: i.importedFrom ?? null,
    };
  }
  async listEvents(timeMin: string, timeMax: string) {
    const lo = Date.parse(timeMin);
    const hi = Date.parse(timeMax);
    return [...this.events.values()].filter((e) =>
      e.allDay ? Date.parse(`${e.date}T12:00:00Z`) < hi && Date.parse(`${e.endDate}T00:00:00Z`) > lo : Date.parse(e.start!) < hi && Date.parse(e.end!) > lo,
    );
  }
  async getEvent(id: string) {
    return this.events.get(id) ?? null;
  }
  async insertEvent(i: EventInput) {
    const generated = this.add(i.summary, '2000-01-01', '00:00', '01:00');
    const id = i.id ?? generated;
    const event = this.events.get(generated)!;
    this.events.delete(generated);
    this.events.set(id, { ...event, ...this.fromInput(i), id });
    return id;
  }
  async patchEvent(id: string, i: EventInput) {
    Object.assign(this.events.get(id)!, this.fromInput(i));
  }
  async deleteEvent(id: string) {
    this.events.delete(id);
  }
}

/** In-memory Google account: a calendar list; the planner may create calendars. */
class FakeAccount implements GoogleAccount {
  calendars = new Map<string, FakeCalendar>();
  managed = new FakeCalendar('Kelly');
  created = 0;
  source(name: string): FakeCalendar {
    const c = new FakeCalendar(name);
    this.calendars.set(`src-${name}`, c);
    return c;
  }
  async calendarList() {
    return [...this.calendars.entries()].map(([id, c]) => ({ id, summary: c.summary, primary: false, accessRole: 'owner' }));
  }
  async createCalendar(summary: string) {
    this.created++;
    const id = `managed-${this.created}`;
    // The first managed calendar is the object tests already hold; later ones are new.
    if (this.created > 1) this.managed = new FakeCalendar(summary);
    this.calendars.set(id, this.managed);
    return id;
  }
  calendar(id: string) {
    const c = this.calendars.get(id);
    if (!c) throw new Error(`no calendar ${id}`);
    return c;
  }
  async listSeries(id: string, timeMin: string, timeMax: string) {
    const c = this.calendars.get(id)!;
    return [...c.events.values()].filter((e) => e.recurrence || (e.allDay ? true : Date.parse(e.start!) < Date.parse(timeMax) && Date.parse(e.end!) > Date.parse(timeMin)));
  }
}

/** Saturday 2026-11-21 10:00 Toronto. */
const SAT_10 = toInstant('2026-11-21', '10:00', TZ).getTime();

function setup(now = SAT_10, connected = true) {
  const db = openDatabase(':memory:');
  const account = new FakeAccount();
  let clock = now;
  const google = new GoogleConnection(db, null, 'http://127.0.0.1:8720/oauth/callback', TZ, fetch, () => clock, connected ? account : null);
  const planner = new Planner(db, google, TZ, () => clock);
  const sent: NotifyEvent[] = [];
  const notify = async (e: NotifyEvent) => {
    sent.push(e);
    return 'delivered' as const;
  };
  const jobs = new Jobs(db, planner, notify, silent, () => clock);
  return {
    db,
    account,
    /** The managed calendar (created on first use). */
    get cal() {
      return account.managed;
    },
    planner,
    sent,
    jobs,
    setClock: (t: number) => (clock = t),
  };
}


describe('Learning planner drafts', () => {
  const key = 'assignment:52d53d26-d51b-4d35-b505-49e3863feb35';
  const date = '2026-11-22';
  const draftBody = {
    date, period: 'day',
    items: [
      { date, title: 'Solve one problem', start: '18:00', end: '19:00', task: { key, priority: 1, estimateMinutes: 90, deadline: date } },
      { date, title: 'Solve one problem', start: '23:30', end: '24:00', task: { key, priority: 1, estimateMinutes: 90, deadline: date } },
    ],
  };

  it('only exposes scoped planner calls and waits for the existing approval before writing a todo or calendar block', async () => {
    const { db, planner, account, cal } = setup();
    const learning = { 'X-Planner-Key': 'learning-fixture' };
    const hermes = { 'X-Planner-Key': 'broker-fixture' };
    const keys = [{ name: 'hermes-broker', key: hermes['X-Planner-Key'] }, { name: 'learning', key: learning['X-Planner-Key'] }];
    const server = createApi(planner, async () => 'delivered', keys, silent);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, headers: Record<string, string>, body: object) => fetch(base + path, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    try {
      const unavailable = await fetch(base + `/learning/availability?date=${date}`, { headers: learning });
      assert.equal(unavailable.status, 200);
      assert.deepEqual(await unavailable.json(), { timeZone: TZ, calendarConnected: false, reserved: [], days: [{ date, busy: [] }] });
      assert.equal(account.created, 0, 'reading availability cannot create a Google calendar');
      await planner.cal(); // normal owner use creates the managed calendar
      cal.add('private appointment', date, '12:00', '13:00');
      cal.add('free slot', date, '14:00', '15:00', { transparent: true });
      const availability = await fetch(base + `/learning/availability?date=${date}`, { headers: learning });
      assert.deepEqual(await availability.json(), {
        timeZone: TZ, calendarConnected: true, reserved: [], days: [{ date, busy: [{ start: 720, end: 780 }] }],
      });
      assert.equal((await post('/learning/proposals', hermes, draftBody)).status, 403);
      assert.equal((await post('/todos', learning, {})).status, 403);
      const response = await post('/learning/proposals', learning, draftBody);
      const { proposal } = await response.json() as { proposal: { code: string; items: Array<{ todo?: unknown }> } };
      assert.equal(response.status, 200);
      assert.deepEqual(proposal.items[0].todo, { title: 'Solve one problem', estimateMinutes: 90, deadline: date });
      const retry = await post('/learning/proposals', learning, draftBody);
      assert.equal((await retry.json() as { proposal: { code: string } }).proposal.code, proposal.code);
      assert.equal(planner.proposals().length, 1);
      assert.equal(planner.listTodos().length, 0);
      assert.equal(cal.events.size, 2);
      assert.equal((await post(`/proposals/${proposal.code}/apply`, learning, {})).status, 403);

      const approve = await post(`/proposals/${proposal.code}/apply`, hermes, {});
      assert.equal(approve.status, 200);
      const todo = planner.listTodos()[0];
      assert.equal(planner.listTodos().length, 1);
      assert.equal(todo.deadline, date);
      const day = await planner.day(date);
      assert.deepEqual(day.blocks.map((b) => [b.start, b.end, b.todoId]), [['18:00', '19:00', todo.id], ['23:30', '24:00', todo.id]]);
      assert.equal([...cal.events.values()].find((e) => e.plannerBlockId === day.blocks[1].id)?.end, toInstant('2026-11-23', '00:00', TZ).toISOString());
      assert.deepEqual((await planner.learningAvailability(date, 1)).reserved, [{ key, minutes: 90 }]);
      assert.equal((await post(`/proposals/${proposal.code}/apply`, hermes, {})).status, 400);
      assert.equal(cal.events.size, 4, 'reapplying cannot duplicate calendar events');
      assert.equal(planner.listTodos().length, 1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    }
  });

  it('recovers a calendar write before a failed response and refuses a newly busy slot', async () => {
    const { db, planner, cal } = setup();
    try {
      await planner.cal();
      const proposed = planner.createLearningProposal(draftBody);
      const originalInsert = cal.insertEvent.bind(cal);
      let loseResponse = true;
      cal.insertEvent = async (event) => {
        const id = await originalInsert(event);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('simulated interrupted write response');
        }
        return id;
      };
      await assert.rejects(planner.applyProposal(proposed.code, { items: [1] }, 'hermes'), /interrupted/);
      assert.equal(cal.events.size, 1);
      assert.equal(planner.listTodos().length, 0);
      await planner.applyProposal(proposed.code, { items: [1] }, 'hermes');
      assert.equal(cal.events.size, 1);
      assert.equal(planner.listTodos().length, 1);

      cal.add('new appointment', date, '23:40', '23:55');
      await assert.rejects(planner.applyProposal(proposed.code, { items: [2] }, 'hermes'), (error: unknown) => error instanceof PlannerError && error.code === 'plan_conflict');
      assert.equal(cal.events.size, 2);
      assert.equal(planner.proposal(proposed.code).items[1].applied, false);
    } finally {
      db.close();
    }
  });
});

describe('proposal checks', () => {
  const s = {
    ...DEFAULT_SETTINGS,
    lastBus: { weekday: '01:22', saturday: '22:00', sunday: '21:40' },
    places: [
      { name: '집', match: ['집'] },
      { name: 'UTM', match: ['UTM', 'Davis', 'RA Gym'] },
      { name: 'Sheridan', match: ['Sheridan', 'SH AA'] },
    ],
    travel: [{ from: '집', to: 'UTM', minutes: 40 }, { from: '집', to: 'Sheridan', minutes: 90 }, { from: 'Sheridan', to: 'UTM', minutes: 40 }],
  };
  const item = (title: string, date: string, start: string, end: string, location: string | null = null) => ({ title, date, start, end, location });

  it('passes a day that keeps sleep, travel and the exam', () => {
    const items = [item('기상', '2026-11-26', '06:00', '07:00', '집'), item('S1', '2026-11-26', '13:10', '14:25', 'UTM 도서관'), item('샤워', '2026-11-26', '20:30', '21:30', '집')];
    const existing = [{ ...item('FAS147H5 PRA0102', '2026-11-26', '09:00', '12:00', 'Sheridan Trafalgar'), category: 'class' }];
    assert.deepEqual(planChecks(items, existing, [], { ...s, protectedEvents: [...s.protectedEvents, 'FAS147'] }), []);
  });

  it('flags what the prose draft got wrong: study over an exam, short travel, late bus, sleep, missing deadline', () => {
    const items = [
      item('CSC207 복습', '2026-12-10', '18:00', '19:00', 'UTM 도서관'),
      item('집에서 출발', '2026-12-01', '07:30', '08:00', '집'),
      item('S10', '2026-12-05', '21:30', '22:30', 'UTM 도서관'),
      item('LeetCode', '2026-12-05', '23:10', '23:40', '집'),
    ];
    const existing = [
      { ...item('STA256H5 Final Exam', '2026-12-10', '17:00', '20:00', 'RA Gym A/B'), category: 'class' },
      { ...item('FAS147H5 PRA0102', '2026-12-01', '09:00', '12:00', 'Sheridan Trafalgar'), category: 'class' },
      { ...item('MAT223 LEC', '2026-12-10', '11:00', '12:00', 'IB 345'), category: 'class' },
    ];
    const w = planChecks(items, existing, [{ title: 'MAT223 Weekly HW & PCRA', deadline: '2026-12-08' }], { ...s, protectedEvents: [...s.protectedEvents, 'FAS147'] });
    assert.ok(w.some((x) => x.includes('꼭 지켜야 하는 일정 "STA256H5 Final Exam"')), w.join('\n'));
    assert.ok(w.some((x) => x.includes('이동에 90분이 필요한데 60분뿐')), w.join('\n'));
    assert.ok(w.some((x) => x.includes('막차(22:00) 뒤에')), w.join('\n'));
    assert.ok(w.some((x) => x.includes('수면 시간')), w.join('\n'));
    assert.ok(w.some((x) => x.includes('MAT223 Weekly HW & PCRA')), w.join('\n'));
    assert.ok(!w.some((x) => x.includes('MAT223 LEC')), 'unattended classes are ignored');
  });

  it('returns the checks with a proposal and validates the settings', async () => {
    const { cal, planner } = setup();
    cal.add('CSC236H5 Final Exam', '2026-12-16', '09:00', '12:00', { category: 'class' });
    const p = planner.createProposal({ title: '시험 날', items: [{ title: '공부', date: '2026-12-16', start: '10:00', end: '11:00', category: 'study' }] }, 'hermes');
    const view = await planner.checkedProposal(p.code);
    assert.ok(view.warnings.some((w) => w.includes('CSC236H5 Final Exam')), view.warnings.join('\n'));
    assert.throws(() => planner.updateSettings({ travel: [{ from: '집', to: 'UTM' }] }, 'hermes'), /minutes/);
    const saved = planner.updateSettings({ lastBus: { weekday: '01:22', saturday: '22:00', sunday: '21:40' }, protectedEvents: ['Exam', 'FAS147'] }, 'hermes');
    assert.deepEqual(saved.protectedEvents, ['Exam', 'FAS147']);
  });
});

describe('reminders', () => {
  it('reminds short events 5 minutes before and longer ones 15 minutes before', () => {
    const at = (h: string) => `2026-11-25T${h}:00-05:00`;
    assert.equal(reminderLead(DEFAULT_SETTINGS, at('19:00'), at('20:00')), 5);
    assert.equal(reminderLead(DEFAULT_SETTINGS, at('19:00'), at('20:30')), 15);
    assert.equal(reminderLead(DEFAULT_SETTINGS, at('19:00'), null), 15);
    assert.equal(reminderLead({ ...DEFAULT_SETTINGS, shortEventMinutes: 0 }, at('19:00'), at('19:30')), 15);
  });
});

describe('time', () => {
  it('converts Toronto wall-clock times across DST', () => {
    assert.equal(toInstant('2026-11-21', '23:00', TZ).toISOString(), '2026-11-22T04:00:00.000Z'); // EST
    assert.equal(toInstant('2026-07-01', '23:00', TZ).toISOString(), '2026-07-02T03:00:00.000Z'); // EDT
    assert.deepEqual(localParts(new Date('2026-11-22T04:30:00Z'), TZ), { date: '2026-11-21', time: '23:30', weekday: 6, minutes: 1410 });
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });
});

describe('schedule', () => {
  it('works around busy time with breaks', () => {
    const free = freeIntervals({ start: 420, end: 1350 }, [{ start: 600, end: 720 }], 10);
    assert.deepEqual(free, [{ start: 420, end: 590 }, { start: 730, end: 1350 }]);
  });

  it('spreads deadline work over the days left and puts overdue work first', () => {
    const t = { id: 'a', title: 'A', priority: 2, remaining: 300, deadline: '2026-11-25', earliest: null, createdAt: '' };
    assert.equal(shareFor(t, '2026-11-21', DEFAULT_SETTINGS), 60); // 300 / 5 days
    assert.equal(shareFor(t, '2026-11-25', DEFAULT_SETTINGS), 300);
    const draft = draftDay('2026-11-22', { ...DEFAULT_SETTINGS, dayStart: '09:00', dayEnd: '12:00' }, [], [
      { id: 'late', title: 'Undated', priority: 1, remaining: 60, deadline: null, earliest: null, createdAt: '1' },
      { id: 'due', title: 'Due today', priority: 3, remaining: 120, deadline: '2026-11-22', earliest: null, createdAt: '2' },
    ]);
    assert.deepEqual(draft.blocks.map((b) => [b.title, b.start, b.end]), [
      ['Due today', 540, 630],
      ['Due today', 640, 670],
      ['Undated', 680, 720],
    ]);
    assert.deepEqual(draft.unscheduled, []);
  });

  it('reports deadline work that does not fit', () => {
    const draft = draftDay('2026-11-22', { ...DEFAULT_SETTINGS, dayStart: '09:00', dayEnd: '10:00' }, [], [
      { id: 'due', title: 'Due', priority: 1, remaining: 180, deadline: '2026-11-22', earliest: null, createdAt: '' },
    ]);
    assert.equal(draft.unscheduled[0].minutes, 120);
  });
});

describe('Planner', () => {
  it('drafts around calendar events, confirms into the calendar and follows changes made there', async () => {
    const { cal, planner } = setup();
    cal.add('수업', '2026-11-22', '09:00', '11:00');
    const todo = planner.addTodo({ title: '알고리즘 과제', estimateMinutes: 120, deadline: '2026-11-22' }, 'hermes');
    const [day] = await planner.generate('2026-11-22', 1, 'hermes');
    assert.equal(day.status, 'draft');
    assert.deepEqual(day.events.map((e) => [e.title, e.start, e.end]), [['수업', '09:00', '11:00']]);
    assert.deepEqual(day.blocks.map((b) => [b.start, b.end]), [['07:00', '08:30'], ['11:10', '11:40']]);
    assert.ok(day.blocks.every((b) => b.todoId === todo.id && !b.inCalendar));

    const [confirmed] = await planner.confirm(['2026-11-22'], 'hermes');
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.blocks.every((b) => b.inCalendar && !b.pending));
    const ours = [...cal.events.values()].filter((e) => e.plannerBlockId);
    assert.equal(ours.length, 2);

    // The owner moves one event and deletes the other in Google Calendar.
    const [first, second] = ours;
    first.start = toInstant('2026-11-22', '13:00', TZ).toISOString();
    first.end = toInstant('2026-11-22', '14:30', TZ).toISOString();
    cal.events.delete(second.id);
    const after = await planner.day('2026-11-22');
    assert.deepEqual(after.blocks.map((b) => [b.start, b.end]), [['13:00', '14:30']]);
    assert.ok(planner.changes().some((c) => c.actor === 'calendar' && c.action === 'remove'));
  });

  it('keeps manual edits on regeneration, reopens a confirmed plan and syncs only the difference', async () => {
    const { cal, planner } = setup();
    planner.addTodo({ title: '운동', estimateMinutes: 60 }, 'hermes');
    const [day] = await planner.generate('2026-11-22', 1, 'hermes');
    await planner.confirm(['2026-11-22'], 'hermes');
    const moved = planner.updateBlock(day.blocks[0].id, { start: '18:00' }, 'hermes');
    assert.deepEqual([moved.start, moved.end, moved.origin, moved.pending], ['18:00', '19:00', 'manual', true]);
    const reopened = await planner.day('2026-11-22');
    assert.equal(reopened.status, 'draft');
    assert.equal(reopened.pendingChanges, true);
    const regenerated = (await planner.generate('2026-11-22', 1, 'hermes'))[0];
    assert.deepEqual(regenerated.blocks.map((b) => b.start), ['18:00'], 'manual block kept, nothing re-planned for the same todo');
    await planner.confirm(['2026-11-22'], 'hermes');
    const event = [...cal.events.values()].find((e) => e.plannerBlockId)!;
    assert.equal(event.start, toInstant('2026-11-22', '18:00', TZ).toISOString());
    assert.equal(cal.events.size, 1);
  });

  it('refuses to confirm overlapping plans or without a calendar, and validates input', async () => {
    const { cal, planner } = setup();
    planner.addBlock({ date: '2026-11-22', start: '10:00', end: '11:00', title: '독서' }, 'hermes');
    cal.add('병원', '2026-11-22', '10:30', '11:30');
    await assert.rejects(planner.confirm(['2026-11-22'], 'hermes'), (e: PlannerError) => e.code === 'plan_conflict' && /병원|calendar event/.test(e.message));
    assert.throws(() => planner.addTodo({ title: 'x', estimateMinutes: 0 }, 'hermes'), /estimateMinutes/);
    assert.throws(() => planner.addTodo({ title: 'x', estimateMinutes: 30, deadline: '2026-02-30' }, 'hermes'), /deadline/);
    assert.throws(() => planner.addBlock({ date: '2026-11-20', start: '10:00', end: '11:00', title: 'past' }, 'hermes'), /past/);
    assert.throws(() => planner.updateSettings({ dayStart: '23:00', dayEnd: '07:00' }, 'hermes'), /before/);
    assert.throws(() => planner.updateSettings({ secret: 1 }, 'hermes'), /Unexpected/);

    const offline = setup(SAT_10, false).planner;
    offline.addBlock({ date: '2026-11-22', start: '10:00', end: '11:00', title: '독서' }, 'hermes');
    await assert.rejects(offline.confirm(['2026-11-22'], 'hermes'), (e: PlannerError) => e.code === 'calendar_not_connected');
  });

  it('logs every change with its actor and details', () => {
    const { planner } = setup();
    const t = planner.addTodo({ title: '보고서', estimateMinutes: 90, deadline: '2026-11-30' }, 'hermes');
    planner.updateTodo(t.id, { deadline: '2026-12-02' }, 'hermes');
    planner.progressTodo(t.id, 90, false, 'hermes');
    const [done, update, create] = planner.changes(3);
    assert.equal(create.action, 'create');
    assert.deepEqual((update.detail as any).changes.deadline, { from: '2026-11-30', to: '2026-12-02' });
    assert.equal(done.action, 'complete');
    assert.equal(planner.listTodos('open').length, 0);
  });
});

describe('Managed calendar', () => {
  it('creates the "Kelly" calendar once, writes plan blocks there with their category, and recreates it if deleted', async () => {
    const { account, planner } = setup();
    account.source('Personal').add('남의 캘린더 일정', '2026-11-22', '09:00', '10:00');
    const todo = planner.addTodo({ title: 'CSC263 복습', estimateMinutes: 60, kind: 'study' }, 'hermes');
    const [day] = await planner.generate('2026-11-22', 1, 'hermes');
    assert.equal(account.created, 1);
    assert.deepEqual(day.events, [], 'other calendars are not read for planning');
    assert.equal(day.blocks[0].category, 'study');
    await planner.confirm(['2026-11-22'], 'hermes');
    const written = [...account.managed.events.values()];
    assert.equal(written.length, 1);
    assert.equal(written[0].category, 'study');
    assert.equal(written[0].plannerBlockId, day.blocks[0].id);
    assert.equal(planner.managedCalendar().name, 'Kelly');

    // The owner deletes the calendar in Google: a new one is made and the block is written again on confirm.
    account.calendars.delete('managed-1');
    (planner as any).verified = null;
    const again = await planner.day('2026-11-22');
    assert.equal(account.created, 2);
    assert.equal(again.blocks[0].inCalendar, false);
    assert.ok(planner.changes().some((c) => c.entity === 'calendar' && (c.detail as any).reason.includes('missing')));
    assert.equal(todo.kind, 'study');
  });

  it('adds fixed events (one-off and repeating) that plans work around; plan blocks and deadlines are not editable as events', async () => {
    const { cal, planner } = setup();
    const lecture = await planner.addEvent({ title: 'CSC263 강의', date: '2026-11-23', start: '10:00', end: '11:00', category: 'class', repeat: 'weekly', repeatDays: ['MO', 'WE'], until: '2026-12-09', location: 'BA 1160' }, 'hermes');
    const stored = cal.events.get(lecture.id)!;
    assert.deepEqual(stored.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261210T045959Z']);
    assert.equal(stored.category, 'class');
    await planner.addEvent({ title: '엄마 생일', date: '2026-12-01', allDay: true, category: 'birthday', repeat: 'yearly' }, 'hermes');
    planner.addTodo({ title: '과제', estimateMinutes: 240, deadline: '2026-11-23' }, 'hermes');
    const [day] = await planner.generate('2026-11-23', 1, 'hermes');
    assert.ok(day.blocks.every((b) => b.end <= '09:50' || b.start >= '11:10'), 'blocks keep clear of the lecture');
    assert.equal(day.events.find((e) => e.title === 'CSC263 강의')?.category, 'class');

    await planner.updateEvent(lecture.id, { start: '13:00', scope: 'series' }, 'hermes');
    assert.equal(localParts(new Date(cal.events.get(lecture.id)!.start!), TZ).time, '13:00');
    assert.deepEqual(cal.events.get(lecture.id)!.recurrence, stored.recurrence, 'the series keeps its rule');
    await assert.rejects(planner.updateEvent(lecture.id, { date: '2026-11-24', scope: 'series' }, 'hermes'), /series cannot move/);
    await assert.rejects(planner.addEvent({ title: 'x', date: '2026-11-23', start: '10:00', end: '11:00', category: 'deadline' }, 'hermes'), /category/);
    await assert.rejects(planner.addEvent({ title: 'x', date: '2026-11-23', start: '10:00', end: '11:00', category: 'class', repeat: 'weekly', repeatDays: ['XX'] }, 'hermes'), /repeatDays/);

    await planner.confirm(['2026-11-23'], 'hermes');
    const blockEvent = [...cal.events.values()].find((e) => e.plannerBlockId)!;
    await assert.rejects(planner.removeEvent(blockEvent.id, {}, 'hermes'), /plan block/);
    await planner.removeEvent(lecture.id, { scope: 'series' }, 'hermes');
    assert.ok(!cal.events.has(lecture.id));
  });

  it('keeps an all-day deadline marker per open todo in sync', async () => {
    const { cal, planner } = setup();
    const t = planner.addTodo({ title: '보고서', estimateMinutes: 60, deadline: '2026-11-27' }, 'hermes');
    assert.equal(await planner.syncDeadlines(), 1);
    assert.equal(await planner.syncDeadlines(), 0, 'nothing to do when unchanged');
    const marker = () => [...cal.events.values()].find((e) => e.deadlineTodoId === t.id);
    assert.deepEqual([marker()!.summary, marker()!.date, marker()!.category, marker()!.allDay], ['마감(이날까지): 보고서', '2026-11-27', 'deadline', true]);
    planner.updateTodo(t.id, { deadline: '2026-11-30' }, 'hermes');
    await planner.syncDeadlines();
    assert.equal(marker()!.date, '2026-11-30');
    const day = await planner.day('2026-11-30');
    assert.equal(day.events[0].deadline, true);
    await assert.rejects(planner.updateEvent(marker()!.id, { title: 'x' }, 'hermes'), /deadline marker/);
    planner.progressTodo(t.id, undefined, true, 'hermes');
    await planner.syncDeadlines();
    assert.equal(marker(), undefined, 'done: the marker goes away');
  });

  it('keeps the old calendars as reference only: synced, searchable, never written to the Kelly calendar', async () => {
    const { account, cal, planner } = setup();
    const classes = account.source('Classes');
    classes.add('CSC263 LEC0101', '2026-09-08', '10:00', '11:00', { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261210T045959Z'] });
    classes.add('\tOffice hours ', '2026-11-25', '15:00', '16:00');
    const routine = account.source('Rountine');
    routine.add('Gym', '2026-09-22', '19:00', '21:00', { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH,TU,WE'] });

    await assert.rejects(planner.referenceSync({ calendars: ['Nope'] }, 'hermes'), /No calendar named "Nope"/);
    const sync = await planner.referenceSync({ calendars: ['classes', 'Rountine'] }, 'hermes');
    assert.deepEqual(sync.calendars, [{ name: 'Classes', events: 2, repeating: 1 }, { name: 'Rountine', events: 1, repeating: 1 }]);
    assert.equal(cal.events.size, 0, 'nothing is written to the Kelly calendar');
    await planner.referenceSync({ calendars: ['Classes'] }, 'hermes'); // re-sync updates, no duplicates

    const all = planner.referenceSearch({});
    assert.equal(all.total, 3);
    assert.deepEqual(
      all.items.map((i) => [i.calendar, i.title, i.when, i.hint]),
      [
        ['Classes', 'CSC263 LEC0101', '매주 화·목 10:00–11:00 (9/8(화)부터, 12/9까지)', 'class'],
        ['Classes', 'Office hours', '11/25(수) 15:00–16:00', 'class'],
        ['Rountine', 'Gym', '매주 화·수·목 19:00–21:00 (9/22(화)부터)', 'routine'],
      ],
    );
    assert.deepEqual(planner.referenceSearch({ text: 'gym' }).items.map((i) => i.title), ['Gym']);
    assert.deepEqual(planner.referenceSearch({ repeating: false }).items.map((i) => i.title), ['Office hours']);
    assert.deepEqual(planner.referenceSearch({ from: '2026-12-15' }).items.map((i) => i.title), ['Gym'], 'ended series and past events drop out');
    assert.ok(!(await planner.calendars()).some((c) => c.name === 'Kelly'), 'the managed calendar is not a reference source');
  });

  it('builds proposals the owner picks from, edits them, and writes only what is applied', async () => {
    const { cal, planner } = setup();
    const a = planner.createProposal(
      {
        title: '루틴 시안 A: 아침형',
        items: [
          { title: '헬스', date: '2026-11-23', start: '07:00', end: '08:00', category: 'routine', repeat: 'weekly', repeatDays: ['MO', 'WE', 'FR'] },
          { title: '아침 식사', date: '2026-11-23', start: '07:30', end: '08:00', category: 'routine', repeat: 'daily' },
          { title: '월세', date: '2026-11-21', allDay: true, category: 'personal', repeat: 'monthly' },
        ],
      },
      'hermes',
    );
    assert.equal(a.code, 'A');
    assert.deepEqual(a.items.map((i) => [i.n, i.when]), [
      [1, '매주 월·수·금 07:00–08:00 (11/23(월)부터)'],
      [2, '매일 07:30–08:00 (11/23(월)부터)'],
      [3, '매달 21일 종일 (11/21(토)부터)'],
    ]);
    assert.equal(a.warnings.length, 1, '헬스 and 아침 식사 overlap');
    assert.throws(() => planner.createProposal({ title: 'x', items: [{ title: 'y', date: '2026-11-23', start: '07:00', end: '08:00', category: 'deadline' }] }, 'hermes'), /items\[1\]: category/);
    const b = planner.createProposal({ title: '루틴 시안 B: 저녁형', items: [{ title: '헬스', date: '2026-11-24', start: '19:00', end: '20:30', category: 'routine', repeat: 'weekly', repeatDays: ['TU', 'TH'] }] }, 'hermes');
    assert.equal(b.code, 'B');

    // The owner: "A로 하되 헬스는 6시, 식사는 빼고, 주말 장보기 추가"
    const edited = planner.editProposal(
      'A',
      { update: [{ n: 1, start: '06:00', end: '07:00' }], remove: [2], add: [{ title: '장보기', date: '2026-11-28', start: '10:00', end: '11:00', category: 'personal', repeat: 'weekly', interval: 2 }] },
      'hermes',
    );
    assert.deepEqual(edited.items.map((i) => [i.n, i.title, i.when]), [
      [1, '헬스', '매주 월·수·금 06:00–07:00 (11/23(월)부터)'],
      [3, '월세', '매달 21일 종일 (11/21(토)부터)'],
      [4, '장보기', '2주마다 토 10:00–11:00 (11/28(토)부터)'],
    ]);
    assert.deepEqual(edited.warnings, []);
    assert.equal(cal.events.size, 0, 'drafts are not in the calendar');

    const applied = await planner.applyProposal('A', { items: [1, 4] }, 'hermes');
    assert.deepEqual(applied.written.map((w) => w.n), [1, 4]);
    assert.equal(applied.status, 'draft', 'item 3 is still open');
    assert.equal(cal.events.size, 2);
    assert.deepEqual([...cal.events.values()].map((e) => e.recurrence), [['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'], ['RRULE:FREQ=WEEKLY;BYDAY=SA;INTERVAL=2']]);
    assert.throws(() => planner.editProposal('A', { update: [{ n: 1, start: '05:00', end: '06:00' }] }, 'hermes'), /already in the calendar/);
    assert.equal((await planner.applyProposal('A', {}, 'hermes')).status, 'applied');
    assert.deepEqual(planner.discardProposal('B', 'hermes'), { code: 'B', status: 'discarded' });
    assert.deepEqual(planner.proposals().map((p) => p.code), []);
    assert.deepEqual(planner.proposals('all').map((p) => [p.code, p.status]), [['A', 'applied'], ['B', 'discarded']]);
  });

  it('repeats beyond weekly: every N days/weeks/months/years, nth weekday of the month, until or a count', async () => {
    const { cal, planner } = setup();
    const add = async (body: Record<string, unknown>) => {
      const e = await planner.addEvent({ title: 't', date: '2026-11-24', start: '10:00', end: '11:00', category: 'personal', ...body }, 'hermes');
      return [cal.events.get(e.id)!.recurrence?.[0], e.when];
    };
    assert.deepEqual(await add({ repeat: 'daily', interval: 3, count: 10 }), ['RRULE:FREQ=DAILY;INTERVAL=3;COUNT=10', '3일마다 10:00–11:00 (11/24(화)부터, 10회)']);
    assert.deepEqual(await add({ repeat: 'weekly', interval: 3, repeatDays: ['TU'] }), ['RRULE:FREQ=WEEKLY;BYDAY=TU;INTERVAL=3', '3주마다 화 10:00–11:00 (11/24(화)부터)']);
    assert.deepEqual(await add({ repeat: 'monthly', monthlyBy: 'weekday' }), ['RRULE:FREQ=MONTHLY;BYDAY=-1TU', '매달 마지막 화요일 10:00–11:00 (11/24(화)부터)']);
    assert.deepEqual(await add({ date: '2026-11-10', repeat: 'monthly', monthlyBy: 'weekday', interval: 2, until: '2027-06-30' }), [
      'RRULE:FREQ=MONTHLY;BYDAY=2TU;INTERVAL=2;UNTIL=20270701T035959Z',
      '2달마다 둘째 화요일 10:00–11:00 (11/10(화)부터, 2027/6/30까지)',
    ]);
    assert.deepEqual(await add({ repeat: 'yearly', interval: 4 }), ['RRULE:FREQ=YEARLY;INTERVAL=4', '4년마다 11/24 10:00–11:00 (11/24(화)부터)']);
    await assert.rejects(planner.addEvent({ title: 't', date: '2026-11-24', start: '10:00', end: '11:00', category: 'personal', repeat: 'daily', until: '2026-12-01', count: 3 }, 'hermes'), /until or count/);
    await assert.rejects(planner.addEvent({ title: 't', date: '2026-11-24', start: '10:00', end: '11:00', category: 'personal', interval: 2 }, 'hermes'), /only go with a repeat/);

    // Change how a series repeats: the whole rule is given again.
    const gym = await planner.addEvent({ title: '헬스', date: '2026-11-24', start: '19:00', end: '20:00', category: 'routine', repeat: 'weekly' }, 'hermes');
    await planner.updateEvent(gym.id, { scope: 'series', repeat: 'weekly', repeatDays: ['TU', 'TH'], until: '2027-04-30' }, 'hermes');
    assert.deepEqual(cal.events.get(gym.id)!.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20270501T035959Z']);
    await assert.rejects(planner.updateEvent(gym.id, { scope: 'series', until: '2027-05-30' }, 'hermes'), /whole rule/);
  });
});

describe('Jobs', () => {
  it('posts tomorrow at 23:00, the week on Sunday 23:00 and today at 05:00, each once', async () => {
    const { planner, sent, jobs, setClock } = setup(toInstant('2026-11-21', '22:59', TZ).getTime());
    planner.addTodo({ title: '알고리즘 과제', estimateMinutes: 60, deadline: '2026-11-23' }, 'hermes');
    await jobs.tick();
    assert.equal(sent.filter((e) => e.type === 'plan').length, 0);

    setClock(toInstant('2026-11-21', '23:00', TZ).getTime()); // Saturday
    await jobs.tick();
    await jobs.tick();
    const proposals = sent.filter((e) => e.type === 'plan');
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].type === 'plan' && proposals[0].plan.kind, 'proposal');
    assert.equal(proposals[0].type === 'plan' && proposals[0].plan.days[0].date, '2026-11-22');

    setClock(toInstant('2026-11-22', '05:00', TZ).getTime());
    await jobs.tick();
    const today = sent.at(-1)!;
    assert.ok(today.type === 'plan' && today.plan.kind === 'today' && today.plan.days[0].date === '2026-11-22');

    setClock(toInstant('2026-11-22', '23:05', TZ).getTime()); // Sunday
    await jobs.tick();
    const week = sent.at(-1)!;
    assert.ok(week.type === 'plan' && week.plan.kind === 'week');
    assert.deepEqual(week.type === 'plan' && week.plan.days.map((d) => d.date), Array.from({ length: 7 }, (_, i) => addDays('2026-11-23', i)));
  });

  it('skips the 05:00 message for a completely empty day', async () => {
    const { sent, jobs } = setup(toInstant('2026-11-22', '05:00', TZ).getTime());
    await jobs.tick();
    assert.equal(sent.filter((e) => e.type === 'plan').length, 0);
  });

  it('reminds 5 minutes before a short event and not earlier', async () => {
    const { cal, sent, jobs, setClock } = setup(toInstant('2026-11-22', '18:50', TZ).getTime());
    cal.add('CSC207 과제 파악', '2026-11-22', '19:00', '20:00');
    await jobs.tick();
    assert.equal(sent.filter((e) => e.type === 'reminder').length, 0, '10 minutes before: not yet');
    setClock(toInstant('2026-11-22', '18:55', TZ).getTime());
    await jobs.tick();
    const reminders = sent.filter((e) => e.type === 'reminder');
    assert.equal(reminders.length, 1);
    assert.ok(reminders[0].type === 'reminder' && reminders[0].reminder.minutesBefore === 5);
  });

  it('reminds 15 minutes before each longer event, once', async () => {
    const { cal, sent, jobs, setClock } = setup(toInstant('2026-11-22', '08:40', TZ).getTime());
    cal.add('수업', '2026-11-22', '09:00', '10:30', { location: 'BA 1160' });
    cal.add('하루 종일', '2026-11-22', '00:00', '23:59', { allDay: true, start: null, end: null });
    await jobs.tick();
    assert.equal(sent.filter((e) => e.type === 'reminder').length, 0, '20 minutes before: not yet');
    setClock(toInstant('2026-11-22', '08:45', TZ).getTime());
    await jobs.tick();
    await jobs.tick();
    const reminders = sent.filter((e) => e.type === 'reminder');
    assert.equal(reminders.length, 1);
    assert.ok(reminders[0].type === 'reminder' && reminders[0].reminder.title === '수업' && reminders[0].reminder.minutesBefore === 15);
  });
});

describe('API', () => {
  it('requires the client key and maps planner errors to status codes', async () => {
    const { planner } = setup();
    const server = createApi(planner, async () => 'delivered', [{ name: 'hermes-broker', key: 'k'.repeat(40) }], silent);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { 'X-Planner-Key': 'k'.repeat(40), 'Content-Type': 'application/json' };
    try {
      assert.equal((await fetch(`${base}/todos`)).status, 401);
      const created = await fetch(`${base}/todos`, { method: 'POST', headers, body: JSON.stringify({ title: '장보기', estimateMinutes: 30 }) });
      assert.equal(created.status, 200);
      assert.equal(((await created.json()) as any).todo.title, '장보기');
      const bad = await fetch(`${base}/todos`, { method: 'POST', headers, body: JSON.stringify({ title: '장보기', estimateMinutes: 30, owner: 'x' }) });
      assert.equal(bad.status, 400);
      assert.equal((await fetch(`${base}/blocks/00000000-0000-4000-8000-000000000000/remove`, { method: 'POST', headers })).status, 404);
      assert.equal((await fetch(`${base}/day?date=2026-13-01`, { headers })).status, 400);
      assert.equal((await fetch(`${base}/nope`, { headers })).status, 404);
      const log = (await (await fetch(`${base}/changes?limit=5`, { headers })).json()) as any;
      assert.equal(log.changes[0].actor, 'hermes');
    } finally {
      server.close();
    }
  });
});

describe('Google OAuth', () => {
  it('accepts only Desktop app client files with Google endpoints', () => {
    const file = (installed: object) => JSON.stringify({ installed });
    const ok = parseClientFile(file({ client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-xyz', token_uri: 'https://oauth2.googleapis.com/token' }));
    assert.equal(ok.tokenUri, 'https://oauth2.googleapis.com/token');
    assert.throws(() => parseClientFile(JSON.stringify({ web: {} })), /Desktop app/);
    assert.throws(() => parseClientFile(file({ client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-xyz', token_uri: 'https://evil.example/token' })), /token_uri/);
  });

  it('treats a token with older permissions as "connect again"', () => {
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO google_auth (id, refresh_token, scope, connected_at) VALUES (1, 'rt', 'https://www.googleapis.com/auth/calendar.events', 'x')").run();
    const conn = new GoogleConnection(db, { clientId: 'a.apps.googleusercontent.com', clientSecret: 'secret-123456', tokenUri: 'https://oauth2.googleapis.com/token' }, 'http://127.0.0.1:8720/oauth/callback', TZ);
    assert.deepEqual([conn.status().connected, conn.status().missingPermissions], [false, true]);
    assert.equal(conn.account(), null);
  });

  it('starts a PKCE sign-in and completes it once, storing the refresh token only in the DB', async () => {
    const db = openDatabase(':memory:');
    const client = { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret-xyz', tokenUri: 'https://oauth2.googleapis.com/token' };
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600, refresh_token: 'rt', scope: SCOPES.join(' ') }), { status: 200 });
    }) as unknown as typeof fetch;
    const conn = new GoogleConnection(db, client, 'http://127.0.0.1:8720/oauth/callback', TZ, fakeFetch);
    const { authUrl } = conn.start();
    const params = new URL(authUrl).searchParams;
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.equal(params.get('scope'), SCOPES.join(' '));
    assert.ok(!params.get('scope')!.includes('auth/calendar '), 'never full calendar access');
    assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:8720/oauth/callback');
    await conn.finish(params.get('state')!, '4/0Abc-code');
    assert.match(calls[0].body, /code_verifier=/);
    assert.equal(conn.status().connected, true);
    await assert.rejects(conn.finish(params.get('state')!, '4/0Abc-code'), /expired or was already used/);
    assert.ok(!JSON.stringify(conn.status()).includes('rt'));
  });
});
