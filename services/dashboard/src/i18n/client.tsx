'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { DICTS, LANG_COOKIE, type Dict, type Lang } from './index';

const LangContext = createContext<Lang>('ko');

/** Set once in the root layout from the `pai_lang` cookie, so client text matches the server's. */
export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useLang(): Lang {
  return useContext(LangContext);
}

export function useT(): Dict {
  return DICTS[useContext(LangContext)];
}

/**
 * Switches ko <-> en: writes the cookie (same attributes as the theme cookie) and reloads, so the
 * server renders every page text in the new language. ?ok= / ?error= notices are dropped because
 * they were written in the previous language.
 */
export function LangToggle() {
  const lang = useLang();
  const t = DICTS[lang];
  const next: Lang = lang === 'ko' ? 'en' : 'ko';
  const switchTo = () => {
    document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=31536000; samesite=strict`;
    const url = new URL(window.location.href);
    url.searchParams.delete('ok');
    url.searchParams.delete('error');
    window.location.replace(url.toString());
  };
  return (
    <button type="button" onClick={switchTo} title={t.langSwitch.switchTitle} lang={next} aria-label={t.langSwitch.switchTitle}>
      {t.langSwitch.switchLabel}
    </button>
  );
}
