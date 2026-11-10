import { clockText, t, type Locale, type Params } from '#platform/core/i18n/index.js';
import { errorTable, plainErrors, type ErrorDefinitions } from '../definition.js';
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
export const headlessErrors: ErrorDefinitions = errorTable('headless', plainErrors('headless.agent.worker.', {
  NATIVE_PROJECTION_RETIRED: 'error', NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE: 'config', NATIVE_SUBSCRIPTION_OTHER_PERSON: 'config', NATIVE_RELAY_LIMIT: 'error',
  NATIVE_WORKER_F08_REQUIRED: 'error', NATIVE_WORKER_CAPACITY_WAIT: 'error', NATIVE_CLI_WORKER_PROFILE_INVALID: 'error', NATIVE_CLI_WORKER_UNAVAILABLE: 'error',
  NATIVE_WORKER_TERMINATION_UNKNOWN: 'error', NATIVE_WORKER_OUTPUT_LIMIT: 'error', NATIVE_WORKER_STOP_UNCONFIRMED: 'error', NATIVE_WORKER_EFFECTS_UNKNOWN: 'error',
  NATIVE_WORKER_NOT_STARTED: 'error', NATIVE_WORKER_CUSTODY_UNKNOWN: 'error',
}), plainErrors('headless.agent.reason.', {
  NATIVE_AGENT_CLI_UNAVAILABLE: 'error', NATIVE_AGENT_LOGIN_REQUIRED: 'error', NATIVE_AGENT_CAPABILITY_UNSEALED: 'error', NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED: 'error',
  NATIVE_AGENT_PLUGIN_UNEXPECTED: 'error', NATIVE_AGENT_BRIDGE_UNAVAILABLE: 'error', NATIVE_AGENT_ENVIRONMENT_REFUSED: 'error',
}), plainErrors('error.', { HEADLESS_CLI_UNAVAILABLE: 'error', HEADLESS_OWNER_MISMATCH: 'error' }), {
  HEADLESS_PREFLIGHT_FAILED: { category: 'error', render: (p, l) => ({ message: preflight(p, l) }) },
}, plainErrors('error.', { HEADLESS_LOGIN_REQUIRED: 'error', HEADLESS_REQUEST_INVALID: 'error' }), {
  HEADLESS_ISOLATION_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: isolation(p, l) }) },
}, plainErrors('error.', { HEADLESS_DELEGATION_REFUSED: 'error' }), {
  NATIVE_AGENT_RECONNECT_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('headless.agent.connection.reconnectRequired', p, l) }) },
}, plainErrors('error.', { HEADLESS_PERSON_REQUIRED: 'error', HEADLESS_GUARD_FAILED: 'error' }), {
  HEADLESS_LIMIT_REACHED: { category: 'error', render: (p, l) => ({ message: limit(p, l) }) },
  HEADLESS_LOGIN_BUSY: { category: 'error', render: (p, l) => ({ message: p['holder'] === 'cli' ? t('error.HEADLESS_LOGIN_BUSY.cli', p, l) : t('error.HEADLESS_LOGIN_BUSY', p, l) }) },
}, plainErrors('error.', { HEADLESS_CREDITS_REQUIRED: 'error' }), {
  // S9 card texts reused read-only: a known reset time names when to ask again. f3: a Brain plan whose reset is within brain_planner.quotaWait waits
  // visibly first (new derived attempt); this refusal means no wait applied or the attempts are spent. Nothing retries on its own.
  HEADLESS_QUOTA_EXHAUSTED: { category: 'error', render: (p, l) => ({ message: `${t('error.HEADLESS_QUOTA_EXHAUSTED', p, l)} ${typeof p['resetsAtMs'] === 'number'
    ? t('quotaask.card.resetKnown', { time: clockText(p['resetsAtMs']) }, l) : t('quotaask.card.resetUnknown', {}, l)}` }) },
}, plainErrors('headless.agent.worker.', {
  NATIVE_WORKER_VERIFICATION_WAIT: 'error', NATIVE_WORKER_F08_INVALID: 'error', NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED: 'error', NATIVE_WORKER_PLUGIN_UNEXPECTED: 'error',
  NATIVE_WORKER_INPUT_REFUSED: 'error',
}));
