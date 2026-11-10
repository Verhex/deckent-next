import { plainErrors, type ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `agentsevo` family (S8-3/S8-4 suggestions, standing cards, drafts; i18n `locales/<locale>/agentsevo.json`). */
export const agentsevoErrors: ErrorDefinitions = plainErrors('error.', { CATALOG_SUGGESTION_STALE: 'error', CATALOG_SUGGESTION_SHADOW: 'error', CATALOG_DRAFT_UNAVAILABLE: 'error', CATALOG_DRAFT_CHANGED: 'error' });
