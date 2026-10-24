import { z } from 'zod';
import { counterSchema, createImmutableJsonObjectSchema, identitySchema, sanitizeIssues, type ValidationIssue } from '#domain/core/primitives/index.js';
import { CATALOG_CHANNEL_KINDS, NATIVE_CLI_CHANNELS, MODEL_LIFECYCLE_STATES, REASONING_EFFORTS, exactModelIdSchema, daySchema, cliVersionSchema, aliasesSchema } from './catalog-values.js';
import { channelMetadataSchema, modelMetadataSchema, reportedModelNameSchema, channelReportedNamesSchema } from './catalog-metadata.js';
import { PROVIDER_CATALOG_WIRE_LIMITS, ProviderCatalogError, providerProtocolSchema } from './catalog.js';

/**
 * Provider catalog document, schemaVersion 2/3 (WORKER-CURRENCY-1, owner 2026-09-30): the v1 declaration plus what a model catalog entry needs to be
 * selectable — a provider is a *channel* (how the model is reached: API key, CLI subscription, local server …) and each model carries
 * its exact API model id (`nativeId`), lifecycle, CLI minimum and supported reasoning efforts. The ledger catalog (v43) stores one row
 * per (channel id = provider id, exact model id); this document is the one authored shape it is written from. v1 stays byte-identical,
 * so the chat binding digests of v1 declarations never change. V3 metadata is additive, explicit and strictly validated.
 */
export const PROVIDER_CATALOG_DOCUMENT_SCHEMA_VERSION = 3;
export { CATALOG_CHANNEL_KINDS, NATIVE_CLI_CHANNELS, MODEL_LIFECYCLE_STATES, REASONING_EFFORTS, EXACT_MODEL_ID_MAX_LENGTH, exactModelIdSchema } from './catalog-values.js';
export const modelLifecycleSchema = z.object({ state: z.enum(MODEL_LIFECYCLE_STATES), deprecatedOn: daySchema.nullable(),
  retireNotBefore: daySchema.nullable(), retiredOn: daySchema.nullable(), replacementModelId: exactModelIdSchema.optional(),
  source: z.object({ url: z.string().url().max(512).startsWith('https://'), observedOn: daySchema }).strict().readonly().nullable(),
}).strict().readonly();
const channelV2 = z.object({ kind: z.enum(CATALOG_CHANNEL_KINDS), cli: z.enum(NATIVE_CLI_CHANNELS).nullable(),
  aliases: aliasesSchema }).strict();
/** The v1 model fields (id, version, nativeId, protocols) with the exact-id grammar, plus the selection data. */
const modelV2 = z.object({ id: identitySchema, version: counterSchema.positive(), nativeId: exactModelIdSchema,
  protocols: z.array(providerProtocolSchema).min(1).readonly(), lifecycle: modelLifecycleSchema,
  minCliVersion: cliVersionSchema.nullable(), efforts: z.array(z.enum(REASONING_EFFORTS)).max(REASONING_EFFORTS.length).readonly(),
  aliases: aliasesSchema,
  effortBinding: z.object({ mode: z.literal('fixed-model'), level: z.enum(REASONING_EFFORTS) }).strict().readonly().optional(),
}).strict();
// Additive record metadata: old admission fields are retained and must agree, never a second source of authority.
const channelV3 = channelV2.extend(channelMetadataSchema.shape).refine(c => c.client === c.cli
  && JSON.stringify(c.aliasesRefused) === JSON.stringify(c.aliases));
const modelV3 = modelV2.extend(modelMetadataSchema.shape).refine(m => m.channelModelId === m.nativeId
  && m.minClientVersion === m.minCliVersion && JSON.stringify(m.reasoning.supportedEfforts) === JSON.stringify(m.efforts)
  && (m.reasoning.defaultEffort === null || m.reasoning.supportedEfforts.includes(m.reasoning.defaultEffort)));
export const catalogChannelSchema = z.union([channelV3, channelV2]).readonly();
export const catalogModelSchema = z.union([modelV3, modelV2]).readonly();
const provider = { id: identitySchema, version: counterSchema.positive() };
const document = { revision: identitySchema };
export const providerCatalogDocumentSchema = z.discriminatedUnion('schemaVersion', [
  z.object({ ...document, schemaVersion: z.literal(2), providers: z.array(z.object({ ...provider,
    channel: channelV2.readonly(), models: z.array(modelV2.readonly()).readonly() }).strict().readonly()).readonly() }).strict(),
  z.object({ ...document, schemaVersion: z.literal(3), providers: z.array(z.object({ ...provider,
    channel: channelV3.readonly(), models: z.array(modelV3.readonly()).readonly() }).strict().readonly()).readonly(),
    recommendedActivations: z.array(z.object({ channelId: identitySchema, modelIds: z.array(exactModelIdSchema).readonly() }).strict().readonly()).readonly().optional(),
  }).strict(),
]);

export type ProviderCatalogDocument = Readonly<z.infer<typeof providerCatalogDocumentSchema>>;
export type CatalogChannel = z.infer<typeof catalogChannelSchema>;
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type ModelLifecycle = z.infer<typeof modelLifecycleSchema>;

/** Session-start reported names (owner K1 2026-10-22) of a channel's FINAL model set: only on a native CLI channel, no name repeats within
 * a model or is claimed by two models — one reported name maps to exactly one exact id — and the channel total stays within its bound.
 * Shared by document parsing and the partial ledger merge. */
export function reportedNameConflict(channel: CatalogChannel, models: readonly CatalogModel[]): boolean {
  const seen = new Set<string>();
  for (const model of models) {
    const names = 'reportedNames' in model ? model.reportedNames ?? [] : [];
    if ((names.length > 0 || ('selection' in model && model.selection !== undefined)) && channel.kind !== 'native-cli') return true;
    for (const { name } of names) { if (seen.has(name)) return true; seen.add(name); }
  }
  return !channelReportedNamesSchema.safeParse([...seen]).success;
}
/** M4 connect terms belong to an HTTP API channel's models only (a CLI or local channel never carries an adapter tariff or route). */
export function connectTermsMisplaced(channel: CatalogChannel, models: readonly CatalogModel[]): boolean {
  return channel.kind !== 'http-api' && models.some(model => 'connect' in model && model.connect !== undefined);
}
/**
 * Catalog-derived model evidence a FROZEN worker pin may carry (owner K1/K2 2026-10-22), stamped at admission from the channel's catalog rows
 * and present only when the catalog records it, so pins without it keep their exact bytes. `reportedNames`: the session-start names of the
 * admitted model; `otherReportedNames`: names the channel's other models claim; `providerChosen`: the admitted entry leaves the model choice
 * to the provider. Only the frozen execution-profile pin carries these fields; a Run graph request pin never does. One shape for every copy.
 */
export const workerModelPinEvidenceShape = {
  reportedNames: z.array(reportedModelNameSchema).min(1).max(16).readonly().optional(),
  otherReportedNames: channelReportedNamesSchema.refine(names => names.length > 0).optional(),
  providerChosen: z.literal(true).optional(),
} as const;
/** The evidence of one admitted model, derived from its channel's catalog rows (bounded by the channel check); sorted for stable bytes. */
export type CatalogPinModelEvidence = Readonly<{ reportedNames?: readonly string[]; otherReportedNames?: readonly string[]; providerChosen?: true }>;
export function catalogPinModelEvidence(models: readonly CatalogModel[], modelId: string): CatalogPinModelEvidence {
  const names = (model: CatalogModel) => 'reportedNames' in model ? (model.reportedNames ?? []).map(entry => entry.name) : [];
  const admitted = models.find(model => model.nativeId === modelId);
  const own = admitted ? [...new Set(names(admitted))].sort() : [];
  const others = [...new Set(models.filter(model => model.nativeId !== modelId).flatMap(names))].filter(name => !own.includes(name)).sort();
  return Object.freeze({ ...(own.length ? { reportedNames: Object.freeze(own) } : {}), ...(others.length ? { otherReportedNames: Object.freeze(others) } : {}),
    ...(admitted && 'selection' in admitted && admitted.selection === 'provider' ? { providerChosen: true as const } : {}) });
}
/** Channel invariants: one version per channel id, one entry per exact id, no alias shadowing an exact id, CLI data only on CLI channels. */
function channelIssues(catalog: ProviderCatalogDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (...path: (string | number)[]) => issues.push(Object.freeze({ path: Object.freeze(path), code: 'custom' }));
  const channels = new Set<string>();
  catalog.providers.forEach((provider, p) => {
    if (channels.has(provider.id)) issue('providers', p, 'id'); channels.add(provider.id);
    if ((provider.channel.kind === 'native-cli') !== (provider.channel.cli !== null)) issue('providers', p, 'channel');
    const exact = new Set<string>(), models = new Set<string>(), aliases = new Set<string>();
    provider.models.forEach((model, m) => {
      if (exact.has(model.nativeId)) issue('providers', p, 'models', m, 'nativeId'); exact.add(model.nativeId);
      if (models.has(`${model.id}\0${model.version}`)) issue('providers', p, 'models', m, 'id'); models.add(`${model.id}\0${model.version}`);
      if (model.minCliVersion !== null && provider.channel.kind !== 'native-cli') issue('providers', p, 'models', m, 'minCliVersion');
      if (model.effortBinding && (provider.channel.kind !== 'native-cli' || model.efforts.length !== 1 || model.efforts[0] !== model.effortBinding.level)) issue('providers', p, 'models', m, 'effortBinding');
      if (new Set(model.efforts).size !== model.efforts.length) issue('providers', p, 'models', m, 'efforts');
      // A retired entry names its day; any other state may carry an announced retirement day, after which admission treats it as retired.
      if (model.lifecycle.state === 'retired' && model.lifecycle.retiredOn === null) issue('providers', p, 'models', m, 'lifecycle');
    });
    [...provider.channel.aliases, ...provider.models.flatMap(model => model.aliases)].forEach((alias, a) => {
      if (exact.has(alias) || aliases.has(alias)) issue('providers', p, 'aliases', a); aliases.add(alias);
    });
    if (reportedNameConflict(provider.channel, provider.models)) issue('providers', p, 'reportedNames');
    if (connectTermsMisplaced(provider.channel, provider.models)) issue('providers', p, 'connect');
  });
  if (catalog.schemaVersion === 3) {
    const seen = new Set<string>();
    for (const recommendation of catalog.recommendedActivations ?? []) {
      const provider = catalog.providers.find(p => p.id === recommendation.channelId);
      if (!provider || seen.has(recommendation.channelId) || new Set(recommendation.modelIds).size !== recommendation.modelIds.length
        || recommendation.modelIds.some(id => !provider.models.some(m => m.nativeId === id))) issue('recommendedActivations');
      seen.add(recommendation.channelId);
    }
  }
  return issues;
}
const envelope = createImmutableJsonObjectSchema(PROVIDER_CATALOG_WIRE_LIMITS);
const byText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
/** Strict, bounded, canonical (sorted) v2/v3 document. v1 input is not accepted here; it keeps parseProviderCatalog. */
export function parseProviderCatalogDocument(input: unknown): ProviderCatalogDocument {
  const copied = envelope.safeParse(input);
  if (!copied.success) throw new ProviderCatalogError('PROVIDER_CATALOG_INVALID', sanitizeIssues(copied.error.issues));
  const parsed = providerCatalogDocumentSchema.safeParse(copied.data);
  if (!parsed.success) throw new ProviderCatalogError('PROVIDER_CATALOG_INVALID', sanitizeIssues(parsed.error.issues));
  const issues = channelIssues(parsed.data);
  if (issues.length) throw new ProviderCatalogError('PROVIDER_CATALOG_DUPLICATE', Object.freeze(issues));
  return Object.freeze(providerCatalogDocumentSchema.parse({ ...parsed.data, providers: parsed.data.providers
    .map(provider => ({ ...provider, models: [...provider.models].sort((a, b) => byText(a.nativeId, b.nativeId)) }))
    .sort((a, b) => byText(a.id, b.id)) }));
}
