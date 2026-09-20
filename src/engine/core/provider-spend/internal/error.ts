export type ProviderSpendErrorCode = 'PROVIDER_SPEND_INVALID' | 'PROVIDER_SPEND_CONFLICT'
  | 'PROVIDER_SPEND_EXHAUSTED' | 'PROVIDER_SPEND_FROZEN' | 'PROVIDER_SPEND_UNAVAILABLE';

export class ProviderSpendError extends Error {
  constructor(readonly code: ProviderSpendErrorCode) { super(code); this.name = 'ProviderSpendError'; }
}
