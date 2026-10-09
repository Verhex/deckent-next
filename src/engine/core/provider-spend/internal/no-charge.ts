import { z } from 'zod';
import type { ModelInvocationProfile, ModelInvocationReceipt, ProviderSpendQuote } from '#domain/index.js';
import data from './no-charge-policy.json' with { type: 'json' };
import { providerSpendEvidenceDigest, providerSpendQuoteDigest } from './account.js';
import { providerSpendRejectionHasNoCharge } from './invocation.js';

const policy = z.object({ schemaVersion: z.literal(1), retrievedAt: z.string(), note: z.string(), vendors: z.array(z.object({
  vendor: z.string(), endpoints: z.array(z.string().url()).min(1), statuses: z.array(z.number().int().min(400).max(499)).min(1), source: z.string().url(),
}).strict()) }).strict().parse(data);

/** A numeric zero quote is insufficient: the pinned tariff must literally price every dimension at zero. */
export function providerSpendHasZeroTariff(quote: ProviderSpendQuote): boolean {
  providerSpendQuoteDigest(quote);
  if (quote.maxChargeMinorUnits !== 0) return false;
  const tariff = quote.pricing.definition;
  const zero = (value: unknown) => (typeof value === 'number' || typeof value === 'string') && /^0(?:\.0+)?$/.test(String(value));
  if (tariff['kind'] === 'operator-static') return zero(tariff['inputMinorUnitsPerMillionTokens']) && zero(tariff['outputMinorUnitsPerMillionTokens'])
    && (tariff['cachedInputMinorUnitsPerMillionTokens'] === undefined || zero(tariff['cachedInputMinorUnitsPerMillionTokens']));
  if (tariff['kind'] !== 'vendor-published' || tariff['version'] !== 1) return false;
  const rates = tariff['usdPerMTok'];
  return !!rates && typeof rates === 'object' && !Array.isArray(rates) && Object.keys(rates).length >= 3 && Object.values(rates).every(zero)
    && tariff['offPeakUsdPerMTok'] === undefined;
}

/** PROVIDER-LOCALITY: only a literal loopback IP is this machine; the name `localhost`, LAN and WSL addresses are not. */
function literalLoopback(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try { const host = new URL(value).hostname; return host === '127.0.0.1' || host === '[::1]'; } catch { return false; }
}

/** Budget exemption (owner 2026-10-09, Jev 3f877ac4): a literal zero tariff AND every declared endpoint (`endpoint`, `tokenizeEndpoint`, …)
 * on a literal loopback address. A zero tariff declared for any other host is only a claim: it keeps the budget gate and a 0 reservation. */
export function providerSpendLocalZeroTariff(profile: ModelInvocationProfile, quote: ProviderSpendQuote): boolean {
  const endpoints = Object.entries(profile.adapter.definition).filter(([key]) => /endpoint$/iu.test(key));
  return providerSpendHasZeroTariff(quote) && endpoints.some(([key]) => key === 'endpoint') && endpoints.every(([, value]) => literalLoopback(value));
}

/** Receipt metadata is validated separately; complete retained body bytes are required by the recovering store. */
export function certifyProviderSpendNoCharge(receipt: ModelInvocationReceipt): string | null {
  const outcome = receipt.outcome;
  if (!providerSpendRejectionHasNoCharge(outcome) || outcome?.state !== 'rejected') return null;
  if (outcome.evidence.reason === 'not-sent') return providerSpendEvidenceDigest({ schemaVersion: 1, kind: 'pre-post-refusal' });
  if (outcome.evidence.body.byteLength === 0) return null;
  const endpoint = receipt.profile.adapter.definition['endpoint'];
  const vendor = policy.vendors.find(row => typeof endpoint === 'string' && row.endpoints.includes(endpoint) && row.statuses.includes(outcome.evidence.httpStatus!));
  return vendor ? providerSpendEvidenceDigest({ schemaVersion: policy.schemaVersion, kind: 'vendor-admission-rejection', ...vendor }) : null;
}
