import { modelInvocationBillingAxis } from '#engine/core/provider-spend/index.js';
import { TaskGraphError, validateTaskGraph, executionRegistrySchema, resolveTaskWorkClass, encodeCommandProjection, advisoryProposalPermissions, isRecognisedProposalPermission,
  type ModelInvocationReceipt, type ProposalPermission, type RunProposal, type RunProposalBinding, type RecordedTaskAgent, type WorkClassRegistry } from '#domain/index.js';
import { ErrorRegistry, sha256, type KnownSecretSnapshot } from '#platform/index.js';
import { brainOutputDigest, parseBrainDraft } from '#capabilities/index.js';
import { parseProviderSpendCheckpoint, providerSpendRemaining, type ProviderSpendCheckpoint } from '#engine/core/provider-spend/index.js';
import { runProposalPermissionCatalog } from '#engine/core/runs/index.js';
/** Pure gates. Registry metadata advertises permissions; evaluatePolicy still decides each permission. `agents`: the system's agent selection per task
 * now (S8-1b); a candidate agent takes standing admission away (AJAN-ORG S6, owner Q-S3), and the selection is recorded for the admission recheck. */
export function validateRunProposal(proposal: RunProposal, registry: WorkClassRegistry | undefined, checkpointInput: ProviderSpendCheckpoint | null,
  now: number, spending?: Readonly<{ semantics: 'metered' | 'not-metered'; digest: string }>, budgetSource?: 'configured',
  agents?: ReadonlyMap<string, Omit<RecordedTaskAgent, 'taskId'>>): NonNullable<RunProposalBinding['admission']> {
  try { validateTaskGraph(proposal.graph); } catch (error) {
    if (!(error instanceof TaskGraphError)) throw error;
    throw ErrorRegistry.createError('RUN_PROPOSAL_GRAPH_INVALID', { params: { reason: error.code } });
  }
  let standingAdmission = true, policy;
  for (const task of proposal.graph.tasks) {
    if (!task.workClass || (task.workInput?.workClass && task.workInput.workClass !== task.workClass)) throw ErrorRegistry.createError('RUN_PROPOSAL_WORK_CLASS_REQUIRED');
    const resolved = resolveTaskWorkClass(task.kind, task.workClass, registry); policy = resolved.policy;
    const admission = resolved.workClass && 'proposalAdmission' in resolved.workClass ? resolved.workClass.proposalAdmission : undefined;
    standingAdmission &&= admission?.risk === 'low' && admission.standingAdmission === true
      && resolved.policy.bindings.some(row => row.kind === task.kind && row.classId === task.workClass) && agents?.get(task.id)?.standing !== 'candidate';
  }
  const recorded = proposal.graph.tasks.flatMap(task => { const row = agents?.get(task.id); return row ? [{ taskId: task.id, agentId: row.agentId, revision: row.revision, standing: row.standing }] : []; });
  // accept_mark (owner 2026-10-18, Jev 2f191a60): the list is advisory and evaluates nothing; admission evaluates only the system-derived task set.
  // A model's unrecognised or repeated entry is marked on the card instead of refusing the plan; a person's own list stays strict.
  if (proposal.source.kind === 'human') {
    const catalog = runProposalPermissionCatalog(registry), seen = new Set<string>();
    for (const permission of proposal.requiredPermissions) {
      const key = JSON.stringify(permission);
      if (seen.has(key) || !isRecognisedProposalPermission(permission, catalog)) throw ErrorRegistry.createError('RUN_PROPOSAL_PERMISSION_UNKNOWN');
      seen.add(key);
    }
  }
  const basis = { registryRevision: policy!.revision, registryDigest: sha256(encodeCommandProjection('proposal-registry:1', policy)), standingAdmission, ...(recorded.length ? { agents: recorded } : {}),
    ...(spending ? { budgetSemantics: spending.semantics === 'not-metered' ? 'not-metered' as const : 'admission-check-only' as const, spendingDigest: spending.digest } : {}) };
  if (spending?.semantics === 'not-metered') return Object.freeze({ ...basis, budget: null });
  if (!checkpointInput) throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_MISSING');
  const checkpoint = parseProviderSpendCheckpoint(checkpointInput), account = checkpoint.account, budget = account.budget;
  if (budget.scopeId !== proposal.scopeId) throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_SCOPE');
  if (budget.currency !== proposal.budgetCeiling.currency) throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_CURRENCY');
  const remaining = providerSpendRemaining(checkpoint)!.remainingMinorUnits, ceiling = proposal.budgetCeiling.limitMinorUnits;
  // The refusal names the money left so the person sees what a plan may still declare (owner 2026-10-17).
  if (account.frozen || remaining < ceiling) throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_EXCEEDED', { params: { remaining, ceiling, currency: budget.currency } });
  return Object.freeze({ ...basis,
    budget: { budgetId: budget.budgetId, budgetRevision: budget.revision, checkpointDigest: checkpoint.digest,
      remainingMinorUnits: remaining, checkedAt: now, ...(budgetSource ? { source: budgetSource } : {}) } });
}

/** The configured admission registry's work classes: one reading for proposal validation, inspection and the approval card. */
export const configuredProposalRegistry = (admission: Readonly<{ registry: unknown }> | null): WorkClassRegistry | undefined =>
  admission ? executionRegistrySchema.parse(admission.registry).workClasses : undefined;
/** Advisory entries this installation does not recognise, each once. Response-only: never stored, never evaluated, never a grant. */
export function unrecognisedRunProposalPermissions(proposal: RunProposal, registry: WorkClassRegistry | undefined): readonly ProposalPermission[] {
  const catalog = runProposalPermissionCatalog(registry);
  return advisoryProposalPermissions(proposal.requiredPermissions, proposal.graph).filter(row => !isRecognisedProposalPermission(row, catalog));
}
/** The admission basis a pending approval keeps exact on resubmission (recheck_ceiling, owner 2026-10-18). The person approves the declared
 * ceiling, never the moving balance: registry, budget identity/revision/source and spending semantics stay exact, while the checkpoint digest and
 * money left may move. validateRunProposal rechecks currency, frozen and money left >= ceiling on every submission. */
export function stableRunProposalBasis(input: RunProposalBinding['admission']): unknown {
  // S8-1b: the agent selection is re-derived at admission (a changed active agent needs the card there); it never parks the proposal. Standing
  // admission is the registry's (digest-bound) answer plus that selection, so it is left out too: a promoted candidate then proceeds on its card.
  if (!input) return input;
  const basis = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'agents' && key !== 'standingAdmission')) as Omit<typeof input, 'agents' | 'standingAdmission'>;
  const budget = basis.budget;
  if (!budget) return basis;
  return { ...basis, budget: { budgetId: budget.budgetId, budgetRevision: budget.budgetRevision, checkedAt: budget.checkedAt, ...(budget.source ? { source: budget.source } : {}) } };
}
/** The same recheck inside the Run transaction, against the account row read under the writer lock. */
export function recheckRunProposalBudget(budget: NonNullable<NonNullable<RunProposalBinding['admission']>['budget']>, ceiling: RunProposal['budgetCeiling'],
  checkpointInput: unknown): void {
  const checkpoint = parseProviderSpendCheckpoint(checkpointInput), account = checkpoint.account;
  if (account.budget.budgetId !== budget.budgetId || account.budget.revision !== budget.budgetRevision || account.budget.currency !== ceiling.currency) {
    throw ErrorRegistry.createError('RUN_PROPOSAL_BASIS_STALE');
  }
  const remaining = providerSpendRemaining(checkpoint)!.remainingMinorUnits;
  if (account.frozen || remaining < ceiling.limitMinorUnits) {
    throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_EXCEEDED', { params: { remaining, ceiling: ceiling.limitMinorUnits, currency: ceiling.currency } });
  }
}

export function assertRunProposalSource(proposal: RunProposal, receipt: ModelInvocationReceipt | null, text?: string | null, known?: KnownSecretSnapshot): void {
  if (proposal.source.kind !== 'model') return;
  const reference = proposal.source.receipt;
  if (!receipt || receipt.request.commandId !== reference.commandId || receipt.claim.invocationId !== reference.invocationId
    || receipt.request.scopeId !== proposal.scopeId || receipt.outcome?.state !== 'responded' || receipt.outcome.content.digest !== reference.responseDigest
    || encodeCommandProjection('model-ref', receipt.request.reference) !== encodeCommandProjection('model-ref', reference.reference)
    || encodeCommandProjection('actor', { id: receipt.actor.id, issuer: receipt.actor.issuer, subject: receipt.actor.subject })
      !== encodeCommandProjection('actor', proposal.proposer)) throw ErrorRegistry.createError('RUN_PROPOSAL_SOURCE_INVALID');
  const contribution = proposal.source.contribution;
  if (contribution) {
    if ((contribution.schemaVersion === 2 && contribution.billingAxis !== modelInvocationBillingAxis(receipt.profile)) || contribution.requestDigest !== receipt.request.requestDigest || contribution.activationRevision !== receipt.activationRevision
      || contribution.bindingDigest !== receipt.request.expectedBinding.digest || !text) throw ErrorRegistry.createError('RUN_PROPOSAL_SOURCE_INVALID');
    // The system may only narrow the model's ceiling (BrainPlanApplication caps it at the remaining money); graph and permissions are exact.
    const draft = parseBrainDraft(text, known), ceiling = proposal.budgetCeiling;
    if (brainOutputDigest(draft) !== contribution.outputDigest || ceiling.currency !== draft.budgetCeiling.currency || ceiling.limitMinorUnits > draft.budgetCeiling.limitMinorUnits
      || brainOutputDigest({ graph: proposal.graph, budgetCeiling: draft.budgetCeiling, requiredPermissions: proposal.requiredPermissions }) !== contribution.outputDigest) throw ErrorRegistry.createError('RUN_PROPOSAL_SOURCE_INVALID');
  }
}
