import { clockText, t, type Locale, type Params } from '#platform/core/i18n/index.js';
import { errorTable, plainErrors, type ErrorDefinitions } from '../definition.js';

function npmReason(reason: unknown, locale: Locale): string | undefined {
  switch (reason) {
    case 'missing': return t('error.headless.npmReason.missing', {}, locale);
    case 'not-directory': return t('error.headless.npmReason.not-directory', {}, locale);
    case 'not-regular-file': return t('error.headless.npmReason.not-regular-file', {}, locale);
    case 'not-expected-link': return t('error.headless.npmReason.not-expected-link', {}, locale);
    case 'untrusted-owner': return t('error.headless.npmReason.untrusted-owner', {}, locale);
    case 'group-or-other-writable': return t('error.headless.npmReason.group-or-other-writable', {}, locale);
    case 'set-id': return t('error.headless.npmReason.set-id', {}, locale);
    case 'multiple-hard-links': return t('error.headless.npmReason.multiple-hard-links', {}, locale);
    case 'no-hard-links': return t('error.headless.npmReason.no-hard-links', {}, locale);
    case 'manifest-mismatch': return t('error.headless.npmReason.manifest-mismatch', {}, locale);
    case 'manifest-invalid': return t('error.headless.npmReason.manifest-invalid', {}, locale);
    case 'manifest-too-large': return t('error.headless.npmReason.manifest-too-large', {}, locale);
    case 'manifest-unreadable': return t('error.headless.npmReason.manifest-unreadable', {}, locale);
    case 'not-executable': return t('error.headless.npmReason.not-executable', {}, locale);
    case 'changed-during-check': return t('error.headless.npmReason.changed-during-check', {}, locale);
    case 'verification-unavailable': return t('error.headless.npmReason.verification-unavailable', {}, locale);
    default: return undefined;
  }
}

function selectionRefusal(reason: unknown, locale: Locale): string {
  let kind: string;
  switch (reason) {
    case 'directory': kind = t('error.headless.selectionKind.directory', {}, locale); break;
    case 'not-regular-file': kind = t('error.headless.selectionKind.not-regular-file', {}, locale); break;
    case 'not-executable': kind = t('error.headless.selectionKind.not-executable', {}, locale); break;
    default: return t('error.headless.selectionUnavailable', {}, locale);
  }
  return t('error.headless.selectionRefused', { kind }, locale);
}

function npmLayoutRefusal(p: Params, l: Locale): string {
  const manifest = p['reason'] === 'manifest-exclusion-changed' ? t('error.headless.npmProof.manifest-exclusion-changed', {}, l)
    : p['reason'] === 'manifest-declares-bin' ? t('error.headless.npmProof.manifest-declares-bin', {}, l)
      : t('error.headless.npmProof.manifest-exclusion-unverified', {}, l);
  let native: string;
  switch (p['native']) {
    case 'native-platform-unverified': native = t('error.headless.npmProof.native-platform-unverified', {}, l); break;
    case 'native-file-changed': native = t('error.headless.npmProof.native-file-changed', {}, l); break;
    case 'native-format-unverified': native = t('error.headless.npmProof.native-format-unverified', {}, l); break;
    case 'native-read-incomplete': native = t('error.headless.npmProof.native-read-incomplete', {}, l); break;
    case 'native-proof-unavailable': native = t('error.headless.npmProof.native-proof-unavailable', {}, l); break;
    default: return t('error.HEADLESS_PREFLIGHT_FAILED.npm-layout-unknown', {}, l);
  }
  return t('error.headless.npmProof.refused', { manifest, native }, l);
}

function configRefusal(reason: unknown, l: Locale): string {
  switch (reason) {
    case 'relative-path': return t('error.headless.config.relative-path', {}, l);
    case 'unresolved': return t('error.headless.config.unresolved', {}, l);
    case 'missing': return t('error.headless.config.missing', {}, l);
    case 'not-directory': return t('error.headless.config.not-directory', {}, l);
    case 'untrusted-owner': return t('error.headless.config.untrusted-owner', {}, l);
    case 'unverified': return t('error.headless.config.unverified', {}, l);
    case 'unreported': return t('error.headless.config.unreported', {}, l);
    case 'reported-mismatch': return t('error.headless.config.reported-mismatch', {}, l);
    case 'entry-limit': return t('error.headless.config.entry-limit', {}, l);
    case 'copy-entry-rejected': return t('error.headless.config.copy-entry-rejected', {}, l);
    case 'copy-size-limit': return t('error.headless.config.copy-size-limit', {}, l);
    case 'mask-unverified': return t('error.headless.config.mask-unverified', {}, l);
    case 'private-entry-refused': return t('error.headless.config.private-entry-refused', {}, l);
    case 'lock-unverified': return t('error.headless.config.lock-unverified', {}, l);
    default: return t('error.HEADLESS_PREFLIGHT_FAILED.config-dir', {}, l);
  }
}

function spawnRefusal(reason: unknown, l: Locale): string {
  switch (reason) {
    case 'timeout': return t('error.headless.probe.timeout', {}, l);
    case 'start-failed': return t('error.headless.probe.start-failed', {}, l);
    case 'output-limit': return t('error.headless.probe.output-limit', {}, l);
    case 'line-limit': return t('error.headless.probe.line-limit', {}, l);
    case 'stopped': return t('error.headless.probe.stopped', {}, l);
    default: return t('error.HEADLESS_PREFLIGHT_FAILED.spawn', {}, l);
  }
}

/** The failed preflight check selects the sentence; a check this release does not know keeps the generic one. */
const preflight = (p: Params, l: Locale) => {
  switch (p['check']) {
    case 'version': {
      const exit = p['exitCode'], version = p['version'], minimum = p['minimum'];
      if (p['reason'] === 'exit' && typeof exit === 'string' && /^(?:[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5])$/u.test(exit))
        return t('error.HEADLESS_PREFLIGHT_FAILED.version-exit', { exit }, l);
      if (p['reason'] === 'unreadable') return t('error.HEADLESS_PREFLIGHT_FAILED.version-unreadable', {}, l);
      const versionPattern = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/u;
      if (p['reason'] === 'too-old' && typeof version === 'string' && typeof minimum === 'string' && versionPattern.test(version) && versionPattern.test(minimum))
        return t('error.HEADLESS_PREFLIGHT_FAILED.version-too-old', { version, minimum }, l);
      return t('error.HEADLESS_PREFLIGHT_FAILED.version', {}, l);
    }
    case 'npm-layout-unknown': return npmLayoutRefusal(p, l);
    case 'npm-payload-missing':
    case 'npm-payload-unverified': {
      const reason = npmReason(p['reason'], l);
      if (reason !== undefined) return p['recheck'] === 1
        ? t('error.headless.npmRecheckRefusal', { reason }, l) : t('error.headless.npmRefusal', { reason }, l);
      return p['check'] === 'npm-payload-missing' ? t('error.HEADLESS_PREFLIGHT_FAILED.npm-payload-missing', {}, l)
        : t('error.HEADLESS_PREFLIGHT_FAILED.npm-payload-unverified', {}, l);
    }
    case 'signal': return t('error.HEADLESS_PREFLIGHT_FAILED.signal', {}, l);
    case 'cancelled': return t('error.HEADLESS_PREFLIGHT_FAILED.cancelled', {}, l);
    case 'selected-file': return selectionRefusal(p['reason'], l);
    case 'path-candidate-unverified': return t('error.headless.pathCandidateUnverified', {}, l);
    case 'executable-recheck': return t('error.headless.executableRecheckRefusal', {
      reason: npmReason(p['reason'], l) ?? t('error.headless.npmReason.verification-unavailable', {}, l),
    }, l);
    case 'executable-changed': return t('error.HEADLESS_PREFLIGHT_FAILED.executable-changed', {}, l);
    case 'executable-bind-unverified': return t('error.headless.executableBindUnverified', {}, l);
    case 'executable-bind-target-mismatch': return t('error.headless.executableBindTargetMismatch', {}, l);
    case 'npm-package-directory-overlap': return t('error.headless.npmPackageDirectoryOverlap', {}, l);
    case 'npm-package-runtime-overlap': return t('error.headless.npmPackageRuntimeOverlap', {}, l);
    case 'realm-command-unverified': return t('error.headless.realmCommandUnverified', {}, l);
    case 'preflight-record-write': return t('error.headless.preflightRecordWrite', {}, l);
    case 'preflight-record-unreadable': return t('error.headless.preflightRecordUnreadable', {}, l);
    case 'flags':
      if (p['reason'] === 'help-unverified') return t('error.headless.probe.help-unverified', {}, l);
      if (p['reason'] === 'parser-unverified') return t('error.headless.probe.parser-unverified', {}, l);
      return t('error.HEADLESS_PREFLIGHT_FAILED.flags', p, l);
    case 'auth-status': return t('error.HEADLESS_PREFLIGHT_FAILED.auth-status', p, l);
    case 'config-dir': return configRefusal(p['reason'], l);
    case 'state-dir':
      if (p['reason'] === 'not-directory') return t('error.headless.state.not-directory', {}, l);
      if (p['reason'] === 'unverified') return t('error.headless.state.unverified', {}, l);
      return t('error.HEADLESS_PREFLIGHT_FAILED.state-dir', p, l);
    case 'spawn': return spawnRefusal(p['reason'], l);
    case 'agent-program-changed': return t('error.headless.agentProgramChanged', {}, l);
    case 'agent-seal': return t('error.headless.agentSealMismatch', {}, l);
    default: return t('error.HEADLESS_PREFLIGHT_FAILED', p, l);
  }
};
/** S3-5: why the isolation realm is not usable selects the sentence (no usable bubblewrap, a restricted user namespace, a realm or gateway that did not start). */
const isolation = (p: Params, l: Locale) => {
  switch (p['check']) {
    case 'launcher':
      if (p['reason'] === 'unverified') return t('error.headless.isolation.launcher-unverified', {}, l);
      if (p['reason'] === 'platform') return t('error.headless.isolation.launcher-platform', {}, l);
      return t('error.HEADLESS_ISOLATION_UNAVAILABLE', p, l);
    case 'user-namespace': return t('error.HEADLESS_ISOLATION_UNAVAILABLE.user-namespace', p, l);
    case 'realm': return t('error.HEADLESS_ISOLATION_UNAVAILABLE.realm', p, l);
    case 'gateway': return t('error.HEADLESS_ISOLATION_UNAVAILABLE.gateway', p, l);
    case 'limits':
      if (p['reason'] === 'limiter-unverified') return t('error.headless.isolation.limiter-unverified', {}, l);
      if (p['reason'] === 'limiter-unrunnable') return t('error.headless.isolation.limiter-unrunnable', {}, l);
      if (p['reason'] === 'limit-application') return t('error.headless.isolation.limit-application', {}, l);
      if (p['reason'] === 'limit-verification') return t('error.headless.isolation.limit-verification', {}, l);
      return t('error.HEADLESS_ISOLATION_UNAVAILABLE.limits', p, l);
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
}), {
  HEADLESS_CLI_UNAVAILABLE: { category: 'error', render: (p, l) => {
    switch (p['check']) {
      case 'path-search-empty': return { message: t('error.headless.pathSearchEmpty', {}, l) };
      case 'path-search-incomplete': return { message: t('error.headless.pathSearchIncomplete', {}, l) };
      case 'recorded-path-unverified': return { message: t('error.headless.recordedPathUnverified', {}, l) };
      case 'login-launch-unverified': return { message: t('error.headless.loginLaunchUnverified', {}, l) };
      default: return { message: t('error.HEADLESS_CLI_UNAVAILABLE', {}, l) };
    }
  } },
}, plainErrors('error.', { HEADLESS_OWNER_MISMATCH: 'error' }), {
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
