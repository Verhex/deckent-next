import { TaskGraphError, validateTaskGraph, resolveTaskWorkClass, getPolicyVocabulary, encodeCommandProjection, type ModelInvocationReceipt, type RunProposal,
  type RunProposalBinding, type WorkClassRegistry } from '#domain/index.js';
import { ErrorRegistry, sha256 } from '#platform/index.js';
import { parseProviderSpendCheckpoint, type ProviderSpendCheckpoint } from '#engine/core/provider-spend/index.js';
/** Pure gates. Registry metadata advertises permissions; evaluatePolicy still decides each permission. */
export function validateRunProposal(proposal: RunProposal, registry: WorkClassRegistry | undefined, checkpointInput: ProviderSpendCheckpoint | null,
  now: number): NonNullable<RunProposalBinding['admission']> {
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
      && resolved.policy.bindings.some(row => row.kind === task.kind && row.classId === task.workClass);
  }
  const catalog = [...getPolicyVocabulary().resources, ...(policy?.proposalPermissions ?? [])];
  const seen = new Set<string>();
  for (const permission of proposal.requiredPermissions) {
    const key = JSON.stringify(permission);
    if (seen.has(key) || !catalog.some(row => row.kind === permission.kind && (row.actions as readonly string[]).includes(permission.action))) {
      throw ErrorRegistry.createError('RUN_PROPOSAL_PERMISSION_UNKNOWN');
    }
    seen.add(key);
  }
  if (!checkpointInput) throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_MISSING');
  const checkpoint = parseProviderSpendCheckpoint(checkpointInput), account = checkpoint.account, budget = account.budget;
  if (budget.scopeId !== proposal.scopeId) throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_SCOPE');
  if (budget.currency !== proposal.budgetCeiling.currency) throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_CURRENCY');
  const remaining = BigInt(budget.limitMinorUnits) - BigInt(account.reservedMinorUnits) - BigInt(account.settledMinorUnits);
  if (account.frozen || remaining < BigInt(proposal.budgetCeiling.limitMinorUnits)) throw ErrorRegistry.createError('RUN_PROPOSAL_BUDGET_EXCEEDED');
  return Object.freeze({ registryRevision: policy!.revision, registryDigest: sha256(encodeCommandProjection('proposal-registry:1', policy)), standingAdmission,
    budget: { budgetId: budget.budgetId, budgetRevision: budget.revision, checkpointDigest: checkpoint.digest,
      remainingMinorUnits: Number(remaining), checkedAt: now } });
}

export function assertRunProposalSource(proposal: RunProposal, receipt: ModelInvocationReceipt | null): void {
  if (proposal.source.kind !== 'model') return;
  const reference = proposal.source.receipt;
  if (!receipt || receipt.request.commandId !== reference.commandId || receipt.claim.invocationId !== reference.invocationId
    || receipt.request.scopeId !== proposal.scopeId || receipt.outcome?.state !== 'responded' || receipt.outcome.content.digest !== reference.responseDigest
    || encodeCommandProjection('model-ref', receipt.request.reference) !== encodeCommandProjection('model-ref', reference.reference)
    || encodeCommandProjection('actor', { id: receipt.actor.id, issuer: receipt.actor.issuer, subject: receipt.actor.subject })
      !== encodeCommandProjection('actor', proposal.proposer)) throw ErrorRegistry.createError('RUN_PROPOSAL_SOURCE_INVALID');
}
