import type { ProviderSpendReservation } from '#engine/index.js';
/** Cache dimensions from a settled, verified tariff measurement; held, missing and unsupported sources stay unknown. */
export function settledProviderCacheUsage(spending: ProviderSpendReservation | null): Readonly<{ readTokens: number; writeTokens: number; promptTokens: number }> | null {
  const measurement = spending?.measurement;
  if (spending?.disposition.state !== 'settled-measured-tariff' || measurement?.basis !== 'measured-tariff' || measurement.source.version !== 1) return null;
  const { id, dimensions } = measurement.source;
  if (!['anthropic-usage-tariff', 'openai-compatible-usage-tariff'].includes(id)) return null;
  const readFields = id === 'anthropic-usage-tariff' ? ['cache-read'] : ['cached-input'];
  const writeFields = id === 'anthropic-usage-tariff' ? ['cache-write-5m', 'cache-write-1h', 'cache-write-unsplit'] : ['cache-write'];
  if (!dimensions.some(d => d.field === 'input') || !dimensions.some(d => readFields.includes(d.field))) return null;
  const sum = (fields: readonly string[]) => dimensions.filter(d => fields.includes(d.field)).reduce((total, d) => total + d.tokens, 0);
  const readTokens = sum(readFields), writeTokens = sum(writeFields), promptTokens = sum(['input', ...readFields, ...writeFields]);
  return [readTokens, writeTokens, promptTokens].every(Number.isSafeInteger) ? { readTokens, writeTokens, promptTokens } : null;
}
