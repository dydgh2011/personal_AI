/** English dictionary. Typed as `Dict` (from the Korean reference): same keys on both sides. */
import type { Dict } from '../ko';
import * as core from './core';
import * as learning from './learning';
import * as usage from './usage';
import * as knowledge from './knowledge';
import * as services from './services';

export const en: Dict = {
  lang: 'en',
  locale: 'en-US',
  ...core,
  ...learning,
  ...usage,
  ...knowledge,
  ...services,
};
