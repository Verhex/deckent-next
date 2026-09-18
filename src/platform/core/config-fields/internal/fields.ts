import { DOCKER_EXECUTION_SETTINGS, GIT_EXECUTION_SETTINGS, ARTIFACT_STORAGE_LIMITS } from './execution.js';
import { SQLITE_STORAGE_OPTIONS } from './storage.js';
import { z } from 'zod';
import { PRODUCT_LAYOUT_REGISTRY, LAYOUT_CONTRACT_SINCE, CONFIG_SCHEMA_VERSION, CONFIG_CONTRACT_SINCE, OUTPUT_MODES } from '#platform/core/common/index.js';
import { SUPPORTED_LANGUAGES } from '#platform/core/i18n/index.js';

type EnvironmentBinding = { readonly names: readonly string[]; readonly path?: readonly string[]; readonly encoding?: 'boolean' };
function field<T extends z.ZodTypeAny>(descriptionKey: string, schema: T, environment: readonly EnvironmentBinding[] = [], since = CONFIG_CONTRACT_SINCE) {
  return Object.freeze({ schema, environment, metadata: Object.freeze({ descriptionKey, tier: 'core' as const, since }) });
}
const providerId = z.string().trim().min(1).nullable().default(null);
/** Single declaration of mutable config policy. Consumers derive, never duplicate, these values. */
export const CONFIG_FIELDS = Object.freeze({
  schema_version: field('config.field.schema_version', z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION)),
  language: field('config.field.language', z.enum(SUPPORTED_LANGUAGES as ['en', 'tr']).default('en'), [{ names: ['DECKENT_LANGUAGE', 'DECKENT_LANG'] }]),
  mode: field('config.field.mode', z.enum(['performance', 'balanced', 'economic', 'api']).default('performance'), [{ names: ['DECKENT_MODE'] }]),
  output_mode: field('config.field.output_mode', z.enum(OUTPUT_MODES).default('standard')),
  layout: field('config.field.layout', z.object({ root: z.string().min(1).nullable().default(null), resources: z.record(z.string().min(1)).default({}) }).strict().default({}),
    [{ names: [PRODUCT_LAYOUT_REGISTRY.rootEnvironmentKey], path: ['root'] }], LAYOUT_CONTRACT_SINCE),
  storage: field('config.field.storage', z.object({ driver: z.literal('sqlite').default('sqlite'),
    sqlite: SQLITE_STORAGE_OPTIONS.default({ busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }) }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  artifacts: field('config.field.artifacts', ARTIFACT_STORAGE_LIMITS.default({ maxBytes: 16777216 }), [], LAYOUT_CONTRACT_SINCE),
  execution: field('config.field.execution', z.object({ docker: DOCKER_EXECUTION_SETTINGS, git: GIT_EXECUTION_SETTINGS }).strict().nullable().default(null), [], LAYOUT_CONTRACT_SINCE),
  cli: field('config.field.cli', z.object({ graphInputMaxBytes: z.number().int().positive().safe().default(1048576) }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  mcp: field('config.field.mcp', z.object({
    inputMaxBytes: z.number().int().positive().safe().default(1048576),
    responseMaxBytes: z.number().int().positive().safe().default(1048576),
    maxConcurrentCalls: z.number().int().positive().safe().default(8),
  }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  cancellation: field('config.field.cancellation', z.object({ maxConcurrentDeliveries: z.number().int().positive().safe(),
    recoveryPageSize: z.number().int().positive().safe().default(64),
    maxAttempts: z.number().int().positive().safe().default(3), retryDelayMs: z.number().int().positive().safe().default(1000),
    claimTtlMs: z.number().int().positive().safe().default(30000),
  }).strict().nullable().default(null), [], LAYOUT_CONTRACT_SINCE),
  admission: field('config.field.admission', z.object({ registry: z.record(z.unknown()), poolId: z.string().min(1),
    executionSlots: z.number().int().positive().safe(), inFlightSlots: z.number().int().positive().safe(),
    ordering: z.literal('input-order'),
  }).strict().nullable().default(null), [], LAYOUT_CONTRACT_SINCE),
  inspection: field('config.field.inspection', z.object({
    maxPageSize: z.number().int().positive().max(2_147_483_646).default(64),
    policyMaxBytes: z.number().int().positive().safe().default(1048576),
  }).strict().default({}), [], LAYOUT_CONTRACT_SINCE),
  projectName: field('config.field.projectName', z.string().min(1).default('deckent-project')),
  max_workers: field('config.field.max_workers', z.union([z.number().int().positive().safe(), z.literal('auto')]).default('auto')),
  enforce_principal_assurance: field('config.field.enforce_principal_assurance', z.boolean().default(false)),
  strict_tenant_isolation: field('config.field.strict_tenant_isolation', z.boolean().default(false)),
  tenant_id: field('config.field.tenant_id', z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default('local')),
  auth_mode: field('config.field.auth_mode', z.enum(['subscription', 'api', 'hybrid', 'local']).default('subscription')),
  spawn_backend: field('config.field.spawn_backend', z.enum(['auto', 'docker', 'subprocess', 'tmux']).default('auto')),
  live_trace: field('config.field.live_trace', z.object({ enabled: z.boolean().default(false) }).strict().default({}),
    [{ names: ['DECKENT_LIVE_TRACE'], path: ['enabled'], encoding: 'boolean' }]),
  providers: field('config.field.providers', z.object({ brain: providerId, worker: providerId, fallback: providerId,
    overrides: z.record(z.string()).default({}) }).strict().default({}), [
    { names: ['DECKENT_BRAIN_PROVIDER'], path: ['brain'] },
    { names: ['DECKENT_WORKER_PROVIDER'], path: ['worker'] },
  ]),
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
