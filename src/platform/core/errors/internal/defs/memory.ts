import { t } from '#platform/core/i18n/index.js';
import { errorTable, plainErrors, type ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `memory` family (S4 memory journal v1; i18n `locales/<locale>/memory.json`); texts live in that family. */
export const memoryErrors: ErrorDefinitions = errorTable('memory', plainErrors('error.', {
  MEMORY_UNAVAILABLE: 'error', MEMORY_CORRUPT: 'error', MEMORY_COMMAND_CONFLICT: 'error', MEMORY_REVISION_CONFLICT: 'error', MEMORY_NOT_FOUND: 'error',
  MEMORY_OUTCOME_UNKNOWN: 'error', MEMORY_ENTRY_INVALID: 'usage', MEMORY_TRANSITION_INVALID: 'error', MEMORY_VERIFIER_NOT_HUMAN: 'error',
  MEMORY_SELF_VERIFICATION: 'error', MEMORY_EVALUATION_UNAVAILABLE: 'error', MEMORY_EVALUATION_NOT_PASSED: 'error', MEMORY_EVALUATION_OTHER_CONTENT: 'error',
  MEMORY_QUERY_INVALID: 'usage',
  // S4B-1 (texts in the `memory-automation` family).
  MEMORY_ENTRY_WITHHELD: 'error', MEMORY_PURGED_CONTENT: 'error', MEMORY_EXTRACTION_BOUND: 'error', MEMORY_CANDIDATE_SECRET: 'error',
  MEMORY_CANDIDATE_QUARANTINED: 'error', MEMORY_DISTILLER_REQUIRED: 'error', MEMORY_AUTOMATION_INVALID: 'usage',
  // S4B-3 (texts in the `memory-automation` family).
  MEMORY_EVALUATION_NOT_INDEPENDENT: 'error', MEMORY_EVALUATION_MAKER_UNKNOWN: 'error', MEMORY_EVALUATOR_REQUIRED: 'error',
}), {
  // S4B-5 (texts in the `memory-automation` family): a failed memory read at Run admission holds the Run, with the next step.
  MEMORY_CONTEXT_HELD: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_CONTEXT_HELD', p, l), suggestion: t('memory.held.next.MEMORY_CONTEXT_HELD', p, l) }) },
  // S4B-6 (texts in the `memory-automation` family): a failed memory read for a Brain planning request refuses it before any model call.
  BRAIN_MEMORY_CONTEXT_HELD: { category: 'error', render: (p, l) => ({ message: t('error.BRAIN_MEMORY_CONTEXT_HELD', p, l), suggestion: t('memory.held.next.BRAIN_MEMORY_CONTEXT_HELD', p, l) }) },
  // S4B-4 (texts in the `memory-review` family).
  MEMORY_PURGE_REPLAY_HELD: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_PURGE_REPLAY_HELD', p, l), suggestion: t('memory.held.next.MEMORY_PURGE_REPLAY_HELD', p, l) }) },
}, plainErrors('error.', { MEMORY_PERSON_REQUIRED: 'error', MEMORY_CONTEST_RESOLVED: 'error', MEMORY_PURGE_INVOCATION_REFUSED: 'error' }), {
  // S4B-7 (texts in the `memory-rollout` family): a protected live switch whose measured exit criteria do not hold is not written.
  MEMORY_ROLLOUT_CRITERIA_UNMET: { category: 'error', render: (p, l) => ({ message: t('error.MEMORY_ROLLOUT_CRITERIA_UNMET', p, l), suggestion: t('memory.held.next.MEMORY_ROLLOUT_CRITERIA_UNMET', p, l) }) },
});
