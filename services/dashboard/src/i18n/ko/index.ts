/**
 * Korean dictionary: the reference. Its shape is the type `Dict`; the English dictionary must
 * match it key for key (src/i18n/en/index.ts), so a missing translation does not compile.
 */
import * as core from './core';
import * as learning from './learning';
import * as usage from './usage';
import * as knowledge from './knowledge';
import * as services from './services';

export const ko = {
  lang: 'ko' as 'ko' | 'en',
  /** Locale for every number and date on screen. */
  locale: 'ko-KR',
  ...core,
  ...learning,
  ...usage,
  ...knowledge,
  ...services,
};

export type Dict = typeof ko;
