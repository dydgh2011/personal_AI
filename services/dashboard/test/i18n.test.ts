import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { DICTS, en, ko, LANG_COOKIE, parseLang } from '@/i18n';
import { fmtDateTime, fmtNumber } from '@/i18n/format';
import { since } from '@/lib/diff';
import { proxy } from '@/proxy';

/** Every leaf path of a dictionary, with "fn" for functions (TypeScript checks the rest). */
function shape(value: unknown, path = ''): string[] {
  if (typeof value === 'function') return [`${path}:fn`];
  if (Array.isArray(value)) return value.flatMap((v, i) => shape(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => shape(v, path ? `${path}.${k}` : k));
  return [`${path}:${typeof value}`];
}

describe('dictionaries (ko / en)', () => {
  it('have exactly the same keys, and no empty texts', () => {
    expect(shape(en)).toEqual(shape(ko));
    for (const dict of [ko, en]) {
      const empty = shape(dict).filter((p) => p.endsWith(':string')).map((p) => p.split(':')[0])
        .filter((p) => p.split(/[.[\]]/).filter(Boolean).reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], dict) === '');
      expect(empty).toEqual([]);
    }
  });

  it('reads the language cookie: only "en" switches, anything else is Korean', () => {
    expect(parseLang('en')).toBe('en');
    expect(parseLang('ko')).toBe('ko');
    expect(parseLang(undefined)).toBe('ko');
    expect(parseLang('fr')).toBe('ko');
    expect(DICTS.en.lang).toBe('en');
    expect(DICTS.ko.locale).toBe('ko-KR');
  });

  it('formats dates and numbers with one locale per language', () => {
    expect(fmtNumber(ko, 12345)).toBe('12,345');
    expect(fmtNumber(en, 12345)).toBe('12,345');
    const date = fmtDateTime(ko, '2026-11-26T12:00:00Z', { timeZone: 'UTC', month: 'long', day: 'numeric' });
    expect(date).toContain('11월');
    expect(fmtDateTime(en, '2026-11-26T12:00:00Z', { timeZone: 'UTC', month: 'long', day: 'numeric' })).toBe('November 26');
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(since(iso, ko)).toBe(ko.common.minutesAgo(5));
    expect(since(iso, en)).toBe(en.common.minutesAgo(5));
  });

  it('translates the session notice of a logged-out form post with the request cookie', () => {
    const post = (lang?: string) => {
      const req = new NextRequest('http://127.0.0.1:8710/api/tasks/x/cancel', { method: 'POST', headers: lang ? { cookie: `${LANG_COOKIE}=${lang}` } : {} });
      return decodeURIComponent(proxy(req).headers.get('location') ?? '');
    };
    expect(post()).toContain(ko.flash.sessionExpired);
    expect(post('en')).toContain(en.flash.sessionExpired);
  });
});
