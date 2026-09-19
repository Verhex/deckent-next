import { z } from 'zod';
import { counterSchema, createImmutableJsonObjectSchema, identitySchema, sanitizeIssues,
  type ValidationIssue } from '#domain/core/primitives/index.js';

export const PROVIDER_CATALOG_SCHEMA_VERSION = 1;
export const PROVIDER_CATALOG_WIRE_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 262_144,
  maxCodeUnits: 8 * 1024 * 1024,
});
export const NATIVE_MODEL_ID_MAX_LENGTH = 1024;

const nativeIdSchema = z.string().min(1).max(NATIVE_MODEL_ID_MAX_LENGTH).refine(value => value.trim() === value &&
  ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
const capabilitySchema = z.object({
  id: identitySchema,
  version: counterSchema.positive(),
  state: z.enum(['supported', 'unsupported', 'unknown']),
}).strict().readonly();
const protocolSchema = z.object({
  family: identitySchema,
  version: identitySchema,
  capabilities: z.array(capabilitySchema).readonly(),
}).strict().readonly();
const modelSchema = z.object({
  id: identitySchema,
  version: counterSchema.positive(),
  nativeId: nativeIdSchema,
  protocols: z.array(protocolSchema).min(1).readonly(),
}).strict().readonly();
const providerSchema = z.object({
  id: identitySchema,
  version: counterSchema.positive(),
  models: z.array(modelSchema).readonly(),
}).strict().readonly();
/** Strict structural schema suitable for the config-section registry. Cross-reference admission lives in parseProviderCatalog. */
export const providerCatalogObjectSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CATALOG_SCHEMA_VERSION),
  revision: identitySchema,
  providers: z.array(providerSchema).readonly(),
}).strict();

export type ProviderCatalog = Readonly<z.infer<typeof providerCatalogObjectSchema>>;
export type ProviderCatalogErrorCode = 'PROVIDER_CATALOG_INVALID' | 'PROVIDER_CATALOG_DUPLICATE';
export class ProviderCatalogError extends Error {
  constructor(readonly code: ProviderCatalogErrorCode, readonly issues: readonly ValidationIssue[] = []) {
    super(code); this.name = 'ProviderCatalogError';
  }
}

const catalogEnvelopeSchema = createImmutableJsonObjectSchema(PROVIDER_CATALOG_WIRE_LIMITS);
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const compareTuple = (left: readonly [string, string | number], right: readonly [string, string | number]): number =>
  compareText(left[0], right[0]) || (typeof left[1] === 'number' && typeof right[1] === 'number'
    ? left[1] - right[1] : compareText(String(left[1]), String(right[1])));

function duplicateIssues(catalog: ProviderCatalog): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const inspect = <T>(values: readonly T[], key: (value: T) => string, base: readonly (string | number)[]) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const encoded = key(value);
      if (seen.has(encoded)) issues.push(Object.freeze({ path: Object.freeze([...base, index]), code: 'custom' }));
      else seen.add(encoded);
    });
  };
  inspect(catalog.providers, value => `${value.id}\0${value.version}`, ['providers']);
  catalog.providers.forEach((provider, providerIndex) => {
    inspect(provider.models, value => `${value.id}\0${value.version}`, ['providers', providerIndex, 'models']);
    provider.models.forEach((model, modelIndex) => {
      inspect(model.protocols, value => `${value.family}\0${value.version}`, ['providers', providerIndex, 'models', modelIndex, 'protocols']);
      model.protocols.forEach((protocol, protocolIndex) => inspect(protocol.capabilities,
        value => `${value.id}\0${value.version}`, ['providers', providerIndex, 'models', modelIndex, 'protocols', protocolIndex, 'capabilities']));
    });
  });
  return issues;
}

export function parseProviderCatalog(input: unknown): ProviderCatalog {
  const copied = catalogEnvelopeSchema.safeParse(input);
  if (!copied.success) throw new ProviderCatalogError('PROVIDER_CATALOG_INVALID', sanitizeIssues(copied.error.issues));
  const parsed = providerCatalogObjectSchema.safeParse(copied.data);
  if (!parsed.success) throw new ProviderCatalogError('PROVIDER_CATALOG_INVALID', sanitizeIssues(parsed.error.issues));
  const duplicates = duplicateIssues(parsed.data);
  if (duplicates.length) throw new ProviderCatalogError('PROVIDER_CATALOG_DUPLICATE', Object.freeze(duplicates));
  const sorted = {
    ...parsed.data,
    providers: parsed.data.providers.map(provider => ({ ...provider,
      models: provider.models.map(model => ({ ...model,
        protocols: model.protocols.map(protocol => ({ ...protocol,
          capabilities: [...protocol.capabilities].sort((a, b) => compareTuple([a.id, a.version], [b.id, b.version])),
        })).sort((a, b) => compareTuple([a.family, a.version], [b.family, b.version])),
      })).sort((a, b) => compareTuple([a.id, a.version], [b.id, b.version])),
    })).sort((a, b) => compareTuple([a.id, a.version], [b.id, b.version])),
  };
  return Object.freeze(providerCatalogObjectSchema.parse(sorted));
}
