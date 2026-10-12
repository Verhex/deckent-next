import { z } from 'zod';
import { nativeCliIdSchema, type ModelInvocationProfile, type ExecutionProfileDefinition } from '#domain/index.js';
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
  if (input.kind === 'worker') return subscription.safeParse(input.profile.parameters['nativeSubscription']).success ? 'not-metered' : 'metered';
  return providerSpendLocalZeroTariffProfile(input.profile) ? 'not-metered' : 'metered';
}

export function workSpendingBasis(profiles: readonly (ExecutionProfileDefinition | null)[]) {
  return { semantics: profiles.every(profile => classifyWorkSpending({ kind: 'worker', profile }) === 'not-metered') ? 'not-metered' as const : 'metered' as const,
    digest: providerSpendEvidenceDigest({ schemaVersion: 1, profiles }) };
}
/** Initial account projection only; this creates neither a ledger account nor a reservation. */
export function configuredProviderSpendCheckpoint(budget: ProviderSpendBudget) {
  return createProviderSpendCheckpoint(createProviderSpendAccount(budget), 1, 0);
}
