import { ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID, parseAnthropicMessagesDefinition } from '#adapters/core/provider-anthropic-messages/index.js';
import { PROVIDER_CONNECT_KINDS } from './registry.js';

/** What enabling the prompt cache on one existing profile would write, with its own tariff's ratios to the base input price (display only). */
export type ProviderProfileCacheOffer = Readonly<{ ttl: '5m'; modelId: string; writeRatio: number; readRatio: number; next: Record<string, unknown> }>;

/**
 * CACHE-SLICE1 (owner 2026-10-09): the governed one-step migration of an EXISTING profile. Offered only for an Anthropic profile whose definition has
 * no `cache` field at all (written before the registry default existed) and only when a connect row of that adapter defaults new profiles to 5m:
 * an explicit `none` (or any explicit TTL) is the person's choice and is never offered a change. `next` is the same profile with `cache: '5m'` and
 * the next version, checked by the adapter's own definition parser; the caller writes it through the governed config writer.
 */
export function providerProfileCacheOffer(profile: unknown): ProviderProfileCacheOffer | null {
  const value = profile as { version?: unknown; adapter?: { id?: unknown; definition?: Record<string, unknown> } } | null;
  const definition = value?.adapter?.definition;
  if (!value || value.adapter?.id !== ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID || !definition || 'cache' in definition || typeof value.version !== 'number') return null;
  if (!PROVIDER_CONNECT_KINDS.some(kind => kind.connect?.adapter === ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID && kind.connect.cacheDefault === '5m')) return null;
  let parsed;
  try { parsed = parseAnthropicMessagesDefinition({ ...definition, cache: '5m' }); } catch { return null; }
  // The base band's rates; a tiered tariff's longer-prompt band has its own (`/usage` shows what the requests actually paid).
  const rates = parsed.tariff.usdPerMTok, input = Number(rates.input);
  if (!(input > 0)) return null;
  return Object.freeze({ ttl: '5m', modelId: parsed.tariff.modelId, writeRatio: Number(rates.cacheWrite5m) / input, readRatio: Number(rates.cacheRead) / input,
    next: { ...(profile as Record<string, unknown>), version: value.version + 1, adapter: { ...value.adapter, definition: { ...definition, cache: '5m' } } } });
}
