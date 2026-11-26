import type { Dict } from './ko';

/**
 * One locale per selected language (ko-KR / en-US) for every number and date on screen. Time zones
 * stay what each screen already used; pass `timeZone` in the options.
 */
export function fmtNumber(t: Dict, n: number, options?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(t.locale, options);
}

export function fmtDateTime(t: Dict, value: Date | string | number, options: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat(t.locale, options).format(date);
}
