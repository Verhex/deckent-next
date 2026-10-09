import type { ProviderSpendReservation } from './account.js';

/** Raw cache classes of one settled call plus the same-request net cache benefit (CACHE-SLICE1 `/usage`). `netBenefitUsdE10`: USD x 1e10, the
 * read savings minus the write premium against the uncached input rate of the same request and tier; null when it does not fit a safe integer. */
export type SettledProviderCacheUsage = Readonly<{ readTokens: number; writeTokens: number; promptTokens: number; write5mTokens: number; write1hTokens: number;
  netBenefitUsdE10: number | null }>;
/** Rate string (at most 4 fraction digits, USD per MTok) in units of 0.0001; tokens x units = USD x 1e10. */
const units = (rate: string) => { const [whole = '0', fraction = ''] = rate.split('.'); return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0')); };

/** Cache dimensions from a settled, verified tariff measurement; held, missing and unsupported sources stay unknown. */
export function settledProviderCacheUsage(spending: ProviderSpendReservation | null): SettledProviderCacheUsage | null {
  const measurement = spending?.measurement;
  if (spending?.disposition.state !== 'settled-measured-tariff' || measurement?.basis !== 'measured-tariff' || measurement.source.version !== 1) return null;
  const { id, dimensions } = measurement.source;
  if (!['anthropic-usage-tariff', 'openai-compatible-usage-tariff'].includes(id)) return null;
  const readFields = id === 'anthropic-usage-tariff' ? ['cache-read'] : ['cached-input'];
  const writeFields = id === 'anthropic-usage-tariff' ? ['cache-write-5m', 'cache-write-1h', 'cache-write-unsplit'] : ['cache-write'];
  const input = dimensions.find(d => d.field === 'input');
  if (!input || !dimensions.some(d => readFields.includes(d.field))) return null;
  const sum = (fields: readonly string[]) => dimensions.filter(d => fields.includes(d.field)).reduce((total, d) => total + d.tokens, 0);
  const readTokens = sum(readFields), writeTokens = sum(writeFields), promptTokens = sum(['input', ...readFields, ...writeFields]);
  const write5mTokens = sum(['cache-write-5m']), write1hTokens = sum(['cache-write-1h']);
  // Same-request counterfactual (RESEARCH §3.10): what the cached classes saved or cost against the request's own uncached input rate.
  const base = units(input.usdPerMillionTokens);
  const net = dimensions.reduce((total, d) => readFields.includes(d.field) ? total + BigInt(d.tokens) * (base - units(d.usdPerMillionTokens))
    : writeFields.includes(d.field) ? total - BigInt(d.tokens) * (units(d.usdPerMillionTokens) - base) : total, 0n);
  const netBenefitUsdE10 = net >= BigInt(Number.MIN_SAFE_INTEGER) && net <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(net) : null;
  return [readTokens, writeTokens, promptTokens].every(Number.isSafeInteger) ? { readTokens, writeTokens, promptTokens, write5mTokens, write1hTokens, netBenefitUsdE10 } : null;
}
