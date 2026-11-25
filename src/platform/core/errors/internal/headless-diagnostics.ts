import { messageText, t, type Locale, type MessageKey, type Params } from '#platform/core/i18n/index.js';

const catalogText = (key: MessageKey, locale: Locale, params: Params = {}) => messageText(key, locale, params) ?? key;

type Render = (params: Params, locale: Locale) => string;
type Field = Readonly<{ example: string | number; accepts(value: unknown): boolean }>;
type Cases = Readonly<Record<string, MessageKey | Render>>;
type Fixed = Readonly<Record<string, string | number>>;
type ExtraFields = Readonly<Record<string, Field>>;
type Diagnostic<Code extends string = string, Fields extends Fixed = Fixed, Extra extends ExtraFields | undefined = ExtraFields | undefined> = Readonly<{
  code: Code;
  fields: Fields;
  extras: Extra;
  render: Render;
}>;

function diagnostic<const Code extends string, const Fields extends Fixed, const Extra extends ExtraFields | undefined = undefined>(
  code: Code, fields: Fields, message: MessageKey | Render, extras?: Extra,
): Diagnostic<Code, Fields, Extra> {
  const render: Render = typeof message === 'string' ? (_, locale) => catalogText(message, locale) : message;
  return Object.freeze({ code, fields: Object.freeze(fields), extras: extras as Extra, render });
}

function classified<const Code extends string, const By extends string, const Fields extends Fixed, const Values extends Cases>(
  code: Code, by: By, fields: Fields, values: Values,
) {
  type Row = Diagnostic<Code, Fields & Readonly<Record<By, keyof Values & string>>, undefined>;
  return Object.entries(values).map(([value, message]) => diagnostic(code, Object.freeze({ ...fields, [by]: value }), message)) as Row[];
}

const preflight = 'HEADLESS_PREFLIGHT_FAILED';
const isolation = 'HEADLESS_ISOLATION_UNAVAILABLE';
const unavailable = 'HEADLESS_CLI_UNAVAILABLE';
const request = 'HEADLESS_REQUEST_INVALID';
const loginBusy = 'HEADLESS_LOGIN_BUSY';
const loginRequired = 'HEADLESS_LOGIN_REQUIRED';
const limit = 'HEADLESS_LIMIT_REACHED';
const ownerMismatch = 'HEADLESS_OWNER_MISMATCH';
const workerResult = 'HEADLESS_WORKER_RESULT';

const npmReasons = {
  missing: 'error.headless.npmReason.missing',
  'not-directory': 'error.headless.npmReason.not-directory',
  'not-regular-file': 'error.headless.npmReason.not-regular-file',
  'not-expected-link': 'error.headless.npmReason.not-expected-link',
  'untrusted-owner': 'error.headless.npmReason.untrusted-owner',
  'group-or-other-writable': 'error.headless.npmReason.group-or-other-writable',
  'set-id': 'error.headless.npmReason.set-id',
  'multiple-hard-links': 'error.headless.npmReason.multiple-hard-links',
  'no-hard-links': 'error.headless.npmReason.no-hard-links',
  'manifest-mismatch': 'error.headless.npmReason.manifest-mismatch',
  'manifest-invalid': 'error.headless.npmReason.manifest-invalid',
  'manifest-too-large': 'error.headless.npmReason.manifest-too-large',
  'manifest-unreadable': 'error.headless.npmReason.manifest-unreadable',
  'not-executable': 'error.headless.npmReason.not-executable',
  'changed-during-check': 'error.headless.npmReason.changed-during-check',
  'verification-unavailable': 'error.headless.npmReason.verification-unavailable',
} as const;
export type NpmCheckReason = keyof typeof npmReasons;

const recheck = (key: MessageKey): Render => (_, locale) =>
  t('error.headless.executableRecheckRefusal', { reason: catalogText(key, locale) }, locale);
const npmMessage = (key: MessageKey, rechecking: boolean, uncertain: boolean): Render => (_, locale) => {
  const reason = catalogText(key, locale);
  return catalogText(uncertain ? 'error.headless.npmUnverified'
    : rechecking ? 'error.headless.npmRecheckRefusal' : 'error.headless.npmRefusal', locale, { reason });
};
const npmOther = <const Recheck extends Fixed>(extra: Recheck, rechecking: boolean) =>
  classified(preflight, 'reason', { check: 'npm-payload-unverified', ...extra } as const, {
    'not-directory': npmMessage(npmReasons['not-directory'], rechecking, false),
    'not-regular-file': npmMessage(npmReasons['not-regular-file'], rechecking, false),
    'not-expected-link': npmMessage(npmReasons['not-expected-link'], rechecking, false),
    'untrusted-owner': npmMessage(npmReasons['untrusted-owner'], rechecking, false),
    'group-or-other-writable': npmMessage(npmReasons['group-or-other-writable'], rechecking, false),
    'set-id': npmMessage(npmReasons['set-id'], rechecking, false),
    'multiple-hard-links': npmMessage(npmReasons['multiple-hard-links'], rechecking, false),
    'no-hard-links': npmMessage(npmReasons['no-hard-links'], rechecking, false),
    'manifest-mismatch': npmMessage(npmReasons['manifest-mismatch'], rechecking, false),
    'manifest-invalid': npmMessage(npmReasons['manifest-invalid'], rechecking, false),
    'manifest-too-large': npmMessage(npmReasons['manifest-too-large'], rechecking, true),
    'manifest-unreadable': npmMessage(npmReasons['manifest-unreadable'], rechecking, true),
    'not-executable': npmMessage(npmReasons['not-executable'], rechecking, false),
    'changed-during-check': npmMessage(npmReasons['changed-during-check'], rechecking, true),
    'verification-unavailable': npmMessage(npmReasons['verification-unavailable'], rechecking, true),
  });
const nativeProof = {
  'native-platform-unverified': 'error.headless.npmProof.native-platform-unverified',
  'native-file-changed': 'error.headless.npmProof.native-file-changed',
  'native-format-unverified': 'error.headless.npmProof.native-format-unverified',
  'native-read-incomplete': 'error.headless.npmProof.native-read-incomplete',
  'native-proof-unavailable': 'error.headless.npmProof.native-proof-unavailable',
} as const;
const manifestProof = {
  'manifest-exclusion-changed': 'error.headless.npmProof.manifest-exclusion-changed',
  'manifest-declares-bin': 'error.headless.npmProof.manifest-declares-bin',
  'manifest-exclusion-unverified': 'error.headless.npmProof.manifest-exclusion-unverified',
  'manifest-target-missing': 'error.headless.npmProof.manifest-target-missing',
  'manifest-target-not-directory': 'error.headless.npmProof.manifest-target-not-directory',
  'manifest-target-not-regular': 'error.headless.npmProof.manifest-target-not-regular',
} as const;
const npmProof = <const Reason extends keyof typeof manifestProof>(reason: Reason) =>
  classified(preflight, 'native', { check: 'npm-layout-unknown', reason } as const, {
    'native-platform-unverified': proofMessage(reason, 'native-platform-unverified'),
    'native-file-changed': proofMessage(reason, 'native-file-changed'),
    'native-format-unverified': proofMessage(reason, 'native-format-unverified'),
    'native-read-incomplete': proofMessage(reason, 'native-read-incomplete'),
    'native-proof-unavailable': proofMessage(reason, 'native-proof-unavailable'),
  });
function proofMessage(manifest: keyof typeof manifestProof, native: keyof typeof nativeProof): Render {
  return (_, locale) => t('error.headless.npmProof.refused', { manifest: catalogText(manifestProof[manifest], locale), native: catalogText(nativeProof[native], locale) }, locale);
}

const selectionKind = {
  directory: 'error.headless.selectionKind.directory',
  'not-regular-file': 'error.headless.selectionKind.not-regular-file',
  'not-executable': 'error.headless.selectionKind.not-executable',
} as const;
const selected = (key: MessageKey): Render => (_, locale) =>
  t('error.headless.selectionRefused', { kind: catalogText(key, locale) }, locale);

const outcome = {
  completed: 'error.headless.loginOutcome.completed',
  cancelled: 'error.headless.loginOutcome.cancelled',
  failed: 'error.headless.loginOutcome.failed',
} as const;
const unsaved = (exit: keyof typeof outcome): Render => (_, locale) =>
  t('error.headless.loginOutcome.unsaved', { outcome: catalogText(outcome[exit], locale) }, locale);
const unsavedCases = <const Check extends 'login-record-write' | 'login-record-rename'>(check: Check) =>
  classified(preflight, 'exit', { check } as const, {
    completed: unsaved('completed'),
    cancelled: unsaved('cancelled'),
    failed: unsaved('failed'),
  });

const exitCode = { example: '9', accepts: (value: unknown) => typeof value === 'string' && /^(?:[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5])$/u.test(value) } as const;
const version = { example: '1.2.3', accepts: (value: unknown) => typeof value === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(value) } as const;
const minimum = { ...version, example: '2.0.0' } as const;
const bound = { example: 16, accepts: (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 } as const;

export const headlessDiagnosticCases = Object.freeze([
  diagnostic(workerResult, { reason: 'exit' }, (p, l) => t('agent.turn.failure.processExit', { code: p['exitCode']! }, l), { exitCode: bound }),
  ...classified(workerResult, 'reason', {}, {
    signal: 'agent.turn.failure.processSignal',
    quota: 'error.headless.workerQuota',
    'quota-status-unrecognized': 'headless.chat.quotaStatusUnrecognized',
    'invalid-output': 'error.TERMINAL_CHAT_REJECTED.invalidOutput',
    'model-mismatch': 'error.TERMINAL_CHAT_REJECTED.modelMismatch',
    'provider-error': 'error.TERMINAL_CHAT_REJECTED.providerError',
    guard: 'error.TERMINAL_CHAT_REJECTED.guard',
  }),
  diagnostic(unavailable, { check: 'path-search-empty' }, (p, l) => t('error.headless.pathSearchEmpty', p, l), { bound }),
  diagnostic(unavailable, { check: 'path-search-unverified' }, (p, l) => t('error.headless.pathSearchUnverified', p, l), { bound }),
  diagnostic(unavailable, { check: 'path-search-execute-unverified' }, (p, l) => t('error.headless.pathSearchExecuteUnverified', p, l), { bound }),
  diagnostic(unavailable, { check: 'path-search-not-file' }, (p, l) => t('error.headless.pathSearchNotFile', p, l), { bound }),
  diagnostic(unavailable, { check: 'path-search-execute-denied' }, (p, l) => t('error.headless.pathSearchExecuteDenied', p, l), { bound }),
  diagnostic(unavailable, { check: 'path-search-incomplete' }, (p, l) => t('error.headless.pathSearchIncomplete', p, l), { bound }),
  ...classified(unavailable, 'check', {}, {
    'recorded-path-unverified': 'error.headless.recordedPathUnverified',
    'recorded-path-missing': 'error.HEADLESS_CLI_UNAVAILABLE',
    'recorded-path-not-directory': 'error.headless.npmReason.not-directory',
    'recorded-path-directory': selectionKind.directory,
    'recorded-path-not-file': selectionKind['not-regular-file'],
    'recorded-path-not-executable': selectionKind['not-executable'],
    'login-launch-unverified': 'error.headless.loginLaunchUnverified',
  }),
  ...classified(preflight, 'check', {}, {
    signal: 'error.HEADLESS_PREFLIGHT_FAILED.signal',
    'relay-signal-diagnostic': 'error.headless.relaySignalDiagnostic',
    cancelled: 'error.HEADLESS_PREFLIGHT_FAILED.cancelled',
    'executable-changed': 'error.HEADLESS_PREFLIGHT_FAILED.executable-changed',
    'executable-bind-unverified': 'error.headless.executableBindUnverified',
    'executable-bind-target-mismatch': 'error.headless.executableBindTargetMismatch',
    'npm-package-directory-overlap': 'error.headless.npmPackageDirectoryOverlap',
    'npm-package-runtime-overlap': 'error.headless.npmPackageRuntimeOverlap',
    'realm-command-unverified': 'error.headless.realmCommandUnverified',
    'preflight-record-write': 'error.headless.preflightRecordWrite',
    'recorded-program-unverified': 'error.headless.recordedProgramUnverified',
    'recorded-program-mismatch': 'error.headless.recordedProgramMismatch',
    'recorded-owner-mismatch': 'error.headless.recordedOwnerMismatch',
    'preflight-record-unreadable': 'error.headless.preflightRecordUnreadable',
    'auth-status': 'error.HEADLESS_PREFLIGHT_FAILED.auth-status',
    'agent-owner-mismatch': 'error.headless.agentOwnerMismatch',
    'agent-program-changed': 'error.headless.agentProgramChanged',
    'agent-observation-identity-unverified': 'error.headless.agentObservationIdentityUnverified',
    'agent-program-path-mismatch': 'error.headless.agentProgramPathMismatch',
    'agent-path-outside-roots': 'error.headless.agentPathOutsideRoots',
    'agent-resolved-path-outside-roots': 'error.headless.agentResolvedPathOutsideRoots',
    'agent-readiness-verifier-unavailable': 'error.headless.agentReadinessVerifierUnavailable',
    'agent-readiness-query-unavailable': 'error.headless.agentReadinessQueryUnavailable',
    'agent-seal': 'error.headless.agentSealMismatch',
    'managed-login-dir': 'error.headless.managedLoginDir',
    'program-owner-unverified': 'error.headless.programOwnerUnverified',
    'probe-scratch-create': 'error.headless.probeScratchCreate',
    'probe-scratch-remove': 'error.headless.probeScratchRemove',
    'login-status-incomplete': 'error.headless.loginStatusIncomplete',
    'login-status-operation-unverified': 'error.headless.loginStatusOperationUnverified',
    'login-status-unreadable': 'error.headless.loginStatusUnreadable',
    'login-status-positive-nonzero': 'error.headless.loginStatusPositiveNonzero',
    'login-status-run-list': 'error.headless.loginStatusRunList',
    'login-status-run-remove': 'error.headless.loginStatusRunRemove',
    'realm-scratch-create': 'error.headless.realmScratchCreate',
    'realm-scratch-remove': 'error.headless.realmScratchRemove',
    'realm-config-directory-close': 'error.headless.realmConfigDirectoryClose',
    'realm-program-close': 'error.headless.realmProgramClose',
    'realm-gateway-close': 'error.headless.realmGatewayClose',
    'realm-bridge-close': 'error.headless.realmBridgeClose',
    'realm-process-request': 'error.headless.realmProcessRequest',
    'realm-process-response': 'error.headless.realmProcessResponse',
    'realm-process-unverified': 'error.headless.realmProcessUnverified',
    'agent-run-dispose': 'error.headless.agentRunDispose',
    'agent-run-remove': 'error.headless.agentRunRemove',
    'worker-preparation-release': 'error.headless.workerPreparationRelease',
    'lock-directory-create': 'error.headless.lockDirectoryCreate',
    'lock-directory-read': 'error.headless.lockDirectoryRead',
    'lock-directory-type': 'error.headless.lockDirectoryType',
    'lock-directory-private': 'error.headless.lockDirectoryPrivate',
    'lock-marker-read': 'error.headless.lockMarkerRead',
    'lock-marker-read-changed': 'error.headless.lockMarkerReadChanged',
    'lock-marker-write': 'error.headless.lockMarkerWrite',
    'lock-marker-parse': 'error.headless.lockMarkerParse',
    'lock-marker-remove': 'error.headless.lockMarkerRemove',
    'lock-guard-release': 'error.headless.lockGuardRelease',
  }),
  diagnostic(preflight, { check: 'executable-changed', reason: 'bind-race-diagnostic' }, 'error.headless.executableBindRaceDiagnostic'),
  diagnostic(preflight, { check: 'executable-changed', reason: 'legacy-unverified' }, 'error.headless.executableLegacyUnverified'),
  diagnostic(preflight, { check: 'npm-layout-unknown', reason: 'legacy-unverified' }, 'error.headless.npmLayoutLegacyUnverified'),
  diagnostic(preflight, { check: 'npm-payload-missing', reason: 'legacy-unverified' }, 'error.headless.npmPayloadLegacyUnverified'),
  diagnostic(preflight, { check: 'npm-payload-unverified', reason: 'legacy-unverified' }, 'error.headless.npmPayloadLegacyUnverified'),
  ...classified(preflight, 'reason', { check: 'environment' }, {
    probe: 'error.headless.environment.probe',
    'sign-in': 'error.headless.environment.sign-in',
  }),
  ...classified(preflight, 'reason', { check: 'selected-file' }, {
    unavailable: 'error.headless.selectionUnavailable',
    'relative-path': 'error.headless.absoluteProgram',
    missing: 'error.headless.npmReason.missing',
    'not-directory': 'error.headless.npmReason.not-directory',
    directory: selected(selectionKind.directory),
    'not-regular-file': selected(selectionKind['not-regular-file']),
    'not-executable': selected(selectionKind['not-executable']),
  }),
  ...classified(preflight, 'reason', { check: 'path-candidate-unverified' }, {
    unavailable: 'error.headless.pathCandidateUnverified',
    missing: 'error.headless.npmReason.missing',
    'not-directory': 'error.headless.npmReason.not-directory',
    ...selectionKind,
  }),
  ...classified(preflight, 'reason', { check: 'executable-recheck' }, {
    'legacy-unverified': 'error.headless.recheckLegacyUnverified',
    missing: recheck(npmReasons.missing),
    'not-directory': recheck(npmReasons['not-directory']),
    directory: recheck(selectionKind.directory),
    'not-regular-file': recheck(npmReasons['not-regular-file']),
    'not-executable': recheck(npmReasons['not-executable']),
    'verification-unavailable': recheck(npmReasons['verification-unavailable']),
  }),
  diagnostic(preflight, { check: 'npm-payload-missing', reason: 'missing' }, npmMessage(npmReasons.missing, false, false)),
  diagnostic(preflight, { check: 'npm-payload-missing', reason: 'missing', recheck: 1 }, npmMessage(npmReasons.missing, true, false)),
  ...npmOther({}, false),
  ...npmOther({ recheck: 1 }, true),
  diagnostic(preflight, { check: 'npm-layout-unknown' }, 'error.HEADLESS_PREFLIGHT_FAILED.npm-layout-unknown'),
  ...npmProof('manifest-exclusion-changed'),
  ...npmProof('manifest-declares-bin'),
  ...npmProof('manifest-exclusion-unverified'),
  ...npmProof('manifest-target-missing'),
  ...npmProof('manifest-target-not-directory'),
  ...npmProof('manifest-target-not-regular'),
  ...classified(preflight, 'reason', { check: 'login-status-incomplete' }, {
    timeout: 'error.headless.loginStatus.timeout',
    signal: 'error.headless.loginStatus.signal',
    cancelled: 'error.headless.loginStatus.cancelled',
    'start-failed': 'error.headless.loginStatus.start-failed',
    'output-limit': 'error.headless.loginStatus.output-limit',
    'line-limit': 'error.headless.loginStatus.line-limit',
    stopped: 'error.headless.loginStatus.stopped',
  }),
  ...classified(preflight, 'reason', { check: 'config-dir' }, {
    'legacy-unverified': 'error.headless.configLegacyUnverified',
    'relative-path': 'error.headless.config.relative-path',
    unresolved: 'error.headless.config.unresolved',
    missing: 'error.headless.config.missing',
    'not-directory': 'error.headless.config.not-directory',
    'untrusted-owner': 'error.headless.config.untrusted-owner',
    unverified: 'error.headless.config.unverified',
    unreported: 'error.headless.config.unreported',
    'reported-mismatch': 'error.headless.config.reported-mismatch',
    'entry-limit': 'error.headless.config.entry-limit',
    'copy-entry-rejected': 'error.headless.config.copy-entry-rejected',
    'copy-size-limit': 'error.headless.config.copy-size-limit',
    'mask-unverified': 'error.headless.config.mask-unverified',
    'private-entry-refused': 'error.headless.config.private-entry-refused',
    'lock-unverified': 'error.headless.config.lock-unverified',
  }),
  ...classified(preflight, 'reason', { check: 'state-dir' }, {
    'not-directory': 'error.headless.state.not-directory',
    unverified: 'error.headless.state.unverified',
    'not-private': 'error.HEADLESS_PREFLIGHT_FAILED.state-dir',
  }),
  ...classified(preflight, 'reason', { check: 'flags' }, {
    'help-unverified': 'error.headless.probe.help-unverified',
    'parser-unverified': 'error.headless.probe.parser-unverified',
    'legacy-unverified': 'error.headless.flagsLegacyUnverified',
  }),
  ...classified(preflight, 'reason', { check: 'spawn' }, {
    'legacy-unverified': 'error.headless.spawnLegacyUnverified',
    timeout: 'error.headless.probe.timeout',
    'start-failed': 'error.headless.probe.start-failed',
    'output-limit': 'error.headless.probe.output-limit',
    'line-limit': 'error.headless.probe.line-limit',
    stopped: 'error.headless.probe.stopped',
  }),
  diagnostic(preflight, { check: 'version', reason: 'exit' }, (p, l) => t('error.HEADLESS_PREFLIGHT_FAILED.version-exit', { exit: p['exitCode']! }, l), { exitCode }),
  diagnostic(preflight, { check: 'version', reason: 'too-old' }, (p, l) => t('error.HEADLESS_PREFLIGHT_FAILED.version-too-old', p, l), { version, minimum }),
  ...classified(preflight, 'reason', { check: 'version' }, {
    'exit-unrenderable': 'error.headless.versionExitUnrenderable',
    unreadable: 'error.HEADLESS_PREFLIGHT_FAILED.version-unreadable',
    'too-old-unrenderable': 'error.headless.versionTooOldUnrenderable',
    'legacy-unverified': 'error.headless.versionLegacyUnverified',
  }),
  ...unsavedCases('login-record-write'),
  ...unsavedCases('login-record-rename'),
  ...classified(isolation, 'check', {}, {
    'user-namespace': 'error.HEADLESS_ISOLATION_UNAVAILABLE.user-namespace',
    realm: 'error.HEADLESS_ISOLATION_UNAVAILABLE.realm',
    gateway: 'error.HEADLESS_ISOLATION_UNAVAILABLE.gateway',
  }),
  ...classified(isolation, 'reason', { check: 'launcher' }, {
    'legacy-unverified': 'error.headless.launcherLegacyUnverified',
    platform: 'error.headless.isolation.launcher-platform',
    unverified: 'error.headless.isolation.launcher-unverified',
    'identity-mismatch': 'error.headless.isolation.launcher-identity-mismatch',
  }),
  ...classified(isolation, 'reason', { check: 'limits' }, {
    'limiter-unverified': 'error.headless.isolation.limiter-unverified',
    'limiter-unrunnable': 'error.headless.isolation.limiter-unrunnable',
    'limit-application': 'error.headless.isolation.limit-application',
    'limit-verification': 'error.headless.isolation.limit-verification',
    'legacy-unverified': 'error.headless.limitsLegacyUnverified',
  }),
  ...classified(isolation, 'reason', { check: 'login-lock' }, {
    'legacy-unverified': 'error.headless.lockLegacyUnverified',
    'guard-path': 'error.headless.lockGuardPath',
    'native-unavailable': 'error.headless.lockNativeUnavailable',
    'guard-unsafe': 'error.headless.lockGuardUnsafe',
    'guard-acquire': 'error.headless.lockGuardAcquire',
  }),
  ...classified(loginBusy, 'holder', {}, {
    'legacy-family-unverified': 'error.headless.loginBusy.legacy-family',
    cli: 'error.HEADLESS_LOGIN_BUSY.cli',
    guard: 'error.headless.loginBusy.guard',
    'legacy-unverified': 'error.headless.loginBusy.legacy-unverified',
    'legacy-process': 'error.headless.loginBusy.legacy-process',
    'legacy-process-unverified': 'error.headless.loginBusy.legacy-process-unverified',
  }),
  ...classified(limit, 'limit', {}, {
    'legacy-unverified': 'error.headless.limitLegacyUnverified',
    'cpu-time': 'error.HEADLESS_LIMIT_REACHED.cpu-time',
    processes: 'error.HEADLESS_LIMIT_REACHED.processes',
    memory: 'error.HEADLESS_LIMIT_REACHED.memory',
  }),
  diagnostic(ownerMismatch, {}, 'error.HEADLESS_OWNER_MISMATCH'),
  ...classified(loginRequired, 'reason', {}, {
    'legacy-unverified': 'error.headless.loginRequired.legacy-unverified',
    'status-unconfirmed': 'error.headless.loginRequired.status-unconfirmed',
    'reported-signed-out': 'error.headless.loginRequired.reported-signed-out',
    'subscription-unconfirmed': 'error.headless.loginRequired.subscription-unconfirmed',
  }),
  ...classified(request, 'reason', {}, {
    definition: 'error.headless.request.definition',
    profile: 'error.headless.request.profile',
    token: 'error.headless.request.token',
    binding: 'error.headless.request.binding',
    request: 'error.headless.request.request',
    size: 'error.headless.request.size',
    effort: 'error.headless.request.effort',
    'agent-closed': 'error.headless.request.agent-closed',
    'agent-order': 'error.headless.request.agent-order',
    'model-alias': 'error.headless.request.model-alias',
    'turn-bound': 'error.headless.request.turn-bound',
    'forbidden-flag': 'error.headless.request.forbidden-flag',
    'agent-profile': 'error.headless.request.agent-profile',
    'program-definition': 'error.headless.programDefinition',
    'connect-definition': 'error.headless.connectDefinition',
    'prepared-definition': 'error.headless.preparedDefinition',
    'login-family': 'error.headless.loginFamily',
    'login-method': 'error.headless.loginMethod',
    sso: 'error.headless.loginSso',
    'gateway-provider': 'error.headless.gatewayProvider',
  }),
] as const);

type DiagnosticRow = typeof headlessDiagnosticCases[number];
type ExtraParams<Extra> = Extra extends ExtraFields ? {
  readonly [Key in keyof Extra]: Extra[Key]['example'] extends string ? string : number;
} : Record<never, never>;
type CaseParams<Row> = Row extends DiagnosticRow ? Row['fields'] & ExtraParams<Row['extras']> : never;
type ParamsFor<Code extends HeadlessDiagnosticCode> = CaseParams<Extract<DiagnosticRow, { code: Code }>>;
export type HeadlessDiagnosticCode = DiagnosticRow['code'];
export type HeadlessDiagnosticArgs = {
  [Code in HeadlessDiagnosticCode]: keyof ParamsFor<Code> extends never
    ? readonly [code: Code]
    : readonly [code: Code, params: ParamsFor<Code>];
}[HeadlessDiagnosticCode];
export type HeadlessPreflightParams = ParamsFor<typeof preflight>;

export function isHeadlessDiagnosticCode(code: string): code is HeadlessDiagnosticCode {
  return diagnosticCodes.has(code);
}

const diagnosticCodes: ReadonlySet<string> = new Set(headlessDiagnosticCases.map(row => row.code));

function caseFor(code: string, params: Params): Diagnostic | undefined {
  const known = Object.keys(params).filter(key => key !== 'floor' && key !== 'major' && key !== 'connectPhase');
  return (headlessDiagnosticCases as readonly Diagnostic[]).find(row => row.code === code
    && known.length === Object.keys(row.fields).length + Object.keys(row.extras ?? {}).length
    && Object.entries(row.fields).every(([key, value]) => params[key] === value)
    && Object.entries(row.extras ?? {}).every(([key, field]) => field.accepts(params[key]))
    && (row.fields['reason'] !== 'too-old' || belowMinimum(String(params['version']), String(params['minimum']))));
}

function belowMinimum(reported: string, minimum: string): boolean {
  const actual = reported.split('.').map(Number), required = minimum.split('.').map(Number);
  const firstDifference = actual.findIndex((part, index) => part !== required[index]);
  return firstDifference !== -1 && actual[firstDifference]! < required[firstDifference]!;
}

/** Normalize an old or external error without trusting any extra data. */
function verifiedHeadlessParams(code: string, params: Params): Params | null {
  const row = caseFor(code, params);
  if (!row) return null;
  return { ...row.fields, ...Object.fromEntries(Object.keys(row.extras ?? {}).map(key => [key, params[key]!])) };
}

/** The persisted form contains only the closed case, without renderer or local path metadata. */
export function readHeadlessDiagnosticCase(input: unknown): { code: HeadlessDiagnosticCode; params: Params } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
    || !Object.hasOwn(input, 'code') || !Object.hasOwn(input, 'params')) return null;
  const { code, params } = input as { code: unknown; params: unknown };
  if (typeof code !== 'string' || !isHeadlessDiagnosticCode(code) || !params || typeof params !== 'object' || Array.isArray(params)) return null;
  const verified = verifiedHeadlessParams(code, params as Params);
  return verified && Object.keys(verified).length === Object.keys(params).length ? { code, params: verified } : null;
}

/** A v1 refusal only kept the check. A matching case is usable only if there is no other interpretation. */
export function readLegacyHeadlessDiagnosticCase(code: unknown, check: unknown) {
  if (typeof code !== 'string' || typeof check !== 'string') return null;
  const candidates = (headlessDiagnosticCases as readonly Diagnostic[]).filter(row => row.code === code && row.fields['check'] === check);
  return candidates.length === 1 ? readHeadlessDiagnosticCase({ code, params: { check } }) : null;
}

export function localizeHeadlessDiagnostic(code: HeadlessDiagnosticCode, params: Params, locale: Locale): string {
  const row = caseFor(code, params);
  return row ? row.render(params, locale) : t('error.headless.diagnosticUnverified', {}, locale);
}

// Worker waiting and Run parking already carry an opaque failure identifier.
export type HeadlessDiagnosticIdentifier = `HEADLESS_${string}__${string}`;
function identifier(row: Diagnostic): HeadlessDiagnosticIdentifier {
  const fields = Object.keys(row.fields).sort().map(key => `${key}_${row.fields[key]}`.replaceAll('-', '_').toUpperCase());
  return `${row.code as HeadlessDiagnosticCode}__${fields.join('__')}`;
}
export function headlessDiagnosticIdentifier(code: string, params: Params): HeadlessDiagnosticIdentifier | undefined {
  const row = caseFor(code, params);
  if (!row) return undefined;
  const base = identifier(row);
  // The existing failure identifier may include only values checked by the closed case.
  return row.extras ? `${base}__${Object.keys(row.extras).sort().map(key => params[key]).join('__')}` : base;
}
function identifierCase(value: string) {
  if (!value.startsWith('HEADLESS_') || !value.includes('__')) return undefined;
  for (const row of headlessDiagnosticCases as readonly Diagnostic[]) {
    const base = identifier(row);
    if (!row.extras) {
      if (base === value) return { row, params: row.fields };
      continue;
    }
    if (!value.startsWith(base + '__')) continue;
    const keys = Object.keys(row.extras).sort(), passed = value.slice(base.length + 2).split('__', keys.length + 1);
    if (passed.length !== keys.length) break;
    const extra = Object.fromEntries(keys.map((key, index) => {
      const raw = passed[index]!;
      return [key, typeof row.extras![key]!.example === 'number' && String(Number(raw)) === raw ? Number(raw) : raw];
    }));
    const params = readHeadlessDiagnosticCase({ code: row.code, params: { ...row.fields, ...extra } })?.params;
    if (params) return { row, params };
    break;
  }
  return undefined;
}

export function isHeadlessDiagnosticIdentifier(value: string): boolean {
  return identifierCase(value) !== undefined;
}

export function readHeadlessDiagnosticIdentifier(value: string, locale: Locale): string | undefined {
  if (!value.startsWith('HEADLESS_') || !value.includes('__')) return undefined;
  const parsed = identifierCase(value);
  return parsed ? parsed.row.render(parsed.params, locale) : t('error.headless.diagnosticUnverified', {}, locale);
}
