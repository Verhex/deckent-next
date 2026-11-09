import type { ModelReference } from '#domain/index.js';

/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). Projection of profiles already validated by the configuration owner, not a send-admission contract. */
export type OnboardingBillingProfile = Readonly<{ schemaVersion: number; scopeId: string;
  reference: ModelReference; billingAxis?: string }>;

/** Presentation only: the governed invocation still owns tariff, capacity, reservation and settlement. */
export function onboardingNeedsBudget(profiles: readonly OnboardingBillingProfile[], scopeId: string, reference: ModelReference | null,
  legacyMetered: boolean, currentUsd: number | null): boolean {
  const profile = profiles.find(row => row.scopeId === scopeId && reference
    && row.reference.providerId === reference.providerId && row.reference.providerVersion === reference.providerVersion
    && row.reference.modelId === reference.modelId && row.reference.modelVersion === reference.modelVersion);
  const metered = profile && profile.schemaVersion !== 1 ? profile.billingAxis === 'metered' : legacyMetered;
  return metered && (currentUsd === 0 || currentUsd === null);
}
