/**
 * Deadlines are calendar dates (YYYY-MM-DD) in the owner's own timezone, not instants: a deadline
 * of 2027-03-01 means "by the end of that day wherever the owner is". The L3 planner turns them
 * into instants with an explicit timezone; L2 only stores and compares dates.
 */
export const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !CALENDAR_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Whole days from `from` (ISO instant) to `to` (default now), rounded down. */
export function daysSince(from: string, to: Date): number {
  return Math.floor((to.getTime() - new Date(from).getTime()) / 86_400_000);
}
