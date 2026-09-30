import { z } from 'zod';
import { counterSchema, createImmutableJsonObjectSchema, identitySchema, sanitizeIssues, type ValidationIssue } from '#domain/core/primitives/index.js';
import { NATIVE_MODEL_ID_MAX_LENGTH, PROVIDER_CATALOG_WIRE_LIMITS, ProviderCatalogError, providerProtocolSchema } from './catalog.js';

/**
 * Provider catalog document, schemaVersion 2 (WORKER-CURRENCY-1, owner 2026-09-30): the v1 declaration plus what a model catalog entry needs to be
 * selectable — a provider is a *channel* (how the model is reached: API key, CLI subscription, local server …) and each model carries
 * its exact API model id (`nativeId`), lifecycle, CLI minimum and supported reasoning efforts. The ledger catalog (v43) stores one row
 * per (channel id = provider id, exact model id); this document is the one authored shape it is written from. v1 stays byte-identical,
 * so the chat binding digests of v1 declarations never change. No field has a default: every v2 value is authored explicitly.
 */
export const PROVIDER_CATALOG_DOCUMENT_SCHEMA_VERSION = 2;
/** How a channel reaches its models: a subscription CLI inside the worker image, an HTTP API with a key, or a local server. */
export const CATALOG_CHANNEL_KINDS = Object.freeze(['native-cli', 'http-api', 'local-server'] as const);
export const NATIVE_CLI_CHANNELS = Object.freeze(['claude', 'codex', 'cursor'] as const);
export const MODEL_LIFECYCLE_STATES = Object.freeze(['active', 'legacy', 'deprecated', 'retired'] as const);
export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const);
export const EXACT_MODEL_ID_MAX_LENGTH = 256;
const CATALOG_ALIAS_MAX = 64;

/** An exact model id as a provider's API names it: printable, trimmed, never option-like. Aliases share the grammar and are data. */
export const exactModelIdSchema = z.string().min(1).max(Math.min(EXACT_MODEL_ID_MAX_LENGTH, NATIVE_MODEL_ID_MAX_LENGTH)).refine(value => value.trim() === value
  && !value.startsWith('-') && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
/** A calendar day (UTC, ISO 8601 `YYYY-MM-DD`); validated arithmetically so the domain stays clock-free. */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
});
const cliVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/).max(64);
const aliasesSchema = z.array(exactModelIdSchema).max(CATALOG_ALIAS_MAX).readonly();
export const modelLifecycleSchema = z.object({ state: z.enum(MODEL_LIFECYCLE_STATES), deprecatedOn: daySchema.nullable(),
  retireNotBefore: daySchema.nullable(), retiredOn: daySchema.nullable(),
  source: z.object({ url: z.string().url().max(512).startsWith('https://'), observedOn: daySchema }).strict().readonly().nullable(),
}).strict().readonly();
export const catalogChannelSchema = z.object({ kind: z.enum(CATALOG_CHANNEL_KINDS), cli: z.enum(NATIVE_CLI_CHANNELS).nullable(),
  aliases: aliasesSchema }).strict().readonly();
/** The v1 model fields (id, version, nativeId, protocols) with the exact-id grammar, plus the selection data. */
export const catalogModelSchema = z.object({ id: identitySchema, version: counterSchema.positive(), nativeId: exactModelIdSchema,
  protocols: z.array(providerProtocolSchema).min(1).readonly(), lifecycle: modelLifecycleSchema,
  minCliVersion: cliVersionSchema.nullable(), efforts: z.array(z.enum(REASONING_EFFORTS)).max(REASONING_EFFORTS.length).readonly(),
  aliases: aliasesSchema }).strict().readonly();
const catalogProviderSchema = z.object({ id: identitySchema, version: counterSchema.positive(), channel: catalogChannelSchema,
  models: z.array(catalogModelSchema).readonly() }).strict().readonly();
export const providerCatalogDocumentSchema = z.object({ schemaVersion: z.literal(PROVIDER_CATALOG_DOCUMENT_SCHEMA_VERSION), revision: identitySchema,
  providers: z.array(catalogProviderSchema).readonly() }).strict();

export type ProviderCatalogDocument = Readonly<z.infer<typeof providerCatalogDocumentSchema>>;
export type CatalogChannel = z.infer<typeof catalogChannelSchema>;
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type ModelLifecycle = z.infer<typeof modelLifecycleSchema>;

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
      if (new Set(model.efforts).size !== model.efforts.length) issue('providers', p, 'models', m, 'efforts');
      if ((model.lifecycle.state === 'retired') !== (model.lifecycle.retiredOn !== null)) issue('providers', p, 'models', m, 'lifecycle');
    });
    [...provider.channel.aliases, ...provider.models.flatMap(model => model.aliases)].forEach((alias, a) => {
      if (exact.has(alias) || aliases.has(alias)) issue('providers', p, 'aliases', a); aliases.add(alias);
    });
  });
  return issues;
}
const envelope = createImmutableJsonObjectSchema(PROVIDER_CATALOG_WIRE_LIMITS);
const byText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
/** Strict, bounded, canonical (sorted) v2 document. v1 input is not accepted here; it keeps parseProviderCatalog. */
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
