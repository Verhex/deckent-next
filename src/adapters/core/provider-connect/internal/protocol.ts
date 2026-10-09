import { isDeepStrictEqual } from 'node:util';
import { modelInvocationProfileSchema } from '#domain/index.js';
import { OPENAI_CHAT_HTTP_ADAPTER_ID, OPENAI_RESPONSES_HTTP_ADAPTER_VERSION, isOpenAiChatHttpAdapter,
  parseOpenAiChatHttpDefinition, lookupOpenAiCompatibleTariff } from '#adapters/core/provider-openai-chat/index.js';
import { PROVIDER_CONNECT_KINDS } from './registry.js';

export type ProviderProfileProtocolDetail = Readonly<{ modelId: string; from: string; to: string; protocol: 'responses' }>;
/** Exact verified endpoint/model route only. No automatic change, key rebinding, catalog digest or allocation rewrite. */
export function providerProfileProtocolOffer(profile: unknown): Readonly<{ next: Record<string, unknown>; detail: ProviderProfileProtocolDetail }> | null {
  const parsed = modelInvocationProfileSchema.safeParse(profile);
  if (!parsed.success || !isOpenAiChatHttpAdapter(parsed.data.adapter) || parsed.data.adapter.version === OPENAI_RESPONSES_HTTP_ADAPTER_VERSION) return null;
  const value = parsed.data;
  let definition;
  try { definition = parseOpenAiChatHttpDefinition(value.adapter.definition); } catch { return null; }
  if (definition.tariff.kind !== 'vendor-published' || definition.dialect?.protocol || definition.tokenizeEndpoint) return null;
  const tariff = definition.tariff, original = lookupOpenAiCompatibleTariff(definition.endpoint, tariff.modelId);
  if (!original || !isDeepStrictEqual(original, tariff)) return null;
  const route = PROVIDER_CONNECT_KINDS.flatMap(kind => {
    if (kind.connect?.adapter !== OPENAI_CHAT_HTTP_ADAPTER_ID || kind.endpoint.default === null) return [];
    const expected = new URL(kind.connect.chatPath, kind.endpoint.default).href;
    return expected === definition.endpoint ? kind.connect.protocolRoutes ?? [] : [];
  }).find(row => row.modelId === tariff.modelId);
  if (!route) return null;
  const endpoint = new URL(route.path, definition.endpoint).href, nextTariff = lookupOpenAiCompatibleTariff(endpoint, tariff.modelId);
  if (!nextTariff) return null;
  const nextDefinition = { ...definition, endpoint, dialect: route.dialect, tariff: nextTariff };
  try { parseOpenAiChatHttpDefinition(nextDefinition); } catch { return null; }
  const next = { ...value, version: value.version + 1,
    adapter: { ...value.adapter, version: OPENAI_RESPONSES_HTTP_ADAPTER_VERSION, definition: nextDefinition } };
  if (!modelInvocationProfileSchema.safeParse(next).success) return null;
  return { next, detail: { modelId: tariff.modelId, from: definition.endpoint, to: endpoint, protocol: 'responses' } };
}
