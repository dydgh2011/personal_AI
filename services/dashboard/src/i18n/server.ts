import 'server-only';
import { cookies } from 'next/headers';
import { DICTS, LANG_COOKIE, parseLang, type Dict, type Lang } from './index';

/** The request's language from the `pai_lang` cookie (server components and route handlers). */
export async function getLang(): Promise<Lang> {
  return parseLang((await cookies()).get(LANG_COOKIE)?.value);
}

/** The request's dictionary. */
export async function getT(): Promise<Dict> {
  return DICTS[await getLang()];
}
