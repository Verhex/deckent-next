import { z } from 'zod';
import { CONFIG_SCHEMA_VERSION, OUTPUT_MODES } from '../../common/index.js';
import { SUPPORTED_LANGUAGES } from '../../i18n/index.js';

type EnvironmentBinding = { readonly names: readonly string[]; readonly path?: readonly string[]; readonly encoding?: 'boolean' };
function field<T extends z.ZodTypeAny>(schema: T, environment: readonly EnvironmentBinding[] = []) {
  return Object.freeze({ schema, environment });
}
const providerId = z.string().trim().min(1).nullable().default(null);
/** Single declaration of mutable config policy. Consumers derive, never duplicate, these values. */
export const CONFIG_FIELDS = Object.freeze({
  schema_version: field(z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION)),
  language: field(z.enum(SUPPORTED_LANGUAGES as ['en', 'tr']).default('en'), [{ names: ['DECKENT_LANGUAGE', 'DECKENT_LANG'] }]),
  mode: field(z.enum(['performance', 'balanced', 'economic', 'api']).default('performance'), [{ names: ['DECKENT_MODE'] }]),
  output_mode: field(z.enum(OUTPUT_MODES).default('standard')),
  projectName: field(z.string().min(1).default('deckent-project')),
  max_workers: field(z.union([z.number().int().positive().safe(), z.literal('auto')]).default('auto')),
  enforce_principal_assurance: field(z.boolean().default(false)),
  strict_tenant_isolation: field(z.boolean().default(false)),
  tenant_id: field(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default('local')),
  auth_mode: field(z.enum(['subscription', 'api', 'hybrid', 'local']).default('subscription')),
  spawn_backend: field(z.enum(['auto', 'docker', 'subprocess', 'tmux']).default('auto')),
  live_trace: field(z.object({ enabled: z.boolean().default(false) }).strict().default({}),
    [{ names: ['DECKENT_LIVE_TRACE'], path: ['enabled'], encoding: 'boolean' }]),
  providers: field(z.object({ brain: providerId, worker: providerId, fallback: providerId,
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
