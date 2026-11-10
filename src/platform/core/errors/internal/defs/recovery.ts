import { t } from '#platform/core/i18n/index.js';
import { errorTable, plainErrors, type ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `recovery` family (alpha.56 recovery rollout cards; i18n `locales/<locale>/recovery.json`); texts live in that family. */
export const recoveryErrors: ErrorDefinitions = errorTable('recovery', plainErrors('error.', { RECOVERY_TARGET_INVALID: 'usage' }), {
  RECOVERY_ROLLOUT_CRITERIA_UNMET: { category: 'error', render: (p, l) => ({ message: t('error.RECOVERY_ROLLOUT_CRITERIA_UNMET', p, l), suggestion: t('recovery.next.RECOVERY_ROLLOUT_CRITERIA_UNMET', p, l) }) },
}, plainErrors('error.', { RECOVERY_CELL_NOT_OWN: 'error', RECOVERY_ACTION_NO_EXECUTOR: 'error', RECOVERY_VERDICT_CONFLICT: 'error' }));
