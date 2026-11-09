import { t } from '#platform/core/i18n/index.js';
import { errorTable, plainErrors, type ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `agents` family (S7 agent/skill catalog core; i18n `locales/<locale>/agents.json`); texts live in that family. */
export const agentsErrors: ErrorDefinitions = errorTable('agents', plainErrors('error.', {
  AGENT_CATALOG_UNAVAILABLE: 'error', AGENT_CATALOG_CORRUPT: 'error', AGENT_CATALOG_COMMAND_CONFLICT: 'error', AGENT_CATALOG_REVISION_CONFLICT: 'error',
  AGENT_CATALOG_NOT_FOUND: 'error', AGENT_CATALOG_EXISTS: 'error', AGENT_CATALOG_OUTCOME_UNKNOWN: 'error', AGENT_CATALOG_LIMIT: 'error',
  AGENT_DEFINITION_INVALID: 'usage', SKILL_DEFINITION_INVALID: 'usage', AGENT_ORG_CYCLE: 'error', AGENT_ORG_DEPTH: 'error', AGENT_PARENT_NOT_FOUND: 'error',
  AGENT_SKILL_NOT_PINNED: 'error',
}), {
  // BeUser E-02: the CLI adds the installation's WorkClasses (`known`); other transports keep the plain sentence.
  AGENT_WORK_CLASS_UNKNOWN: { category: 'error', render: (p, l) => ({ message: p['known'] === undefined ? t('error.AGENT_WORK_CLASS_UNKNOWN', p, l) : t('error.AGENT_WORK_CLASS_UNKNOWN.known', p, l) }) },
}, plainErrors('error.', {
  SKILL_IMPORT_UNPINNED: 'error', SKILL_IMPORT_PIN_MISMATCH: 'error', SKILL_IMPORT_UNSIGNED: 'error', SKILL_IMPORT_SIGNATURE_UNVERIFIED: 'error',
  AGENT_PROMPT_TOO_LARGE: 'usage', AGENT_STANDING_REFUSED: 'error', AGENT_STANDING_CONFLICT: 'error',
}));
