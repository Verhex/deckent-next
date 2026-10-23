import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `agents` family (S7 agent/skill catalog core; i18n `locales/<locale>/agents.json`); texts live in that family. */
export const agentsErrors: ErrorDefinitions = Object.freeze({
  AGENT_CATALOG_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_CATALOG_UNAVAILABLE', p, l) }) },
  AGENT_CATALOG_CORRUPT: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_CATALOG_CORRUPT', p, l) }) },
  AGENT_CATALOG_COMMAND_CONFLICT: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_CATALOG_COMMAND_CONFLICT', p, l) }) },
  AGENT_CATALOG_REVISION_CONFLICT: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_CATALOG_REVISION_CONFLICT', p, l) }) },
  AGENT_CATALOG_NOT_FOUND: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_CATALOG_NOT_FOUND', p, l) }) },
  AGENT_CATALOG_EXISTS: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_CATALOG_EXISTS', p, l) }) },
  AGENT_CATALOG_OUTCOME_UNKNOWN: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_CATALOG_OUTCOME_UNKNOWN', p, l) }) },
  AGENT_CATALOG_LIMIT: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_CATALOG_LIMIT', p, l) }) },
  AGENT_DEFINITION_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.AGENT_DEFINITION_INVALID', p, l) }) },
  SKILL_DEFINITION_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.SKILL_DEFINITION_INVALID', p, l) }) },
  AGENT_ORG_CYCLE: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_ORG_CYCLE', p, l) }) },
  AGENT_ORG_DEPTH: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_ORG_DEPTH', p, l) }) },
  AGENT_PARENT_NOT_FOUND: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_PARENT_NOT_FOUND', p, l) }) },
  AGENT_SKILL_NOT_PINNED: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_SKILL_NOT_PINNED', p, l) }) },
  AGENT_WORK_CLASS_UNKNOWN: { category: 'error', render: (p, l) => ({ message: t('error.AGENT_WORK_CLASS_UNKNOWN', p, l) }) },
  SKILL_IMPORT_UNPINNED: { category: 'error', render: (p, l) => ({ message: t('error.SKILL_IMPORT_UNPINNED', p, l) }) },
  SKILL_IMPORT_PIN_MISMATCH: { category: 'error', render: (p, l) => ({ message: t('error.SKILL_IMPORT_PIN_MISMATCH', p, l) }) },
  SKILL_IMPORT_UNSIGNED: { category: 'error', render: (p, l) => ({ message: t('error.SKILL_IMPORT_UNSIGNED', p, l) }) },
  SKILL_IMPORT_SIGNATURE_UNVERIFIED: { category: 'error', render: (p, l) => ({ message: t('error.SKILL_IMPORT_SIGNATURE_UNVERIFIED', p, l) }) },
});
