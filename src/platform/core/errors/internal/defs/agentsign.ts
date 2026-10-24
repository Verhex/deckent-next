import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `agentsign` family (S8-5 signer keys and signed catalog writes; i18n `locales/<locale>/agentsign.json`). */
export const agentsignErrors: ErrorDefinitions = Object.freeze({
  CATALOG_SIGNER_UNKNOWN: { category: 'error', render: (p, l) => ({ message: t('error.CATALOG_SIGNER_UNKNOWN', p, l) }) },
  CATALOG_SIGNER_REVOKED: { category: 'error', render: (p, l) => ({ message: t('error.CATALOG_SIGNER_REVOKED', p, l) }) },
  CATALOG_SIGNER_MISMATCH: { category: 'error', render: (p, l) => ({ message: t('error.CATALOG_SIGNER_MISMATCH', p, l) }) },
  CATALOG_SIGNATURE_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.CATALOG_SIGNATURE_INVALID', p, l) }) },
  CATALOG_SIGNATURE_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('error.CATALOG_SIGNATURE_REQUIRED', p, l) }) },
  SKILL_SIGNER_REFUSED: { category: 'error', render: (p, l) => ({ message: t('error.SKILL_SIGNER_REFUSED', p, l) }) },
  SKILL_SIGNER_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.SKILL_SIGNER_INVALID', p, l) }) },
  SIGNER_REVOCATION_LOG_BROKEN: { category: 'error', render: (p, l) => ({ message: t('error.SIGNER_REVOCATION_LOG_BROKEN', p, l) }) },
  SIGNER_KEY_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('error.SIGNER_KEY_UNAVAILABLE', p, l) }) },
});
