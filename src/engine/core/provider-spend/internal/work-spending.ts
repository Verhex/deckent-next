import { z } from 'zod';
import { nativeCliIdSchema, type ModelInvocationBillingAxis, type ModelInvocationProfile, type ExecutionProfileDefinition } from '#domain/index.js';
import { providerSpendEvidenceDigest } from './account.js';
import { createProviderSpendAccount } from './account.js';
import { createProviderSpendCheckpoint } from './checkpoint.js';
import type { ProviderSpendBudget } from '#domain/index.js';
import { providerSpendLocalZeroTariffProfile } from './no-charge.js';
export type WorkSpending = 'metered' | 'not-metered';
const subscription = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), provider: nativeCliIdSchema }).passthrough();
/** Trusted selected bindings only; never a model-authored billing claim. Unknown bindings stay metered. */
export function classifyWorkSpending(input: Readonly<{ kind: 'model'; profile: ModelInvocationProfile | null }>
  | Readonly<{ kind: 'worker'; profile: ExecutionProfileDefinition | null }>): WorkSpending {
  if (!input.profile) return 'metered';
  if (input.kind === 'worker') return workerBillingAxis(input.profile) === 'subscription' ? 'not-metered' : 'metered';
  return modelInvocationBillingAxis(input.profile) === 'metered' ? 'metered' : 'not-metered';
}

export function workSpendingBasis(profiles: readonly (ExecutionProfileDefinition | null)[]) {
  return { semantics: profiles.every(profile => classifyWorkSpending({ kind: 'worker', profile }) === 'not-metered') ? 'not-metered' as const : 'metered' as const,
    digest: providerSpendEvidenceDigest({ schemaVersion: 1, profiles }) };
}
/** Initial account projection only; this creates neither a ledger account nor a reservation. */
export function configuredProviderSpendCheckpoint(budget: ProviderSpendBudget) {
  return createProviderSpendCheckpoint(createProviderSpendAccount(budget), 1, 0);
}

/** Compatibility classification never rewrites historical v1 profiles or their digest. */
export function modelInvocationBillingAxis(profile: ModelInvocationProfile): ModelInvocationBillingAxis {
  return profile.schemaVersion === 2 ? profile.billingAxis : providerSpendLocalZeroTariffProfile(profile) ? 'local' : 'metered';
}

/** Unknown worker bindings stay conservatively metered at admission; observation must not claim an API charge. */
export function workerBillingAxis(profile: ExecutionProfileDefinition): ModelInvocationBillingAxis | null {
  return subscription.safeParse(profile.parameters['nativeSubscription']).success ? 'subscription' : null;
}
