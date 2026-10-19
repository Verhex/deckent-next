import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `setup` family (i18n `locales/<locale>/setup.json`); texts live in that family. */
export const setupErrors: ErrorDefinitions = Object.freeze({
  SETUP_STAGE_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_STAGE_INVALID', p, l) }) },
  SETUP_STAGE_SHADOW: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_STAGE_SHADOW', p, l) }) },
  SETUP_FAMILY_UNKNOWN: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_FAMILY_UNKNOWN', p, l) }) },
  SETUP_OBSERVATION_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_OBSERVATION_INVALID', p, l) }) },
  SETUP_ANSWER_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_ANSWER_INVALID', p, l) }) },
});
