import { t, type Locale, type Params } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** The failed preflight check selects the sentence; a check this release does not know keeps the generic one. */
const preflight = (p: Params, l: Locale) => {
  switch (p['check']) {
    case 'version': return t('error.HEADLESS_PREFLIGHT_FAILED.version', p, l);
    case 'flags': return t('error.HEADLESS_PREFLIGHT_FAILED.flags', p, l);
    case 'auth-status': return t('error.HEADLESS_PREFLIGHT_FAILED.auth-status', p, l);
    case 'config-dir': return t('error.HEADLESS_PREFLIGHT_FAILED.config-dir', p, l);
    case 'state-dir': return t('error.HEADLESS_PREFLIGHT_FAILED.state-dir', p, l);
    case 'spawn': return t('error.HEADLESS_PREFLIGHT_FAILED.spawn', p, l);
    default: return t('error.HEADLESS_PREFLIGHT_FAILED', p, l);
  }
};
/** Error codes owned by the `headless` family (S3 subscription Brain through the person's own CLI; i18n `locales/<locale>/headless.json`). */
export const headlessErrors: ErrorDefinitions = Object.freeze({
  HEADLESS_CLI_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('error.HEADLESS_CLI_UNAVAILABLE', p, l) }) },
  HEADLESS_OWNER_MISMATCH: { category: 'error', render: (p, l) => ({ message: t('error.HEADLESS_OWNER_MISMATCH', p, l) }) },
  HEADLESS_PREFLIGHT_FAILED: { category: 'error', render: (p, l) => ({ message: preflight(p, l) }) },
  HEADLESS_LOGIN_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('error.HEADLESS_LOGIN_REQUIRED', p, l) }) },
  HEADLESS_REQUEST_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.HEADLESS_REQUEST_INVALID', p, l) }) },
});
