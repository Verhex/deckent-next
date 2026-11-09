import { plainErrors, type ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `agentstats` family (S8-2 catalog evolution statistics; i18n `locales/<locale>/agentstats.json`). */
export const agentstatsErrors: ErrorDefinitions = plainErrors('error.', { CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE: 'error', CATALOG_EVOLUTION_CORRUPT: 'error', CATALOG_EVOLUTION_POSITION_CONFLICT: 'error' });
