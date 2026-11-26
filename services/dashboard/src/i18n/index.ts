/**
 * Dashboard language (Korean / English). See README "언어(i18n)".
 *
 * - The language lives in the `pai_lang` cookie ("ko" | "en"), like the theme cookie. Default: ko.
 * - `ko` is the reference dictionary and defines the type `Dict`; `en` must have exactly the same
 *   keys, so a missing translation on either side is a compile error.
 * - Server code reads the cookie (src/i18n/server.ts); client components get the language from
 *   <LangProvider> (src/i18n/client.tsx). Both dictionaries are plain data + small functions.
 */
import { en } from './en';
import { ko, type Dict } from './ko';

export type Lang = 'ko' | 'en';
export type { Dict };
export const LANGS: readonly Lang[] = ['ko', 'en'];
export const LANG_COOKIE = 'pai_lang';
export const DEFAULT_LANG: Lang = 'ko';

export const DICTS: Record<Lang, Dict> = { ko, en };

/** Cookie value -> language. Anything other than "en" is the default (ko). */
export const parseLang = (value: unknown): Lang => (value === 'en' ? 'en' : 'ko');

export const dictFor = (lang: Lang): Dict => DICTS[lang];

export { ko, en };
