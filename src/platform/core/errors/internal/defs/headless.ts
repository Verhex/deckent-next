import { clockText, t, type Locale, type Params } from '#platform/core/i18n/index.js';
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
/** S3-5: why the isolation realm is not usable selects the sentence (no usable bubblewrap, a restricted user namespace, a realm or gateway that did not start). */
const isolation = (p: Params, l: Locale) => {
  switch (p['check']) {
    case 'user-namespace': return t('error.HEADLESS_ISOLATION_UNAVAILABLE.user-namespace', p, l);
    case 'realm': return t('error.HEADLESS_ISOLATION_UNAVAILABLE.realm', p, l);
    case 'gateway': return t('error.HEADLESS_ISOLATION_UNAVAILABLE.gateway', p, l);
    case 'limits': return t('error.HEADLESS_ISOLATION_UNAVAILABLE.limits', p, l);
    default: return t('error.HEADLESS_ISOLATION_UNAVAILABLE', p, l);
  }
};
/** f5: which realm bound stopped the CLI selects the sentence; a bound this release does not know keeps the generic one. */
const limit = (p: Params, l: Locale) => {
  switch (p['limit']) {
    case 'cpu-time': return t('error.HEADLESS_LIMIT_REACHED.cpu-time', p, l);
    case 'processes': return t('error.HEADLESS_LIMIT_REACHED.processes', p, l);
    case 'memory': return t('error.HEADLESS_LIMIT_REACHED.memory', p, l);
    default: return t('error.HEADLESS_LIMIT_REACHED', p, l);
  }
};
/** Error codes owned by the `headless` family (S3 subscription Brain through the person's own CLI; i18n `locales/<locale>/headless.json`). */
export const headlessErrors: ErrorDefinitions = Object.freeze({
  HEADLESS_CLI_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('error.HEADLESS_CLI_UNAVAILABLE', p, l) }) },
  HEADLESS_OWNER_MISMATCH: { category: 'error', render: (p, l) => ({ message: t('error.HEADLESS_OWNER_MISMATCH', p, l) }) },
  HEADLESS_PREFLIGHT_FAILED: { category: 'error', render: (p, l) => ({ message: preflight(p, l) }) },
  HEADLESS_LOGIN_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('error.HEADLESS_LOGIN_REQUIRED', p, l) }) },
  HEADLESS_REQUEST_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.HEADLESS_REQUEST_INVALID', p, l) }) },
  HEADLESS_ISOLATION_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: isolation(p, l) }) },
  HEADLESS_DELEGATION_REFUSED: { category: 'error', render: (p, l) => ({ message: t('error.HEADLESS_DELEGATION_REFUSED', p, l) }) },
  HEADLESS_PERSON_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('error.HEADLESS_PERSON_REQUIRED', p, l) }) },
  HEADLESS_GUARD_FAILED: { category: 'error', render: (p, l) => ({ message: t('error.HEADLESS_GUARD_FAILED', p, l) }) },
  HEADLESS_LIMIT_REACHED: { category: 'error', render: (p, l) => ({ message: limit(p, l) }) },
  HEADLESS_CREDITS_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('error.HEADLESS_CREDITS_REQUIRED', p, l) }) },
  // S9 card texts reused read-only: a known reset time names when to ask again. f3: a Brain plan whose reset is within brain_planner.quotaWait waits
  // visibly first (new derived attempt); this refusal means no wait applied or the attempts are spent. Nothing retries on its own.
  HEADLESS_QUOTA_EXHAUSTED: { category: 'error', render: (p, l) => ({ message: `${t('error.HEADLESS_QUOTA_EXHAUSTED', p, l)} ${typeof p['resetsAtMs'] === 'number'
    ? t('quotaask.card.resetKnown', { time: clockText(p['resetsAtMs']) }, l) : t('quotaask.card.resetUnknown', {}, l)}` }) },
});
