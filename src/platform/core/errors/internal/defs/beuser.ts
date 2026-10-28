import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** B1 refuses uncertain targets without echoing raw paths, terminal content or credentials. */
export const beuserErrors: ErrorDefinitions = Object.freeze({
  BEUSER_INPUT_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.BEUSER_INPUT_INVALID', p, l), suggestion: t('remedy.BEUSER_INPUT_INVALID', p, l) }) },
  BEUSER_TARGET_NOT_SANDBOX: { category: 'error', render: (p, l) => ({ message: t('error.BEUSER_TARGET_NOT_SANDBOX', p, l), suggestion: t('remedy.BEUSER_TARGET_NOT_SANDBOX', p, l) }) },
  BEUSER_LIMITS_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('error.BEUSER_LIMITS_UNAVAILABLE', p, l), suggestion: t('remedy.BEUSER_LIMITS_UNAVAILABLE', p, l) }) },
  BEUSER_MODEL_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('error.BEUSER_MODEL_UNAVAILABLE', p, l), suggestion: t('remedy.BEUSER_MODEL_UNAVAILABLE', p, l) }) },
  BEUSER_SURFACE_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('error.BEUSER_SURFACE_UNAVAILABLE', p, l), suggestion: t('remedy.BEUSER_SURFACE_UNAVAILABLE', p, l) }) },
  BEUSER_SURFACE_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.BEUSER_SURFACE_INVALID', p, l), suggestion: t('remedy.BEUSER_SURFACE_INVALID', p, l) }) },
  BEUSER_SURFACE_LIMIT: { category: 'error', render: (p, l) => ({ message: t('error.BEUSER_SURFACE_LIMIT', p, l), suggestion: t('remedy.BEUSER_SURFACE_LIMIT', p, l) }) },
  BEUSER_SURFACE_BUSY: { category: 'error', render: (p, l) => ({ message: t('error.BEUSER_SURFACE_BUSY', p, l), suggestion: t('remedy.BEUSER_SURFACE_BUSY', p, l) }) },
  BEUSER_CAPTURE_BLOCKED: { category: 'error', render: (p, l) => ({ message: t('error.BEUSER_CAPTURE_BLOCKED', p, l), suggestion: t('remedy.BEUSER_CAPTURE_BLOCKED', p, l) }) },
  BEUSER_SURFACE_EOF: { category: 'error', render: (p, l) => ({ message: t('error.BEUSER_SURFACE_EOF', p, l), suggestion: t('remedy.BEUSER_SURFACE_EOF', p, l) }) },
  BACKUP_REALM_SEALED: { category: 'error', render: (p, l) => ({ message: t('error.BACKUP_REALM_SEALED', p, l), suggestion: t('remedy.BACKUP_REALM_SEALED', p, l) }) },
});
