import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createImmutableJsonObjectSchema, type JsonObject } from '#domain/index.js';
import { decimalRate, type DecimalRate } from './decimal.js';
import { OpenRouterPricingError } from './error.js';

export const OPENROUTER_TARIFF_VERSION = 1 as const;
const boundedMetadata = createImmutableJsonObjectSchema({ maxDepth: 16, maxNodes: 65_536, maxCodeUnits: 1_048_576 });
const identity = z.string().min(1).max(1024), integer = z.number().int().nonnegative().safe();
const selectionSchema = z.object({ modelId: identity, endpointTag: identity,
  fetchedAtMs: integer, expiresAtMs: integer }).strict();
const endpointSchema = z.object({ model_id: identity, tag: identity, provider_name: identity,
  context_length: integer.positive(), max_prompt_tokens: integer.positive().nullable(),
  max_completion_tokens: integer.positive().nullable(), status: z.number().int(),
  supported_parameters: z.array(identity),
  // Already descriptor-copied as bounded JSON. Do not rebuild this with z.record: it can discard
  // prototype-named keys before the pricing allowlist sees them.
  pricing: z.custom<JsonObject>(value => value !== null && typeof value === 'object' && !Array.isArray(value)) }).passthrough();
const metadataSchema = z.object({ data: z.object({ id: identity, endpoints: z.array(endpointSchema) }).passthrough() }).passthrough();

export interface OpenRouterTariffSelection {
  readonly modelId: string; readonly endpointTag: string; readonly fetchedAtMs: number; readonly expiresAtMs: number;
}
export interface OpenRouterTariff {
  readonly schemaVersion: 1; readonly selection: OpenRouterTariffSelection; readonly metadataDigest: string; readonly tariffDigest: string;
  readonly metadata: JsonObject; readonly definition: JsonObject; readonly providerName: string;
  readonly contextLength: number; readonly maxPromptTokens: number; readonly maxCompletionTokens: number;
  readonly supportedParameters: readonly string[]; readonly pricedDimensions: readonly string[]; readonly unpricedDimensions: readonly string[];
}
export interface TariffRates { readonly prompt: DecimalRate; readonly completion: DecimalRate; readonly request: DecimalRate;
  readonly input_cache_read: DecimalRate; readonly input_cache_write: DecimalRate; readonly internal_reasoning: DecimalRate }
const tokenDimensions = ['prompt', 'completion', 'input_cache_read', 'input_cache_write', 'internal_reasoning'] as const;
const ratesByTariff = new WeakMap<OpenRouterTariff, TariffRates>();
const zero = decimalRate('0');

/** Validates a captured native document, not its network provenance. The caller owns trusted acquisition.
 * Full native metadata is retained and digested; unknown pricing is never silently stripped by a schema.
 */
export function parseOpenRouterTariff(metadata: unknown, selection: OpenRouterTariffSelection): OpenRouterTariff {
  const copied = boundedMetadata.safeParse(metadata), selected = boundedMetadata.safeParse(selection);
  const parsed = copied.success && metadataSchema.safeParse(copied.data);
  const identityResult = selected.success && selectionSchema.safeParse(selected.data);
  if (!parsed || !parsed.success || !identityResult || !identityResult.success) throw new OpenRouterPricingError('INVALID_METADATA');
  const identity = identityResult.data;
  if (identity.expiresAtMs <= identity.fetchedAtMs || parsed.data.data.id !== identity.modelId) throw new OpenRouterPricingError('INVALID_METADATA');
  const endpoints = parsed.data.data.endpoints, matches = endpoints.filter(endpoint => endpoint.tag === identity.endpointTag);
  // OpenRouter base slugs match variants/regions as well. A leaf tag must identify exactly one endpoint.
  if (!identity.endpointTag.includes('/') || matches.length !== 1
    || endpoints.some(endpoint => endpoint.tag.startsWith(`${identity.endpointTag}/`))) {
    throw new OpenRouterPricingError('ENDPOINT_AMBIGUOUS');
  }
  const endpoint = matches[0]!;
  if (endpoint.model_id !== identity.modelId || endpoint.status !== 0) throw new OpenRouterPricingError('ENDPOINT_UNAVAILABLE');
  const rates = parseRates(endpoint.pricing);
  const pricedDimensions = Object.freeze([...tokenDimensions, 'request'].filter(key => Object.hasOwn(endpoint.pricing, key)).sort());
  const unpricedDimensions = Object.freeze([...tokenDimensions, 'request'].filter(key => !Object.hasOwn(endpoint.pricing, key)).sort());
  const tariffIdentity = { schemaVersion: OPENROUTER_TARIFF_VERSION, selection: identity,
    modelId: endpoint.model_id, endpointTag: endpoint.tag, providerName: endpoint.provider_name,
    contextLength: endpoint.context_length, maxPromptTokens: endpoint.max_prompt_tokens, maxCompletionTokens: endpoint.max_completion_tokens,
    supportedParameters: [...endpoint.supported_parameters].sort(), pricing: endpoint.pricing };
  const definition = boundedMetadata.parse(tariffIdentity);
  const tariffDigest = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
  const tariff: OpenRouterTariff = Object.freeze({ schemaVersion: OPENROUTER_TARIFF_VERSION, selection: Object.freeze(identity),
    metadata: copied.data, definition, metadataDigest: createHash('sha256').update(JSON.stringify(copied.data)).digest('hex'), tariffDigest,
    providerName: endpoint.provider_name, contextLength: endpoint.context_length,
    // A published context bound still bounds input or output when a separate native limit is null.
    maxPromptTokens: Math.min(endpoint.max_prompt_tokens ?? endpoint.context_length, endpoint.context_length),
    maxCompletionTokens: Math.min(endpoint.max_completion_tokens ?? endpoint.context_length, endpoint.context_length),
    supportedParameters: Object.freeze([...endpoint.supported_parameters]), pricedDimensions, unpricedDimensions });
  ratesByTariff.set(tariff, rates);
  return tariff;
}

export function requireTariffRates(tariff: OpenRouterTariff, nowMs: number): TariffRates {
  const rates = ratesByTariff.get(tariff);
  if (!rates) throw new OpenRouterPricingError('INVALID_METADATA');
  if (!Number.isSafeInteger(nowMs) || nowMs < tariff.selection.fetchedAtMs || nowMs >= tariff.selection.expiresAtMs) {
    throw new OpenRouterPricingError('STALE_TARIFF');
  }
  return rates;
}

function parseRates(pricing: Record<string, unknown>): TariffRates {
  if (!Object.hasOwn(pricing, 'prompt') || !Object.hasOwn(pricing, 'completion')) throw new OpenRouterPricingError('INVALID_METADATA');
  const base: Record<string, DecimalRate> = {};
  for (const key of [...tokenDimensions, 'request']) base[key] = Object.hasOwn(pricing, key) ? decimalRate(pricing[key]) : zero;
  for (const [key, value] of Object.entries(pricing)) {
    if (Object.hasOwn(base, key)) continue;
    // Known non-text charges must be zero in this version's supported tariff. Discounts never reduce a bound.
    if (key === 'discount' && value === 0) continue;
    if (['image', 'web_search'].includes(key) && decimalRate(value).coefficient === 0n) continue;
    if (key === 'overrides' && Array.isArray(value) && value.length === 0) continue;
    throw new OpenRouterPricingError('UNSUPPORTED_PRICING');
  }
  return Object.freeze(base) as unknown as TariffRates;
}
