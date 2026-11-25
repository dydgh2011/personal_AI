export const TIME_ZONE = 'America/Toronto';
const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const DAY_MS = 86_400_000;
const DAILY_MINUTES = 120;
const BREAK_MINUTES = 10;

export type Period = 'day' | 'week';
export interface Interval { start: number; end: number }
export interface Window { weekday: number; start: string; end: string }
export interface WorkItem {
  id: string;
  kind: 'assignment' | 'review';
  title: string;
  domain: string | null;
  goalId: string | null;
  weeklyMinutes: number | null;
  priority: number;
  minutes: number;
  deadline: string | null;
  dueDate: string | null;
  method?: 'practice' | 'revalidate';
}
export interface StudyBlock extends Pick<WorkItem, 'id' | 'kind' | 'title' | 'domain' | 'deadline' | 'dueDate'> {
  start: string;
  end: string;
  minutes: number;
}
interface PlanDay {
  date: string;
  availableMinutes: number;
  plannedMinutes: number;
  blocks: StudyBlock[];
}

export function localTime(instant: Date): { date: string; minutes: number } {
  const parts = Object.fromEntries(DATE_FORMAT.formatToParts(instant).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const midnight = (date: string) => new Date(`${date}T00:00:00Z`);
export const addDays = (date: string, days: number) => new Date(midnight(date).getTime() + days * DAY_MS).toISOString().slice(0, 10);
const weekday = (date: string) => midnight(date).getUTCDay();

export function toMinutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function toTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Avoid wall times that are ambiguous or do not exist when Toronto changes its clocks. */
function clockChange(date: string): Interval[] {
  const before = localTime(new Date(`${date}T05:00:00Z`)).minutes;
  const after = localTime(new Date(`${date}T12:00:00Z`)).minutes;
  return after - before === 7 * 60 ? [] : [{ start: 59, end: 180 }];
}

function freeIntervals(window: Interval, blocked: Interval[]): Interval[] {
  const free: Interval[] = [];
  let start = window.start;
  for (const b of [...blocked].sort((a, b) => a.start - b.start)) {
    if (b.end <= start || b.start >= window.end) continue;
    if (b.start > start) free.push({ start, end: b.start });
    start = Math.max(start, b.end);
  }
  if (start < window.end) free.push({ start, end: window.end });
  return free;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function compareItems(a: WorkItem, b: WorkItem): number {
  const aDue = a.deadline ?? a.dueDate ?? '9999-12-31';
  const bDue = b.deadline ?? b.dueDate ?? '9999-12-31';
  return cmp(aDue, bDue) || b.priority - a.priority || cmp(a.kind, b.kind) || cmp(a.id, b.id);
}

export function buildPlan(
  date: string,
  period: Period,
  now: { date: string; minutes: number },
  windows: readonly Window[],
  busyByDate: ReadonlyMap<string, Interval[]>,
  items: readonly WorkItem[],
): { days: PlanDay[]; remaining: Array<WorkItem & { remainingMinutes: number }> } {
  const queue = [...items].sort(compareItems).map((item) => ({ item, remainingMinutes: item.minutes }));
  const weeklyUse = new Map<string, number>();
  const days: PlanDay[] = [];
  for (let offset = 0; offset < (period === 'day' ? 1 : 7); offset++) {
    const day = addDays(date, offset);
    if (weekday(day) === 1) weeklyUse.clear();
    const window = windows.find((w) => w.weekday === weekday(day));
    const from = day === now.date ? Math.ceil((now.minutes + 1) / 5) * 5 : 0;
    const busy = (busyByDate.get(day) ?? []).map(({ start, end }) => ({ start: start - BREAK_MINUTES, end: end + BREAK_MINUTES }));
    const intervals = window ? freeIntervals(
      { start: Math.max(from, toMinutes(window.start)), end: toMinutes(window.end) },
      busy.concat(clockChange(day)),
    ) : [];
    const view: PlanDay = { date: day, availableMinutes: intervals.reduce((sum, i) => sum + i.end - i.start, 0), plannedMinutes: 0, blocks: [] };
    for (const interval of intervals) {
      let start = interval.start;
      while (interval.end - start >= 30 && DAILY_MINUTES - view.plannedMinutes >= 30) {
        const item = queue.find(({ item, remainingMinutes }) => remainingMinutes >= 30
          && (!item.dueDate || item.dueDate <= day)
          && (item.deadline !== null || item.weeklyMinutes === null || (weeklyUse.get(item.goalId!) ?? 0) + 30 <= item.weeklyMinutes));
        if (!item) break;
        const { id, kind, title, domain, deadline, dueDate, goalId, weeklyMinutes } = item.item;
        const budget = goalId && deadline === null && weeklyMinutes !== null ? weeklyMinutes - (weeklyUse.get(goalId) ?? 0) : Infinity;
        const cap = Math.min(item.remainingMinutes, interval.end - start, DAILY_MINUTES - view.plannedMinutes, budget);
        const minutes = cap >= 60 ? 60 : 30;
        view.blocks.push({ id, kind, title, domain, deadline, dueDate, start: toTime(start), end: toTime(start + minutes), minutes });
        item.remainingMinutes -= minutes;
        view.plannedMinutes += minutes;
        if (goalId) weeklyUse.set(goalId, (weeklyUse.get(goalId) ?? 0) + minutes);
        start += minutes + BREAK_MINUTES;
      }
    }
    days.push(view);
  }
  return { days, remaining: queue.filter((entry) => entry.remainingMinutes > 0).map(({ item, remainingMinutes }) => ({ ...item, remainingMinutes })) };
}
