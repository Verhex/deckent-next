import { t, resolveLocale, currencyAmountText, type Locale, type Params } from '#platform/core/i18n/index.js';
import { NODE_ENGINE_FLOOR_TEXT, NODE_ENGINE_RANGE, displayAddress } from '#platform/core/common/index.js';
import { DeckentError } from './error.js';
import { errorTable, plainErrors, type AuthorizationRefusal, type ErrorDefinition, type ErrorDefinitions, type ErrorEntry } from './definition.js';
import { mergeErrorDefinitions } from './merge.js';
import { ERROR_DEFINITION_FRAGMENTS } from './defs/index.js';
export type { ErrorEntry } from './definition.js';
const workerKindIssues = (p: Params, l: Locale) => (['image-missing', 'image-unverified'] as const).flatMap(reason => {
  const kinds = p[reason === 'image-missing' ? 'missingKinds' : 'unverifiedKinds'] || Object.entries(p).filter(([key]) => key.startsWith(`${reason}.`)).map(([, value]) => value).join(', ');
  return kinds ? [reason === 'image-missing' ? t('worker.kinds.image-missing', { kinds }, l) : t('worker.kinds.image-unverified', { kinds }, l)] : [];
}).join(' ');
function invocationInputSubject(p: Params, l: Locale): string {
  switch (p['subject']) {
    case 'cli.input.subject.queue': return t('cli.input.subject.queue', {}, l);
    case 'cli.input.subject.memory': return t('cli.input.subject.memory', {}, l);
    case 'cli.input.subject.approval': return t('cli.input.subject.approval', {}, l);
    case 'cli.input.subject.operation': return t('cli.input.subject.operation', {}, l);
    case 'cli.input.subject.decision': return t('cli.input.subject.decision', {}, l);
    case 'cli.input.subject.spending': return t('cli.input.subject.spending', {}, l);
    case 'cli.input.subject.identity': return t('cli.input.subject.identity', {}, l);
    case 'cli.input.subject.agent': return t('cli.input.subject.agent', {}, l);
    case 'cli.input.subject.hub': return t('cli.input.subject.hub', {}, l);
    default: return t('cli.input.subject.model', {}, l);
  }
}
function discoveryCause(p: Params, l: Locale): string {
  switch (p['cause']) {
    case 'no-credential': return t('models.connect.cause.no-credential', { status: p['status'] ?? '-' }, l);
    case 'credential-rejected': return t('models.connect.cause.credential-rejected', { status: p['status'] ?? '-' }, l);
    case 'access-denied': return t('models.connect.cause.access-denied', { status: p['status'] ?? '-' }, l);
    case 'rate-limit': return t('models.connect.cause.rate-limit', { status: p['status'] ?? '-' }, l);
    case 'spend-limit': return t('models.connect.cause.spend-limit', { status: p['status'] ?? '-' }, l);
    case 'limit-reached': return t('models.connect.cause.limit-reached', { status: p['status'] ?? '-' }, l);
    case 'http-status': return t('models.connect.cause.http-status', { status: p['status'] ?? '-' }, l);
    case 'redirect': return t('models.connect.cause.redirect', { status: p['status'] ?? '-' }, l);
    case 'network': return t('models.connect.cause.network', { status: p['status'] ?? '-' }, l);
    case 'timeout': return t('models.connect.cause.timeout', { status: p['status'] ?? '-' }, l);
    case 'invalid-list': return t('models.connect.cause.invalid-list', { status: p['status'] ?? '-' }, l);
    case 'not-listable': return t('models.connect.cause.not-listable', { status: p['status'] ?? '-' }, l);
    default: return t('models.connect.cause.unexpected', {}, l);
  }
}
/** alpha.56.1: a network or timeout failure names the address it tried (credential-free by construction); a loopback one adds the port hint. */
function discoveryUnavailable(p: Params, l: Locale): string {
  const address = (p['cause'] === 'network' || p['cause'] === 'timeout' ? displayAddress(p['address']) : undefined) ?? '';
  let local = false;
  // The provider locality invariant's literal loopback hosts (`isLiteralLoopbackHostname`; importing it here would close a unit cycle).
  try { local = address !== '' && ['127.0.0.1', '[::1]'].includes(new URL(address).hostname); } catch { /* not an address: no hint */ }
  // BeUser alpha.56.1 (Ayşe): a local server that did not answer is not "the network"; the plain steps come first, then the container/VM hint.
  if (local) return p['cause'] === 'timeout' ? t('models.connect.localSlow', { address }, l) : t('models.connect.localSilent', { address }, l);
  const cause = address ? t('models.connect.cause.tried', { cause: discoveryCause(p, l), address }, l) : discoveryCause(p, l);
  return t('error.MODEL_CONNECT_DISCOVERY_UNAVAILABLE', { ...p, cause }, l);
}
/** BeUser alpha.56.1 (Mert): the refusal names which thing failed (the runtime socket directory, the socket, the ledger lock file) and, for the
 * directory whose only fault is its mode, the next step (the service start re-creates its own empty directory). Never a path. */
function runtimeEndpointUnsafe(p: Params, l: Locale): string {
  const reason = typeof p['reason'] === 'string' && /^[a-z]+(?:-[a-z]+)*$/u.test(p['reason']) ? p['reason'] : null;
  if (reason === 'parent-mode') return t('error.LOCAL_RUNTIME_ENDPOINT_UNSAFE.parentMode', {}, l);
  if (reason === 'parent-mode-kept') return t('error.LOCAL_RUNTIME_ENDPOINT_UNSAFE.parentModeKept', {}, l);
  if (!reason) return t('error.LOCAL_RUNTIME_ENDPOINT_UNSAFE', p, l);
  const thing = reason.startsWith('parent-') ? t('runtime.socket.thing.directory', {}, l) : reason === 'ledger-lock' ? t('runtime.socket.thing.lock', {}, l) : t('runtime.socket.thing.socket', {}, l);
  return t('error.LOCAL_RUNTIME_ENDPOINT_UNSAFE.reason', { ...p, thing }, l);
}
/** MCP_SANDBOX_COMMAND_UNREACHABLE (MCP-SANDBOX-PATHS): one catalog sentence per diagnosis kind (params name, kind, role, path, target
 * ('' = none), runner); `{targetSuffix}` is ' -> <target>' when the link target differs, the role is its own localized label. */
function installationFileUnsafe(p: Params, l: Locale): string {
  const reasons = { type: t('installation.fileUnsafe.type', {}, l), owner: t('installation.fileUnsafe.owner', {}, l), mode: t('installation.fileUnsafe.mode', {}, l),
    links: t('installation.fileUnsafe.links', {}, l), size: t('installation.fileUnsafe.size', {}, l) };
  const reason = String(p['reason']);
  return p['path'] && Object.hasOwn(reasons, reason) ? t('installation.fileUnsafeDetail', { ...p, reason: reasons[reason as keyof typeof reasons] }, l) : t('error.INSTALLATION_FILE_UNSAFE', p, l);
}
/** BeUser KER-06: an input file that could not be read adds its path, the bounded cause (missing | denied | link | unreadable) and the next step. */
function inputUnavailable(base: string, p: Params, l: Locale): string {
  switch (p['reason']) {
    case 'missing': return `${base} ${t('cli.input.unavailable.missing', p, l)}`;
    case 'denied': return `${base} ${t('cli.input.unavailable.denied', p, l)}`;
    case 'link': return `${base} ${t('cli.input.unavailable.link', p, l)}`;
    case 'unreadable': return `${base} ${t('cli.input.unavailable.unreadable', p, l)}`;
    default: return base;
  }
}
/** PATCH_LIMIT names the exceeded bound (params detail, observed, limit, field); an unknown or absent detail keeps the generic sentence. */
function patchLimit(p: Params, l: Locale): string {
  switch (p['detail']) {
    case 'bytes': return t('error.PATCH_LIMIT.bytes', p, l);
    case 'entries': return t('error.PATCH_LIMIT.entries', p, l);
    case 'depth': return t('error.PATCH_LIMIT.depth', p, l);
    case 'path': return t('error.PATCH_LIMIT.path', p, l);
    case 'time': return t('error.PATCH_LIMIT.time', p, l);
    case 'git-timeout': return t('error.PATCH_LIMIT.gitTimeout', p, l);
    case 'git-output': return t('error.PATCH_LIMIT.gitOutput', p, l);
    default: return t('error.PATCH_LIMIT', p, l);
  }
}
/** WORKER_INSTRUCTIONS_UNAVAILABLE (alpha.53 F1) names why there is nothing to trust or revoke; an unknown reason keeps the generic sentence. */
function workerInstructionsUnavailable(p: Params, l: Locale): string {
  switch (p['reason']) {
    case 'target': return t('error.WORKER_INSTRUCTIONS_UNAVAILABLE.target', p, l);
    case 'no-execution': return t('error.WORKER_INSTRUCTIONS_UNAVAILABLE.noExecution', p, l);
    case 'source-none': return t('error.WORKER_INSTRUCTIONS_UNAVAILABLE.sourceNone', p, l);
    case 'absent': return t('error.WORKER_INSTRUCTIONS_UNAVAILABLE.absent', p, l);
    case 'store': return t('error.WORKER_INSTRUCTIONS_UNAVAILABLE.store', p, l);
    case 'size': return t('error.WORKER_INSTRUCTIONS_UNAVAILABLE.size', p, l);
    case 'unsafe': return t('error.WORKER_INSTRUCTIONS_UNAVAILABLE.unsafe', p, l);
    default: return t('error.WORKER_INSTRUCTIONS_UNAVAILABLE', p, l);
  }
}
/** BETA-RAKIP-3: the next safe step after an uncertain or blocked operation. A surface that knows the command (`deckent operation`) passes
 * scope, command, kind and id and gets the exact inspect command; any other producer keeps the generic sentence. */
function effectNextStep(kind: 'unknown' | 'busy', p: Params, l: Locale): string {
  const named = typeof p['scope'] === 'string' && typeof p['command'] === 'string' && typeof p['kind'] === 'string' && typeof p['id'] === 'string';
  if (kind === 'unknown') return named ? t('remedy.EFFECT_OUTCOME_UNKNOWN.command', p, l) : t('remedy.EFFECT_OUTCOME_UNKNOWN', p, l);
  return named ? t('remedy.EFFECT_TARGET_BUSY.command', p, l) : t('remedy.EFFECT_TARGET_BUSY', p, l);
}
/** TASK_GRAPH_LIMIT (PARALLEL-S3) names the exceeded admission bound; an unknown detail keeps the generic sentence. */
function taskGraphLimit(p: Params, l: Locale): string {
  switch (p['detail']) {
    case 'tasks': return t('error.TASK_GRAPH_LIMIT.tasks', p, l);
    case 'edges': return t('error.TASK_GRAPH_LIMIT.edges', p, l);
    case 'depth': return t('error.TASK_GRAPH_LIMIT.depth', p, l);
    default: return t('error.TASK_GRAPH_LIMIT', p, l);
  }
}
/** TASK_GRAPH_INVALID (params reason = structural TaskGraphError code, path): cycle and missing dependency get their own sentence. */
function taskGraphInvalid(p: Params, l: Locale): string {
  switch (p['reason']) {
    case 'TASK_GRAPH_CYCLE': return t('error.TASK_GRAPH_INVALID.cycle', p, l);
    case 'TASK_DEPENDENCY_MISSING': return t('error.TASK_GRAPH_INVALID.dependencyMissing', p, l);
    default: return t('error.TASK_GRAPH_INVALID', { ...p, path: p['path'] ?? 'graph', reason: p['reason'] ?? 'invalid' }, l);
  }
}
function mcpSandboxUnreachable(p: Params, l: Locale): string {
  const name = String(p['name'] ?? '');
  if (p['kind'] === 'path-hidden') {
    const role = p['role'] === 'command' ? t('error.MCP_SANDBOX_COMMAND_UNREACHABLE.role.command', {}, l) : t('error.MCP_SANDBOX_COMMAND_UNREACHABLE.role.argument', {}, l);
    return t('error.MCP_SANDBOX_COMMAND_UNREACHABLE.pathHidden', { name, role, path: String(p['path'] ?? ''), targetSuffix: p['target'] ? ` -> ${String(p['target'])}` : '' }, l);
  }
  if (p['kind'] === 'package-runner') return t('error.MCP_SANDBOX_COMMAND_UNREACHABLE.packageRunner', { name, runner: String(p['runner'] ?? '') }, l);
  return t('error.MCP_SANDBOX_COMMAND_UNREACHABLE.containerDaemon', { name, runner: String(p['runner'] ?? '') }, l);
}
/** E1: the bounded kinds of a failed Docker image-probe step (the adapter's DockerImageProbeCause), each with its own words. */
const DOCKER_IMAGE_PROBE_CAUSES: Readonly<Record<string, (l: Locale) => string>> = { deadline: l => t('docker.imageProbe.cause.deadline', {}, l),
  exit: l => t('docker.imageProbe.cause.exit', {}, l), signal: l => t('docker.imageProbe.cause.signal', {}, l), parse: l => t('docker.imageProbe.cause.parse', {}, l) };
const dockerImageProbeCause = (cause: unknown) => typeof cause === 'string' && Object.hasOwn(DOCKER_IMAGE_PROBE_CAUSES, cause) ? DOCKER_IMAGE_PROBE_CAUSES[cause]! : null;
/** alpha.56 U5-S1: the delegation refusal's next step, chosen by the caller from display facts (the bound already decided). */
const DELEGATION_HINTS: Readonly<Record<string, (p: Params, l: Locale) => string>> = { owner: (p, l) => t('policy.hint.owner', p, l), other: (p, l) => t('policy.hint.other', p, l),
  unnamed: (p, l) => t('policy.hint.unnamed', p, l), deny: (p, l) => t('policy.hint.deny', p, l), approval: (p, l) => t('policy.hint.approval', p, l) };
/** FIX8b: each custody refusal names its own next step; an open folder is named with its mode only on the person's own terminal path. */
function siwcCustodyMessage(p: Params, l: Locale): string {
  const reason = p['reason'];
  if (reason === 'unsafe-root') return typeof p['path'] !== 'string' ? t('siwc.custody.unsafeRoot', p, l) : p['folder'] === 'parent' ? t('siwc.custody.privateParent', p, l) : t('siwc.custody.privateFolder', p, l);
  if (reason === 'unknown-locality' || reason === 'remote-store') return t('siwc.custody.localDisk', p, l);
  if (reason === 'shared-store' || reason === 'foreign-os-owner') return t('siwc.custody.personalRequired', p, l);
  return reason === 'profile-unresolved' ? t('siwc.custody.profileRequired', p, l) : reason === 'cleanup-pending' ? t('siwc.custody.cleanupPending', p, l)
    : reason === 'non-person-owner' ? t('siwc.custody.nonPersonOwner', p, l) : t('error.SIWC_STORE_NOT_PERSONAL', p, l);
}
const coreDefinitions: ErrorDefinitions = errorTable('core', {
  SIWC_ACCOUNT_STILL_CONNECTED: { category: 'error', render: (p, l) => ({ message: t('siwc.account.signOutFirst', p, l) }) },
  SIWC_USAGE_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('siwc.usageUnavailable', p, l) }) },
  SIWC_SERVICE_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('siwc.serviceUnavailable', p, l) }) },
  SIWC_WORKER_ISOLATION_UNAVAILABLE: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: t('error.SIWC_WORKER_ISOLATION_UNAVAILABLE', p, l) }) },
  SIWC_APP_SERVER_AUTH_UNAVAILABLE: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: p['reason'] === 'activation-hold' ? t('siwc.worker.activationHold', p, l) : t('error.SIWC_APP_SERVER_AUTH_UNAVAILABLE', p, l) }) },
}, plainErrors('error.', { SIWC_RELAY_REFUSED: 'error', SIWC_APP_SERVER_EFFECT_UNKNOWN: 'error', SIWC_WORKER_CLEANUP_UNPROVEN: 'error' }), {
  HEADLESS_PLAN_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('siwc.notEligible', p, l) }) },
}, plainErrors('error.', { SUBSCRIPTION_RAW_USE_REFUSED: 'error', SECRET_SESSION_RESERVED: 'error' }), {
  SIWC_STORE_NOT_PERSONAL: { category: 'error', render: (p, l) => ({ message: siwcCustodyMessage(p, l) }) },
}, plainErrors('error.', {
  SECRET_STORE_PROTECTION_REQUIRED: 'error', OAUTH_CONNECTION_INTERACTIVE_REQUIRED: 'error', OAUTH_CONNECTION_PLATFORM_UNSUPPORTED: 'error',
  OAUTH_CONNECTION_INVALID: 'error', OAUTH_CONNECTION_DENIED: 'error', OAUTH_CONNECTION_UNAVAILABLE: 'error', OAUTH_CONNECTION_CANCELLED: 'error',
  OAUTH_CONNECTION_TIMEOUT: 'error', OAUTH_CONNECTION_IDENTITY_INVALID: 'error', OAUTH_CONNECTION_STORE_REQUIRED: 'error', OAUTH_CONNECTION_CHANGED: 'error',
  OAUTH_CONNECTION_REAUTHORIZE: 'error', BACKUP_STATE_CHANGED: 'config', BACKUP_TARGET_IDENTITY_MISMATCH: 'config', BACKUP_RESTORE_INCOMPLETE: 'config',
  BACKUP_RESTORE_HOLD: 'config', BACKUP_COVERAGE_INCOMPLETE: 'config', BACKUP_INPUT_INVALID: 'usage', BACKUP_POLICY_DENIED: 'config', BACKUP_PASSPHRASE_INVALID: 'config',
  BACKUP_PATH_UNSAFE: 'config', BACKUP_POLICY_UNREADABLE: 'config', BACKUP_TARGET_CONFIG_CONFLICT: 'config', BACKUP_DIRECTORY_UNSAFE: 'config', BACKUP_LIMIT: 'config',
  BACKUP_KEY_INVALID: 'config', BACKUP_SET_INVALID: 'config', BACKUP_MANIFEST_INVALID: 'config', BACKUP_FINGERPRINT_INVALID: 'config', BACKUP_LEDGER_INVALID: 'config',
  BACKUP_STATE_MISSING: 'config', BACKUP_SET_EXISTS: 'config', BACKUP_TIMEOUT: 'config', BACKUP_TARGET_NOT_EMPTY: 'config', BACKUP_SERVICE_RUNNING: 'config',
  BACKUP_CUSTODY_UNAVAILABLE: 'config', BACKUP_IO: 'config', BACKUP_AUDIT_UNAVAILABLE: 'config', BACKUP_SCHEDULE_IDENTITY_REQUIRED: 'config',
  BACKUP_SCHEDULE_SECRET_REQUIRED: 'config',
}), {
  // U7 (İ-6): the walk-up from a subfolder found an installation above it that it may not adopt (params path/root; reason picks the sentence).
  INSTALLATION_ROOT_UNSAFE: { category: 'config', render: (p, l) => ({ message: p['reason'] === 'mode' ? t('error.INSTALLATION_ROOT_UNSAFE.mode', p, l) : t('error.INSTALLATION_ROOT_UNSAFE', p, l) }) },
}, plainErrors('error.', { INSTALLATION_ROOT_FOREIGN: 'config', INSTALLATION_ROOT_INSIDE_DATA_ROOT: 'config', INSTALLATION_ROOT_WALK_UNSUPPORTED: 'config' }), {
  INSTALLATION_ROOT_TRACKED: { category: 'config', render: (p, l) => ({ message: p['reason'] === 'unknown' ? t('error.INSTALLATION_ROOT_TRACKED.unknown', p, l) : t('error.INSTALLATION_ROOT_TRACKED', p, l) }) },
  PROJECT_ATTACHMENT_DENIED: { category: 'config', render: (p, l) => ({ message: p['reason'] === 'location-write' ? t('error.PROJECT_ATTACHMENT_DENIED.location-write', p, l) : p['reason'] === 'location' ? t('error.PROJECT_ATTACHMENT_DENIED.location', p, l) : t('error.PROJECT_ATTACHMENT_DENIED', p, l) }) },
}, plainErrors('error.', {
  INSTALLATION_IDENTITY_RELOCATED: 'config', INSTALLATION_IDENTITY_RESOLUTION_INVALID: 'config', INSTALLATION_IDENTITY_INVALID: 'config',
  PROJECT_ATTACHMENT_INVALID: 'config', PROJECT_ATTACHMENT_SOURCE_REGISTERED: 'config', PROJECT_ATTACHMENT_READ_LIMIT: 'config', PROJECT_ATTACHMENT_UNAVAILABLE: 'config',
  PROJECT_ATTACHMENT_CHANGED: 'config', PROJECT_ATTACHMENT_PERSON_MISMATCH: 'config', MODEL_USE_NOT_ACTIVE: 'config',
  MODEL_USE_BINDING_CHANGED: 'config', PROJECT_ATTACHMENT_REVOKED: 'config', PROJECT_ATTACHMENT_INCOMPLETE: 'config', PROJECT_ATTACHMENT_LIFECYCLE_BLOCKED: 'config',
  INSTALLATION_IDENTITY_UNAVAILABLE: 'config', INSTALLATION_IDENTITY_MASKED: 'config', INSTALLATION_IDENTITY_LOCKED: 'config',
  INSTALLATION_IDENTITY_UNSUPPORTED: 'config', INSTALLATION_IDENTITY_SOURCE_INVALID: 'config', INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED: 'config', INSTALLATION_IDENTITY_NEWER_BINDING: 'config',
  IDENTITY_PROFILE_INVALID: 'usage', IDENTITY_PROFILE_NAMESPACE_UNKNOWN: 'usage', IDENTITY_PROFILE_VERSION_UNKNOWN: 'usage', IDENTITY_PROFILE_UNKNOWN: 'usage',
  IDENTITY_PROFILE_SHADOW: 'usage', IDENTITY_PROFILE_DIGEST_MISMATCH: 'usage', IDENTITY_PREVIEW_INVALID: 'usage', IDENTITY_PREVIEW_SCOPE_DENIED: 'usage',
  IDENTITY_PREVIEW_CONFLICT: 'usage', IDENTITY_PREVIEW_LIMIT: 'usage',
}), {
  IDENTITY_PREVIEW_UNAVAILABLE: { category: 'usage', render: (p, l) => ({ message: inputUnavailable(t('error.IDENTITY_PREVIEW_UNAVAILABLE', p, l), p, l) }) },
}, plainErrors('error.', {
  PROJECT_IDENTITY_INVALID: 'config', PROJECT_IDENTITY_UNAVAILABLE: 'config', PROJECT_IDENTITY_MASKED: 'config', PROJECT_IDENTITY_INCOMPLETE: 'config',
  PROJECT_IDENTITY_LOCKED: 'config',

  CONFIG_SECRET_SECTION_REFUSED: 'config', CONFIG_LAYER_INVALID: 'config', CONFIG_DIGEST_INVALID: 'config', CONFIG_ARRAY_INDEX_INVALID: 'config',
  CONFIG_KEY_NOT_OBJECT: 'config', CONFIG_METADATA_MISSING: 'config', APPROVAL_INVALID: 'error',
}), {
  APPROVAL_DENIED: { category: 'error', refusal: 'approval-denied', render: (p, l) => ({ message: t('error.APPROVAL_DENIED', p, l) }) },
}, plainErrors('error.', {
  APPROVAL_MISSING: 'error', APPROVAL_CONFLICT: 'error', APPROVAL_EXPIRED: 'error', APPROVAL_INTEGRITY: 'error', APPROVAL_STALE: 'error', APPROVAL_REQUIRED: 'error',
  APPROVAL_UNSETTLED: 'error', SESSION_REQUIRED: 'error', SESSION_EXPIRED: 'error', SESSION_INACTIVE: 'error', INTEGRITY_KEY_UNAVAILABLE: 'error',
  PREFIX_CACHE_SALT_UNAVAILABLE: 'error',
}), {
  CLI_INVOCATION_INPUT_LIMIT: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_INVOCATION_INPUT_LIMIT', { ...p, subject: invocationInputSubject(p, l) }, l) }) },
  CLI_INVOCATION_INPUT_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_INVOCATION_INPUT_INVALID', { ...p, subject: invocationInputSubject(p, l) }, l) }) },
  CLI_INVOCATION_INPUT_TTY: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_INVOCATION_INPUT_TTY', { ...p, subject: invocationInputSubject(p, l) }, l) }) },
  CLI_INVOCATION_INPUT_UNAVAILABLE: { category: 'usage', render: (p, l) => ({ message: inputUnavailable(t('error.CLI_INVOCATION_INPUT_UNAVAILABLE', { ...p, subject: invocationInputSubject(p, l) }, l), p, l) }) },
}, plainErrors('error.', { CLI_CATALOG_INPUT_LIMIT: 'usage', CLI_CATALOG_INPUT_INVALID: 'usage', CLI_CATALOG_INPUT_TTY: 'usage' }), {
  CLI_CATALOG_INPUT_UNAVAILABLE: { category: 'usage', render: (p, l) => ({ message: inputUnavailable(t('error.CLI_CATALOG_INPUT_UNAVAILABLE', p, l), p, l) }) },
}, plainErrors('error.', { RUNTIME_CHAT_EVENT_TOO_LARGE: 'error', TERMINAL_CHAT_NOT_CONFIGURED: 'usage' }), {
  MODEL_CONNECT_DISCOVERY_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: discoveryUnavailable(p, l) }) },
}, plainErrors('error.', {
  MODEL_CONNECT_DISCOVERY_INVALID: 'usage', MODEL_CONNECT_DISCOVERY_LIMIT: 'usage', MODEL_CONNECT_PRICE_REQUIRED: 'usage', MODEL_CONNECT_NO_AVAILABLE: 'usage',
  MODEL_CONNECT_WORKER_IMAGE_REQUIRED: 'usage', MODEL_CONNECT_INVALID: 'usage', MODEL_CONNECT_NOT_CONNECTABLE: 'usage', MODEL_CONNECT_ENDPOINT_FIXED: 'usage',
  MODEL_CONNECT_ENDPOINT_INVALID: 'usage',
}), {
  // KER-07: the requested model and connection are named; the models the server listed are shown, or that it listed none.
  MODEL_CONNECT_MODEL_UNKNOWN: { category: 'usage', render: (p, l) => ({ message: typeof p['model'] !== 'string' ? t('error.MODEL_CONNECT_MODEL_UNKNOWN', p, l)
    : p['models'] ? t('error.MODEL_CONNECT_MODEL_UNKNOWN.listed', p, l) : t('error.MODEL_CONNECT_MODEL_UNKNOWN.none', p, l) }) },
}, plainErrors('error.', {
  MODEL_CONNECT_DECLARATION_CONFLICT: 'error', MODEL_CONNECT_KEY_NAME_UNAVAILABLE: 'usage', MODEL_CONNECT_SEED_UNAVAILABLE: 'error',
  MODEL_CONNECT_TARIFF_UNKNOWN: 'error', MODEL_CONNECT_TARIFF_UNVERIFIED: 'error', MODEL_CONNECT_KEY_INSECURE: 'usage', MODEL_CONNECT_DEFINITION_INVALID: 'error',
  TERMINAL_DEFAULT_MODEL_PROJECT_LAYER: 'config', TERMINAL_CHAT_MODEL_NOT_DECLARED: 'error', TERMINAL_CHAT_TRUNCATED: 'error', TERMINAL_CHAT_EMPTY: 'error',
  TERMINAL_CHAT_CANCELLED: 'error', TERMINAL_CHAT_UNAVAILABLE: 'error', AGENT_TURN_IN_PROGRESS: 'error', AGENT_TURN_CONFLICT: 'error', AGENT_TURN_CORRUPT: 'error',
  AGENT_TURN_INVALID: 'usage', AGENT_TURN_REASONING_UNSUPPORTED: 'usage', AGENT_TURN_UNAVAILABLE: 'error', TERMINAL_TTY_REQUIRED: 'usage',
  INFERENCE_METRICS_UNREAD: 'error',
}), {
  INFERENCE_NOT_CONFIGURED: { category: 'error', render: (_p, l) => ({ message: t('inference.notConfigured', {}, l) }) },
}, plainErrors('error.', {
  INFERENCE_PROFILE_UNKNOWN: 'usage', DECISION_INVALID: 'error', DECISION_UNAVAILABLE: 'error', DECISION_COMMAND_CONFLICT: 'error', DECISION_CORRUPT: 'error',
  DECISION_RECORD_REQUIRED: 'error', DECISION_OUTCOME_UNKNOWN: 'error', DECISION_ADVICE_INVALID: 'error', DECISION_POLICY_INVALID: 'error',
  DECISION_CASE_INVALID: 'error', DECISION_EVIDENCE_FUTURE: 'error', DECISION_EVIDENCE_REFERENCE_INVALID: 'error', DECISION_LIMIT_EXCEEDED: 'error',
  DECISION_RECORD_INVALID: 'error', MODEL_INVOCATION_INVALID: 'error', MODEL_INVOCATION_BINDING_CONFLICT: 'error',
}), {
  CONFIG_MODEL_PROFILE_REBIND_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('error.CONFIG_MODEL_PROFILE_REBIND_REQUIRED', p, l), suggestion: t('remedy.CONFIG_MODEL_PROFILE_REBIND_REQUIRED', p, l) }) },
  MODEL_INVOCATION_PROFILE_CONFLICT: { category: 'error', render: (p, l) => ({ message: t('error.MODEL_INVOCATION_PROFILE_CONFLICT', p, l), suggestion: t('remedy.MODEL_INVOCATION_PROFILE_CONFLICT', p, l) }) },
}, plainErrors('error.', {
  MODEL_INVOCATION_COMMAND_CONFLICT: 'error', MODEL_INVOCATION_CORRUPT: 'error', MODEL_INVOCATION_UNAVAILABLE: 'error', MODEL_INVOCATION_OUTCOME_UNKNOWN: 'error',
  MODEL_INVOCATION_REASONING_UNSUPPORTED: 'error', MODEL_INVOCATION_ACTIVATION_CONFLICT: 'error',
}), {
  MODEL_NOT_ACTIVATED: { category: 'error', render: (p, l) => ({ message: t('error.MODEL_NOT_ACTIVATED', { ...p,
    command: t('tui.model.command.activate', p, l) }, l) }) },
}, plainErrors('error.', {
  TERMINAL_MODEL_SWITCH_REFUSED: 'error', MODEL_INVOCATION_ALLOCATION_CONFLICT: 'error', MODEL_INVOCATION_RESULT_LIMIT: 'error',
  MODEL_INVOCATION_DELIVERY_UNAVAILABLE: 'error', PROVIDER_SPEND_INVALID: 'error', PROVIDER_SPEND_RESULT_LIMIT: 'error', PROVIDER_SPEND_UNAVAILABLE: 'error',
  OPENROUTER_PRIVACY_UNAVAILABLE: 'error', PROVIDER_SPEND_CONFLICT: 'error',
}), {
  PROVIDER_SPEND_EXHAUSTED: { category: 'error', render: (p, l) => ({ message: p['settled'] !== undefined && p['held'] !== undefined
    ? t('error.PROVIDER_SPEND_EXHAUSTED.totals', p, l) : t('error.PROVIDER_SPEND_EXHAUSTED', p, l) }) },
}, plainErrors('error.', {
  PROVIDER_SPEND_BUDGET_EXISTS: 'error', PROVIDER_SPEND_BUDGET_ABSENT: 'usage', PROVIDER_SPEND_TARIFF_UNVERIFIED: 'error', PROVIDER_SPEND_FROZEN: 'error',
  MODEL_INVOCATION_QUOTA_EXHAUSTED: 'error', MODEL_INVOCATION_CAPACITY_EXHAUSTED: 'error', OPENAI_CHAT_DEFINITION_INVALID: 'error', OPENAI_CHAT_REQUEST_INVALID: 'error',
  OPENAI_CHAT_REQUEST_TOO_LARGE: 'error', OPENAI_CHAT_RESPONSE_TOO_LARGE: 'error', OPENAI_CHAT_TIMEOUT: 'error', OPENAI_CHAT_CANCELLED: 'error',
  OPENAI_CHAT_TRANSPORT_UNKNOWN: 'error', OPENAI_CHAT_MODEL_MISMATCH: 'error', OPENAI_CHAT_CACHE_SALT_UNAVAILABLE: 'error', MODEL_ACTIVATION_INVALID: 'error',
  MODEL_ACTIVATION_REVISION_CONFLICT: 'error', MODEL_ACTIVATION_NOT_FOUND: 'error', MODEL_ACTIVATION_NOT_ACTIVE: 'error', MODEL_ACTIVATION_BINDING_CONFLICT: 'error',
  MODEL_ACTIVATION_COMMAND_CONFLICT: 'error', MODEL_ACTIVATION_CORRUPT: 'error', MODEL_ACTIVATION_UNAVAILABLE: 'error', MODEL_ACTIVATION_OUTCOME_UNKNOWN: 'error',
  MODEL_ACTIVATION_CATALOG_CONFLICT: 'error',
}), {
  MODEL_ACTIVATION_DELIVERY_UNFIT: { category: 'error', render: (p, l) => ({ message: t('error.MODEL_ACTIVATION_DELIVERY_UNFIT', { ...p,
    setting: p['surface'] === 'mcp' ? t('doctor.modelInvocationDelivery.config.mcp', {}, l) : t('doctor.modelInvocationDelivery.config.runtime-service', {}, l) }, l) }) },
}, plainErrors('error.', {
  WORKER_MODEL_UNPINNED: 'error', WORKER_MODEL_ALIAS_REFUSED: 'error', WORKER_CHANNEL_NOT_ACTIVE: 'error', WORKER_CHANNEL_MISMATCH: 'error',
  WORKER_MODEL_UNKNOWN: 'error', WORKER_MODEL_RETIRED: 'error', WORKER_MODEL_NOT_CURRENT: 'error', WORKER_MODEL_NOT_ACTIVE: 'error', WORKER_MODEL_CLI_TOO_OLD: 'error',
  MODEL_CATALOG_INVALID: 'error', MODEL_CATALOG_REVISION_CONFLICT: 'error', MODEL_CATALOG_NOT_FOUND: 'error', MODEL_CATALOG_NOT_ACTIVE: 'error',
  MODEL_CATALOG_COMMAND_CONFLICT: 'error', MODEL_CATALOG_CORRUPT: 'error', MODEL_CATALOG_UNAVAILABLE: 'error', MODEL_CATALOG_READ_ONLY: 'error',
  MODEL_CATALOG_OUTCOME_UNKNOWN: 'error', WORKER_MODEL_BINDING_MISMATCH: 'error', MODEL_CATALOG_ALIAS_CONFLICT: 'error',
}), {
  MODEL_CATALOG_MODEL_RETIRED: { category: 'error', render: (p, l) => ({ message: [t('error.MODEL_CATALOG_MODEL_RETIRED', p, l), ...(p['successor'] ? [t('error.MODEL_CATALOG_MODEL_RETIRED.successor', p, l)] : [])].join(' ') }) },
}, plainErrors('error.', {
  WORK_INPUT_REQUIRED: 'error', WORK_INPUT_TEMPLATE_REQUIRED: 'error', WORK_INPUT_TURN_LIMIT_UNSUPPORTED: 'error', WORK_INPUT_TURN_LIMIT_EXCEEDS_TEMPLATE: 'error',
  WORKER_INSTRUCTIONS_TOO_LARGE: 'error',
}), {
  WORKER_INSTRUCTIONS_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: workerInstructionsUnavailable(p, l) }) },
  WORKER_INSTRUCTIONS_CHANGED: { category: 'error', render: (p, l) => ({ message: p['reason'] === 'place' ? t('error.WORKER_INSTRUCTIONS_CHANGED.place', p, l) : t('error.WORKER_INSTRUCTIONS_CHANGED', p, l) }) },
}, plainErrors('error.', {
  WORK_CLASS_NOT_REGISTERED: 'error', WORK_CLASS_OVERRIDE_DENIED: 'error', WORK_CLASS_PARENT_INVALID: 'error', WORK_CLASS_REGISTRY_LIMIT: 'error',
  WORK_CLASS_REVISION_INVALID: 'error', WORKER_EFFORT_UNSUPPORTED: 'error', TASK_DECISION_APPROVAL_REQUIRED: 'error', AI_AUTHORITY_NON_DELEGABLE: 'error',
  TASK_DECISION_HUMAN_REQUIRED: 'error', RUN_HOLD_PERSON_REQUIRED: 'error', RUN_QUOTA_PERSON_REQUIRED: 'error', RUN_QUOTA_WAIT_LIMIT: 'error',
  NERVOUS_RULES_UNREADABLE: 'error', NERVOUS_SIGNAL_INVALID: 'error', NERVOUS_ACTION_REFUSED: 'error', RUN_PARKED: 'error', RUN_TERMINAL: 'error',
  RUN_NOT_PARKED: 'error', RUN_DECISION_NOT_READY: 'error', RUN_DECISION_EXPIRED: 'error', TASK_EVALUATION_INVALID: 'error', TASK_EVALUATION_STALE: 'error',
  TASK_EVALUATION_NOT_READY: 'error', TASK_EVALUATION_CRITERIA: 'error', TASK_EVIDENCE_INVALID: 'error', TASK_EVIDENCE_UNAVAILABLE: 'error',
  TASK_EVIDENCE_UNLINKED: 'error', EVALUATION_EVIDENCE_INVALID: 'error', EVALUATION_EVIDENCE_INCOMPLETE: 'error', EVALUATION_EVIDENCE_SCOPE: 'error',
  EVALUATION_EVIDENCE_LIMIT: 'error', EVALUATION_EVIDENCE_CORRUPT: 'error', EVALUATION_EVIDENCE_UNAVAILABLE: 'error',
}), {
  EXECUTION_NOT_CONFIGURED: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: t('error.EXECUTION_NOT_CONFIGURED', p, l) }) },
  EXECUTION_HOST_UNSUPPORTED: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: t('error.EXECUTION_HOST_UNSUPPORTED', p, l) }) },
}, plainErrors('error.', {
  CANCELLATION_DELIVERY_CONFLICT: 'error', RECONCILIATION_NOT_CONFIGURED: 'error', RECONCILIATION_RECOVERY_INVALID: 'error', RECONCILIATION_RUNTIME_LOOP_OPTIONS: 'error',
  RECONCILIATION_RUNTIME_LOOP_RUNNING: 'error', CANCELLATION_RUNTIME_LOOP_OPTIONS: 'error', CANCELLATION_RUNTIME_LOOP_RUNNING: 'error',
  LOCAL_RUNTIME_UNSUPPORTED: 'error', LOCAL_RUNTIME_NATIVE_UNAVAILABLE: 'error', LOCAL_RUNTIME_SOCKET_PATH_TOO_LONG: 'config', DOCTOR_CONFIG_INCOMPLETE: 'config',
  DOCTOR_LEDGER_UNAVAILABLE: 'config',
}), {
  DOCTOR_SOCKET_HEALABLE: { category: 'config', render: (_p, l) => ({ message: t('error.LOCAL_RUNTIME_ENDPOINT_UNSAFE.parentMode', {}, l) }) },
}, plainErrors('error.', {
  DOCTOR_SOCKET_UNAVAILABLE: 'config', DOCTOR_POLICY_UNREADABLE: 'config', DOCTOR_BUBBLEWRAP_NOT_STAGED: 'config', INSTALLATION_NOT_STARTABLE: 'config',
  LOCAL_RUNTIME_OPTIONS: 'error', RUNTIME_SHUTDOWN_UNAVAILABLE: 'error',
}), {
  RUNTIME_SERVICE_EXTERNALLY_MANAGED: { category: 'error', render: (p, l) => ({ message: p['action'] === 'stop' ? t('error.RUNTIME_SERVICE_EXTERNALLY_MANAGED.stop', p, l)
    : p['action'] === 'stop-via-manager' ? t('error.RUNTIME_SERVICE_EXTERNALLY_MANAGED.stopViaManager', p, l) : t('error.RUNTIME_SERVICE_EXTERNALLY_MANAGED', p, l) }) },
}, plainErrors('error.', { RUNTIME_AUTOSTART_FAILED: 'error', TERMINAL_SCOPE_REQUIRED: 'usage', LOCAL_RUNTIME_UNAVAILABLE: 'error' }), {
  LOCAL_RUNTIME_ENDPOINT_UNSAFE: { category: 'error', render: (p, l) => ({ message: runtimeEndpointUnsafe(p, l) }) },
}, plainErrors('error.', {
  LOCAL_RUNTIME_ALREADY_RUNNING: 'error', LOCAL_RUNTIME_TRANSPORT: 'error', RUNTIME_SERVICE_TRANSPORT: 'error', RUNTIME_CHAT_TURN_TOO_LARGE: 'error',
  RUNTIME_SERVICE_CORRELATION: 'error', RUNTIME_SERVICE_RESPONSE_LIMIT: 'error', RUNTIME_SERVICE_DELIVERY_INVALID: 'error', RUNTIME_SERVICE_OPTIONS: 'error',
  RUNTIME_SERVICE_BUSY: 'error', RUNTIME_SERVICE_STOPPING: 'error', RUNTIME_SERVICE_RECOVERY_FAILED: 'error', RUNTIME_SERVICE_NOT_STOPPING: 'error',
  SERVICE_SHUTDOWN_INVALID: 'error', SERVICE_SHUTDOWN_CONFLICT: 'error', SERVICE_SHUTDOWN_INSTANCE: 'error', SERVICE_SHUTDOWN_AUDIT_UNAVAILABLE: 'error',
  SERVICE_SHUTDOWN_CORRUPT: 'error', SERVICE_SHUTDOWN_NOT_ADMITTED: 'error', SERVICE_SHUTDOWN_OUTCOME_CONFLICT: 'error', RUNTIME_SERVICE_SHUTDOWN_INCOMPLETE: 'error',
  // H34 S3 Q1 (owner 2026-09-27 evening decision 6): `runtime serve` refuses to start while one of its own scopes is already pinned
  // to another company (config/ledger mismatch; same 'config' category, exit 78, as CONFIG_VERSION_UNSUPPORTED/LAYOUT_VERSION_UNSUPPORTED
  // and the INSTALLATION_PROFILE_* siblings above — the operator's remedy is their own company.id or ledger, not a transport retry).
  RUN_PROGRESSION_SCOPE_SKIPPED: 'config', RUNTIME_SERVICE_SCOPE_FOREIGN: 'config', RUN_WORKSPACE_CUSTODY_CONFLICT: 'error', RUN_WORKSPACE_CUSTODY_CORRUPT: 'error',
  WORKSPACE_CUSTODY_UNCONVERTIBLE: 'error', WORKSPACE_REQUEST_INVALID: 'error', WORKSPACE_OPTIONS_INVALID: 'error', WORKSPACE_UNSAFE: 'error',
  WORKSPACE_RUN_BASE_REMOVED: 'error', WORKSPACE_IDENTITY_CONFLICT: 'error', WORKSPACE_ALLOCATION_INCOMPLETE: 'error', WORKSPACE_GIT_FAILED: 'error',
  CANCELLATION_DELIVERY_CORRUPT: 'error',
}), {
  CANCELLATION_NOT_CONFIGURED: { category: 'error', render: (p, l) => ({
    message: t('error.CANCELLATION_NOT_CONFIGURED', { ...p, missing: p['missing'] ?? t('output.unknown', {}, l) }, l),
    suggestion: t('error.CANCELLATION_NOT_CONFIGURED.init', {}, l),
  }) },
  EXECUTION_PROFILE_INVALID: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: t('error.EXECUTION_PROFILE_INVALID', p, l) }) },
}, plainErrors('error.', { EXECUTION_RESOURCE_CEILING: 'config' }), {
  TASK_GRAPH_LIMIT: { category: 'config', render: (p, l) => ({ message: taskGraphLimit(p, l) }) },
  TASK_GRAPH_INVALID: { category: 'usage', render: (p, l) => ({ message: taskGraphInvalid(p, l) }) },
}, plainErrors('error.', { PATCH_CORRUPT: 'error', QUEUE_CONFLICT: 'error', QUEUE_CAPACITY: 'error', QUEUE_TARGET_BUSY: 'error', QUEUE_CORRUPT: 'error' }), {
  // BeUser DR2-06: a target-branch refusal names the rule and the next step; other uses keep the human-session message.
  QUEUE_AUTHORITY_REQUIRED: { category: 'error', render: (p, l) => p['reason'] ? { message: t('error.QUEUE_TARGET_BRANCH', p, l), suggestion: p['reason'] === 'protected' ? t('remedy.QUEUE_TARGET_BRANCH.protected', p, l)
    : p['reason'] === 'checked-out' ? t('remedy.QUEUE_TARGET_BRANCH.checkedOut', p, l) : p['reason'] === 'not-base' ? t('remedy.QUEUE_TARGET_BRANCH.notBase', p, l)
    : p['reason'] === 'not-allowed' ? t('remedy.QUEUE_TARGET_BRANCH.notAllowed', p, l) : t('remedy.QUEUE_TARGET_BRANCH.invalid', p, l) } : { message: t('error.QUEUE_AUTHORITY_REQUIRED', p, l) } },
}, plainErrors('error.', {
  QUEUE_WORK_TARGET_REQUIRED: 'error', QUEUE_RECOVERY_REQUIRED: 'error', QUEUE_CONFIRMATION_REQUIRED: 'error', QUEUE_EXPIRED: 'error',
  QUEUE_VERIFICATION_NOT_ADMITTED: 'error', QUEUE_PREPARATION_REFUSED: 'error',
  // OTONOM-TESLIM shadow (alpha.53): the advice record of a ticket could not be written; diagnosis only, the queue is unaffected.
  AUTONOMY_SHADOW_NOT_RECORDED: 'error',
  // D1a (owner 2026-10-18): typed reasons of the service's bounded delivery re-attempt (queue view `reattempt.reason`, ticket `reason`).
  DELIVERY_INTENT_MISSING: 'error', DELIVERY_REATTEMPT_EXHAUSTED: 'error', DELIVERY_REATTEMPT_NOT_ELIGIBLE: 'error', DELIVERY_REATTEMPT_EFFECTS: 'error',
  DELIVERY_REATTEMPT_FAILED: 'error', WORKER_INACTIVITY_STOPPED: 'error', TASK_STALL_RETRY_EXHAUSTED: 'error', WORKER_INACTIVITY_POLICY_INVALID: 'error',
  // D2b (owner 2026-10-18): a Run's delivery intent is admitted only from a verified human with an approved card; the service re-queue is bounded.
  DELIVERY_INTENT_NOT_ADMITTED: 'error', QUEUE_REQUEUE_EXHAUSTED: 'error', CANDIDATE_MISMATCH: 'error', CANDIDATE_NOT_ACCEPTED: 'error',
  DELIVERY_INTERACTIVE_REQUIRED: 'error', DELIVERY_CONFIRMATION_DECLINED: 'error', PATCH_INTEGRATION_PENDING: 'error', PATCH_CONFLICT: 'error',
  PATCH_BASE_ADVANCED: 'error',
  // K6 (owner 2026-09-30 A): the work target enforces task scope; params count, paths (first 16, repository-relative), omitted.
  PATCH_SCOPE_VIOLATION: 'error', PATCH_WORKING_TREE_BUSY: 'error', PATCH_WORKING_TREE_PARTIAL: 'error',
}), {
  // F1 (Astra 3015): a file moved aside could not return to its name (the person's newer file is there); `kept` names it, `written` may be empty.
  PATCH_WORKING_TREE_KEPT: { category: 'error', render: (p, l) => ({ message: p['written'] ? t('error.PATCH_WORKING_TREE_KEPT.partial', p, l) : t('error.PATCH_WORKING_TREE_KEPT', p, l) }) },
}, plainErrors('error.', {
  // R3017/R3019: a journal, lock record or recovery custody that is unreadable or of another version (`path`): an explicit refusal, nothing settled or written.
  PATCH_WORKING_TREE_RECORD_UNSUPPORTED: 'error',
}), {
  PATCH_WORKING_TREE_UNSUPPORTED: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: t('error.PATCH_WORKING_TREE_UNSUPPORTED', p, l) }) },
  PATCH_WORKING_TREE_SUBFOLDER: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: t('error.PATCH_WORKING_TREE_SUBFOLDER', p, l) }) },
  PATCH_WORKING_TREE_FILTER: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: t('error.PATCH_WORKING_TREE_FILTER', p, l) }) },
}, plainErrors('error.', {
  // A6-1 (owner 2026-11-08, K-1): params count, paths (first 16), omitted — a patch writing a filtered path kept at HEAD; found, required — the Git floor.
  PATCH_WORKING_TREE_FILTERED: 'error',
}), {
  PATCH_WORKING_TREE_GIT_VERSION: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: t('error.PATCH_WORKING_TREE_GIT_VERSION', p, l) }) },
}, plainErrors('error.', { PATCH_WORKING_TREE_NOT_WRITTEN: 'error', PATCH_WORKING_TREE_CHANGED: 'error' }), {
  // Params limit (bytes), maxEntries; without them (a later view of the recorded refusal) the summary stands.
  PATCH_WORKING_TREE_LISTING_LIMIT: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: p['limit'] === undefined ? t('error.PATCH_WORKING_TREE_LISTING_LIMIT.summary', p, l) : t('error.PATCH_WORKING_TREE_LISTING_LIMIT', p, l) }) },
  PATCH_WORKING_TREE_COPY_LIMIT: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: t('error.PATCH_WORKING_TREE_COPY_LIMIT', p, l) }) },
  DELIVERY_WORKING_TREE_DENIED: { category: 'error', refusal: 'delivery', render: (p, l) => ({ message: t('error.DELIVERY_WORKING_TREE_DENIED', p, l) }) },
  DELIVERY_WORKING_TREE_APPROVAL_UNSUPPORTED: { category: 'error', refusal: 'delivery', render: (p, l) => ({ message: t('error.DELIVERY_WORKING_TREE_APPROVAL_UNSUPPORTED', p, l) }) },
}, plainErrors('error.', { PATCH_SCOPE_UNDECLARED: 'error', PATCH_INSTRUCTION_SURFACE_WRITE: 'error' }), {
  // S6 (owner 2026-10-14): the pre-dispatch secret gate; params count, paths (first 16 as `path (rule)`), omitted — never a value. Without
  // params (a later view of the recorded code) the summary sentence stands. INCOMPLETE names the exhausted bound (limit, observed, bound).
  WORKER_TREE_SECRET_REFUSED: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: p['paths'] === undefined ? t('error.WORKER_TREE_SECRET_REFUSED.summary', p, l) : t('error.WORKER_TREE_SECRET_REFUSED', p, l),
    suggestion: t('remedy.WORKER_TREE_SECRET_REFUSED', p, l) }) },
  WORKER_TREE_SCAN_INCOMPLETE: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: p['limit'] === undefined ? t('error.WORKER_TREE_SCAN_INCOMPLETE.summary', p, l) : t('error.WORKER_TREE_SCAN_INCOMPLETE', p, l),
    suggestion: t('remedy.WORKER_TREE_SCAN_INCOMPLETE', p, l) }) },
  // PRE-7 ORTAM-HAZIR: Deckent's own preflight found a declared environment requirement unmet; params requirement, kind, target, registered
  // (yes|no). Without params (a later view of the recorded refusal) the summary stands. An installation defect, never a task failure.
  EXECUTION_ENVIRONMENT_NOT_READY: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: p['kind'] === undefined ? t('error.EXECUTION_ENVIRONMENT_NOT_READY.summary', p, l)
    : p['registered'] === 'no' ? t('error.EXECUTION_ENVIRONMENT_NOT_READY.unregistered', p, l) : t('error.EXECUTION_ENVIRONMENT_NOT_READY', p, l), suggestion: t('remedy.EXECUTION_ENVIRONMENT_NOT_READY', p, l) }) },
  // REVISE 2691: the preflight could not prove its probe container gone; params requirement, kind, probe. Nothing launched; never met or unmet.
  EXECUTION_ENVIRONMENT_UNCERTAIN: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: p['probe'] === undefined ? t('error.EXECUTION_ENVIRONMENT_UNCERTAIN.summary', p, l)
    : t('error.EXECUTION_ENVIRONMENT_UNCERTAIN', p, l), suggestion: t('remedy.EXECUTION_ENVIRONMENT_UNCERTAIN', p, l) }) },
  // E1: the probe for a requirement was stopped by its own deadline before it answered (container proven gone); params requirement, kind.
  // The Run is held (progression park with this code) for an explicit re-run; never an installation defect, never retried on its own.
  EXECUTION_ENVIRONMENT_TIMED_OUT: { category: 'error', launch: 'held', render: (p, l) => ({ message: p['requirement'] === undefined ? t('error.EXECUTION_ENVIRONMENT_TIMED_OUT.summary', p, l)
    : t('error.EXECUTION_ENVIRONMENT_TIMED_OUT', p, l), suggestion: t('remedy.EXECUTION_ENVIRONMENT_TIMED_OUT', p, l) }) },
  // R2 (D3a 2026-10-18): a load-dependent `time` bound (limit timeoutMs or admissionTimeoutMs), retried on a later turn; params refusals, maxTimeRefusals.
  WORKER_TREE_SCAN_DEFERRED: { category: 'error', render: (p, l) => ({ message: p['limit'] === undefined ? t('error.WORKER_TREE_SCAN_DEFERRED.summary', p, l) : t('error.WORKER_TREE_SCAN_DEFERRED', p, l),
    suggestion: t('remedy.WORKER_TREE_SCAN_DEFERRED', p, l) }) },
}, plainErrors('error.', { WORK_TARGET_PATH_INVALID: 'config', WORK_TARGET_UNSAFE: 'config', WORK_TARGET_IN_DATA_ROOT: 'config', WORK_TARGET_IS_PROJECT: 'config' }), {
  // BeUser DR2-05: the work was made in another repository than the current work source; one rule sentence shared with the /config warning.
  WORK_TARGET_CHANGED: { category: 'config', render: (p, l) => ({ message: `${p['made'] ? t('error.WORK_TARGET_CHANGED', p, l) : t('error.WORK_TARGET_CHANGED.unknown', p, l)} ${t('workTarget.onlyWhereMade', {}, l)}`,
    suggestion: p['made'] ? t('remedy.WORK_TARGET_CHANGED', p, l) : t('remedy.WORK_TARGET_CHANGED.unknown', p, l) }) },
}, plainErrors('error.', {
  // BeUser D-03: a work target on an installation without coding execution would be written beside no execution settings; set coding up first.
  WORK_TARGET_EXECUTION_MISSING: 'config', WORK_TARGET_NOT_WORKTREE: 'config', WORK_TARGET_SHARES_PROJECT_REPOSITORY: 'config', WORK_TARGET_ALTERNATES: 'config',
  WORK_TARGET_BASE_MISSING: 'config', EFFECT_INVALID: 'usage', EFFECT_OPERATION_UNKNOWN: 'config', EFFECT_APPROVAL_REQUIRED: 'error',
  EFFECT_PRECONDITION_CHANGED: 'error',
}), {
  EFFECT_TARGET_BUSY: { category: 'error', render: (p, l) => ({ message: t('error.EFFECT_TARGET_BUSY', p, l), suggestion: effectNextStep('busy', p, l) }) },
}, plainErrors('error.', { EFFECT_CONFLICT: 'error' }), {
  EFFECT_OUTCOME_UNKNOWN: { category: 'error', render: (p, l) => ({ message: t('error.EFFECT_OUTCOME_UNKNOWN', p, l), suggestion: effectNextStep('unknown', p, l) }) },
}, plainErrors('error.', {
  EFFECT_NOT_COMPENSABLE: 'error', EFFECT_REJECTED: 'error', EFFECT_TARGET_CHANGED: 'error',
  // POLICY-ADMIN I5-i: a generic producer refused an authority operation before any policy, ledger or target access.
  OPERATION_SURFACE_RESTRICTED: 'error',
  // POLICY-HARDEN K3: only the authority surface may allow an approval of an authority operation; a deny stays open everywhere.
  APPROVAL_SURFACE_RESTRICTED: 'error',
  // B1 APPROVAL-ASSURANCE: MCP never allows; an allow below the approval's minimum assurance (Core's, raised by policy) is refused.
  APPROVAL_ATTENDED_REQUIRED: 'error', APPROVAL_INTERACTIVE_REQUIRED: 'error', APPROVAL_ASSURANCE_INSUFFICIENT: 'error',
  // MCP-CLIENT scoped registry and approval (`deckent mcp add|add-json|list|get|remove|approve`).
  MCP_SERVER_UNKNOWN: 'usage', MCP_SERVER_EXISTS: 'usage', MCP_SERVER_SCOPE_AMBIGUOUS: 'usage', MCP_SERVER_ENTRY_INVALID: 'config', MCP_SERVER_NAME_INVALID: 'usage',
  MCP_SANDBOX_UNAVAILABLE: 'error', MCP_SERVER_START_FAILED: 'error',
}), {
  // MCP-SANDBOX-PATHS (2026-09-29): the default realm's bubblewrap view cannot reach what the server needs (params: name, kind, and role/path/target
  // or runner); the sentence is chosen by the diagnosis kind.
  MCP_SANDBOX_COMMAND_UNREACHABLE: { category: 'error', render: (p, l) => ({ message: mcpSandboxUnreachable(p, l) }) },
}, plainErrors('error.', {
  MCP_TOOL_UNKNOWN: 'usage', MCP_TOOL_SUMMARY_UNAVAILABLE: 'usage',
  // The Deckent MCP server's own refusals (Ek A: an MCP error carries its localized message).
  MCP_BUSY: 'error', MCP_INPUT_INVALID: 'usage', MCP_RESPONSE_LIMIT: 'error', MCP_TOOL_FAILED: 'error', MCP_REGISTRY_FILE_INVALID: 'config',
  MCP_SERVER_NOT_TRUSTED: 'usage', MCP_TRUST_STORE_UNAVAILABLE: 'error', EFFECT_TARGET_UNAVAILABLE: 'error', EFFECT_CORRUPT: 'error', ADOPTION_TARGET_DENIED: 'config',
  ADOPTION_TARGET_MISSING: 'error', ADOPTION_TARGET_CHECKED_OUT: 'error',
}), {
  ADOPTION_BASE_CHANGED: { category: 'error', render: (p, l) => ({ message: t('error.ADOPTION_BASE_CHANGED', p, l), suggestion: t('remedy.ADOPTION_BASE_CHANGED', p, l) }) }, // BeUser DR2-08: the real next steps
}, plainErrors('error.', {
  ADOPTION_NOT_DELIVERED: 'error', ADOPTION_NOT_ACCEPTED: 'error', ADOPTION_TARGET_BUSY: 'error', ADOPTION_SUPERSEDED: 'error', ADOPTION_TARGET_MOVED: 'error',
  ADOPTION_CONFLICT: 'error', ADOPTION_CORRUPT: 'error', ADOPTION_VERIFICATION_FAILED: 'error', ADOPTION_VERIFICATION_PENDING: 'error',
  ADOPTION_VERIFICATION_UNSETTLED: 'error', ADOPTION_VERIFICATION_CANCELLED: 'error', ADOPTION_VERIFICATION_MISMATCH: 'error', ADOPTION_NOT_VERIFIED: 'error',
  ADOPTION_VERIFICATION_CRITERIA_WEAKER: 'error', ADOPTION_FENCE_MISMATCH: 'error', ADOPTION_RELEASED: 'error', ADOPTION_NOT_APPLIED: 'error',
  ADOPTION_REPOSITORY_CHANGED: 'error', ADOPTION_VERIFICATION_NOT_CONFIGURED: 'config', PATCH_UNSUPPORTED: 'error',
}), {
  PATCH_LIMIT: { category: 'error', render: (p, l) => ({ message: patchLimit(p, l) }) },
}, plainErrors('error.', {
  PATCH_UNSAFE: 'error', WORKER_OBSERVATION_INVALID: 'error', WORKER_OBSERVATION_UNAVAILABLE: 'error', WORKER_EVENTS_SEAL_FAILED: 'error', PATCH_UNAVAILABLE: 'error',
  NATIVE_CREDENTIAL_UNAVAILABLE: 'error', NATIVE_CONNECTION_UNAVAILABLE: 'error', TASK_EVALUATOR_INVALID: 'error', TASK_KIND_NOT_REGISTERED: 'error',
  TASK_EVALUATOR_NOT_REGISTERED: 'error', EXECUTION_REGISTRY_VALIDATOR_INVALID: 'error', BRAIN_INPUT_INVALID: 'error', BRAIN_TEMPLATE_UNAVAILABLE: 'error',
  BRAIN_OUTPUT_INVALID: 'error', BRAIN_OUTPUT_TRUNCATED: 'error', BRAIN_CONTEXT_TOO_LARGE: 'error',
}), {
  // BeUser D-02: an unregistered task kind names the kinds used and the registered ones, with the person's next step.
  BRAIN_GRAPH_INVALID: { category: 'error', render: (p, l) => ({ message: workerKindIssues(p, l)
    ? t('error.BRAIN_GRAPH_INVALID.unusableKind', { ...p, detail: workerKindIssues(p, l) }, l)
    : p['rule'] === 'TASK_KIND_NOT_REGISTERED' && typeof p['kinds'] === 'string' ? t('error.BRAIN_GRAPH_INVALID.kind', p, l) : t('error.BRAIN_GRAPH_INVALID', p, l) }) },
}, plainErrors('error.', {
  BRAIN_PROVIDER_REJECTED: 'error', BRAIN_OUTCOME_UNKNOWN: 'error', BRAIN_CANCELLED: 'error', RUN_ADMISSION_NOT_CONFIGURED: 'error', RUN_STORE_CORRUPT: 'error',
  RUN_PROPOSAL_BUDGET_SCOPE: 'error', RUN_PROPOSAL_BUDGET_CURRENCY: 'error', RUN_PROPOSAL_VERSION: 'error', RUN_PROPOSAL_GRAPH_INVALID: 'error',
  RUN_PROPOSAL_INVALID: 'error', RUN_PROPOSAL_WORK_CLASS_REQUIRED: 'error', RUN_PROPOSAL_PERMISSION_UNKNOWN: 'error', RUN_PROPOSAL_BUDGET_MISSING: 'error',
}), {
  RUN_PROPOSAL_BUDGET_EXCEEDED: { category: 'error', render: (p, l) => {
    const money = (key: string) => typeof p[key] === 'number' && typeof p['currency'] === 'string' ? currencyAmountText(p[key], p['currency'], l) : null, remaining = money('remaining'), ceiling = money('ceiling');
    return { message: remaining === null ? t('error.RUN_PROPOSAL_BUDGET_EXCEEDED', p, l) : ceiling === null ? t('error.RUN_PROPOSAL_BUDGET_EXCEEDED.remaining', { remaining }, l)
      : t('error.RUN_PROPOSAL_BUDGET_EXCEEDED.ceiling', { remaining, ceiling }, l) }; } },
}, plainErrors('error.', {
  RUN_PROPOSAL_BASIS_STALE: 'error', RUN_PROPOSAL_COMMAND_CONFLICT: 'error', RUN_PROPOSAL_ACTOR_MISMATCH: 'error', RUN_PROPOSAL_SOURCE_INVALID: 'error',
  RUN_PROPOSAL_STORE_UNAVAILABLE: 'error', RUN_PROPOSAL_OUTCOME_UNKNOWN: 'error', RUN_PROPOSAL_CORRUPT: 'error', RUN_PROPOSAL_NOT_FOUND: 'error',
  RUN_APPROVAL_REQUIRED: 'error',
}), {
  RUN_STORE_CONFLICT: { category: 'error', render: (p, l) => ({ message: t('error.RUN_STORE_CONFLICT', p, l), suggestion: t('remedy.RUN_STORE_CONFLICT', p, l) }) },
}, plainErrors('error.', {
  HANDOFF_SOURCE_NOT_ACCEPTED: 'error', HANDOFF_ARTIFACT_MISMATCH: 'error', HANDOFF_PATCH_UNAPPLICABLE: 'error', HANDOFF_INVALID: 'error',
  HANDOFF_LIMIT_EXCEEDED: 'error', RUN_NOT_FOUND: 'error', RUN_COMMAND_CONFLICT: 'error', RUN_POOL_REQUIRED: 'error', RUN_POOL_CONFLICT: 'error', RUN_POOL_FULL: 'error',
  RUN_POOL_CAPACITY_OCCUPIED: 'error', RUN_POOL_HELD: 'error',
}), {
  RUN_CAPACITY_OR_ORDER: { category: 'error', render: (p, l) => ({ message:
    ['site', 'reason', 'readyCount', 'delayedCount', 'executionOccupied', 'executionSlots'].every(key => p[key] !== undefined)
      ? (p.eligibilityGapMs !== undefined ? t('error.RUN_CAPACITY_OR_ORDER.delayed', p, l) : t('error.RUN_CAPACITY_OR_ORDER.detail', p, l))
      : t('error.RUN_CAPACITY_OR_ORDER', p, l) }) },
}, plainErrors('error.', {
  INVENTORY_QUERY_INVALID: 'usage', ATTEMPT_NOT_FOUND: 'error', SUPERVISOR_REQUEST_INVALID: 'error', SUPERVISOR_WORKSPACE_INVALID: 'error',
  SUPERVISOR_IDENTITY_CONFLICT: 'error', SUPERVISOR_PROFILE_INVALID: 'error', SUPERVISOR_PROFILE_ORIGIN_MISMATCH: 'error', SUPERVISOR_OPTIONS_INVALID: 'error',
  SUPERVISOR_ISOLATION_MISMATCH: 'error', SUPERVISOR_CANCELLED: 'error', SUPERVISOR_CONTROL_FAILED: 'error', SUPERVISOR_NOT_TERMINAL: 'error',
  SUPERVISOR_RELEASE_UNCONFIRMED: 'error',
}), {
  QUERY_UNEXPECTED_FAILURE: { category: 'error', render: (p, l) => ({ message: p['record'] === undefined ? t('error.QUERY_UNEXPECTED_FAILURE', p, l) : t('error.QUERY_UNEXPECTED_FAILURE.recorded', p, l) }) },
}, plainErrors('error.', { RUN_PROGRESSION_PARKED: 'error' }), {
  // Crash-loop breaker: params task, attempt, phase (last preparation phase entered, or 'unknown'), aborts, bound. Without params (the parked
  // Run's recorded failure code seen later) the summary sentence stands.
  DISPATCH_PREPARATION_ABORTED: { category: 'error', render: (p, l) => ({ message: p['aborts'] === undefined ? t('error.DISPATCH_PREPARATION_ABORTED.summary', p, l) : t('error.DISPATCH_PREPARATION_ABORTED', p, l),
    suggestion: t('remedy.DISPATCH_PREPARATION_ABORTED', p, l) }) },
}, plainErrors('error.', {
  RUN_PROGRESSION_PARK_UNAVAILABLE: 'error', INVENTORY_UNAVAILABLE: 'error', MONITOR_UNAVAILABLE: 'error', DISPATCH_INVENTORY_LIMIT: 'usage',
}), {
  AUTHENTICATION_REQUIRED: { category: 'error', refusal: 'authentication', render: (p, l) => ({ message: t('error.AUTHENTICATION_REQUIRED', p, l) }) },
  AUTHENTICATION_SCOPE_DENIED: { category: 'error', refusal: 'authentication', render: (p, l) => ({ message: t('error.AUTHENTICATION_SCOPE_DENIED', p, l) }) },
  POLICY_UNAVAILABLE: { category: 'error', refusal: 'policy-unavailable', render: (p, l) => ({ message: t('error.POLICY_UNAVAILABLE', p, l) }) },
}, plainErrors('error.', { POLICY_DELEGATION_STEP_INVALID: 'error', POLICY_DELEGATION_CONFLICT: 'error' }), {
  // BeUser ZEY-02/D-04/E-05: a CLI refusal may carry the missing cell (operation, or cell + founder family) and its founder-baseline next step; the code stays.
  POLICY_DENIED: { category: 'error', refusal: 'policy-denied', render: (p, l) => ({ message: p['operation'] !== undefined ? t('error.POLICY_DENIED.operation', p, l) : p['cell'] !== undefined ? t('error.POLICY_DENIED.founder', p, l) : t('error.POLICY_DENIED', p, l) }) },
  // KER-03: a refusal that knows the requested scope names it; both say where the usable scopes are listed.
  SCOPE_UNKNOWN: { category: 'error', refusal: 'scope-unknown', render: (p, l) => ({ message: typeof p['scope'] === 'string' ? t('error.SCOPE_UNKNOWN.named', p, l) : t('error.SCOPE_UNKNOWN', p, l) }) },
  // C12 Q8: require-approval outside the operation catalog (no broker there yet). Typed and distinct from POLICY_DENIED.
  POLICY_APPROVAL_UNSUPPORTED: { category: 'error', refusal: 'approval-unsupported', render: (p, l) => ({ message: t('error.POLICY_APPROVAL_UNSUPPORTED', p, l) }) },
  // POLICY-ADMIN P1-P3: typed refusals of policy.administer@1; no surface maps them yet (authority producer surface is P5).
  // alpha.56 U5-S1: params kind, action, target, scope, reason, hint (owner|other|unnamed|deny|approval), people; without them the summary sentence.
  POLICY_DELEGATION_EXCEEDS: { category: 'error', render: (p, l) => ({ message: p['kind'] === undefined ? t('error.POLICY_DELEGATION_EXCEEDS.summary', p, l)
    : t('error.POLICY_DELEGATION_EXCEEDS', { ...p, hint: (DELEGATION_HINTS[String(p['hint'])] ?? DELEGATION_HINTS['unnamed']!)(p, l) }, l) }) },
}, plainErrors('error.', {
  POLICY_LAST_ADMIN: 'error', POLICY_CHANGE_INVALID: 'error', POLICY_CHANGE_TOO_LARGE: 'error', POLICY_ADMINISTER_UNSUPPORTED: 'error',
  // SECRET-K1: typed refusals of the SecretStore port (engine) and its backends. No parameter or cause ever carries a secret value or store
  // content; the texts interpolate only {backend}, {path} (the store directory) and {name}.
  SECRET_NAME_INVALID: 'usage', SECRET_VALUE_INVALID: 'usage', SECRET_STORE_UNKNOWN: 'config', SECRET_STORE_UNAVAILABLE: 'error', SECRET_HELPER_INVALID: 'config',
  SECRET_HELPER_DENIED: 'error', SECRET_HELPER_TIMEOUT: 'error', SECRET_HELPER_OUTPUT_LIMIT: 'error', SECRET_HELPER_FAILED: 'error', SECRET_STORE_UNSAFE: 'error',
  SECRET_STORE_CORRUPT: 'error', SECRET_STORE_READ_ONLY: 'error', SECRET_STORE_UNSUPPORTED: 'error',
  // SECRET-BOUNDS (Astra 2185 R5): the change would grow the store document past the bound its reader enforces (params backend, maxBytes;
  // nothing written).
  SECRET_STORE_FULL: 'error', SECRET_STORE_DOWNGRADE_UNCONFIRMED: 'error', SECRET_STORE_SWITCH_UNVERIFIED: 'error', SECRET_STORE_SWITCH_DENIED: 'error',
  // Astra 2456 P1-1: another secret change or store switch holds the installation's custody section past the wait bound (nothing changed).
  SECRET_STORE_ENV_UNCONFIRMED: 'error', SECRET_STORE_BUSY: 'error',
  // A store switch published another store after this change opened {backend}: nothing was decided, recorded or written.
  SECRET_STORE_CHANGED: 'error',
  // SECRET-WRITE: no allow grant on `secret`/`set|delete` for this name (params action, name — never a value); the text names the grant to add.
  // The prompt of `secret set` was ended with Ctrl-C (nothing sent).
  SECRET_CHANGE_DENIED: 'error', SECRET_INPUT_CANCELLED: 'error',
}), {
  // PRE-8 v2 (owner 2026-10-21): project vault, reference-only `.deck`, grant at use. Params carry names, a project root, a scope, a reason
  // or a line number only — never a value or a `.deck` line.
  DECK_FILE_INVALID: { category: 'config', render: (p, l) => ({ message: p['line'] === undefined ? t('error.DECK_FILE_INVALID.file', p, l) : t('error.DECK_FILE_INVALID', p, l) }) },
  DECK_DECLARATION_REQUIRED: { category: 'config', render: (p, l) => ({ message: t('error.DECK_DECLARATION_REQUIRED', p, l), suggestion: t('remedy.DECK_DECLARATION_REQUIRED', p, l) }) },
  SECRET_GRANT_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('error.SECRET_GRANT_REQUIRED', p, l), suggestion: t('remedy.SECRET_GRANT_REQUIRED', p, l) }) },
  SECRET_PROJECT_MISSING: { category: 'error', render: (p, l) => ({ message: t('error.SECRET_PROJECT_MISSING', p, l), suggestion: t('remedy.SECRET_PROJECT_MISSING', p, l) }) },
}, plainErrors('error.', { SECRET_PROJECT_IDENTITY_REQUIRED: 'error' }), {
  SECRET_PROJECT_VAULT_OWNERSHIP_LOST: { category: 'error', render: (p, l) => ({ message: t('error.SECRET_PROJECT_VAULT_OWNERSHIP_LOST', p, l), suggestion: t('remedy.SECRET_PROJECT_VAULT_OWNERSHIP_LOST', p, l) }) },
}, plainErrors('error.', { SECRET_PROJECT_VAULT_OWNER_UNOBSERVABLE: 'error' }), {
  SECRET_PROJECT_VAULT_CLAIMED: { category: 'error', render: (p, l) => ({ message: t('error.SECRET_PROJECT_VAULT_CLAIMED', p, l), suggestion: t('remedy.SECRET_PROJECT_VAULT_CLAIMED', p, l) }) },
}, plainErrors('error.', {
  SECRET_GRANT_STORE_UNSAFE: 'error', SECRET_GRANT_STORE_INVALID: 'error',
  // `secret set` off a terminal must name the vault (`--main` or `--project`): no silent scope (owner 2026-10-19).
  SECRET_VAULT_REQUIRED: 'usage', PERMISSION_MODE_CONFLICT: 'error', PERMISSION_MODE_UNSUPPORTED: 'error',
}), {
  PERMISSION_MODE_DENIED: { category: 'error', render: (p, l) => ({ message: (p['scope'] === undefined ? t('error.PERMISSION_MODE_DENIED', p, l) : t('error.PERMISSION_MODE_DENIED.scoped', p, l))
    + (p['hint'] === 'modeOwner' ? ` ${t('policy.hint.modeOwner', p, l)}` : '') }) },
}, plainErrors('error.', {
  PERMISSION_MODE_LOCKED: 'error', PERMISSION_MODE_INVALID: 'usage', AUDIT_INVALID: 'error', AUDIT_INTEGRITY: 'error', AUDIT_CONFLICT: 'error',
  AUDIT_UNAVAILABLE: 'error', AUDIT_REBASELINE_REFUSED: 'error', AUDIT_REBASELINE_STALE: 'error', AUDIT_REBASELINE_INTERACTIVE_REQUIRED: 'error',
  MANAGED_FILE_MISSING: 'error', MANAGED_FILE_UNSAFE: 'error', MANAGED_FILE_UNSUPPORTED: 'error', MANAGED_FILE_OUTSIDE_ROOT: 'error', ATTEMPT_STORE_VERSION: 'error',
  LEDGER_RESET_REQUIRED: 'error', LEDGER_MIGRATION_EVIDENCE_REQUIRED: 'error', ATTEMPT_STORE_BUSY: 'error', ATTEMPT_STORE_OPTIONS: 'config',
  // DEPS-P0: node:sqlite predates the 3.51.3 floor; the text names the floor literally and {floor} is the Node engine range (default param).
  ATTEMPT_STORE_SQLITE_UNSUPPORTED: 'config', ATTEMPT_STORE_READ_UNAVAILABLE: 'error', ATTEMPT_STORE_CORRUPT: 'error', COMMAND_ID_RESERVED: 'usage',
  DISPATCH_FENCE_CONFLICT: 'error', DISPATCH_FENCED: 'error', WORK_CLASS_EVIDENCE_NOT_REGISTERED: 'error', TASK_EVALUATION_PROFILE_MISMATCH: 'error',
  DISPATCH_CORRUPT: 'error',
}), {
  DISPATCH_ARTIFACT_REQUIRED: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: t('error.DISPATCH_ARTIFACT_REQUIRED', p, l) }) },
}, plainErrors('error.', { DISPATCH_CONFLICT: 'error', DISPATCH_NOT_ADMITTED: 'error', DISPATCH_PROFILE_VALIDATION_REQUIRED: 'config' }), {
  CONFIG_FILE_INVALID: { category: 'config', render: (p, l) => ({ message: t('error.CONFIG_FILE_INVALID', p, l), suggestion: t('remedy.CONFIG_FILE_INVALID', p, l), whatHappened: t('what.CONFIG_FILE_INVALID', p, l), why: t('why.CONFIG_FILE_INVALID', p, l), howToFix: Object.freeze(t('fix.CONFIG_FILE_INVALID', p, l).split('\n')) }) },
}, plainErrors('error.', {
  UNSUPPORTED_PLATFORM: 'error', HOME_NOT_RESOLVED: 'config', PATH_TRAVERSAL: 'usage', INVALID_TASK_ID: 'usage', ACTOR_UNVERIFIED: 'usage', CONFIG_UNSAFE_KEY: 'config',
  CONFIG_BACKUP_PRUNE_FAILED: 'config', CONFIG_READ_IO_HOLD: 'config', CONFIG_CONCURRENT_REVISION_HOLD: 'config', CONFIG_APPROVAL_STALE: 'config',
  CONFIG_APPROVAL_REQUIRED: 'config', CONFIG_WRITE_LOCKED: 'config', CONFIG_VERSION_UNSUPPORTED: 'config', CONFIG_SECTION_DUPLICATE: 'config',
  CONFIG_RECORD_INVALID: 'config', CONFIG_SECTION_INVALID: 'config', CONFIG_KEY_UNKNOWN: 'usage', LAYOUT_VERSION_UNSUPPORTED: 'config', LAYOUT_ROOT_INVALID: 'config',
  LAYOUT_RESOURCE_INVALID: 'config', LAYOUT_RESOURCE_UNKNOWN: 'config', LAYOUT_PATH_UNEXPRESSIBLE: 'config', CONFIG_VALIDATION: 'config',
  INITIAL_REGISTRY_PROBE_CLEANUP: 'config', INITIAL_REGISTRY_EXISTS: 'config', INITIAL_REGISTRY_CONFIG_CONFLICT: 'config', INITIAL_REGISTRY_CLI_UNAVAILABLE: 'config',
  CODING_TEMPLATE_REGISTRY_INVALID: 'config', CODING_TEMPLATE_INPUT_INVALID: 'usage', CODING_TEMPLATE_ADMISSION_REQUIRED: 'config',
  CODING_TEMPLATE_IMAGE_REQUIRED: 'config', CODING_TEMPLATE_TOOLCHAIN_REQUIRED: 'config', CODING_TEMPLATE_KIND_CONFLICT: 'config', CLI_CODING_INPUT_LIMIT: 'usage',
  CLI_CODING_INPUT_INVALID: 'usage', CLI_CODING_INPUT_TTY: 'usage',
}), {
  CLI_CODING_INPUT_UNAVAILABLE: { category: 'usage', render: (p, l) => ({ message: inputUnavailable(t('error.CLI_CODING_INPUT_UNAVAILABLE', p, l), p, l) }) },
  CLI_GRAPH_INPUT_LIMIT: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_GRAPH_INPUT_LIMIT', { ...p, limit: p.limit ?? t('cli.graph.configuredLimit', {}, l) }, l) }) },
  CLI_GRAPH_INPUT_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_GRAPH_INPUT_INVALID', { ...p, path: p.path ?? 'graph', reason: p.reason ?? t('cli.graph.expected', {}, l) }, l) }) },
}, plainErrors('error.', { CLI_GRAPH_INPUT_TTY: 'usage' }), {
  CLI_GRAPH_INPUT_UNAVAILABLE: { category: 'usage', render: (p, l) => ({ message: inputUnavailable(t('error.CLI_GRAPH_INPUT_UNAVAILABLE', p, l), p, l) }) },
}, plainErrors('error.', {
  INSTALL_INSPECTION_CONTROL_REQUIRED: 'config', INSTALL_INSPECTION_UNAVAILABLE: 'config', INSTALLATION_EVIDENCE_INVALID: 'config',
  INSTALLATION_EVIDENCE_IMAGES: 'config', INSTALLATION_EVIDENCE_CHANGED: 'config', INSTALLATION_ARTIFACT_INVALID: 'config', INSTALLATION_ARTIFACT_UNSAFE: 'config',
  INSTALLATION_ARTIFACT_LIMIT: 'config', INSTALLATION_ARTIFACT_CHANGED: 'config', INSTALLATION_ARTIFACT_UNAVAILABLE: 'config', DOCKER_IMAGE_PROBE_INVALID: 'config',
}), {
  // E1: `cause` (deadline|exit|signal|parse) is the bounded kind of the failed Docker step, never Docker's own text.
  DOCKER_IMAGE_PROBE_UNAVAILABLE: { category: 'config', render: (p, l) => { const cause = dockerImageProbeCause(p['cause']);
    return { message: cause ? t('error.DOCKER_IMAGE_PROBE_UNAVAILABLE.cause', { cause: cause(l) }, l) : t('error.DOCKER_IMAGE_PROBE_UNAVAILABLE', p, l) }; } },
}, plainErrors('error.', {
  DOCKER_IMAGE_PROBE_CHANGED: 'config', INSTALL_PROFILE_REQUIRED: 'config', INSTALL_PREVIEW_UNAVAILABLE: 'config', INSTALL_PROFILE_SOURCE_UNAVAILABLE: 'config',
  INSTALL_PROFILE_SOURCE_UNSAFE: 'config', INSTALL_PROFILE_SOURCE_TOO_LARGE: 'config', INSTALL_PROFILE_SOURCE_CHANGED: 'config', INSTALL_PROFILE_INVALID: 'config',
  INSTALLATION_PROFILE_INVALID: 'config', INSTALLATION_PROFILE_DIGEST: 'config', INSTALLATION_PROFILE_CONFIG: 'config', INSTALLATION_PROFILE_REGISTRY: 'config',
  INSTALLATION_PROFILE_ADAPTER: 'config', INSTALLATION_PROFILE_EVALUATOR: 'config', INSTALLATION_PROFILE_POOL: 'config', INSTALLATION_PROFILE_POLICY: 'config',
  INSTALLATION_PROFILE_SHUTDOWN: 'config',
  // C12 Q8 follow-up (owner 2026-09-27): installation owns its typed require-approval refusal, same 'config' category
  // (exit 78) as its INSTALLATION_PROFILE_* siblings above, instead of the shared cross-module POLICY_APPROVAL_UNSUPPORTED
  // ('error' category, exit 1) used by the other authorization points outside the operation catalog.
  INSTALLATION_PROFILE_APPROVAL_UNSUPPORTED: 'config', INSTALLATION_PROFILE_PATHS: 'config', BOOTSTRAP_STATE_INVALID: 'config', BOOTSTRAP_STATE_UNSAFE: 'config',
  BOOTSTRAP_STATE_CHANGED: 'config', BOOTSTRAP_INSTALLATION_INCOMPLETE: 'config', BOOTSTRAP_STATE_UNAVAILABLE: 'config', BOOTSTRAP_STATE_UNSUPPORTED: 'config',
  INSTALLATION_JOURNAL_INVALID: 'config', INSTALLATION_JOURNAL_UNSAFE: 'config', INSTALLATION_JOURNAL_CONFLICT: 'config', INSTALLATION_JOURNAL_UNAVAILABLE: 'config',
  INSTALLATION_JOURNAL_BUSY: 'config', INSTALLATION_JOURNAL_OUTCOME_UNKNOWN: 'config', INSTALLATION_JOURNAL_EXPIRED: 'config', INSTALLATION_JOURNAL_UNSUPPORTED: 'config',
  INSTALLATION_FILE_CONFLICT: 'config',
}), {
  INSTALLATION_FILE_UNSAFE: { category: 'config', render: (p, l) => ({ message: installationFileUnsafe(p, l) }) },
}, plainErrors('error.', {
  INSTALLATION_FILE_INVALID: 'config', INSTALLATION_FILE_UNAVAILABLE: 'config', INSTALLATION_FILE_OUTCOME_UNKNOWN: 'config', INSTALLATION_FILE_UNSUPPORTED: 'config',
  INSTALLATION_LEDGER_INVALID: 'config', INSTALLATION_LEDGER_CONFLICT: 'config', INSTALLATION_LEDGER_CORRUPT: 'config', INSTALLATION_LEDGER_UNAVAILABLE: 'config',
  INSTALLATION_LEDGER_OUTCOME_UNKNOWN: 'config', INSTALLATION_RECOVERY_INVALID: 'config', INSTALLATION_RECOVERY_CONSENT: 'config',
  INSTALLATION_RECOVERY_CHANGED: 'config', UNINSTALL_NATIVE_UNSUPPORTED: 'error', UNINSTALL_PURGE_DENIED: 'error', UNINSTALL_LIFECYCLE_HOLD: 'error',
  UNINSTALL_RECOVERY_INVALID: 'error',
}), {
  UNINSTALL_WORK_ACTIVE: { category: 'error', render: (p, l) => ({ message: p['workspaces'] && p['workspaces'] !== '0' ? t('error.UNINSTALL_WORK_ACTIVE_WORKSPACES', p, l) : t('error.UNINSTALL_WORK_ACTIVE', p, l) }) },
}, plainErrors('error.', { UNINSTALL_MANAGED: 'error', UNINSTALL_INVALID: 'error' }), {
  UNINSTALL_PLAN_CHANGED: { category: 'error', render: (p, l) => ({ message: p['diff'] ? t('error.UNINSTALL_PLAN_CHANGED_DIFF', p, l) : t('error.UNINSTALL_PLAN_CHANGED', p, l) }) },
}, plainErrors('error.', {
  UNINSTALL_UNSUPPORTED: 'error', UNINSTALL_BACKUP_COVERAGE: 'error', UNINSTALL_OWNERSHIP: 'error', UNINSTALL_PATH_UNSAFE: 'error', UNINSTALL_SCOPE_UNVERIFIED: 'error',
  UNINSTALL_FINAL_TAIL_UNKNOWN: 'error', UNINSTALL_RESTORE_KEPT: 'error', UNINSTALL_ARCHIVE_INVALID: 'error', UNINSTALL_ARCHIVE_CHANGED: 'error',
  UNINSTALL_BACKUP_DENIED: 'error', UNINSTALL_RECOVERY_LOCATION: 'error', UNINSTALL_AUTHORITY_UNVERIFIED: 'error', UNINSTALL_POLICY_UNREADABLE: 'error',
}), {
  UNINSTALL_SERVICE_RUNNING: { category: 'error', render: (p, l) => ({ message: p['unit'] ? t('error.UNINSTALL_SERVICE_RUNNING', p, l) : t('error.UNINSTALL_SERVICE_RUNNING_UNMANAGED', p, l) }) },
}, plainErrors('error.', {
  UNINSTALL_UNCERTAIN_EFFECTS: 'error', UNINSTALL_UNCERTAIN_MANAGED: 'error', UNINSTALL_DELIVERY_QUEUED: 'error', UNINSTALL_DELIVERY_TARGET_REQUIRED: 'error',
  UNINSTALL_RETIRED: 'error', UNINSTALL_FLAG_MOVED: 'error', INSTALLATION_PUBLICATION_INVALID: 'config', INSTALLATION_PUBLICATION_CONFLICT: 'config',
  INSTALLATION_PUBLICATION_CHANGED: 'config',
}), {
  WORKER_VERSION_COUNTER_TAKEN: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_VERSION_COUNTER_TAKEN', { detail: '', ...p }, l) }) },
  WORKER_VERSION_TAKEN: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_VERSION_TAKEN', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_VERSION_CHECK_FAILED: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_VERSION_CHECK_FAILED', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_VERSION_CHECK_TIMEOUT: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_VERSION_CHECK_TIMEOUT', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_COMMAND_FAILED: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_COMMAND_FAILED', { detail: '', ...p }, l) }) },
  WORKER_DAEMON_CHANGED: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_DAEMON_CHANGED', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_ID_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_ID_INVALID', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_ID_MISMATCH: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_ID_MISMATCH', { detail: '', ...p }, l) }) },
  WORKER_LABEL_MISMATCH: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_LABEL_MISMATCH', { detail: '', ...p }, l) }) },
  WORKER_TAG_MISMATCH: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_TAG_MISMATCH', { detail: '', ...p }, l) }) },
  WORKER_RECEIPT_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_RECEIPT_INVALID', { detail: '', ...p }, l) }) },
  WORKER_RECEIPT_DIRECTORY_UNAVAILABLE: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_RECEIPT_DIRECTORY_UNAVAILABLE', { detail: '', ...p }, l) }) },
  WORKER_HISTORY_COUNTER: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_HISTORY_COUNTER', { detail: '', ...p }, l) }) },
  WORKER_HISTORY_EMPTY: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_HISTORY_EMPTY', { detail: '', ...p }, l) }) },
  WORKER_HISTORY_IDS: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_HISTORY_IDS', { detail: '', ...p }, l) }) },
  WORKER_HISTORY_LINE: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_HISTORY_LINE', { detail: '', ...p }, l) }) },
  WORKER_HISTORY_MISMATCH: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_HISTORY_MISMATCH', { detail: '', ...p }, l) }) },
  WORKER_HISTORY_ORDER: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_HISTORY_ORDER', { detail: '', ...p }, l) }) },
  WORKER_RECIPE_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_RECIPE_INVALID', { detail: '', ...p }, l) }) },
  WORKER_RECIPE_PREVIOUS: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_RECIPE_PREVIOUS', { detail: '', ...p }, l) }) },
  WORKER_RECIPE_REPOSITORY: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_RECIPE_REPOSITORY', { detail: '', ...p }, l) }) },
  WORKER_RECIPE_VERSION: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_RECIPE_VERSION', { detail: '', ...p }, l) }) },
  WORKER_CLI_INCOMPATIBLE: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_CLI_INCOMPATIBLE', { detail: '', ...p }, l) }) },
  WORKER_VERSION_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_VERSION_INVALID', { detail: '', ...p }, l) }) },
  WORKER_PLAN_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_PLAN_INVALID', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_VERSIONS_UNRESOLVABLE: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_VERSIONS_UNRESOLVABLE', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_INSTALLER_CHANGED: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_INSTALLER_CHANGED', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_SOURCE_CREDENTIALS_REFUSED: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_SOURCE_CREDENTIALS_REFUSED', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_SOURCE_INSECURE: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_SOURCE_INSECURE', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_BUILDKIT_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_BUILDKIT_REQUIRED', { detail: '', ...p }, l) }) },
  WORKER_LINEAGE_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_LINEAGE_INVALID', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_CONSENT_MISSING: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_CONSENT_MISSING', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_CONSENT_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_CONSENT_INVALID', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_PROVIDERS_READ_ONLY: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_PROVIDERS_READ_ONLY', { detail: '', ...p }, l) }) },
  WORKER_SETUP_PENDING: { category: 'error', render: (p, l) => ({ message: [t('error.WORKER_SETUP_PENDING', { phase: '-', ...p }, l), workerKindIssues(p, l)].filter(Boolean).join(' ') }) },
  WORKER_IMAGE_DECLINED: { category: 'error', render: (p, l) => ({ message: [t('error.WORKER_IMAGE_DECLINED', {}, l), workerKindIssues(p, l)].filter(Boolean).join(' ') }) },
  WORKER_IMAGE_BUILDING: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_BUILDING', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_DOCKER_WAITING: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_DOCKER_WAITING', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_BUILD_INTERRUPTED: { category: 'error', render: (p, l) => ({ message: [t('error.WORKER_IMAGE_BUILD_INTERRUPTED', { detail: '', ...p }, l), workerKindIssues(p, l)].filter(Boolean).join(' ') }) },
  WORKER_IMAGE_SOURCE_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_SOURCE_INVALID', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_CONTEXT_EXISTS: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_CONTEXT_EXISTS', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_CONTEXT_UNSAFE: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_CONTEXT_UNSAFE', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_BUILD_FAILED: { category: 'error', render: (p, l) => ({ message: [t('error.WORKER_IMAGE_BUILD_FAILED', { detail: '', ...p }, l), workerKindIssues(p, l)].filter(Boolean).join(' ') }) },
  WORKER_IMAGE_BUILD_TIMEOUT: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_BUILD_TIMEOUT', { detail: '', ...p }, l) }) },
  WORKER_IMAGE_RECEIPT_MISSING: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_IMAGE_RECEIPT_MISSING', { detail: '', ...p }, l) }) },
  TOOLCHAIN_RECIPE_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.TOOLCHAIN_RECIPE_INVALID', { detail: '', ...p }, l) }) },
  TOOLCHAIN_HISTORY_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.TOOLCHAIN_HISTORY_INVALID', { detail: '', ...p }, l) }) },
  TOOLCHAIN_RECEIPT_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.TOOLCHAIN_RECEIPT_INVALID', { detail: '', ...p }, l) }) },
  TOOLCHAIN_PLAN_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.TOOLCHAIN_PLAN_INVALID', { detail: '', ...p }, l) }) },
}, plainErrors('error.', {
  TOOLCHAIN_UPDATE_TERMINAL_ONLY: 'error', HUB_STORE_OUTCOME_UNKNOWN: 'error', HUB_ACCOUNT_REFUSED: 'error', HUB_PROFILE_REFUSED: 'error', HUB_RATE_REFUSED: 'error',
  HUB_SERVER_DENIED: 'error', HUB_VERSION_CONFLICT: 'error', HUB_DEPENDENCY_INVALID: 'error', HUB_SECRET_REFUSED: 'error', HUB_REVIEW_REFUSED: 'error',
  HUB_STORE_UNSAFE: 'error', HUB_STORE_CONFLICT: 'error', HUB_TLS_REQUIRED: 'error', HUB_NETWORK_INVALID: 'error', HUB_NETWORK_FAILED: 'error',
  HUB_FIRST_USE_REQUIRED: 'error', HUB_RESOURCE_UNKNOWN: 'error', HUB_STORE_UNSUPPORTED: 'error', HUB_PACKAGE_SCHEMA_UNSUPPORTED: 'error',
  HUB_ENVELOPE_SCHEMA_UNSUPPORTED: 'error', HUB_FEED_SCHEMA_UNSUPPORTED: 'error', HUB_PACKAGE_INVALID: 'error', HUB_ENVELOPE_INVALID: 'error', HUB_FEED_INVALID: 'error',
  HUB_LIMIT_EXCEEDED: 'error', HUB_DIGEST_MISMATCH: 'error', HUB_SIGNATURE_INVALID: 'error', HUB_SIGNER_UNTRUSTED: 'error', HUB_IDENTITY_MISMATCH: 'error',
  HUB_FOREIGN_PACKAGE: 'error', HUB_FEED_REPLAYED: 'error', HUB_FEED_STALE: 'error',
}), {
  HUB_SKILL_FILES_UNAVAILABLE: { category: 'error', launch: 'permanent', render: (p, l) => ({ message: t('error.HUB_SKILL_FILES_UNAVAILABLE', p, l) }) },
}, plainErrors('error.', {
  HUB_SKILL_INVALID: 'error', HUB_FILE_UNSUPPORTED: 'error', HUB_SOURCE_INVALID: 'error', HUB_SOURCE_NOT_FOUND: 'error', HUB_AUTHORITY_REFUSED: 'error',
  HUB_INSTALL_CONFLICT: 'error', HUB_DEPENDENCY_REFUSED: 'error', HUB_DOWNGRADE_REFUSED: 'error', HUB_PACKAGE_REVOKED: 'error', HUB_STORE_CORRUPT: 'error',
  HUB_CONNECTION_UNAVAILABLE: 'error', HUB_STORE_UNAVAILABLE: 'error', HUB_OUTCOME_UNKNOWN: 'error',
}), {
  CLI_USAGE: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_USAGE', { ...p, command: p.command ?? 'deckent', usage: p.usage ?? t('cli.usage.help', {}, l), flag: p.flag ?? t('cli.usage.arguments', {}, l) }, l) }) },
});
// Duplicate codes across the core table and the family fragments fail at load (ERROR_REGISTRY_DUPLICATE), never last-wins.
const definitions = mergeErrorDefinitions([['core', coreDefinitions], ...ERROR_DEFINITION_FRAGMENTS]);
for (const definition of Object.values(definitions)) Object.freeze(definition);
export const ERROR_CODES: readonly string[] = Object.freeze(Object.keys(definitions));
const registered = (code: unknown): ErrorDefinition | undefined => typeof code === 'string' && Object.hasOwn(definitions, code) ? definitions[code] : undefined;
/** KG3 F3: whether `code` is a registered refusal of one of the `include` classes (each caller names its own); an unregistered code is not. */
export const isAuthorizationRefusal = (code: unknown, options: { readonly include: readonly AuthorizationRefusal[] }): boolean => {
  const refusal = registered(code)?.refusal;
  return refusal !== undefined && options.include.includes(refusal);
};
/** S2-e4: the launch disposition a registered code carries; null = transient, an unregistered code included. */
export const launchRefusal = (code: unknown): 'permanent' | 'held' | null => registered(code)?.launch ?? null;
export const ErrorRegistry = Object.freeze({
  has(code: string): boolean { return Object.hasOwn(definitions, code); },
  get(code: string, locale: Locale = resolveLocale(), params: Params = {}): Readonly<ErrorEntry> | undefined {
    const definition = Object.hasOwn(definitions, code) ? definitions[code] : undefined;
    return definition ? Object.freeze(definition.render({ floor: NODE_ENGINE_FLOOR_TEXT, major: NODE_ENGINE_RANGE.match(/\d+/)?.[0] ?? NODE_ENGINE_RANGE, ...params }, locale)) : undefined;
  },
  getAll(locale: Locale = resolveLocale()): Map<string, Readonly<ErrorEntry>> {
    return new Map(ERROR_CODES.map(code => [code, this.get(code, locale)!]));
  },
  createError(code: string, options: { message?: string; suggestion?: string; params?: Params; locale?: Locale; cause?: unknown } = {}): DeckentError {
    const locale = options.locale ?? resolveLocale();
    const entry = this.get(code, locale, options.params);
    const category = Object.hasOwn(definitions, code) ? definitions[code]!.category : 'error';
    return new DeckentError(code, options.message ?? entry?.message ?? t('error.unknown', { code }, locale),
      options.suggestion ?? entry?.suggestion, undefined, entry?.whatHappened, entry?.why, entry?.howToFix, category,
      options.cause === undefined ? undefined : { cause: options.cause },
      options.message === undefined ? target => this.get(code, target, options.params) ?? { message: t('error.unknown', { code }, target) } : undefined, Object.freeze({ ...options.params }));
  },
});
