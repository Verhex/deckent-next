import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createImmutableJsonObjectSchema, type JsonObject } from '#domain/index.js';
import { maxRate } from './decimal.js';
import { chargeDimensions, endpointRates, type TariffRates } from './rates.js';
import { OpenRouterPricingError } from './error.js';
import PRIVACY_LIMITS from './privacy-limits.json' with { type: 'json' };
export const OPENROUTER_TARIFF_VERSION = 2 as const;
const boundedMetadata = createImmutableJsonObjectSchema({ maxDepth: 16, maxNodes: 65_536, maxCodeUnits: 1_048_576 });
const identity = z.string().min(1).max(1024), integer = z.number().int().nonnegative().safe();
const selectionSchema = z.object({ modelId: identity, endpointTag: identity,
  fetchedAtMs: integer, expiresAtMs: integer }).strict();
const endpointSchema = z.object({ model_id: identity, tag: identity, provider_name: identity,
  context_length: integer.positive(), max_prompt_tokens: integer.positive().nullable(),
  max_completion_tokens: integer.positive().nullable(), status: z.number().int(),
  supported_parameters: z.array(identity),
  supports_tool_choice: z.object({ auto: z.boolean().optional(), none: z.boolean().optional(), required: z.boolean().optional() }).passthrough().optional(),
  data_policy: z.object({ training: z.boolean().optional(), retainsPrompts: z.boolean().optional() }).passthrough().nullish(),
  // Already descriptor-copied as bounded JSON. Do not rebuild this with z.record: it can discard
  // prototype-named keys before the pricing allowlist sees them.
  pricing: z.custom<JsonObject>(value => value !== null && typeof value === 'object' && !Array.isArray(value)) }).passthrough();
const metadataSchema = z.object({ data: z.object({ id: identity, endpoints: z.array(endpointSchema) }).passthrough() }).passthrough();
export interface OpenRouterTariffSelection {
  readonly modelId: string; readonly endpointTag: string; readonly fetchedAtMs: number; readonly expiresAtMs: number;
}
export interface OpenRouterTariff {
  readonly schemaVersion: 2; readonly selection: OpenRouterTariffSelection; readonly metadataDigest: string; readonly tariffDigest: string;
  readonly metadata: JsonObject; readonly definition: JsonObject; readonly providerName: string;
  readonly contextLength: number; readonly maxPromptTokens: number; readonly maxCompletionTokens: number;
  readonly supportedParameters: readonly string[]; readonly pricedDimensions: readonly string[]; readonly unpricedDimensions: readonly string[];
  readonly supportedToolChoices: readonly ('auto' | 'none' | 'required')[];
  readonly includedDimensions: readonly string[];
  readonly routeTags: readonly string[];
}
const ratesByTariff = new WeakMap<OpenRouterTariff, TariffRates>();
/** Validates a captured native document, not its network provenance. The caller owns trusted acquisition.
 * Full native metadata is retained and digested; unknown pricing is never silently stripped by a schema.
 */
export function parseOpenRouterTariff(metadata: unknown, selection: OpenRouterTariffSelection, zdrMetadata?: unknown): OpenRouterTariff {
  const copied = boundedMetadata.safeParse(metadata), selected = boundedMetadata.safeParse(selection);
  const parsed = copied.success && metadataSchema.safeParse(copied.data);
  const identityResult = selected.success && selectionSchema.safeParse(selected.data);
  if (!parsed || !parsed.success || !identityResult || !identityResult.success) throw new OpenRouterPricingError('INVALID_METADATA');
  const identity = identityResult.data;
  if (identity.expiresAtMs <= identity.fetchedAtMs || parsed.data.data.id !== identity.modelId) throw new OpenRouterPricingError('INVALID_METADATA');
  const endpoints = parsed.data.data.endpoints;
  // Bare slugs reach every variant/region. Include even currently unavailable variants in the
  // envelope: a status change during metadata freshness must never introduce a higher price.
  const selectedEndpoints = endpoints.filter(endpoint => endpoint.tag === identity.endpointTag
    || !identity.endpointTag.includes('/') && endpoint.tag.startsWith(`${identity.endpointTag}/`));
  if (selectedEndpoints.length === 0) throw new OpenRouterPricingError('ENDPOINT_AMBIGUOUS');
  if (endpoints.some(endpoint => endpoint.model_id !== identity.modelId)) throw new OpenRouterPricingError('ENDPOINT_UNAVAILABLE');
  const zdr = zdrMetadata === undefined ? [] : parseZdrEndpoints(zdrMetadata, identity.modelId);
  // Provider defaults/names never attest endpoint policy. Missing fields require an exact
  // model/tag observation in the official ZDR inventory. Explicit contrary metadata wins.
  const compliant = endpoints.filter(endpoint => endpoint.data_policy?.training !== true && endpoint.data_policy?.retainsPrompts !== true
    && (endpoint.data_policy?.training === false && endpoint.data_policy.retainsPrompts === false || zdr.includes(endpoint.tag)));
  const preferred = compliant.filter(endpoint => selectedEndpoints.includes(endpoint));
  const matches = preferred.some(endpoint => endpoint.status === 0) ? preferred : compliant;
  if (matches.length === 0) throw new OpenRouterPricingError('PRIVACY_UNAVAILABLE');
  if (!matches.some(endpoint => endpoint.status === 0)) {
    throw new OpenRouterPricingError('ENDPOINT_UNAVAILABLE');
  }
  const parsedRates = matches.map(endpoint => endpointRates(endpoint.pricing));
  const rates = Object.freeze(Object.fromEntries(chargeDimensions.map(key => [key,
    parsedRates.map(row => row.rates[key]).reduce(maxRate)]))) as TariffRates;
  const dimensions = (key: 'priced' | 'unpriced' | 'included') => Object.freeze([...new Set(parsedRates.flatMap(row => [...row[key]]))].sort());
  const promptBound = (endpoint: typeof matches[number]) => Math.min(endpoint.max_prompt_tokens ?? endpoint.context_length, endpoint.context_length);
  const outputBound = (endpoint: typeof matches[number]) => Math.min(endpoint.max_completion_tokens ?? endpoint.context_length, endpoint.context_length);
  const supportedParameters = Object.freeze([...new Set(matches.flatMap(endpoint => endpoint.supported_parameters))].sort());
  // A bare route can reach every captured variant. Every variant must explicitly admit the requested value.
  const supportedToolChoices = Object.freeze((['auto', 'none', 'required'] as const)
    .filter(choice => matches.every(endpoint => endpoint.supported_parameters.includes('tool_choice') && endpoint.supports_tool_choice?.[choice] === true)));
  const tariffIdentity = { schemaVersion: OPENROUTER_TARIFF_VERSION, selection: identity,
    dataPolicy: { data_collection: 'deny', zdr: true, inventoryTags: zdr },
    modelId: identity.modelId, endpointTag: identity.endpointTag, inclusionRule: 'closed-text-published-skus-v2',
    endpoints: matches.map(endpoint => ({ tag: endpoint.tag, providerName: endpoint.provider_name,
      contextLength: endpoint.context_length, maxPromptTokens: endpoint.max_prompt_tokens, maxCompletionTokens: endpoint.max_completion_tokens,
      supportedParameters: [...endpoint.supported_parameters].sort(), supportedToolChoices: endpoint.supports_tool_choice ?? null,
      dataPolicy: endpoint.data_policy ?? null, pricing: endpoint.pricing })),
    includedDimensions: dimensions('included'), unpricedDimensions: dimensions('unpriced') };
  const definition = boundedMetadata.parse(tariffIdentity);
  const tariffDigest = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
  const tariff: OpenRouterTariff = Object.freeze({ schemaVersion: OPENROUTER_TARIFF_VERSION, selection: Object.freeze(identity),
    metadata: copied.data, definition, metadataDigest: createHash('sha256').update(JSON.stringify(copied.data)).digest('hex'), tariffDigest,
    providerName: matches[0]!.provider_name, contextLength: Math.max(...matches.map(endpoint => endpoint.context_length)),
    routeTags: Object.freeze([...new Set(matches.map(endpoint => endpoint.tag))].sort()),
    maxPromptTokens: Math.max(...matches.map(promptBound)), maxCompletionTokens: Math.max(...matches.map(outputBound)),
    supportedParameters, supportedToolChoices, pricedDimensions: dimensions('priced'), unpricedDimensions: dimensions('unpriced'), includedDimensions: dimensions('included') });
  ratesByTariff.set(tariff, rates);
  return tariff;
}
/** The documented ZDR inventory carries endpoint records keyed by model_id and exact tag. */
export function parseZdrEndpoints(input: unknown, modelId: string): string[] {
  const copied = createImmutableJsonObjectSchema(PRIVACY_LIMITS).safeParse(input);
  const parsed = copied.success && z.object({ data: z.array(z.object({ model_id: identity, tag: identity })) }).safeParse(copied.data);
  if (!parsed || !parsed.success) throw new OpenRouterPricingError('INVALID_METADATA');
  return [...new Set(parsed.data.data.filter(endpoint => endpoint.model_id === modelId).map(endpoint => endpoint.tag))].sort();
}
export function requireTariffRates(tariff: OpenRouterTariff, nowMs: number): TariffRates {
  const rates = ratesByTariff.get(tariff);
  if (!rates) throw new OpenRouterPricingError('INVALID_METADATA');
  if (!Number.isSafeInteger(nowMs) || nowMs < tariff.selection.fetchedAtMs || nowMs >= tariff.selection.expiresAtMs) {
    throw new OpenRouterPricingError('STALE_TARIFF');
  }
  return rates;
}
