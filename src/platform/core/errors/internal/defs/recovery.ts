import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `recovery` family (alpha.56 recovery rollout cards; i18n `locales/<locale>/recovery.json`); texts live in that family. */
export const recoveryErrors: ErrorDefinitions = Object.freeze({
  RECOVERY_TARGET_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.RECOVERY_TARGET_INVALID', p, l) }) },
  RECOVERY_ROLLOUT_CRITERIA_UNMET: { category: 'error', render: (p, l) => ({ message: t('error.RECOVERY_ROLLOUT_CRITERIA_UNMET', p, l), suggestion: t('recovery.next.RECOVERY_ROLLOUT_CRITERIA_UNMET', p, l) }) },
  RECOVERY_CELL_NOT_OWN: { category: 'error', render: (p, l) => ({ message: t('error.RECOVERY_CELL_NOT_OWN', p, l) }) },
  RECOVERY_ACTION_NO_EXECUTOR: { category: 'error', render: (p, l) => ({ message: t('error.RECOVERY_ACTION_NO_EXECUTOR', p, l) }) },
  RECOVERY_VERDICT_CONFLICT: { category: 'error', render: (p, l) => ({ message: t('error.RECOVERY_VERDICT_CONFLICT', p, l) }) },
});
