import { delegatedUseOf, delegationOwner, delegationPrincipalClass, subscriptionDelegationRefusal, subscriptionRawUseRefusal, subscriptionConsent, readHeadlessRejection, verifiedPrincipalSchema, type JsonObject, type ModelInvocationProfile, type VerifiedPrincipal } from '#domain/index.js';
import { modelInvocationBillingAxis } from '#engine/core/provider-spend/index.js';
import { ErrorRegistry } from '#platform/index.js';

/**
 * Owner Q-H3 (2026-10-23), one rule for every caller of the invocation application: an AI/MCP actor or a system workload spends a subscription
 * profile only under the connection owner's delegated-use consent naming its class (`adapter.definition.delegatedUse`, written only by the person
 * on the connect path). Metered and local profiles are unchanged; the person is never refused here (the adapter's uid floor binds the login).
 */
export function assertSubscriptionDelegation(principal: VerifiedPrincipal, profile: ModelInvocationProfile): void {
  const refusal = subscriptionDelegationRefusal({ billing: modelInvocationBillingAxis(profile), principalClass: delegationPrincipalClass(principal),
    owner: delegationOwner(principal), consent: delegatedUseOf(profile.adapter.definition) });
  if (refusal) throw ErrorRegistry.createError(refusal);
}

export function assertSubscriptionRawUse(principal: VerifiedPrincipal, profile: ModelInvocationProfile, entry: 'raw' | 'feature'): void {
  const refusal = subscriptionRawUseRefusal({ entry, principalClass: delegationPrincipalClass(principal), rawUse: profile.adapter.definition['rawUse'] });
  if (refusal) throw ErrorRegistry.createError(refusal);
}

/** Application-owned access interpretation shared by connection composition and invocation. Authentication remains with the caller. */
export function subscriptionActor(input: VerifiedPrincipal) {
  const principal = verifiedPrincipalSchema.parse(input);
  return Object.freeze({ owner: delegationOwner(principal), principalClass: delegationPrincipalClass(principal) });
}
export function prepareSubscriptionConsent(existing: JsonObject | null | undefined, classes: readonly ('ai' | 'system')[] | undefined,
  by: Readonly<{ issuer: string; subject: string }>, atMs: number) {
  return subscriptionConsent(existing, classes, by, atMs);
}
export function readSubscriptionRejection(evidence: Parameters<typeof readHeadlessRejection>[0], adapterIds: ReadonlySet<string>) {
  return readHeadlessRejection(evidence, adapterIds);
}
