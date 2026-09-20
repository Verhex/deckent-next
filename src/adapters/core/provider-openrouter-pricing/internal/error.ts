/** Native metadata and pricing errors never include requests, response bodies or credentials. */
export type OpenRouterPricingErrorCode = 'INVALID_METADATA' | 'ENDPOINT_AMBIGUOUS' | 'ENDPOINT_UNAVAILABLE'
  | 'UNSUPPORTED_PRICING' | 'INCOMPLETE_PRICING' | 'INVALID_REQUEST' | 'STALE_TARIFF' | 'AMOUNT_OVERFLOW'
  | 'METADATA_UNAVAILABLE' | 'METADATA_TOO_LARGE' | 'METADATA_TIMEOUT' | 'METADATA_CANCELLED';
export class OpenRouterPricingError extends Error {
  constructor(readonly code: OpenRouterPricingErrorCode) { super(code); this.name = 'OpenRouterPricingError'; }
}
