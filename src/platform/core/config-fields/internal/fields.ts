import { persistedString, persistedInteger, persistedUrl } from '#platform/core/validate/index.js';
import { workerImageConsentSchema } from './worker-consent.js';
import { TARGET_QUEUE_SETTINGS } from './target-queue.js';
import { APPROVAL_ASSURANCE_SELECTION } from './approval-assurance.js';
import { DOCKER_EXECUTION_SETTINGS, GIT_EXECUTION_SETTINGS, ARTIFACT_STORAGE_LIMITS, ADOPTION_TARGET_SETTINGS, WORK_TARGET_SETTINGS, WORKER_INSTRUCTION_SETTINGS, DELIVERY_MODE, EXECUTION_RETENTION_SETTINGS, EXECUTION_SECRET_GATE_SETTINGS, RUN_PARKING_SETTINGS, QUOTA_RECOVERY_SETTINGS, STALL_RECOVERY_SETTINGS } from './execution.js';
import { SQLITE_STORAGE_OPTIONS } from './storage.js';
import { RESOURCE_OBSERVATION_SETTINGS } from './resource-observation.js';
import { z } from 'zod';
import { field, mergeConfigFields } from './field.js';
import { SETUP_FIELDS } from './fields-setup.js';
import { MODEL_FIELDS } from './fields-models.js';
import { PRODUCT_LAYOUT_REGISTRY, LAYOUT_CONTRACT_SINCE, CONFIG_SCHEMA_VERSION, OUTPUT_MODES } from '#platform/core/common/index.js';
import { SUPPORTED_LANGUAGES } from '#platform/core/i18n/index.js';
import { INPUT_VALIDATION_LIMITS } from '#platform/core/common/index.js';

export type { ConfigBinding, ConfigApplyMode, ConfigFieldMetadata } from './field.js';
const SERVICE_EXECUTION_CAPACITY_DEFAULT = 8;
/** S4B-1/3/5/7: the modes of every `memoryAutomation` switch, in rollout order (the memory rollout registry names them). */
export const MEMORY_AUTOMATION_MODES = Object.freeze(['off', 'shadow', 'on'] as const);
/** Single declaration of mutable config policy. Consumers derive, never duplicate, these values. */
export const CONFIG_FIELDS = Object.freeze(mergeConfigFields({
  schema_version: field('config.field.schema_version', { state: 'bound', consumers: ['src/platform/core/config'] }, 'live', z.union([z.literal(CONFIG_SCHEMA_VERSION), z.literal(5), z.literal(6)]).prefault(CONFIG_SCHEMA_VERSION)),
  language: field('config.field.language', { state: 'bound', consumers: ['src/surfaces/core/cli-observe'] }, 'live', z.enum(SUPPORTED_LANGUAGES as ['en', 'tr']).optional(), [{ names: ['DECKENT_LANGUAGE', 'DECKENT_LANG'] }]),
  output_mode: field('config.field.output_mode', { state: 'bound', consumers: ['src/platform/core/output'] }, 'live', z.enum(OUTPUT_MODES).prefault('standard')),
  layout: field('config.field.layout', { state: 'bound', consumers: ['src/platform/core/config'] }, 'restart', z.strictObject({ get root() { return persistedString(z.string().min(1)).nullable().prefault(null); }, get resources() { return z.record(z.string(), persistedString(z.string().min(1))).prefault({}); } }).prefault({}),
    [{ names: [PRODUCT_LAYOUT_REGISTRY.rootEnvironmentKey], path: ['root'] }], LAYOUT_CONTRACT_SINCE),
  storage: field('config.field.storage', { state: 'bound', consumers: ['src/composition/core/storage'] }, 'restart', z.strictObject({ get driver() { return z.literal('sqlite').prefault('sqlite'); },
    /* R6: 5000 ms: with opens lock-free, 100 ms still refused 1.5–4% of writes beside 7 clients on one loaded core (alpha.47 stress). */ get sqlite() { return SQLITE_STORAGE_OPTIONS.prefault({ busyTimeoutMs: 5000, journalMode: 'wal', durability: 'full' }); } }).prefault({}), [], LAYOUT_CONTRACT_SINCE),
  artifacts: field('config.field.artifacts', { state: 'bound', consumers: ['src/composition/core/artifacts'] }, 'restart', ARTIFACT_STORAGE_LIMITS.extend({ maxInputs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(64), patchPreview: z.strictObject({ get maxEntries() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(10000); }, get maxDepth() { return persistedInteger().positive().max(128).prefault(32); }, get maxPathBytes() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(1024); } }).prefault({ maxEntries: 10000, maxDepth: 32, maxPathBytes: 1024 }) }).prefault({ maxBytes: 16777216 }), [], LAYOUT_CONTRACT_SINCE),
  targetQueue: field('config.field.targetQueue', { state: 'bound', consumers: ['src/composition/core/runtime-service'] }, 'restart', TARGET_QUEUE_SETTINGS.prefault({})),
  execution: field('config.field.execution', { state: 'bound', consumers: ['src/composition/core/execution', 'src/composition/core/runs'] }, 'restart', z.strictObject({ docker: DOCKER_EXECUTION_SETTINGS.optional(), git: GIT_EXECUTION_SETTINGS, get adoption() { return ADOPTION_TARGET_SETTINGS.prefault({ targets: [] }); },
    get workTargets() { return WORK_TARGET_SETTINGS.optional(); }, get workerInstructions() { return WORKER_INSTRUCTION_SETTINGS.optional(); }, get deliveryMode() { return DELIVERY_MODE.optional(); }, get retention() { return EXECUTION_RETENTION_SETTINGS.prefault({ schemaVersion: 1 }); },
    get secretGate() { return EXECUTION_SECRET_GATE_SETTINGS.prefault({ schemaVersion: 1 }); } }).nullable().prefault(null), [], LAYOUT_CONTRACT_SINCE),
  backup: field('config.field.backup', { state: 'bound', consumers: ['src/composition/core/backup'] }, 'restart', z.strictObject({
    get schedule() { return z.enum(['off', 'daily', 'before-upgrade']).prefault('off'); },
    get retention() { return z.union([z.literal(3), z.literal(7), z.literal(14), z.literal(30)]).prefault(7); },
  }).prefault({})),
  configFile: field('config.field.configFile', { state: 'bound', consumers: ['src/platform/core/config', 'src/adapters/core/config-file'] }, 'live', z.strictObject({
    get backupKeep() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(3); },
    get writeLockTimeoutMs() { return persistedInteger().positive().max(2147483647).prefault(2000); },
  }).prefault({})),
  installation: field('config.field.installation', { state: 'bound', consumers: ['src/composition/core/installation', 'src/adapters/core/installation-files'] }, 'live', z.strictObject({
    get sharedRegistrationId() { return persistedString(z.string().uuid()).optional(); },
    get profileMaxBytes() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(1048576); },
    get writeLockTimeoutMs() { return persistedInteger().positive().max(2147483647).prefault(2000); },
    get identityProbe() { return z.strictObject({ timeoutMs: persistedInteger().positive().max(2147483647).prefault(2000),
      outputBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(65536) }).prefault({}); },
    // Installation binding: an operator-configured machine identity file (absolute path, e.g. a mounted secret) is preferred over the
    // platform identity; without either the binding is weak (root, device, inode). Required machine binding refuses installation-bound writes.
    get machineIdentity() { return z.strictObject({ source: persistedString(z.string().min(1).max(4096)).refine(value => value.startsWith('/'), 'MACHINE_IDENTITY_SOURCE_ABSOLUTE')
      .nullable().prefault(null) }).prefault({}); },
    get requireMachineBinding() { return z.boolean().prefault(false); },
    // K7 (owner 2026-10-27): the person's uninstall recovery root (receipts, tombstone, archive and backup); null: the registry default (XDG state).
    // A protected root: only the person's terminal changes it, and every plan checks it lies outside each folder it deletes.
    get uninstallRecoveryRoot() { return persistedString(z.string().min(1).max(4096)).refine(value => value.startsWith('/'), 'UNINSTALL_RECOVERY_ROOT_ABSOLUTE').nullable().prefault(null); },
    get imageProbe() { return z.strictObject({ timeoutMs: persistedInteger().positive().max(2147483647).prefault(5000),
      outputBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(65536) }).prefault({}); },
    get packageMeasurement() { return z.strictObject({
      maxFiles: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(8192),
      maxFileBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(67108864),
      maxTotalBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(536870912),
      maxDepth: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(32),
    }).prefault({}); },
  }).prefault({}), [], LAYOUT_CONTRACT_SINCE),
  audit: field('config.field.audit', { state: 'bound', consumers: ['src/composition/core/audit'] }, 'restart', z.strictObject({
    get schemaVersion() { return z.literal(1).prefault(1); }, get checkpointIntervalMs() { return persistedInteger().min(1000).max(2147483647).prefault(60000); },
    get pageSize() { return persistedInteger().positive().max(1000).prefault(100); }, get maxRecords() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(100000); },
    get maxScopes() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(1024); },
  }).prefault({})),
  approvals: field('config.field.approvals', { state: 'bound', consumers: ['src/composition/core/approvals'] }, 'restart', z.strictObject({
    assuranceProducers: APPROVAL_ASSURANCE_SELECTION,
    get requestTtlMs() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(600000); },
    get sessionTtlMs() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(60000); },
    get pageSize() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(100); },
    get keyFile() { return z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).prefault('authority.key'); },
    /** APPROVER-NOTE: the most characters (code points) of an approver's own note a tool-call turn gives the model; the record keeps it whole. */
    get approverNoteMaxChars() { return persistedInteger().positive().max(2048).min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(500); },
  }).prefault({}), [], LAYOUT_CONTRACT_SINCE),
  cli: field('config.field.cli', { state: 'bound', consumers: ['src/surfaces/core/cli-run', 'src/surfaces/core/cli-human'] }, 'live', z.strictObject({ get graphInputMaxBytes() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(1048576); }, get invocationInputMaxBytes() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(1048576); },
    /** INIT-D7 (UX only, never a security boundary): exact environment variable names that mark an AI agent caller (no prefix match); any
     * non-empty value other than 0/false makes the CLI plain and never asks a question. Evidence of each default: L-KIT HANDOFF (2026-10-19). */
    get agentEnvironment() { return z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)).max(64).prefault(['CLAUDECODE', 'AI_AGENT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CURSOR_AGENT', 'GEMINI_CLI']); } }).prefault({}), [], LAYOUT_CONTRACT_SINCE),
  policy: field('config.field.policy', { state: 'bound', consumers: ['src/composition/core/approvals'] }, 'live', z.strictObject({
    get mcp() { return z.strictObject({ optInGroups: z.array(z.string().regex(/^[a-z][a-z0-9.-]{0,47}$/u)).max(64).prefault([]) }).prefault({}); },
  }).prefault({})),
  mcp: field('config.field.mcp', { state: 'bound', consumers: ['src/composition/core/agent-turn'] }, 'restart', z.strictObject({
    get inputMaxBytes() { return persistedInteger().positive().max(INPUT_VALIDATION_LIMITS.mcp.maxBytes).prefault(1048576); },
    get responseMaxBytes() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(1048576); },
    get maxConcurrentCalls() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(8); },
    /** Security (MCP pool scope isolation): the most MCP server processes the runtime service keeps across all scopes and projects. */
    get maxServers() { return persistedInteger().positive().max(256).prefault(20); },
  }).prefault({}), [], LAYOUT_CONTRACT_SINCE),
  service: field('config.field.service', { state: 'bound', consumers: ['src/composition/core/runtime-service'] }, 'restart', z.strictObject({
    get identity() { return z.strictObject({ scopeId: persistedString(z.string().min(1)), serviceId: persistedString(z.string().min(1)) }).nullable().prefault(null); },
    get inputMaxBytes() { return persistedInteger().positive().max(INPUT_VALIDATION_LIMITS.ipc.maxBytes).prefault(1048576); },
    get responseMaxBytes() { return persistedInteger().positive().max(4294967295).prefault(1048576); },
    get maxConnections() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(32); },
    get maxConcurrentRequests() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(16); },
    get maxConcurrentExecutions() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(SERVICE_EXECUTION_CAPACITY_DEFAULT); },
    get headerTimeoutMs() { return persistedInteger().positive().max(2147483647).prefault(10000); },
    get responseTimeoutMs() { return persistedInteger().positive().max(2147483647).prefault(10000); },
    get acceptRetryDelayMs() { return persistedInteger().positive().max(2147483647).prefault(25); },
    get acceptRetryLimit() { return persistedInteger().positive().max(2147483647).prefault(3); },
    get shutdownGraceMs() { return persistedInteger().positive().max(2147483647).prefault(30000); },
    // Bounded wait for capacity before the typed BUSY refusal (0: refuse at once), and the client's bounded retries after a BUSY (0: none).
    get admissionWaitMs() { return persistedInteger().nonnegative().max(60000).prefault(250); },
    get busyRetryLimit() { return persistedInteger().nonnegative().max(10).prefault(2); },
    // K6 = A: a service the terminal started on its own stops through the governed stop once no request or execution ran for this long (null: never).
    get idleShutdown() { return z.strictObject({ afterMs: persistedInteger().min(60000).max(86400000).nullable().prefault(900000) }).prefault({}); },
  }).superRefine((value, context) => { if (value.maxConcurrentExecutions >= value.maxConcurrentRequests) context.addIssue({ code: z.ZodIssueCode.custom, path: ['maxConcurrentExecutions'], message: 'SERVICE_EXECUTIONS_CAPACITY' }); }).prefault({}), [], LAYOUT_CONTRACT_SINCE),
  cancellation: field('config.field.cancellation', { state: 'bound', consumers: ['src/composition/core/runtime'] }, 'restart', z.strictObject({ get maxConcurrentDeliveries() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER); },
    get recoveryPageSize() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(64); },
    get maxAttempts() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(3); }, get retryDelayMs() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(1000); },
    get claimTtlMs() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(30000); },
  }).nullable().prefault(null), [], LAYOUT_CONTRACT_SINCE),
  /** S4B-1 (owner S-M1/S-M11/S-M14; A10: the whole subtree is protected, no AI writes it): `extraction.mode` off (customer default) | shadow
   * (receipts only, no candidate) | on (inert candidates); `overlay` narrows the Core `memory-automation` registry, checked by the memory domain at
   * use (a widening overlay is MEMORY_AUTOMATION_INVALID). S4B-3 (owner S-M3/S-M14): `verification.mode` off (customer default) | shadow (sealed
   * evaluation records, nothing verified) | on (an independent pass verifies). S4B-5 (owner S-M6/S-M8/S-M9): `context.mode` off (customer default:
   * no memory read at Run admission) | shadow (the worker part is computed and sealed, never sent) | on (verified entries reach the worker prompt). */
  memoryAutomation: field('memory.config.section', { state: 'bound', consumers: ['src/composition/core/memory'] }, 'restart', z.strictObject({
    get extraction() { return z.strictObject({ mode: z.enum(MEMORY_AUTOMATION_MODES).prefault('off').describe('memory.config.extraction.mode') }).prefault({}); },
    get verification() { return z.strictObject({ mode: z.enum(MEMORY_AUTOMATION_MODES).prefault('off').describe('memory.config.verification.mode') }).prefault({}); },
    get context() { return z.strictObject({ mode: z.enum(MEMORY_AUTOMATION_MODES).prefault('off').describe('memory.config.context.mode') }).prefault({}); }, get overlay() { return z.record(z.string(), z.unknown().optional()).optional(); } }).prefault({})),
  /** S8-2 (S8-DESIGN §4, §9; protected: no AI writes it): the catalog aggregator pass `mode` off (customer default: no pass runs) | shadow | on
   * (S8-2 writes only the pass record in both; suggestions, cards and narrowing arrive in S8-3/S8-4); `overlay` replaces registry rule rows or
   * lowers bounds of the Core `catalog-evolution` registry, checked by the domain at use (an invalid overlay is CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE). */
  catalogEvolution: field('agentstats.config.section', { state: 'bound', consumers: ['src/composition/core/agent-catalog'] }, 'restart', z.strictObject({
    get mode() { return z.enum(['off', 'shadow', 'on']).prefault('off'); }, get overlay() { return z.record(z.string(), z.unknown().optional()).optional(); } }).prefault({})),
  runRuntime: field('config.field.runRuntime', { state: 'bound', consumers: ['src/composition/core/run-progression'] }, 'restart', z.strictObject({
    get parking() { return RUN_PARKING_SETTINGS.prefault({ schemaVersion: 1 }); },
    get quotaRecovery() { return QUOTA_RECOVERY_SETTINGS.prefault({ schemaVersion: 1 }); },
    get stallRecovery() { return STALL_RECOVERY_SETTINGS.prefault({ schemaVersion: 1 }); },
    /** S6R-2/3 Nervous (owner 2026-10-23 Q-R2: shadow first, customer default off): `shadow` seals proposals and executes nothing; `live` executes a
     * measured (`live`) rule's stop step only under the owner's standing policy grant (`recovery-action`); anything else stays a sealed proposal. */
    get nervous() { return z.strictObject({ mode: z.enum(['off', 'shadow', 'live']).prefault('off').describe('config.field.runRuntime.nervous.mode') }).prefault({}); },
    /** S6R-5 (owner Q-R2, lead on s6r4 Q1; protected: no AI writes it): `off` (customer default) freezes no recovery bounds at admission (never a
     * continuation); `shadow` freezes them and a decision only seals what it would do; `live` lets the recovery decision continue a lost task under
     * the owner's standing grant. The stricter of a Run's frozen mode and this one applies. */
    get recovery() { return z.strictObject({ mode: z.enum(['off', 'shadow', 'live']).prefault('off').describe('config.field.runRuntime.recovery.mode') }).prefault({}); },
    get maxConcurrentRuns() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(SERVICE_EXECUTION_CAPACITY_DEFAULT); },
    get maxReservationsPerTurn() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(4); },
    get pollIntervalMs() { return persistedInteger().positive().max(2147483647).prefault(1000); },
    get failureBackoffMs() { return persistedInteger().positive().max(2147483647).prefault(5000); },
    get maxConsecutiveFailures() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(3); },
    /** Crash-loop breaker: abnormal ends (process death) of one Attempt's dispatch preparation before its Run is parked instead of dispatched again. */
    get maxPreparationAborts() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(2); },
    get pageSize() { return persistedInteger().positive().max(2147483646).prefault(64); },
  }).prefault({}), [], LAYOUT_CONTRACT_SINCE),
  cancellationRuntime: field('config.field.cancellationRuntime', { state: 'bound', consumers: ['src/composition/core/runtime'] }, 'restart', z.strictObject({ get scopeIds() { return z.array(persistedString(z.string().min(1))).min(1); },
    get pollIntervalMs() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(1000); }, get failureBackoffMs() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(5000); },
  }).nullable().prefault(null), [], LAYOUT_CONTRACT_SINCE),
  reconciliationRuntime: field('config.field.reconciliationRuntime', { state: 'bound', consumers: ['src/composition/core/runtime'] }, 'restart', z.strictObject({
    get scopeIds() { return z.array(persistedString(z.string().min(1))).min(1); },
    get pollIntervalMs() { return persistedInteger().positive().max(2147483647).prefault(1000); },
    get failureBackoffMs() { return persistedInteger().positive().max(2147483647).prefault(5000); },
    get pageSize() { return persistedInteger().positive().max(2147483646).prefault(64); },
    get maxConcurrentReconciliations() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(4); },
  }).nullable().prefault(null), [], LAYOUT_CONTRACT_SINCE),
  admission: field('config.field.admission', { state: 'bound', consumers: ['src/composition/core/runs'] }, 'restart', z.strictObject({ get registry() { return z.record(z.string(), z.unknown().optional()); }, get poolId() { return persistedString(z.string().min(1)); },
    get executionSlots() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER); }, get inFlightSlots() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER); },
    get ordering() { return z.literal('input-order'); },
    /** PARALLEL-S3: admission policy (not a wire invariant); a larger graph is refused with typed TASK_GRAPH_LIMIT before any write. */
    get graph() { return z.strictObject({ maxTasks: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(256), maxEdges: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(1024),
      maxDepth: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(64) }).prefault({}); },
  }).nullable().prefault(null), [], LAYOUT_CONTRACT_SINCE),
  inspection: field('config.field.inspection', { state: 'bound', consumers: ['src/composition/core/worker-observation'] }, 'restart', z.strictObject({
    get maxPageSize() { return persistedInteger().positive().max(2_147_483_646).prefault(64); },
    get policyMaxBytes() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(1048576); },
    get workers() { return z.strictObject({ heartbeatMs: persistedInteger().min(100).max(60000).prefault(2000),
      staleMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(10000), maxFileBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(65536),
      maxEntries: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(4096),
      sources: z.array(z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).refine(value => value !== 'current'),
        kind: z.enum(['next-project', 'legacy-tasks']), path: persistedString(z.string().min(1)), scopeId: persistedString(z.string().min(1)) })).max(16).prefault([]),
    }).refine(value => new Set(value.sources.map(source => source.id)).size === value.sources.length).prefault({}); },
  }).prefault({}), [], LAYOUT_CONTRACT_SINCE),
  resourceObservation: field('config.field.resourceObservation', { state: 'bound', consumers: ['src/composition/core/resource-observation'] }, 'restart', RESOURCE_OBSERVATION_SETTINGS),
  toolchains: field('config.field.toolchains', { state: 'bound', consumers: ['src/composition/core/toolchains'] }, 'restart', z.strictObject({ get currency() { return z.strictObject({
    mode: z.enum(['off', 'report']).prefault('report'),
    registryEndpoint: persistedUrl().refine(value => { if (!URL.canParse(value)) return true; /* .url() already reported it */ const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }, 'WORKER_IMAGE_SOURCE_INSECURE').prefault('https://registry.npmjs.org'),
    timeoutMs: persistedInteger().positive().max(2_147_483_647).prefault(5000),
    responseMaxBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(65536),
  }).prefault({}); }, get image() { return z.strictObject({
    providers: z.array(z.string().regex(/^[a-z0-9]{1,32}$/u)).prefault([]),
    consents: z.array(workerImageConsentSchema).max(1024).prefault([]),
    baseRefreshMs: persistedInteger().positive().max(2_147_483_647).prefault(604_800_000),
    sources: z.strictObject({ baseImage: z.string().regex(/^[a-z0-9][\w./:@-]{0,254}$/u).nullable().prefault(null),
      proxy: persistedUrl().refine(value => { if (!URL.canParse(value)) return true; /* .url() already reported it */ const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }, 'WORKER_IMAGE_SOURCE_CREDENTIALS_REFUSED').nullable().prefault(null),
      installerUrls: z.record(z.string(), persistedUrl().refine(value => { if (!URL.canParse(value)) return true; /* .url() already reported it */ const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }, 'WORKER_IMAGE_SOURCE_INSECURE')).prefault({}),
    }).prefault({}),
  }).prefault({}); }, get update() { return z.strictObject({
    mode: z.enum(['off', 'propose', 'auto']).prefault('auto'),
    buildTimeoutMs: persistedInteger().positive().max(2_147_483_647).prefault(1_800_000),
    outputBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(1_048_576),
    atStartup: z.boolean().prefault(true),
    /** WORKER-AUTO-REFRESH (owner 2026-10-06 K2): the running service re-checks currency every `intervalMs`; 0 turns the periodic check off. */
    /** Failed build contexts kept as evidence (newest first); older ones are removed after each failure. At least one always stays. */
    failedContextsKept: persistedInteger().min(1).max(1000).prefault(3),
    intervalMs: persistedInteger().min(0).max(2_147_483_647).prefault(86_400_000),
  }).prefault({}); } }).prefault({}), [], LAYOUT_CONTRACT_SINCE),
  projectName: field('config.field.projectName', { state: 'bound', consumers: ['src/surfaces/core/config'] }, 'live', persistedString(z.string().min(1)).prefault('deckent-project')),
  max_workers: field('config.field.max_workers', { state: 'bound', consumers: ['src/composition/core/runs', 'src/composition/core/monitor'] }, 'restart', z.union([persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.literal('auto')]).prefault('auto')),
  company: field('config.field.company', { state: 'bound', consumers: ['src/composition/core/scoped-request'] }, 'restart', z.strictObject({ get id() { return z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).prefault('default'); } }).prefault({})),
  enforce_principal_assurance: field('config.field.enforce_principal_assurance', { state: 'bound', consumers: ['src/surfaces/core/cli-observe'] }, 'live', z.boolean().prefault(false)),
// The per-writer fragments (alpha.48 A2) join after the core fields; a duplicate name fails at load.
}, SETUP_FIELDS, MODEL_FIELDS));
type FieldShape = { [K in keyof typeof CONFIG_FIELDS]: typeof CONFIG_FIELDS[K]['schema'] };
export const CORE_SCHEMA = z.strictObject(Object.fromEntries(
  Object.entries(CONFIG_FIELDS).map(([name, definition]) => [name, definition.schema]),
) as FieldShape);

export const CONFIG_ENVIRONMENT_KEYS = Object.freeze([...new Set(Object.values(CONFIG_FIELDS)
  .flatMap(field => field.environment.flatMap(binding => binding.names)))]);

export function getConfigFieldDefault<K extends keyof typeof CONFIG_FIELDS>(key: K): z.output<typeof CONFIG_FIELDS[K]['schema']> {
  return CONFIG_FIELDS[key].schema.parse(undefined) as z.output<typeof CONFIG_FIELDS[K]['schema']>;
}
