import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `memory` family (S4 memory journal v1; i18n `locales/<locale>/memory.json`); texts live in that family. */
export const memoryErrors: ErrorDefinitions = Object.freeze({
  MEMORY_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_UNAVAILABLE', p, l) }) },
  MEMORY_CORRUPT: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_CORRUPT', p, l) }) },
  MEMORY_COMMAND_CONFLICT: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_COMMAND_CONFLICT', p, l) }) },
  MEMORY_REVISION_CONFLICT: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_REVISION_CONFLICT', p, l) }) },
  MEMORY_NOT_FOUND: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_NOT_FOUND', p, l) }) },
  MEMORY_OUTCOME_UNKNOWN: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_OUTCOME_UNKNOWN', p, l) }) },
  MEMORY_ENTRY_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.MEMORY_ENTRY_INVALID', p, l) }) },
  MEMORY_TRANSITION_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_TRANSITION_INVALID', p, l) }) },
  MEMORY_VERIFIER_NOT_HUMAN: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_VERIFIER_NOT_HUMAN', p, l) }) },
  MEMORY_SELF_VERIFICATION: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_SELF_VERIFICATION', p, l) }) },
  MEMORY_EVALUATION_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_EVALUATION_UNAVAILABLE', p, l) }) },
  MEMORY_EVALUATION_NOT_PASSED: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_EVALUATION_NOT_PASSED', p, l) }) },
  MEMORY_EVALUATION_OTHER_CONTENT: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_EVALUATION_OTHER_CONTENT', p, l) }) },
  MEMORY_QUERY_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.MEMORY_QUERY_INVALID', p, l) }) },
  // S4B-1 (texts in the `memory-automation` family).
  MEMORY_ENTRY_WITHHELD: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_ENTRY_WITHHELD', p, l) }) },
  MEMORY_PURGED_CONTENT: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_PURGED_CONTENT', p, l) }) },
  MEMORY_EXTRACTION_BOUND: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_EXTRACTION_BOUND', p, l) }) },
  MEMORY_CANDIDATE_SECRET: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_CANDIDATE_SECRET', p, l) }) },
  MEMORY_CANDIDATE_QUARANTINED: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_CANDIDATE_QUARANTINED', p, l) }) },
  MEMORY_DISTILLER_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_DISTILLER_REQUIRED', p, l) }) },
  MEMORY_AUTOMATION_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.MEMORY_AUTOMATION_INVALID', p, l) }) },
  // S4B-3 (texts in the `memory-automation` family).
  MEMORY_EVALUATION_NOT_INDEPENDENT: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_EVALUATION_NOT_INDEPENDENT', p, l) }) },
  MEMORY_EVALUATION_MAKER_UNKNOWN: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_EVALUATION_MAKER_UNKNOWN', p, l) }) },
  MEMORY_EVALUATOR_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_EVALUATOR_REQUIRED', p, l) }) },
});
