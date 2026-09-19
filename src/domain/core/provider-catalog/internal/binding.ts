import { z } from 'zod';
import { counterSchema, createImmutableJsonObjectSchema, identitySchema, immutableJsonObjectSchema, sanitizeIssues } from '#domain/core/primitives/index.js';
import { parseProviderCatalog, PROVIDER_CATALOG_WIRE_LIMITS, ProviderCatalogError, type ProviderCatalog } from './catalog.js';

export const MODEL_BINDING_ENCODING_VERSION = 1;
export const MODEL_BINDING_PREFIX = 'deckent.model-binding.v1\n';

export const modelReferenceSchema = z.object({
  providerId: identitySchema,
  providerVersion: counterSchema.positive(),
  modelId: identitySchema,
  modelVersion: counterSchema.positive(),
}).strict();

export type ModelReference = Readonly<z.infer<typeof modelReferenceSchema>>;
export type ModelBindingDefinition = Readonly<{
  encodingVersion: 1;
  provider: Readonly<{ id: string; version: number }>;
  model: ProviderCatalog['providers'][number]['models'][number];
}>;

export function parseModelReference(input: unknown): ModelReference {
  const copied = immutableJsonObjectSchema.safeParse(input);
  if (!copied.success) throw new ProviderCatalogError('PROVIDER_CATALOG_INVALID', sanitizeIssues(copied.error.issues));
  const parsed = modelReferenceSchema.safeParse(copied.data);
  if (!parsed.success) throw new ProviderCatalogError('PROVIDER_CATALOG_INVALID', sanitizeIssues(parsed.error.issues));
  return Object.freeze(parsed.data);
}

/** Exact lookup only: no version selection, alias, default or fallback behavior. */
export function resolveModelBindingDefinition(catalogInput: unknown, referenceInput: unknown): ModelBindingDefinition | null {
  const catalog = parseProviderCatalog(catalogInput), reference = parseModelReference(referenceInput);
  const provider = catalog.providers.find(candidate => candidate.id === reference.providerId && candidate.version === reference.providerVersion);
  const model = provider?.models.find(candidate => candidate.id === reference.modelId && candidate.version === reference.modelVersion);
  if (!provider || !model) return null;
  return Object.freeze({ encodingVersion: MODEL_BINDING_ENCODING_VERSION,
    provider: Object.freeze({ id: provider.id, version: provider.version }), model });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

const definitionShape = z.object({
  encodingVersion: z.literal(MODEL_BINDING_ENCODING_VERSION),
  provider: z.object({ id: identitySchema, version: counterSchema.positive() }).strict(),
  model: z.unknown(),
}).strict();
const definitionEnvelopeSchema = createImmutableJsonObjectSchema(PROVIDER_CATALOG_WIRE_LIMITS);

function parseDefinition(input: unknown): ModelBindingDefinition {
  const copied = definitionEnvelopeSchema.safeParse(input);
  if (!copied.success) throw new ProviderCatalogError('PROVIDER_CATALOG_INVALID', sanitizeIssues(copied.error.issues));
  const shaped = definitionShape.safeParse(copied.data);
  if (!shaped.success) throw new ProviderCatalogError('PROVIDER_CATALOG_INVALID', sanitizeIssues(shaped.error.issues));
  const catalog = parseProviderCatalog({ schemaVersion: 1, revision: 'model-binding-definition', providers: [
    { id: shaped.data.provider.id, version: shaped.data.provider.version, models: [shaped.data.model] },
  ] });
  const model = catalog.providers[0]?.models[0];
  if (!model) throw new ProviderCatalogError('PROVIDER_CATALOG_INVALID');
  return Object.freeze({ encodingVersion: MODEL_BINDING_ENCODING_VERSION,
    provider: Object.freeze({ ...shaped.data.provider }), model });
}

/** UTF-16 key ordering with ECMAScript JSON scalar encoding; this is deliberately not an RFC-JCS claim. */
export function encodeModelBindingDefinition(definitionInput: unknown): string {
  return `${MODEL_BINDING_PREFIX}${canonicalJson(parseDefinition(definitionInput))}`;
}
