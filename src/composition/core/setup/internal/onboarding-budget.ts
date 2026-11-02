import type { TerminalLaunchContext } from '#surfaces/index.js';
type ChatPlan = Awaited<ReturnType<NonNullable<TerminalLaunchContext['describeTerminalChatPlan']>>>;

/** Projection of profiles already validated by the configuration owner, not a send-admission contract. */
export type OnboardingBillingProfile = Readonly<{ schemaVersion: number; scopeId: string;
  reference: NonNullable<ChatPlan['reference']>; billingAxis?: string }>;

/** Presentation only: the governed invocation still owns tariff, capacity, reservation and settlement. */
export function onboardingNeedsBudget(profiles: readonly OnboardingBillingProfile[], scopeId: string, reference: ChatPlan['reference'],
  legacyMetered: boolean, currentUsd: number | null): boolean {
  const profile = profiles.find(row => row.scopeId === scopeId && reference
    && row.reference.providerId === reference.providerId && row.reference.providerVersion === reference.providerVersion
    && row.reference.modelId === reference.modelId && row.reference.modelVersion === reference.modelVersion);
  const metered = profile?.schemaVersion === 2 ? profile.billingAxis === 'metered' : legacyMetered;
  return metered && (currentUsd === 0 || currentUsd === null);
}
