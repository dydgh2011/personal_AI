import type { SchedulePeriod } from './learning-types';

export const SCHEDULE_TZ = 'America/Toronto';
export const schedulePeriod = (value: unknown): SchedulePeriod => value === 'week' ? 'week' : 'day';

export function scheduleDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

export function scheduleHref(date: string | undefined, period: SchedulePeriod): string {
  const query = new URLSearchParams({ period });
  if (date) query.set('date', date);
  return `/learning/planner?${query}`;
}
