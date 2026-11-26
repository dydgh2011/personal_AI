/**
 * Formatting and small decisions for the Learning screens. No I/O, so it is unit tested directly.
 * Status words are always shown as text next to any color (color is never the only signal).
 */

import type { Dict } from '@/i18n';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted' | 'accent';
export type LearningSearchParams = Promise<Record<string, string | string[] | undefined>>;

export const LEARNING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Skill levels 0-4 (same scale as goals' target level). Words: t.learn.levels[level]. */
export const LEVELS = [0, 1, 2, 3, 4] as const;

export const levelLabel = (level: number | null | undefined, t: Dict) =>
  level === null || level === undefined ? t.learn.unverified : t.learn.levelWord(level, t.learn.levels[level]?.label ?? '?');

const TONE: Record<string, Tone> = {
  // milestones
  planned: 'muted', active: 'info', completed: 'ok', archived: 'muted',
  // assignments
  available: 'info', submitted: 'warn', evaluated: 'warn', passed: 'ok', revision_required: 'bad',
  // evaluations
  pending: 'info', failed: 'bad', meets_rubric: 'ok', below_rubric: 'bad', inconclusive: 'warn',
  // gaps
  suggested: 'warn', open: 'bad', addressed: 'ok', dismissed: 'muted',
  // proposals
  awaiting_user_approval: 'warn', applied: 'ok', rejected: 'muted', invalid: 'bad',
  // domains / goals
  exploring: 'info', paused: 'muted', maintaining: 'ok', achieved: 'ok', abandoned: 'muted',
};

export function statusView(status: string | null | undefined, t: Dict): { tone: Tone; label: string } {
  if (!status) return { tone: 'muted', label: t.learn.statusUnknown };
  const label = t.learn.status[status];
  return label ? { tone: TONE[status] ?? 'muted', label } : { tone: 'muted', label: status.replace(/_/g, ' ') };
}

/** Today's calendar date (YYYY-MM-DD) in the given or the server's timezone. */
export function todayIso(now = new Date(), timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

const dayNumber = (iso: string) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000);

/** How a calendar-date deadline relates to today. */
export function deadlineState(date: string | null | undefined, today: string, t: Dict): { days: number; tone: Tone; label: string } | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const days = dayNumber(date) - dayNumber(today);
  if (days < 0) return { days, tone: 'bad', label: t.learn.deadline.overdue(-days) };
  if (days === 0) return { days, tone: 'warn', label: t.learn.deadline.today };
  return { days, tone: days <= 7 ? 'warn' : 'muted', label: t.learn.deadline.inDays(days) };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** Same-site learning paths only: where a form goes back to. Anything else falls back. */
export function safeLearningReturn(value: unknown, fallback = '/learning'): string {
  if (typeof value !== 'string') return fallback;
  // No fragment: back() appends ?ok= / &ok= to the path.
  if (!/^\/learning(\/[A-Za-z0-9_-]+)*\/?(\?[A-Za-z0-9_=&%.+-]*)?$/.test(value)) return fallback;
  return value;
}

export const fileHref = (submissionId: string, fileId: string) => `/api/learning-files/${encodeURIComponent(submissionId)}/${encodeURIComponent(fileId)}`;

export const submissionHref = (assignmentId: string, submissionId: string) =>
  `/learning/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(submissionId)}`;

/** Upload limits as the learning service reports them (used before any bytes are sent). */
export const DEFAULT_UPLOAD_LIMITS = { maxFileBytes: 2 * 1024 * 1024, maxFiles: 4, maxTotalBytes: 6 * 1024 * 1024 };

export function uploadProblem(files: Array<{ name: string; size: number }>, limits: typeof DEFAULT_UPLOAD_LIMITS, t: Dict): string | null {
  const u = t.learn.upload;
  if (files.length > limits.maxFiles) return u.tooMany(limits.maxFiles);
  const empty = files.find((f) => f.size === 0);
  if (empty) return u.empty(empty.name);
  const big = files.find((f) => f.size > limits.maxFileBytes);
  if (big) return u.tooBig(big.name, formatBytes(limits.maxFileBytes));
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > limits.maxTotalBytes) return u.totalTooBig(formatBytes(limits.maxTotalBytes));
  return null;
}

/** "submission:<id>#file:<fileId>" -> a readable source label. */
export function evidenceSource(ref: string, files: Array<{ id: string; name: string }>, t: Dict): string {
  const x = t.learn.evidenceSource;
  if (ref.endsWith('#body')) return x.answer;
  const file = /#file:([0-9a-f-]{36})$/.exec(ref);
  if (file) return files.find((f) => f.id === file[1])?.name ?? x.attached;
  if (ref.startsWith('submission:')) return x.submission;
  if (ref.startsWith('rubric:')) return x.rubric(ref.split('#')[1] ?? '');
  if (ref.startsWith('submission#unknown:')) return x.notFound(ref.slice('submission#unknown:'.length) || x.unknown);
  return ref.length > 60 ? `${ref.slice(0, 57)}…` : ref;
}

/** Days since an ISO instant, as words. */
export function ageText(days: number, t: Dict): string {
  if (days <= 0) return t.learn.age.today;
  if (days === 1) return t.learn.age.yesterday;
  if (days < 60) return t.learn.age.days(days);
  return t.learn.age.months(Math.round(days / 30));
}
