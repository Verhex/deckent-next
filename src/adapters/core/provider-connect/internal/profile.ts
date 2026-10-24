import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isLiteralLoopbackHostname } from '#platform/index.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { endpointMayCarryKey, parseProviderCatalogDocument, type CatalogModel, type JsonObject, type ProviderCatalogDocument } from '#domain/index.js';
import { OPENAI_CHAT_COMPLETIONS_FAMILY, OPENAI_CHAT_COMPLETIONS_VERSION, OPENAI_CHAT_HTTP_ADAPTER_ID, OPENAI_CHAT_HTTP_ADAPTER_VERSION,
  OPENAI_RESPONSES_HTTP_ADAPTER_VERSION,
  lookupOpenAiCompatibleTariff, openAiCompatiblePublishedTariffSchema, parseOpenAiChatHttpDefinition } from '#adapters/core/provider-openai-chat/index.js';
import { ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID, ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION, anthropicMessagesProtocol, anthropicModelCapability,
  anthropicPublishedTariff, anthropicTariffSchema, parseAnthropicMessagesDefinition } from '#adapters/core/provider-anthropic-messages/index.js';
import { providerEndpoint, providerMetadataRouteSchema, providerProtocolRouteSchema, type ProviderConnectKind } from './registry.js';
export class ProviderConnectError extends Error {
  constructor(readonly code: 'MODEL_CONNECT_SEED_UNAVAILABLE' | 'MODEL_CONNECT_TARIFF_UNKNOWN' | 'MODEL_CONNECT_TARIFF_UNVERIFIED' | 'MODEL_CONNECT_KEY_INSECURE'
    | 'MODEL_CONNECT_DEFINITION_INVALID' | 'MODEL_CONNECT_PRICE_REQUIRED') {
    super(code); this.name = 'ProviderConnectError';
  }
}
/** A packaged catalog seed (`assets/model-catalog/<name>.json`, the same files `models catalog register --seed` reads), strictly parsed. */
export async function readProviderConnectSeed(name: string): Promise<ProviderCatalogDocument> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) throw new ProviderConnectError('MODEL_CONNECT_SEED_UNAVAILABLE');
  let text: string;
  try { text = await readFile(fileURLToPath(new URL(`../../../../../assets/model-catalog/${name}.json`, import.meta.url)), 'utf8'); }
  catch { throw new ProviderConnectError('MODEL_CONNECT_SEED_UNAVAILABLE'); }
  try { return parseProviderCatalogDocument(JSON.parse(text)); } catch { throw new ProviderConnectError('MODEL_CONNECT_SEED_UNAVAILABLE'); }
}
export type ConnectionAdapter = Readonly<{ adapter: Readonly<{ id: string; version: number; definition: JsonObject }>;
  protocol: Readonly<{ family: string; version: string }>; tariff: 'published' | 'unmetered' }>;
/** The installation's registered catalog row for the model being connected (M4): its channel, the ledger row revision and the v3 entry. */
export type ConnectCatalogRow = Readonly<{ channelId: string; modelRevision: number; model: CatalogModel }>;
type Tariff = Readonly<{ modelId: string; source: Readonly<{ url: string; retrievedAt: string }> }>;
/**
 * M4 (owner 2026-10-23): a registered catalog row's `connect.tariff` for exactly this model, checked by the adapter's own tariff schema and
 * sealed with the row it came from (`source.catalog`); null when the row states none. Terms for another model or endpoint, or a malformed
 * document, are a typed refusal: a price is never guessed or completed.
 */
function catalogTariff<T extends Tariff>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, row: ConnectCatalogRow | null | undefined, nativeId: string,
  endpoint?: string): T | null {
  const term = row && 'connect' in row.model ? row.model.connect?.tariff : undefined;
  if (term === undefined) return null;
  const parsed = schema.safeParse(structuredClone(term));
  if (!parsed.success || parsed.data.modelId !== nativeId || (endpoint !== undefined && (parsed.data as { endpoint?: unknown }).endpoint !== endpoint)
    || !displayAgrees(row!.model, (parsed.data as { usdPerMTok?: Readonly<Record<string, string>> }).usdPerMTok)) {
    throw new ProviderConnectError('MODEL_CONNECT_TARIFF_UNVERIFIED');
  }
  return { ...parsed.data, source: { ...parsed.data.source, catalog: { channelId: row!.channelId, modelRevision: row!.modelRevision } } } as T;
}
/** Exact decimal equality of two non-negative decimal strings (`12` = `12.0`, `0.3` = `0.30`). */
const sameDecimal = (left: string, right: string) => {
  const canonical = (value: string) => { const [whole = '0', fraction = ''] = value.split('.'); return `${BigInt(whole)}.${fraction.replace(/0+$/u, '')}`; };
  return /^\d+(\.\d+)?$/u.test(left) && /^\d+(\.\d+)?$/u.test(right) && canonical(left) === canonical(right);
};
/**
 * Lead 2026-10-23: the rates a row displays (`pricing`, what a person is shown) and the tariff that bills (`connect.tariff`) never disagree:
 * input, output and cache read are compared exactly where the row displays them (the tariff's base rates; cache read is the adapter's
 * `cacheRead` or `cachedInput`).
 */
function displayAgrees(model: CatalogModel, rates: Readonly<Record<string, string>> | undefined): boolean {
  const pricing = 'pricing' in model ? model.pricing : undefined;
  if (!pricing) return true;
  const pairs: [string | undefined, string | undefined][] = [[pricing.inputPerMTok, rates?.['input']], [pricing.outputPerMTok, rates?.['output']],
    [pricing.cacheReadPerMTok, rates?.['cacheRead'] ?? rates?.['cachedInput']]];
  return pairs.every(([shown, billed]) => shown === undefined || (billed !== undefined && sameDecimal(shown, billed)));
}
/** Terms a row carries that this adapter cannot use are refused, never ignored (lead 2026-10-23). */
function refuseUnusedTerm(row: ConnectCatalogRow | null | undefined, term: 'tariff' | 'route'): void {
  if (row && 'connect' in row.model && row.model.connect?.[term] !== undefined) throw new ProviderConnectError('MODEL_CONNECT_DEFINITION_INVALID');
}
/** A row's `connect.route` for exactly this model, parsed by the registry's own route schema (the model id is the row's). */
function catalogRoute<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, row: ConnectCatalogRow | null | undefined, nativeId: string): T | undefined {
  const term = row && 'connect' in row.model ? row.model.connect?.route : undefined;
  if (term === undefined) return undefined;
  const parsed = schema.safeParse({ ...structuredClone(term), modelId: nativeId });
  if (!parsed.success) throw new ProviderConnectError('MODEL_CONNECT_DEFINITION_INVALID');
  return parsed.data;
}
/** The shipped tariff stays first for every model it lists; catalog terms that state other rates for it are a conflict, never a silent choice. */
function firstTariff<T extends Tariff>(shipped: T | null | undefined, listed: T | null): T | null {
  const rates = (tariff: T) => ({ ...tariff, source: null });
  if (shipped && listed && !isDeepStrictEqual(rates(shipped), rates(listed))) throw new ProviderConnectError('MODEL_CONNECT_TARIFF_UNVERIFIED');
  return shipped ?? listed;
}
/**
 * The adapter part of a connected model's invocation profile (T4-B `models connect`), built from the registry kind and validated by the adapter's
 * own definition parser before anything is written. Anthropic carries the model's published tariff (`pricing.json`), its registry output bound and,
 * for a new profile only, the kind's `cacheDefault` (`existing`: the definition already written for this model, whose cache choice is kept).
 * The OpenAI chat adapter (stage 1, SPEND-SETTLEMENT) carries the verified published row for exactly this endpoint and model
 * (`lookupOpenAiCompatibleTariff`); a remote address without one is refused here (`MODEL_CONNECT_TARIFF_UNVERIFIED`: the spend authority would
 * refuse every paid call), so nothing is written; only a loopback server keeps the zero-rate operator tariff (`unmetered`). A key is named only
 * over https (the adapters refuse a credential in cleartext); a plain-http local server is reached without one.
 * M4: for a model the shipped tables do not list, the tariff and route come from its registered catalog row (`catalog`, its `connect` terms),
 * sealed to that row; the shipped tables stay first for every model they list, so existing profiles keep their exact bytes.
 */
export function connectionAdapter(kind: ProviderConnectKind, input: Readonly<{ endpoint: string; credentialRef: string | null; nativeId: string;
  maxOutputTokens: number; currency: string; existing?: JsonObject | null; catalog?: ConnectCatalogRow | null }>): ConnectionAdapter {
  const connect = kind.connect;
  // A CLI kind's adapter part is built by its own connect step (executable, login dir, uid, preflight), never here.
  if (!connect || connect.chatPath === null) throw new ProviderConnectError('MODEL_CONNECT_DEFINITION_INVALID');
  const route = connect.protocolRoutes?.find(row => row.modelId === input.nativeId)
    ?? (connect.adapter === OPENAI_CHAT_HTTP_ADAPTER_ID && !connect.metadataPricing ? catalogRoute(providerProtocolRouteSchema, input.catalog, input.nativeId) : undefined);
  // A reconnect is not the migration selection: existing definitions keep their wire choice.
  const responses = route && (!input.existing || (input.existing['dialect'] as { protocol?: unknown } | undefined)?.protocol === 'responses');
  if (responses) {
    // The route never leaves the connection's origin: the key is only ever named for that origin (security review M4).
    const routed = new URL(route.path, input.endpoint);
    if (routed.origin !== new URL(input.endpoint).origin) throw new ProviderConnectError('MODEL_CONNECT_DEFINITION_INVALID');
    input = { ...input, endpoint: routed.href };
  }
  const secure = endpointMayCarryKey(input.endpoint); // G2-7: the one key rule; plain http (loopback too) is `authentication: none`
  if (connect.adapter === ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID) {
    if (!secure || input.credentialRef === null) throw new ProviderConnectError('MODEL_CONNECT_KEY_INSECURE');
    refuseUnusedTerm(input.catalog, 'route');
    const tariff = firstTariff(anthropicPublishedTariff(input.nativeId), catalogTariff(anthropicTariffSchema, input.catalog, input.nativeId));
    const capability = anthropicModelCapability(input.nativeId);
    // A model without a shipped capability row keeps the catalog's output bound and the request shape every model accepts (no effort, no thinking).
    if (!tariff || (!capability && !input.catalog)) throw new ProviderConnectError('MODEL_CONNECT_TARIFF_UNKNOWN');
    // CACHE-SLICE1: a new profile takes the registry's TTL; an existing one keeps its own value (an absent field stays absent, `none` stays `none`).
    const cache = input.existing ? input.existing['cache'] : connect.cacheDefault;
    const workspaceId = input.existing?.['workspaceId'];
    const definition = { endpoint: input.endpoint, ...(workspaceId === undefined ? {} : { workspaceId }), ...(connect.tokenCountPath ? { tokenCountEndpoint: new URL(connect.tokenCountPath, input.endpoint).href } : {}),
      maxOutputTokens: capability ? Math.min(input.maxOutputTokens, capability.maxOutputTokens) : input.maxOutputTokens,
      authentication: { type: 'header', name: 'x-api-key', credentialRef: input.credentialRef }, tariff, ...(cache === undefined ? {} : { cache }) };
    try { parseAnthropicMessagesDefinition(definition); } catch { throw new ProviderConnectError('MODEL_CONNECT_DEFINITION_INVALID'); }
    return Object.freeze({ adapter: { id: ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID, version: ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION, definition: definition as unknown as JsonObject },
      protocol: { family: anthropicMessagesProtocol.family, version: anthropicMessagesProtocol.version }, tariff: 'published' });
  }
  const metadata = connect.metadataPricing;
  const pricedRoute = metadata && (metadata.routes.find(row => row.modelId === input.nativeId) ?? catalogRoute(providerMetadataRouteSchema, input.catalog, input.nativeId));
  if (metadata) {
    refuseUnusedTerm(input.catalog, 'tariff'); // the price is the provider's live endpoint metadata, never a catalog tariff
    if (!pricedRoute || input.currency !== 'USD' || new URL(pricedRoute.sourceUrl).origin !== new URL(input.endpoint).origin) throw new ProviderConnectError('MODEL_CONNECT_TARIFF_UNVERIFIED');
    if (!secure || input.credentialRef === null) throw new ProviderConnectError('MODEL_CONNECT_KEY_INSECURE');
    const metadataEndpoint = new URL(`/api/v1/models/${input.nativeId.split('/').map(encodeURIComponent).join('/')}/endpoints`, input.endpoint).href;
    const metadataLimits = { maxAgeMs: metadata.maxAgeMs, maxResponseBytes: metadata.maxResponseBytes, timeoutMs: metadata.timeoutMs };
    const definition = { endpoint: input.endpoint, maxOutputTokens: input.maxOutputTokens,
      dialect: { ...connect.dialect!, tokenLimitField: pricedRoute.tokenLimitField }, authentication: { type: 'bearer', credentialRef: input.credentialRef },
      tariff: { kind: 'openrouter-endpoint', version: 1, currency: 'USD', metadataEndpoint, endpointTag: pricedRoute.endpointTag, metadataLimits } };
    try { parseOpenAiChatHttpDefinition(definition); } catch { throw new ProviderConnectError('MODEL_CONNECT_DEFINITION_INVALID'); }
    return Object.freeze({ adapter: { id: OPENAI_CHAT_HTTP_ADAPTER_ID, version: OPENAI_CHAT_HTTP_ADAPTER_VERSION, definition: definition as unknown as JsonObject },
      protocol: { family: OPENAI_CHAT_COMPLETIONS_FAMILY, version: OPENAI_CHAT_COMPLETIONS_VERSION }, tariff: 'published' });
  }
  const loopback = isLiteralLoopbackHostname(new URL(input.endpoint).hostname);
  const published = loopback ? null : firstTariff(lookupOpenAiCompatibleTariff(input.endpoint, input.nativeId),
    catalogTariff(openAiCompatiblePublishedTariffSchema, input.catalog, input.nativeId, input.endpoint));
  if (!published && !loopback) throw new ProviderConnectError(connect.priceRequired ? 'MODEL_CONNECT_PRICE_REQUIRED' : 'MODEL_CONNECT_TARIFF_UNVERIFIED');
  const definition = { endpoint: input.endpoint, ...(connect.tokenCountPath ? { tokenCountEndpoint: new URL(connect.tokenCountPath, input.endpoint).href } : {}), maxOutputTokens: input.maxOutputTokens,
    dialect: responses ? input.existing?.['dialect'] ?? route.dialect : connect.dialect,
    authentication: secure && input.credentialRef !== null ? { type: 'bearer', credentialRef: input.credentialRef } : { type: 'none' },
    tariff: published ?? { kind: 'operator-static', version: 1, currency: input.currency, inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } };
  try { parseOpenAiChatHttpDefinition(definition); } catch { throw new ProviderConnectError('MODEL_CONNECT_DEFINITION_INVALID'); }
  return Object.freeze({ adapter: { id: OPENAI_CHAT_HTTP_ADAPTER_ID, version: responses ? OPENAI_RESPONSES_HTTP_ADAPTER_VERSION : OPENAI_CHAT_HTTP_ADAPTER_VERSION, definition: definition as unknown as JsonObject },
    protocol: { family: OPENAI_CHAT_COMPLETIONS_FAMILY, version: OPENAI_CHAT_COMPLETIONS_VERSION }, tariff: published ? 'published' : 'unmetered' });
}
/**
 * Whether a model of a seeded kind can be connected with a price at the kind's default address (the `/provider` model list locks the others before
 * anything is written): Anthropic by its published tariff, the OpenAI chat adapter by an exact verified row, a loopback address always (zero tariff).
 */
export function providerConnectModelPriced(kind: ProviderConnectKind, nativeId: string, address: string | null = kind.endpoint.default): boolean {
  const connect = kind.connect, base = address === null ? null : providerEndpoint(address);
  if (connect?.chatPath === null) return true; // a subscription CLI: quota only, no price to verify
  if (!connect || !base?.ok) return false;
  if (connect.adapter === ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID) return anthropicPublishedTariff(nativeId) !== undefined;
  if (connect.metadataPricing) return connect.metadataPricing.routes.some(route => route.modelId === nativeId);
  const endpoint = `${base.base}${connect.chatPath}`;
  return isLiteralLoopbackHostname(new URL(endpoint).hostname) || lookupOpenAiCompatibleTariff(endpoint, nativeId) !== null;
}
/** The protocol family a model connected to this kind must speak (its adapter's), or null when the kind connects no model. */
export function providerConnectFamily(kind: ProviderConnectKind): string | null {
  if (!kind.connect) return null;
  return kind.connect.protocolFamily ?? kind.connect.adapter === ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID ? anthropicMessagesProtocol.family : OPENAI_CHAT_COMPLETIONS_FAMILY;
}
