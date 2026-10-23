import { TARGET_QUEUE_SETTINGS } from './target-queue.js';
import { APPROVAL_ASSURANCE_SELECTION } from './approval-assurance.js';
import { DOCKER_EXECUTION_SETTINGS, GIT_EXECUTION_SETTINGS, ARTIFACT_STORAGE_LIMITS, ADOPTION_TARGET_SETTINGS, WORK_TARGET_SETTINGS, WORKER_INSTRUCTION_SETTINGS, EXECUTION_RETENTION_SETTINGS, EXECUTION_SECRET_GATE_SETTINGS, RUN_PARKING_SETTINGS, QUOTA_RECOVERY_SETTINGS, STALL_RECOVERY_SETTINGS } from './execution.js';
import { SQLITE_STORAGE_OPTIONS } from './storage.js';
import { RESOURCE_OBSERVATION_SETTINGS } from './resource-observation.js';
import { z } from 'zod';
import { field, mergeConfigFields } from './field.js';
import { SETUP_FIELDS } from './fields-setup.js';
import { MODEL_FIELDS } from './fields-models.js';
import { PRODUCT_LAYOUT_REGISTRY, LAYOUT_CONTRACT_SINCE, CONFIG_SCHEMA_VERSION, OUTPUT_MODES } from '#platform/core/common/index.js';
import { SUPPORTED_LANGUAGES } from '#platform/core/i18n/index.js';

export type { ConfigBinding, ConfigApplyMode, ConfigFieldMetadata } from './field.js';
const SERVICE_EXECUTION_CAPACITY_DEFAULT = 8;
/** Single declaration of mutable config policy. Consumers derive, never duplicate, these values. */
export const CONFIG_FIELDS = Object.freeze(mergeConfigFields({
  schema_version: field('config.field.schema_version', { state: 'bound', consumers: ['src/platform/core/config'] }, 'live', z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION)),
  language: field('config.field.language', { state: 'bound', consumers: ['src/surfaces/core/cli-observe'] }, 'live', z.enum(SUPPORTED_LANGUAGES as ['en', 'tr']).optional(), [{ names: ['DECKENT_LANGUAGE', 'DECKENT_LANG'] }]),
  output_mode: field('config.field.output_mode', { state: 'bound', consumers: ['src/platform/core/output'] }, 'live', z.enum(OUTPUT_MODES).default('standard')),
  layout: field('config.field.layout', { state: 'bound', consumers: ['src/platform/core/config'] }, 'restart', z.object({ root: z.string().min(1).nullable().default(null), resources: z.record(z.string().min(1)).default({}) }).strict().default({}),
    [{ names: [PRODUCT_LAYOUT_REGISTRY.rootEnvironmentKey], path: ['root'] }], LAYOUT_CONTRACT_SINCE),
  storage: field('config.field.storage', { state: 'bound', consumers: ['src/composition/core/storage'] }, 'restart', z.object({ driver: z.literal('sqlite').default('sqlite'),
    /* R6: 5000 ms: with opens lock-free, 100 ms still refused 1.5–4% of writes beside 7 clients on one loaded core (alpha.47 stress). */ sqlite: SQLITE_STORAGE_OPTIONS.default({ busyTimeoutMs: 5000, journalMode: 'wal', durability: 'full' }) }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  artifacts: field('config.field.artifacts', { state: 'bound', consumers: ['src/composition/core/artifacts'] }, 'restart', ARTIFACT_STORAGE_LIMITS.extend({ maxInputs: z.number().int().positive().safe().default(64), patchPreview: z.object({ maxEntries: z.number().int().positive().safe().default(10000), maxDepth: z.number().int().positive().max(128).default(32), maxPathBytes: z.number().int().positive().safe().default(1024) }).strict().default({ maxEntries: 10000, maxDepth: 32, maxPathBytes: 1024 }) }).default({ maxBytes: 16777216 }), [], LAYOUT_CONTRACT_SINCE),
  targetQueue: field('config.field.targetQueue', { state: 'bound', consumers: ['src/composition/core/runtime-service'] }, 'restart', TARGET_QUEUE_SETTINGS.default({})),
  execution: field('config.field.execution', { state: 'bound', consumers: ['src/composition/core/execution', 'src/composition/core/runs'] }, 'restart', z.object({ docker: DOCKER_EXECUTION_SETTINGS, git: GIT_EXECUTION_SETTINGS, adoption: ADOPTION_TARGET_SETTINGS.default({ targets: [] }),
    workTargets: WORK_TARGET_SETTINGS.optional(), workerInstructions: WORKER_INSTRUCTION_SETTINGS.optional(), retention: EXECUTION_RETENTION_SETTINGS.default({ schemaVersion: 1 }),
    secretGate: EXECUTION_SECRET_GATE_SETTINGS.default({ schemaVersion: 1 }) }).strict().nullable().default(null), [], LAYOUT_CONTRACT_SINCE),
  backup: field('config.field.backup', { state: 'bound', consumers: ['src/composition/core/backup'] }, 'restart', z.object({
    schedule: z.enum(['off', 'daily', 'before-upgrade']).default('off'),
    retention: z.union([z.literal(3), z.literal(7), z.literal(14), z.literal(30)]).default(7),
  }).strict().default({})),
  configFile: field('config.field.configFile', { state: 'bound', consumers: ['src/platform/core/config', 'src/adapters/core/config-file'] }, 'live', z.object({
    backupKeep: z.number().int().positive().safe().default(3),
    writeLockTimeoutMs: z.number().int().positive().max(2147483647).default(2000),
  }).strict().default({})),
  installation: field('config.field.installation', { state: 'bound', consumers: ['src/composition/core/installation', 'src/adapters/core/installation-files'] }, 'live', z.object({
    profileMaxBytes: z.number().int().positive().safe().default(1048576),
    writeLockTimeoutMs: z.number().int().positive().max(2147483647).default(2000),
    identityProbe: z.object({ timeoutMs: z.number().int().positive().max(2147483647).default(2000),
      outputBytes: z.number().int().positive().safe().default(65536) }).strict().default({}),
    // Installation binding: an operator-configured machine identity file (absolute path, e.g. a mounted secret) is preferred over the
    // platform identity; without either the binding is weak (root, device, inode). Required machine binding refuses installation-bound writes.
    machineIdentity: z.object({ source: z.string().min(1).max(4096).refine(value => value.startsWith('/'), 'MACHINE_IDENTITY_SOURCE_ABSOLUTE')
      .nullable().default(null) }).strict().default({}),
    requireMachineBinding: z.boolean().default(false),
    imageProbe: z.object({ timeoutMs: z.number().int().positive().max(2147483647).default(5000),
      outputBytes: z.number().int().positive().safe().default(65536) }).strict().default({}),
    packageMeasurement: z.object({
      maxFiles: z.number().int().positive().safe().default(8192),
      maxFileBytes: z.number().int().positive().safe().default(67108864),
      maxTotalBytes: z.number().int().positive().safe().default(536870912),
      maxDepth: z.number().int().positive().safe().default(32),
    }).strict().default({}),
  }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  audit: field('config.field.audit', { state: 'bound', consumers: ['src/composition/core/audit'] }, 'restart', z.object({
    schemaVersion: z.literal(1).default(1), checkpointIntervalMs: z.number().int().min(1000).max(2147483647).default(60000),
    pageSize: z.number().int().positive().max(1000).default(100), maxRecords: z.number().int().positive().safe().default(100000),
    maxScopes: z.number().int().positive().safe().default(1024),
  }).strict().default({})),
  approvals: field('config.field.approvals', { state: 'bound', consumers: ['src/composition/core/approvals'] }, 'restart', z.object({
    assuranceProducers: APPROVAL_ASSURANCE_SELECTION,
    requestTtlMs: z.number().int().positive().safe().default(600000),
    sessionTtlMs: z.number().int().positive().safe().default(60000),
    pageSize: z.number().int().positive().safe().default(100),
    keyFile: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).default('authority.key'),
    /** APPROVER-NOTE: the most characters (code points) of an approver's own note a tool-call turn gives the model; the record keeps it whole. */
    approverNoteMaxChars: z.number().int().positive().max(2048).safe().default(500),
  }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  cli: field('config.field.cli', { state: 'bound', consumers: ['src/surfaces/core/cli-run', 'src/surfaces/core/cli-human'] }, 'live', z.object({ graphInputMaxBytes: z.number().int().positive().safe().default(1048576), invocationInputMaxBytes: z.number().int().positive().safe().default(1048576),
    /** INIT-D7 (UX only, never a security boundary): exact environment variable names that mark an AI agent caller (no prefix match); any
     * non-empty value other than 0/false makes the CLI plain and never asks a question. Evidence of each default: L-KIT HANDOFF (2026-10-19). */
    agentEnvironment: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)).max(64).default(['CLAUDECODE', 'AI_AGENT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CURSOR_AGENT', 'GEMINI_CLI']) }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  mcp: field('config.field.mcp', { state: 'bound', consumers: ['src/composition/core/agent-turn'] }, 'restart', z.object({
    inputMaxBytes: z.number().int().positive().safe().default(1048576),
    responseMaxBytes: z.number().int().positive().safe().default(1048576),
    maxConcurrentCalls: z.number().int().positive().safe().default(8),
    /** Security (MCP pool scope isolation): the most MCP server processes the runtime service keeps across all scopes and projects. */
    maxServers: z.number().int().positive().max(256).default(20),
  }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  service: field('config.field.service', { state: 'bound', consumers: ['src/composition/core/runtime-service'] }, 'restart', z.object({
    identity: z.object({ scopeId: z.string().min(1), serviceId: z.string().min(1) }).strict().nullable().default(null),
    inputMaxBytes: z.number().int().positive().max(4294967295).default(1048576),
    responseMaxBytes: z.number().int().positive().max(4294967295).default(1048576),
    maxConnections: z.number().int().positive().safe().default(32),
    maxConcurrentRequests: z.number().int().positive().safe().default(16),
    maxConcurrentExecutions: z.number().int().positive().safe().default(SERVICE_EXECUTION_CAPACITY_DEFAULT),
    headerTimeoutMs: z.number().int().positive().max(2147483647).default(10000),
    responseTimeoutMs: z.number().int().positive().max(2147483647).default(10000),
    acceptRetryDelayMs: z.number().int().positive().max(2147483647).default(25),
    acceptRetryLimit: z.number().int().positive().max(2147483647).default(3),
    shutdownGraceMs: z.number().int().positive().max(2147483647).default(30000),
    // Bounded wait for capacity before the typed BUSY refusal (0: refuse at once), and the client's bounded retries after a BUSY (0: none).
    admissionWaitMs: z.number().int().nonnegative().max(60000).default(250),
    busyRetryLimit: z.number().int().nonnegative().max(10).default(2),
    // K6 = A: a service the terminal started on its own stops through the governed stop once no request or execution ran for this long (null: never).
    idleShutdown: z.object({ afterMs: z.number().int().min(60000).max(86400000).nullable().default(900000) }).strict().default({}),
  }).strict().superRefine((value, context) => { if (value.maxConcurrentExecutions >= value.maxConcurrentRequests) context.addIssue({ code: z.ZodIssueCode.custom, path: ['maxConcurrentExecutions'], message: 'SERVICE_EXECUTIONS_CAPACITY' }); }).default({}), [], LAYOUT_CONTRACT_SINCE),
  cancellation: field('config.field.cancellation', { state: 'bound', consumers: ['src/composition/core/runtime'] }, 'restart', z.object({ maxConcurrentDeliveries: z.number().int().positive().safe(),
    recoveryPageSize: z.number().int().positive().safe().default(64),
    maxAttempts: z.number().int().positive().safe().default(3), retryDelayMs: z.number().int().positive().safe().default(1000),
    claimTtlMs: z.number().int().positive().safe().default(30000),
  }).strict().nullable().default(null), [], LAYOUT_CONTRACT_SINCE),
  /** S4B-1 (owner S-M1/S-M11/S-M14; A10: the whole subtree is protected, no AI writes it): `extraction.mode` off (customer default) | shadow
   * (receipts only, no candidate) | on (inert candidates); `overlay` narrows the Core `memory-automation` registry, checked by the memory domain at
   * use (a widening overlay is MEMORY_AUTOMATION_INVALID). S4B-3 (owner S-M3/S-M14): `verification.mode` off (customer default) | shadow (sealed
   * evaluation records, nothing verified) | on (an independent pass verifies). The context mode joins with S4B-5. */
  memoryAutomation: field('memory.config.section', { state: 'bound', consumers: ['src/composition/core/memory'] }, 'live', z.object({
    extraction: z.object({ mode: z.enum(['off', 'shadow', 'on']).default('off') }).strict().default({}),
    verification: z.object({ mode: z.enum(['off', 'shadow', 'on']).default('off') }).strict().default({}), overlay: z.record(z.string(), z.unknown()).optional() }).strict().default({})),
  runRuntime: field('config.field.runRuntime', { state: 'bound', consumers: ['src/composition/core/run-progression'] }, 'restart', z.object({
    parking: RUN_PARKING_SETTINGS.default({ schemaVersion: 1 }),
    quotaRecovery: QUOTA_RECOVERY_SETTINGS.default({ schemaVersion: 1 }),
    stallRecovery: STALL_RECOVERY_SETTINGS.default({ schemaVersion: 1 }),
    /** S6R-2/3 Nervous (owner 2026-10-23 Q-R2: shadow first, customer default off): `shadow` seals proposals and executes nothing; `live` executes a
     * measured (`live`) rule's stop step only under the owner's standing policy grant (`recovery-action`); anything else stays a sealed proposal. */
    nervous: z.object({ mode: z.enum(['off', 'shadow', 'live']).default('off') }).strict().default({}),
    maxConcurrentRuns: z.number().int().positive().safe().default(SERVICE_EXECUTION_CAPACITY_DEFAULT),
    maxReservationsPerTurn: z.number().int().positive().safe().default(4),
    pollIntervalMs: z.number().int().positive().max(2147483647).default(1000),
    failureBackoffMs: z.number().int().positive().max(2147483647).default(5000),
    maxConsecutiveFailures: z.number().int().positive().safe().default(3),
    /** Crash-loop breaker: abnormal ends (process death) of one Attempt's dispatch preparation before its Run is parked instead of dispatched again. */
    maxPreparationAborts: z.number().int().positive().safe().default(2),
    pageSize: z.number().int().positive().max(2147483646).default(64),
  }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  cancellationRuntime: field('config.field.cancellationRuntime', { state: 'bound', consumers: ['src/composition/core/runtime'] }, 'restart', z.object({ scopeIds: z.array(z.string().min(1)).min(1),
    pollIntervalMs: z.number().int().positive().safe().default(1000), failureBackoffMs: z.number().int().positive().safe().default(5000),
  }).strict().nullable().default(null), [], LAYOUT_CONTRACT_SINCE),
  reconciliationRuntime: field('config.field.reconciliationRuntime', { state: 'bound', consumers: ['src/composition/core/runtime'] }, 'restart', z.object({
    scopeIds: z.array(z.string().min(1)).min(1),
    pollIntervalMs: z.number().int().positive().max(2147483647).default(1000),
    failureBackoffMs: z.number().int().positive().max(2147483647).default(5000),
    pageSize: z.number().int().positive().max(2147483646).default(64),
    maxConcurrentReconciliations: z.number().int().positive().safe().default(4),
  }).strict().nullable().default(null), [], LAYOUT_CONTRACT_SINCE),
  admission: field('config.field.admission', { state: 'bound', consumers: ['src/composition/core/runs'] }, 'restart', z.object({ registry: z.record(z.unknown()), poolId: z.string().min(1),
    executionSlots: z.number().int().positive().safe(), inFlightSlots: z.number().int().positive().safe(),
    ordering: z.literal('input-order'),
    /** PARALLEL-S3: admission policy (not a wire invariant); a larger graph is refused with typed TASK_GRAPH_LIMIT before any write. */
    graph: z.object({ maxTasks: z.number().int().positive().safe().default(256), maxEdges: z.number().int().positive().safe().default(1024),
      maxDepth: z.number().int().positive().safe().default(64) }).strict().default({}),
  }).strict().nullable().default(null), [], LAYOUT_CONTRACT_SINCE),
  inspection: field('config.field.inspection', { state: 'bound', consumers: ['src/composition/core/worker-observation'] }, 'restart', z.object({
    maxPageSize: z.number().int().positive().max(2_147_483_646).default(64),
    policyMaxBytes: z.number().int().positive().safe().default(1048576),
    workers: z.object({ heartbeatMs: z.number().int().min(100).max(60000).default(2000),
      staleMs: z.number().int().positive().safe().default(10000), maxFileBytes: z.number().int().positive().safe().default(65536),
      maxEntries: z.number().int().positive().safe().default(4096),
      sources: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).refine(value => value !== 'current'),
        kind: z.enum(['next-project', 'legacy-tasks']), path: z.string().min(1), scopeId: z.string().min(1) }).strict()).max(16).default([]),
    }).strict().refine(value => new Set(value.sources.map(source => source.id)).size === value.sources.length).default({}),
  }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  resourceObservation: field('config.field.resourceObservation', { state: 'bound', consumers: ['src/composition/core/resource-observation'] }, 'restart', RESOURCE_OBSERVATION_SETTINGS),
  toolchains: field('config.field.toolchains', { state: 'bound', consumers: ['src/composition/core/toolchains'] }, 'restart', z.object({ currency: z.object({
    mode: z.enum(['off', 'report']).default('report'),
    registryEndpoint: z.string().url().default('https://registry.npmjs.org'),
    timeoutMs: z.number().int().positive().max(2_147_483_647).default(5000),
    responseMaxBytes: z.number().int().positive().safe().default(65536),
  }).strict().default({}), update: z.object({
    mode: z.enum(['off', 'propose', 'auto']).default('auto'),
    buildTimeoutMs: z.number().int().positive().max(2_147_483_647).default(1_800_000),
    outputBytes: z.number().int().positive().safe().default(1_048_576),
    atStartup: z.boolean().default(true),
    /** WORKER-AUTO-REFRESH (owner 2026-10-06 K2): the running service re-checks currency every `intervalMs`; 0 turns the periodic check off. */
    /** Failed build contexts kept as evidence (newest first); older ones are removed after each failure. At least one always stays. */
    failedContextsKept: z.number().int().min(1).max(1000).default(3),
    intervalMs: z.number().int().min(0).max(2_147_483_647).default(86_400_000),
  }).strict().default({}) }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  projectName: field('config.field.projectName', { state: 'bound', consumers: ['src/surfaces/core/config'] }, 'live', z.string().min(1).default('deckent-project')),
  max_workers: field('config.field.max_workers', { state: 'bound', consumers: ['src/composition/core/runs', 'src/composition/core/monitor'] }, 'restart', z.union([z.number().int().positive().safe(), z.literal('auto')]).default('auto')),
  company: field('config.field.company', { state: 'bound', consumers: ['src/composition/core/scoped-request'] }, 'restart', z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default('default') }).strict().default({})),
  enforce_principal_assurance: field('config.field.enforce_principal_assurance', { state: 'bound', consumers: ['src/surfaces/core/cli-observe'] }, 'live', z.boolean().default(false)),
// The per-writer fragments (alpha.48 A2) join after the core fields; a duplicate name fails at load.
}, SETUP_FIELDS, MODEL_FIELDS));
type FieldShape = { [K in keyof typeof CONFIG_FIELDS]: typeof CONFIG_FIELDS[K]['schema'] };
export const CORE_SCHEMA = z.object(Object.fromEntries(
  Object.entries(CONFIG_FIELDS).map(([name, definition]) => [name, definition.schema]),
) as FieldShape).strict();

export const CONFIG_ENVIRONMENT_KEYS = Object.freeze([...new Set(Object.values(CONFIG_FIELDS)
  .flatMap(field => field.environment.flatMap(binding => binding.names)))]);

export function getConfigFieldDefault<K extends keyof typeof CONFIG_FIELDS>(key: K): z.output<typeof CONFIG_FIELDS[K]['schema']> {
  return CONFIG_FIELDS[key].schema.parse(undefined);
}
