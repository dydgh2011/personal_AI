/**
 * Formatting and small decisions for the Learning screens. No I/O, so it is unit tested directly.
 * Status words are always shown as text next to any color (color is never the only signal).
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted' | 'accent';
export type LearningSearchParams = Promise<Record<string, string | string[] | undefined>>;

export const LEARNING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Skill levels 0-4 (same scale as goals' target level). */
export const LEVELS = [
  { level: 0, label: 'None', hint: 'not started' },
  { level: 1, label: 'Aware', hint: 'knows the words' },
  { level: 2, label: 'Guided', hint: 'can do it with help' },
  { level: 3, label: 'Independent', hint: 'does it alone' },
  { level: 4, label: 'Can teach', hint: 'explains and adapts it' },
] as const;

export const levelLabel = (level: number | null | undefined) => (level === null || level === undefined ? 'unverified' : `${level} · ${LEVELS[level]?.label ?? '?'}`);

const STATUS: Record<string, { tone: Tone; label: string }> = {
  // milestones
  planned: { tone: 'muted', label: 'planned' },
  active: { tone: 'info', label: 'active' },
  completed: { tone: 'ok', label: 'completed' },
  archived: { tone: 'muted', label: 'archived' },
  // assignments
  available: { tone: 'info', label: 'open' },
  submitted: { tone: 'warn', label: 'awaiting evaluation' },
  evaluated: { tone: 'warn', label: 'awaiting your decision' },
  passed: { tone: 'ok', label: 'passed' },
  revision_required: { tone: 'bad', label: 'revision required' },
  // evaluations
  pending: { tone: 'info', label: 'running' },
  failed: { tone: 'bad', label: 'failed' },
  meets_rubric: { tone: 'ok', label: 'meets rubric' },
  below_rubric: { tone: 'bad', label: 'below rubric' },
  inconclusive: { tone: 'warn', label: 'inconclusive' },
  // gaps
  suggested: { tone: 'warn', label: 'AI suggestion' },
  open: { tone: 'bad', label: 'open' },
  addressed: { tone: 'ok', label: 'addressed' },
  dismissed: { tone: 'muted', label: 'dismissed' },
  // proposals
  awaiting_user_approval: { tone: 'warn', label: 'awaiting approval' },
  applied: { tone: 'ok', label: 'applied' },
  rejected: { tone: 'muted', label: 'rejected' },
  invalid: { tone: 'bad', label: 'invalid' },
  // domains / goals
  exploring: { tone: 'info', label: 'exploring' },
  paused: { tone: 'muted', label: 'paused' },
  maintaining: { tone: 'ok', label: 'maintaining' },
  achieved: { tone: 'ok', label: 'achieved' },
  abandoned: { tone: 'muted', label: 'abandoned' },
};

export function statusView(status: string | null | undefined): { tone: Tone; label: string } {
  if (!status) return { tone: 'muted', label: 'unknown' };
  return STATUS[status] ?? { tone: 'muted', label: status.replace(/_/g, ' ') };
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
export function deadlineState(date: string | null | undefined, today: string): { days: number; tone: Tone; label: string } | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const days = dayNumber(date) - dayNumber(today);
  if (days < 0) return { days, tone: 'bad', label: `${-days} day${days === -1 ? '' : 's'} overdue` };
  if (days === 0) return { days, tone: 'warn', label: 'due today' };
  if (days <= 7) return { days, tone: 'warn', label: `in ${days} day${days === 1 ? '' : 's'}` };
  return { days, tone: 'muted', label: `in ${days} days` };
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

export function uploadProblem(files: Array<{ name: string; size: number }>, limits = DEFAULT_UPLOAD_LIMITS): string | null {
  if (files.length > limits.maxFiles) return `파일은 최대 ${limits.maxFiles}개까지 올릴 수 있습니다.`;
  const empty = files.find((f) => f.size === 0);
  if (empty) return `"${empty.name}" 파일이 비어 있습니다.`;
  const big = files.find((f) => f.size > limits.maxFileBytes);
  if (big) return `"${big.name}" 파일이 ${formatBytes(limits.maxFileBytes)}보다 큽니다.`;
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > limits.maxTotalBytes) return `파일 합계가 ${formatBytes(limits.maxTotalBytes)}보다 큽니다.`;
  return null;
}

/** "submission:<id>#file:<fileId>" -> a readable source label. */
export function evidenceSource(ref: string, files: Array<{ id: string; name: string }> = []): string {
  if (ref.endsWith('#body')) return 'answer text';
  const file = /#file:([0-9a-f-]{36})$/.exec(ref);
  if (file) return files.find((f) => f.id === file[1])?.name ?? 'attached file';
  if (ref.startsWith('submission:')) return 'submission';
  if (ref.startsWith('rubric:')) return `rubric · ${ref.split('#')[1] ?? ''}`;
  if (ref.startsWith('submission#unknown:')) return `${ref.slice('submission#unknown:'.length) || 'unknown'} (not found)`;
  return ref.length > 60 ? `${ref.slice(0, 57)}…` : ref;
}

/** Days since an ISO instant, as words. */
export function ageText(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}
