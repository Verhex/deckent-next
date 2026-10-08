export type ProviderSpendErrorCode = 'PROVIDER_SPEND_INVALID' | 'PROVIDER_SPEND_CONFLICT'
  | 'PROVIDER_SPEND_EXHAUSTED' | 'PROVIDER_SPEND_FROZEN' | 'PROVIDER_SPEND_TARIFF_UNVERIFIED' | 'PROVIDER_SPEND_UNAVAILABLE' | 'PROVIDER_SPEND_RESULT_LIMIT';

export type ProviderSpendNextAction = 'models.revise-budget' | 'models.reconcile-spending' | 'config.write-tariff';
export class ProviderSpendError extends Error {
  readonly nextAction: ProviderSpendNextAction | null;
  constructor(readonly code: ProviderSpendErrorCode) { super(code); this.name = 'ProviderSpendError';
    this.nextAction = code === 'PROVIDER_SPEND_FROZEN' ? 'models.reconcile-spending' : code === 'PROVIDER_SPEND_EXHAUSTED' ? 'models.revise-budget'
      : code === 'PROVIDER_SPEND_TARIFF_UNVERIFIED' ? 'config.write-tariff' : null; }
}
