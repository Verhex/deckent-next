import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `agentsevo` family (S8-3/S8-4 suggestions, standing cards, drafts; i18n `locales/<locale>/agentsevo.json`). */
export const agentsevoErrors: ErrorDefinitions = Object.freeze({
  CATALOG_SUGGESTION_STALE: { category: 'error', render: (p, l) => ({ message: t('error.CATALOG_SUGGESTION_STALE', p, l) }) },
  CATALOG_SUGGESTION_SHADOW: { category: 'error', render: (p, l) => ({ message: t('error.CATALOG_SUGGESTION_SHADOW', p, l) }) },
  CATALOG_DRAFT_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('error.CATALOG_DRAFT_UNAVAILABLE', p, l) }) },
  CATALOG_DRAFT_CHANGED: { category: 'error', render: (p, l) => ({ message: t('error.CATALOG_DRAFT_CHANGED', p, l) }) },
});
