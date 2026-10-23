import { delegatedUseOf, delegationOwner, delegationPrincipalClass, subscriptionDelegationRefusal, type ModelInvocationProfile, type VerifiedPrincipal } from '#domain/index.js';
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
