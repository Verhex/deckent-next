import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `agentstats` family (S8-2 catalog evolution statistics; i18n `locales/<locale>/agentstats.json`). */
export const agentstatsErrors: ErrorDefinitions = Object.freeze({
  CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('error.CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE', p, l) }) },
  CATALOG_EVOLUTION_CORRUPT: { category: 'error', render: (p, l) => ({ message: t('error.CATALOG_EVOLUTION_CORRUPT', p, l) }) },
  CATALOG_EVOLUTION_POSITION_CONFLICT: { category: 'error', render: (p, l) => ({ message: t('error.CATALOG_EVOLUTION_POSITION_CONFLICT', p, l) }) },
});
