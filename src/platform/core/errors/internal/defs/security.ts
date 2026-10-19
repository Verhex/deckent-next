import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `security` family (i18n `locales/<locale>/security.json`); texts live in that family. */
export const securityErrors: ErrorDefinitions = Object.freeze({
  // SEC-3 (F33): config issue reasons; the text names no reference, secret name or value.
  SECRET_REFERENCE_PROJECT_LAYER: { category: 'config', render: (p, l) => ({ message: t('error.SECRET_REFERENCE_PROJECT_LAYER', p, l) }) },
  SECRET_REFERENCE_LEAVES_HOST: { category: 'config', render: (p, l) => ({ message: t('error.SECRET_REFERENCE_LEAVES_HOST', p, l) }) },
  // SEC-1 (A48-D5, F32): an authority write without the service-held terminal witness, or from the MCP actor; nothing was written.
  AUTHORITY_WITNESS_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('error.AUTHORITY_WITNESS_REQUIRED', p, l) }) },
});
