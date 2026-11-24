import type { ConfigLoadOptions } from '#platform/index.js';
import { classifyWorkSpending, modelInvocationBillingAxis, providerSpendHasZeroTariff, isRunIntentResult, type RunPlanningResult } from '#engine/index.js';
import { inspectConfiguredModelInvocation } from '#composition/core/model-invocation/index.js';
export type InspectPlanningSpending = () => Promise<Pick<Awaited<ReturnType<typeof inspectConfiguredModelInvocation>>, 'invocation' | 'spending' | 'planUsage'>>;
/** Optional observation under the invocation's own inspect policy; never changes proposal/admission authority. */
export function withPlanningSpending(root: string, result: import('#engine/index.js').RunProposalResult, options: ConfigLoadOptions, inspect?: InspectPlanningSpending): Promise<import('#engine/index.js').RunProposalResult>;
export function withPlanningSpending(root: string, result: RunPlanningResult, options: ConfigLoadOptions): Promise<RunPlanningResult>;
export async function withPlanningSpending(root: string, result: RunPlanningResult, options: ConfigLoadOptions, inspect?: InspectPlanningSpending): Promise<RunPlanningResult> {
  if (isRunIntentResult(result)) return result;
  const planningSpending = await observePlanningSpending(root, result.proposal.proposal, options, inspect);
  return planningSpending ? Object.freeze({ ...result, planningSpending }) : result;
}
export async function observePlanningSpending(root: string, proposal: import('#domain/index.js').RunProposal, options: ConfigLoadOptions, inspect?: InspectPlanningSpending) {
  if (proposal.source.kind !== 'model') return undefined;
  let planningSpending: NonNullable<import('#engine/index.js').RunProposalResult['planningSpending']> = { class: 'unknown', currency: null, amountMinorUnits: null, evidence: 'unknown' };
  try {
    const source = proposal.source.receipt;
    const view = inspect ? await inspect() : await inspectConfiguredModelInvocation(root,
      { schemaVersion: 2, scopeId: proposal.scopeId, invocationId: source.invocationId, reference: source.reference }, options);
    const receipt = view.invocation;
    // Receipt identity and author are checked again before projecting optional financial evidence.
    const contribution = proposal.source.contribution;
    if (receipt?.request.commandId === source.commandId && receipt.claim.invocationId === source.invocationId
      && (!contribution || (contribution.requestDigest === receipt.request.requestDigest
        && contribution.bindingDigest === receipt.request.expectedBinding.digest && contribution.activationRevision === receipt.activationRevision
        && (!('billingAxis' in contribution) || contribution.billingAxis === modelInvocationBillingAxis(receipt.profile)))) && receipt.outcome?.state === 'responded' && receipt.outcome.content.digest === source.responseDigest
      && receipt.actor.id === proposal.proposer.id && receipt.actor.issuer === proposal.proposer.issuer && receipt.actor.subject === proposal.proposer.subject) {
      const spending = view.spending, state = spending?.disposition;
      const free = 'billingAxis' in receipt.profile ? receipt.profile.billingAxis !== 'metered' : spending ? providerSpendHasZeroTariff(spending.descriptor.quote) : classifyWorkSpending({ kind: 'model', profile: receipt.profile }) === 'not-metered';
      const settled = state && (state.state === 'settled-measured-tariff' || state.state === 'settled-provider-reported' || state.state === 'settled-local');
      planningSpending = { class: free ? 'not-metered' : spending ? 'metered' : 'unknown', currency: spending?.descriptor.quote.currency ?? null, amountMinorUnits: settled && 'amountMinorUnits' in state ? state.amountMinorUnits : null,
        ...('billingAxis' in receipt.profile ? { billingAxis: modelInvocationBillingAxis(receipt.profile) } : {}),
        evidence: view.planUsage ? 'plan-usage' : settled ? spending?.measurement?.basis === 'measured-tariff' && spending.measurement.source.tier === 'upper-bound'
          ? 'measured-tariff-upper-bound' : spending?.measurement?.basis ?? 'settled-local' : state?.state === 'held' ? 'held' : 'unknown' };
    }
  } catch { /* Unavailable/denied supplemental observation cannot undo an already durable proposal. */ }
  return Object.freeze(planningSpending);
}
