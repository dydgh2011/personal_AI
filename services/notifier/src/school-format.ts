import { ValidationError } from './format.js';

/**
 * School updates from the school connector service. "now" = important items sent right away
 * (mentions the owner); "digest" = the rest, collected and sent at fixed times.
 * Titles and summaries come from school services (written by instructors, classmates, senders)
 * or a summarising model: they are shown as plain text, never as links or mentions.
 */
export interface SchoolItem {
  service: 'quercus' | 'piazza' | 'outlook' | 'gmail' | 'course_site';
  kind: string;
  course: string | null;
  title: string;
  summary: string | null;
  url: string | null;
}

export interface SchoolEvent {
  mode: 'now' | 'digest';
  items: SchoolItem[];
  more: number;
  /** now: mention the owner (urgent). false for ordinary UofT mail sent right away. */
  ping: boolean;
}

const SERVICES = ['quercus', 'piazza', 'outlook', 'gmail', 'course_site'] as const;
const SERVICE_LABEL: Record<SchoolItem['service'], string> = { quercus: 'Quercus', piazza: 'Piazza', outlook: '학교 메일', gmail: 'Gmail', course_site: '과목 사이트' };
const URL_HOSTS = /^https:\/\/(q\.utoronto\.ca|piazza\.com|outlook\.office\.com|mail\.google\.com|mcs\.utm\.utoronto\.ca|app\.crowdmark\.com)\//;
const DISCORD_LIMIT = 2000;

function text(value: unknown, field: string, max: number, nullable: boolean): string | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new ValidationError(`${field} is required`);
  }
  if (typeof value !== 'string' || value.length > max) throw new ValidationError(`${field} must be text up to ${max} characters`);
  return value;
}

export function parseSchool(value: unknown): SchoolEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError('school must be an object');
  const o = value as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !['mode', 'items', 'more', 'ping'].includes(k));
  if (extra.length) throw new ValidationError(`school: unexpected fields ${extra.join(', ')}`);
  if (o.mode !== 'now' && o.mode !== 'digest') throw new ValidationError('school.mode must be now or digest');
  if (!Array.isArray(o.items) || o.items.length === 0 || o.items.length > 15) throw new ValidationError('school.items must have 1-15 items');
  const more = o.more === undefined ? 0 : o.more;
  if (typeof more !== 'number' || !Number.isInteger(more) || more < 0 || more > 10_000) throw new ValidationError('school.more must be a count');
  const items = o.items.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ValidationError(`items[${i}] must be an object`);
    const it = raw as Record<string, unknown>;
    const bad = Object.keys(it).filter((k) => !['service', 'kind', 'course', 'title', 'summary', 'url'].includes(k));
    if (bad.length) throw new ValidationError(`items[${i}]: unexpected fields ${bad.join(', ')}`);
    if (!SERVICES.includes(it.service as SchoolItem['service'])) throw new ValidationError(`items[${i}].service is unknown`);
    const kind = text(it.kind, `items[${i}].kind`, 30, false)!;
    if (!/^[a-z_]+$/.test(kind)) throw new ValidationError(`items[${i}].kind must be a-z or _`);
    const url = text(it.url, `items[${i}].url`, 500, true);
    return {
      service: it.service as SchoolItem['service'],
      kind,
      course: text(it.course, `items[${i}].course`, 40, true),
      title: text(it.title, `items[${i}].title`, 300, false)!,
      summary: text(it.summary, `items[${i}].summary`, 400, true),
      url: url && URL_HOSTS.test(url) ? url : null,
    };
  });
  if (o.ping !== undefined && typeof o.ping !== 'boolean') throw new ValidationError('school.ping must be true or false');
  return { mode: o.mode, items, more, ping: o.mode === 'now' && o.ping !== false };
}

/** Plain text: no code spans, no masked links, no mentions, one line. */
function plain(value: string, max: number): string {
  const flat = value
    .replace(/[`*_~|>]/g, '')
    .replace(/@/g, '@​')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const KIND_ICON: Record<string, string> = {
  grade: '📊', announcement: '📢', assignment: '📝', post: '💬', email: '✉️', page_change: '🌐', auth_warning: '🔑', message: '✉️', discussion: '💬',
};

export function formatSchool(e: SchoolEvent, mentionUserId: string | null): string {
  const head = e.mode === 'digest'
    ? '**🗞️ 소식 모음**'
    : e.ping
      ? `${mentionUserId ? `<@${mentionUserId}> ` : ''}**📌 학교 새 소식**`
      : '**📬 새 메일**';
  const lines = [head];
  for (const it of e.items) {
    const icon = KIND_ICON[it.kind] ?? '•';
    const course = it.course ? `[${plain(it.course, 30)}] ` : '';
    lines.push(`${icon} ${SERVICE_LABEL[it.service]} ${course}${plain(it.title, 150)}`);
    if (it.summary) lines.push(`　↳ ${plain(it.summary, 300)}`);
    if (it.url) lines.push(`　<${it.url}>`);
  }
  if (e.more) lines.push(`… 외 ${e.more}건 (Kelly에게 "학교 소식 더 보여줘")`);
  let out = lines.join('\n');
  while (out.length > DISCORD_LIMIT && lines.length > 2) {
    lines.splice(lines.length - 1, 1);
    out = `${lines.join('\n')}\n…`;
  }
  return out.length > DISCORD_LIMIT ? `${out.slice(0, DISCORD_LIMIT - 1)}…` : out;
}
