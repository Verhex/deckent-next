import { clockText, t } from '#platform/core/i18n/index.js';
import { errorTable, plainErrors, type ErrorDefinitions } from '../definition.js';

import { localizeHeadlessDiagnostic, type HeadlessDiagnosticCode } from '../headless-diagnostics.js';

const diagnostic = (code: HeadlessDiagnosticCode): ErrorDefinitions => ({
  [code]: { category: 'error', render: (params, locale) => ({ message: localizeHeadlessDiagnostic(code, params, locale) }) },
});

/** Error codes owned by the `headless` family (S3 subscription Brain through the person's own CLI; i18n `locales/<locale>/headless.json`). */
export const headlessErrors: ErrorDefinitions = errorTable('headless', plainErrors('headless.agent.worker.', {
  NATIVE_PROJECTION_RETIRED: 'error', NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE: 'config', NATIVE_SUBSCRIPTION_OTHER_PERSON: 'config', NATIVE_RELAY_LIMIT: 'error',
  NATIVE_WORKER_F08_REQUIRED: 'error', NATIVE_WORKER_CAPACITY_WAIT: 'error', NATIVE_CLI_WORKER_PROFILE_INVALID: 'error', NATIVE_CLI_WORKER_UNAVAILABLE: 'error',
  NATIVE_WORKER_TERMINATION_UNKNOWN: 'error', NATIVE_WORKER_OUTPUT_LIMIT: 'error', NATIVE_WORKER_STOP_UNCONFIRMED: 'error', NATIVE_WORKER_EFFECTS_UNKNOWN: 'error',
  NATIVE_WORKER_NOT_STARTED: 'error', NATIVE_WORKER_CUSTODY_UNKNOWN: 'error',
}), plainErrors('headless.agent.reason.', {
  NATIVE_AGENT_CLI_UNAVAILABLE: 'error', NATIVE_AGENT_LOGIN_REQUIRED: 'error', NATIVE_AGENT_CAPABILITY_UNSEALED: 'error', NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED: 'error',
  NATIVE_AGENT_PLUGIN_UNEXPECTED: 'error', NATIVE_AGENT_BRIDGE_UNAVAILABLE: 'error', NATIVE_AGENT_ENVIRONMENT_REFUSED: 'error',
}), diagnostic('HEADLESS_CLI_UNAVAILABLE'), diagnostic('HEADLESS_OWNER_MISMATCH'),
diagnostic('HEADLESS_PREFLIGHT_FAILED'), diagnostic('HEADLESS_LOGIN_REQUIRED'),
diagnostic('HEADLESS_REQUEST_INVALID'), diagnostic('HEADLESS_ISOLATION_UNAVAILABLE'), plainErrors('error.', { HEADLESS_DELEGATION_REFUSED: 'error' }), {
  NATIVE_AGENT_RECONNECT_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('headless.agent.connection.reconnectRequired', p, l) }) },
}, plainErrors('error.', { HEADLESS_PERSON_REQUIRED: 'error', HEADLESS_GUARD_FAILED: 'error' }), diagnostic('HEADLESS_LIMIT_REACHED'), diagnostic('HEADLESS_LOGIN_BUSY'), plainErrors('error.', { HEADLESS_CREDITS_REQUIRED: 'error' }), {
  // S9 card texts reused read-only: a known reset time names when to ask again. f3: a Brain plan whose reset is within brain_planner.quotaWait waits
  // visibly first (new derived attempt); this refusal means no wait applied or the attempts are spent. Nothing retries on its own.
  HEADLESS_QUOTA_EXHAUSTED: { category: 'error', render: (p, l) => ({ message: `${t('error.HEADLESS_QUOTA_EXHAUSTED', p, l)} ${typeof p['resetsAtMs'] === 'number'
    ? t('quotaask.card.resetKnown', { time: clockText(p['resetsAtMs']) }, l) : t('quotaask.card.resetUnknown', {}, l)}` }) },
}, plainErrors('headless.agent.worker.', {
  NATIVE_WORKER_VERIFICATION_WAIT: 'error', NATIVE_WORKER_F08_INVALID: 'error', NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED: 'error', NATIVE_WORKER_PLUGIN_UNEXPECTED: 'error',
  NATIVE_WORKER_INPUT_REFUSED: 'error',
}));
