import { z } from 'zod';
import { RegistryError, type ModelInvocationProfile, type ModelInvocationReceipt, type ProviderSpendQuote } from '#domain/index.js';
import { isLiteralLoopbackHostname } from '#platform/index.js';
import data from './no-charge-policy.json' with { type: 'json' };
import { providerSpendEvidenceDigest, providerSpendQuoteDigest } from './account.js';
import { providerSpendRejectionHasNoCharge } from './invocation.js';

/** Complete admission rejections that can carry no charge (invariant): 408/409/499 and every 5xx stay uncertain. */
export const PROVIDER_SPEND_NO_CHARGE_STATUSES: readonly number[] = Object.freeze([400, 401, 402, 403, 404, 405, 406, 407, 410, 411, 412, 413, 414, 415, 416,
  417, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451]);
const exactEndpoint = z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && url.href === value && !url.username && !url.password && !url.search && !url.hash; });
const certificationSchema = z.object({ vendor: z.string().min(1).max(128), endpoints: z.array(exactEndpoint).min(1).max(32),
  statuses: z.array(z.number().int().refine(status => PROVIDER_SPEND_NO_CHARGE_STATUSES.includes(status))).min(1), source: z.string().url() }).strict();
type Certification = z.infer<typeof certificationSchema>;
const policy = z.object({ schemaVersion: z.literal(1), retrievedAt: z.string(), note: z.string(), vendors: z.array(certificationSchema) }).strict().parse(data);
/** Law 10: the packaged policy is the seed; a distribution adds its own vendor rows (dotted ids) through `deckent/extensions` before composeCore
 * seals. Add-only: a row can never widen an existing certification (no shared endpoint, no core namespace); registration grants nothing. */
export class ProviderSpendNoChargeRegistry {
  private readonly rows: Certification[] = []; private sealed = false;
  constructor(core: readonly Certification[]) { for (const row of core) this.admit(row, true); }
  private admit(input: unknown, core: boolean) {
    const parsed = certificationSchema.safeParse(input);
    if (!parsed.success) throw new RegistryError('REGISTRY_MANIFEST_INVALID');
    if (core === parsed.data.vendor.includes('.')) throw new RegistryError('REGISTRY_NAMESPACE_RESERVED');
    if (this.rows.some(row => row.vendor === parsed.data.vendor || row.endpoints.some(endpoint => parsed.data.endpoints.includes(endpoint))))
      throw new RegistryError('REGISTRY_ADAPTER_DUPLICATE');
    this.rows.push(Object.freeze({ ...parsed.data, endpoints: Object.freeze([...parsed.data.endpoints]), statuses: Object.freeze([...parsed.data.statuses]) }) as Certification);
  }
  register(input: unknown): void { if (this.sealed) throw new RegistryError('REGISTRY_SEALED'); this.admit(input, false); }
  seal(): void { this.sealed = true; }
  find(endpoint: string, status: number): Certification | null { return this.rows.find(row => row.endpoints.includes(endpoint) && row.statuses.includes(status)) ?? null; }
}
export const providerSpendNoChargeRegistry = new ProviderSpendNoChargeRegistry(policy.vendors);
export function registerProviderSpendNoChargeCertification(input: unknown): void { providerSpendNoChargeRegistry.register(input); }

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

/** PROVIDER-LOCALITY: only a literal loopback IP is this machine (platform invariant); the name `localhost`, LAN and WSL addresses are not. */
function literalLoopback(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try { return isLiteralLoopbackHostname(new URL(value).hostname); } catch { return false; }
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
  const vendor = typeof endpoint === 'string' ? providerSpendNoChargeRegistry.find(endpoint, outcome.evidence.httpStatus!) : null;
  return vendor ? providerSpendEvidenceDigest({ schemaVersion: policy.schemaVersion, kind: 'vendor-admission-rejection', ...vendor }) : null;
}
