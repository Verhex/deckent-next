import { DOCKER_EXECUTION_SETTINGS, GIT_EXECUTION_SETTINGS, ARTIFACT_STORAGE_LIMITS, ADOPTION_TARGET_SETTINGS, WORK_TARGET_SETTINGS, EXECUTION_RETENTION_SETTINGS, RUN_PARKING_SETTINGS } from './execution.js';
import { SQLITE_STORAGE_OPTIONS } from './storage.js';
import { z } from 'zod';
import { PRODUCT_LAYOUT_REGISTRY, LAYOUT_CONTRACT_SINCE, CONFIG_SCHEMA_VERSION, CONFIG_CONTRACT_SINCE, OUTPUT_MODES } from '#platform/core/common/index.js';
import { SUPPORTED_LANGUAGES } from '#platform/core/i18n/index.js';

export type ConfigBinding = { readonly state: 'bound'; readonly consumers: readonly string[] } | { readonly state: 'declared-only'; readonly reason: string };
export type ConfigApplyMode = 'live' | 'restart';
export interface ConfigFieldMetadata {
  readonly descriptionKey: string; readonly tier: string; readonly since: string;
  readonly binding: ConfigBinding; readonly apply: ConfigApplyMode;
}
type EnvironmentBinding = { readonly names: readonly string[]; readonly path?: readonly string[]; readonly encoding?: 'boolean' };
const SERVICE_EXECUTION_CAPACITY_DEFAULT = 8;
function field<T extends z.ZodTypeAny>(descriptionKey: string, binding: ConfigBinding, apply: ConfigApplyMode, schema: T, environment: readonly EnvironmentBinding[] = [], since = CONFIG_CONTRACT_SINCE) {
  return Object.freeze({ schema, environment, metadata: Object.freeze({ descriptionKey, tier: 'core' as const, since, binding: binding.state === 'bound' ? Object.freeze({ ...binding, consumers: Object.freeze([...binding.consumers]) }) : Object.freeze({ ...binding }), apply }) });
}
/** Single declaration of mutable config policy. Consumers derive, never duplicate, these values. */
export const CONFIG_FIELDS = Object.freeze({
  schema_version: field('config.field.schema_version', { state: 'bound', consumers: ['src/platform/core/config'] }, 'live', z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION)),
  language: field('config.field.language', { state: 'bound', consumers: ['src/surfaces/core/cli'] }, 'live', z.enum(SUPPORTED_LANGUAGES as ['en', 'tr']).default('en'), [{ names: ['DECKENT_LANGUAGE', 'DECKENT_LANG'] }]),
  output_mode: field('config.field.output_mode', { state: 'bound', consumers: ['src/platform/core/output'] }, 'live', z.enum(OUTPUT_MODES).default('standard')),
  layout: field('config.field.layout', { state: 'bound', consumers: ['src/platform/core/config'] }, 'restart', z.object({ root: z.string().min(1).nullable().default(null), resources: z.record(z.string().min(1)).default({}) }).strict().default({}),
    [{ names: [PRODUCT_LAYOUT_REGISTRY.rootEnvironmentKey], path: ['root'] }], LAYOUT_CONTRACT_SINCE),
  storage: field('config.field.storage', { state: 'bound', consumers: ['src/composition/core/storage'] }, 'restart', z.object({ driver: z.literal('sqlite').default('sqlite'),
    sqlite: SQLITE_STORAGE_OPTIONS.default({ busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }) }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  artifacts: field('config.field.artifacts', { state: 'bound', consumers: ['src/composition/core/artifacts'] }, 'restart', ARTIFACT_STORAGE_LIMITS.extend({ maxInputs: z.number().int().positive().safe().default(64), patchPreview: z.object({ maxEntries: z.number().int().positive().safe().default(10000), maxDepth: z.number().int().positive().max(128).default(32), maxPathBytes: z.number().int().positive().safe().default(1024) }).strict().default({ maxEntries: 10000, maxDepth: 32, maxPathBytes: 1024 }) }).default({ maxBytes: 16777216 }), [], LAYOUT_CONTRACT_SINCE),
  execution: field('config.field.execution', { state: 'bound', consumers: ['src/composition/core/execution', 'src/composition/core/runs'] }, 'restart', z.object({ docker: DOCKER_EXECUTION_SETTINGS, git: GIT_EXECUTION_SETTINGS, adoption: ADOPTION_TARGET_SETTINGS.default({ targets: [] }),
    workTargets: WORK_TARGET_SETTINGS.optional(), retention: EXECUTION_RETENTION_SETTINGS.default({ schemaVersion: 1 }) }).strict().nullable().default(null), [], LAYOUT_CONTRACT_SINCE),
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
  approvals: field('config.field.approvals', { state: 'bound', consumers: ['src/composition/core/approvals'] }, 'restart', z.object({
    requestTtlMs: z.number().int().positive().safe().default(600000),
    sessionTtlMs: z.number().int().positive().safe().default(60000),
    pageSize: z.number().int().positive().safe().default(100),
    keyFile: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).default('authority.key'),
  }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  cli: field('config.field.cli', { state: 'bound', consumers: ['src/surfaces/core/cli'] }, 'live', z.object({ graphInputMaxBytes: z.number().int().positive().safe().default(1048576), invocationInputMaxBytes: z.number().int().positive().safe().default(1048576) }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  mcp: field('config.field.mcp', { state: 'bound', consumers: ['src/composition/core/agent-turn'] }, 'restart', z.object({
    inputMaxBytes: z.number().int().positive().safe().default(1048576),
    responseMaxBytes: z.number().int().positive().safe().default(1048576),
    maxConcurrentCalls: z.number().int().positive().safe().default(8),
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
  }).strict().superRefine((value, context) => { if (value.maxConcurrentExecutions >= value.maxConcurrentRequests) context.addIssue({ code: z.ZodIssueCode.custom, path: ['maxConcurrentExecutions'], message: 'SERVICE_EXECUTIONS_CAPACITY' }); }).default({}), [], LAYOUT_CONTRACT_SINCE),
  cancellation: field('config.field.cancellation', { state: 'bound', consumers: ['src/composition/core/runtime'] }, 'restart', z.object({ maxConcurrentDeliveries: z.number().int().positive().safe(),
    recoveryPageSize: z.number().int().positive().safe().default(64),
    maxAttempts: z.number().int().positive().safe().default(3), retryDelayMs: z.number().int().positive().safe().default(1000),
    claimTtlMs: z.number().int().positive().safe().default(30000),
  }).strict().nullable().default(null), [], LAYOUT_CONTRACT_SINCE),
  runRuntime: field('config.field.runRuntime', { state: 'bound', consumers: ['src/composition/core/run-progression'] }, 'restart', z.object({
    parking: RUN_PARKING_SETTINGS.default({ schemaVersion: 1 }),
    maxConcurrentRuns: z.number().int().positive().safe().default(SERVICE_EXECUTION_CAPACITY_DEFAULT),
    maxReservationsPerTurn: z.number().int().positive().safe().default(4),
    pollIntervalMs: z.number().int().positive().max(2147483647).default(1000),
    failureBackoffMs: z.number().int().positive().max(2147483647).default(5000),
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
  enforce_principal_assurance: field('config.field.enforce_principal_assurance', { state: 'bound', consumers: ['src/surfaces/core/cli'] }, 'live', z.boolean().default(false)),
});
type FieldShape = { [K in keyof typeof CONFIG_FIELDS]: typeof CONFIG_FIELDS[K]['schema'] };
export const CORE_SCHEMA = z.object(Object.fromEntries(
  Object.entries(CONFIG_FIELDS).map(([name, definition]) => [name, definition.schema]),
) as FieldShape).strict();

export const CONFIG_ENVIRONMENT_KEYS = Object.freeze([...new Set(Object.values(CONFIG_FIELDS)
  .flatMap(field => field.environment.flatMap(binding => binding.names)))]);

export function getConfigFieldDefault<K extends keyof typeof CONFIG_FIELDS>(key: K): z.output<typeof CONFIG_FIELDS[K]['schema']> {
  return CONFIG_FIELDS[key].schema.parse(undefined);
}
