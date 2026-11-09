import { plainErrors, type ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `agentsign` family (S8-5 signer keys and signed catalog writes; i18n `locales/<locale>/agentsign.json`). */
export const agentsignErrors: ErrorDefinitions = plainErrors('error.', {
  CATALOG_SIGNER_UNKNOWN: 'error', CATALOG_SIGNER_REVOKED: 'error', CATALOG_SIGNER_MISMATCH: 'error', CATALOG_SIGNATURE_INVALID: 'error',
  CATALOG_SIGNATURE_REQUIRED: 'error', SKILL_SIGNER_REFUSED: 'error', SKILL_SIGNER_INVALID: 'usage', SIGNER_REVOCATION_LOG_BROKEN: 'error',
  SIGNER_KEY_UNAVAILABLE: 'error',
});
