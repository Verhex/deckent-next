import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseProviderCatalogDocument, type JsonObject, type ProviderCatalogDocument } from '#domain/index.js';
import { OPENAI_CHAT_COMPLETIONS_FAMILY, OPENAI_CHAT_COMPLETIONS_VERSION, OPENAI_CHAT_HTTP_ADAPTER_ID, OPENAI_CHAT_HTTP_ADAPTER_VERSION,
  lookupOpenAiCompatibleTariff, parseOpenAiChatHttpDefinition } from '#adapters/core/provider-openai-chat/index.js';
import { ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID, ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION, anthropicMessagesProtocol, anthropicModelCapability,
  anthropicPublishedTariff, parseAnthropicMessagesDefinition } from '#adapters/core/provider-anthropic-messages/index.js';
import { providerEndpoint, type ProviderConnectKind } from './registry.js';

export class ProviderConnectError extends Error {
  constructor(readonly code: 'MODEL_CONNECT_SEED_UNAVAILABLE' | 'MODEL_CONNECT_TARIFF_UNKNOWN' | 'MODEL_CONNECT_TARIFF_UNVERIFIED' | 'MODEL_CONNECT_KEY_INSECURE'
    | 'MODEL_CONNECT_DEFINITION_INVALID') {
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
/**
 * The adapter part of a connected model's invocation profile (T4-B `models connect`), built from the registry kind and validated by the adapter's
 * own definition parser before anything is written. Anthropic carries the model's published tariff (`pricing.json`) and its registry output bound.
 * The OpenAI chat adapter (stage 1, SPEND-SETTLEMENT) carries the verified published row for exactly this endpoint and model
 * (`lookupOpenAiCompatibleTariff`); a remote address without one is refused here (`MODEL_CONNECT_TARIFF_UNVERIFIED`: the spend authority would
 * refuse every paid call), so nothing is written; only a loopback server keeps the zero-rate operator tariff (`unmetered`). A key is named only
 * over https (the adapters refuse a credential in cleartext); a plain-http local server is reached without one.
 */
export function connectionAdapter(kind: ProviderConnectKind, input: Readonly<{ endpoint: string; credentialRef: string | null; nativeId: string;
  maxOutputTokens: number; currency: string }>): ConnectionAdapter {
  const connect = kind.connect;
  if (!connect) throw new ProviderConnectError('MODEL_CONNECT_DEFINITION_INVALID');
  const secure = new URL(input.endpoint).protocol === 'https:';
  if (connect.adapter === ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID) {
    if (!secure || input.credentialRef === null) throw new ProviderConnectError('MODEL_CONNECT_KEY_INSECURE');
    const tariff = anthropicPublishedTariff(input.nativeId), capability = anthropicModelCapability(input.nativeId);
    if (!tariff || !capability) throw new ProviderConnectError('MODEL_CONNECT_TARIFF_UNKNOWN');
    const definition = { endpoint: input.endpoint, ...(connect.tokenCountPath ? { tokenCountEndpoint: new URL(connect.tokenCountPath, input.endpoint).href } : {}), maxOutputTokens: Math.min(input.maxOutputTokens, capability.maxOutputTokens),
      authentication: { type: 'header', name: 'x-api-key', credentialRef: input.credentialRef }, tariff };
    try { parseAnthropicMessagesDefinition(definition); } catch { throw new ProviderConnectError('MODEL_CONNECT_DEFINITION_INVALID'); }
    return Object.freeze({ adapter: { id: ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID, version: ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION, definition: definition as unknown as JsonObject },
      protocol: { family: anthropicMessagesProtocol.family, version: anthropicMessagesProtocol.version }, tariff: 'published' });
  }
  const published = openAiChatLoopback(input.endpoint) ? null : lookupOpenAiCompatibleTariff(input.endpoint, input.nativeId);
  if (!published && !openAiChatLoopback(input.endpoint)) throw new ProviderConnectError('MODEL_CONNECT_TARIFF_UNVERIFIED');
  const definition = { endpoint: input.endpoint, ...(connect.tokenCountPath ? { tokenCountEndpoint: new URL(connect.tokenCountPath, input.endpoint).href } : {}), maxOutputTokens: input.maxOutputTokens, dialect: connect.dialect,
    authentication: secure && input.credentialRef !== null ? { type: 'bearer', credentialRef: input.credentialRef } : { type: 'none' },
    tariff: published ?? { kind: 'operator-static', version: 1, currency: input.currency, inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } };
  try { parseOpenAiChatHttpDefinition(definition); } catch { throw new ProviderConnectError('MODEL_CONNECT_DEFINITION_INVALID'); }
  return Object.freeze({ adapter: { id: OPENAI_CHAT_HTTP_ADAPTER_ID, version: OPENAI_CHAT_HTTP_ADAPTER_VERSION, definition: definition as unknown as JsonObject },
    protocol: { family: OPENAI_CHAT_COMPLETIONS_FAMILY, version: OPENAI_CHAT_COMPLETIONS_VERSION }, tariff: published ? 'published' : 'unmetered' });
}
/** The spend authority's own loopback rule (provider-openai-chat `openAiCompatibleTariffRates`): only these hosts may keep a zero tariff. */
function openAiChatLoopback(endpoint: string): boolean {
  return ['127.0.0.1', '[::1]', 'localhost'].includes(new URL(endpoint).hostname);
}

/**
 * Whether a model of a seeded kind can be connected with a price at the kind's default address (the `/provider` model list locks the others before
 * anything is written): Anthropic by its published tariff, the OpenAI chat adapter by an exact verified row, a loopback address always (zero tariff).
 */
export function providerConnectModelPriced(kind: ProviderConnectKind, nativeId: string): boolean {
  const connect = kind.connect, base = kind.endpoint.default === null ? null : providerEndpoint(kind.endpoint.default);
  if (!connect || !base?.ok) return false;
  if (connect.adapter === ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID) return anthropicPublishedTariff(nativeId) !== null;
  const endpoint = `${base.base}${connect.chatPath}`;
  return openAiChatLoopback(endpoint) || lookupOpenAiCompatibleTariff(endpoint, nativeId) !== null;
}

/** The protocol family a model connected to this kind must speak (its adapter's), or null when the kind connects no model. */
export function providerConnectFamily(kind: ProviderConnectKind): string | null {
  if (!kind.connect) return null;
  return kind.connect.adapter === ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID ? anthropicMessagesProtocol.family : OPENAI_CHAT_COMPLETIONS_FAMILY;
}
