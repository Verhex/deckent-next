import { encodeCommandProjection, isAiPrincipal, type ModelInvocationBillingAxis, type RunProposal, type VerifiedPrincipal, type WorkClassRegistry } from '#domain/index.js';
import { DeckentError, ErrorRegistry, type TrustedClock } from '#platform/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { ProviderSpendCheckpoint } from '#engine/core/provider-spend/index.js';
import { RunAdmissionApplication, RunCreationAuthority, systemOrderedGraph, type BoundRunAdmission, type RunAuthorization, type RunView } from '#engine/core/runs/index.js';
import { parseRunProposal, runProposalDigest, runProposalQuerySchema, type RunProposalQuery, type RunProposalRecord, type RunProposalStore } from './proposal-contract.js';
import { stableRunProposalBasis, validateRunProposal } from './proposal-validation.js';
export interface RunProposalContext {
  readonly registry?: WorkClassRegistry | undefined;
  readonly clock: TrustedClock;
  loadBudget(scopeId: string, principal: VerifiedPrincipal): Promise<ProviderSpendCheckpoint | Readonly<{ checkpoint: ProviderSpendCheckpoint | null; source?: 'configured' }> | null>;
  classifySpending?(proposal: RunProposal): Promise<Readonly<{ semantics: 'metered' | 'not-metered'; digest: string }>>;
  verifySource(proposal: RunProposal, principal: VerifiedPrincipal): Promise<void>;
}
export interface RunProposalResult { readonly schemaVersion: 1; readonly proposal: RunProposalRecord; readonly run: RunView | null;
  readonly planningSpending?: Readonly<{ billingAxis?: ModelInvocationBillingAxis; class: 'metered' | 'not-metered' | 'unknown'; currency: string | null;
    amountMinorUnits: number | null; evidence: 'measured-tariff' | 'measured-tariff-upper-bound' | 'provider-reported' | 'settled-local' | 'plan-usage' | 'held' | 'unknown' }>;
  readonly budgetSemantics: 'admission-check-only' | 'not-metered'; readonly runtimeTotalSpendEnforced: false;
  /** A budget refusal's money left (and declared ceiling), on the response that recorded it only: the amount moves with every charge, so it
   * is never stored and a replay renders the refusal without it. Every other refusal replays byte-identically. */
  readonly reasonParams?: Readonly<Record<string, string | number>> }
const result = (proposal: RunProposalRecord, run: RunView | null = null, error?: unknown): RunProposalResult => Object.freeze({ schemaVersion: 1,
  proposal, run, budgetSemantics: proposal.binding.admission?.budgetSemantics ?? 'admission-check-only', runtimeTotalSpendEnforced: false,
  ...(error instanceof DeckentError && proposal.reason === 'RUN_PROPOSAL_BUDGET_EXCEEDED' && error.code === proposal.reason && error.params ? { reasonParams: error.params } : {}) });
/** The graph a proposal's Run is admitted with: the author's graph plus the system order edges (one definition for admission and store). */
export const proposalRunGraph = (graph: RunProposal['graph']) => {
  try { return systemOrderedGraph(graph); }
  catch { throw ErrorRegistry.createError('RUN_PROPOSAL_GRAPH_INVALID', { params: { reason: 'TASK_GRAPH_INVALID' } }); }
};
const codeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
export class RunProposalApplication {
  constructor(private readonly store: RunProposalStore, private readonly verifier: PrincipalVerifier, private readonly authority: RunCreationAuthority,
    private readonly runs: RunAdmissionApplication, private readonly context: RunProposalContext) {}
  private async validate(proposal: RunProposal, principal: VerifiedPrincipal, now: number) {
    const spending = await this.context.classifySpending?.(proposal);
    const loaded = spending?.semantics === 'not-metered' ? null : await this.context.loadBudget(proposal.scopeId, principal);
    const snapshot = loaded && 'checkpoint' in loaded ? loaded : { checkpoint: loaded };
    return validateRunProposal(proposal, this.context.registry, snapshot.checkpoint, now, spending, 'source' in snapshot ? snapshot.source : undefined);
  }
  async propose(input: unknown, credential?: unknown): Promise<RunProposalResult> {
    const proposal = parseRunProposal(input), principal = await authenticate(this.verifier, credential, proposal.scopeId);
    const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    if (encodeCommandProjection('actor', actor) !== encodeCommandProjection('actor', proposal.proposer)) throw ErrorRegistry.createError('RUN_PROPOSAL_ACTOR_MISMATCH');
    // D2b: only a verified human grants a delivery intent; an MCP/AI or workload proposer never obtains one (it is also never standing).
    if (proposal.delivery && isAiPrincipal(principal)) throw ErrorRegistry.createError('DELIVERY_INTENT_NOT_ADMITTED');
    const digest = runProposalDigest(proposal);
    // The proposal keeps the author's graph (its digest and any model source check); the admitted command carries the system edges.
    const command: BoundRunAdmission = { schemaVersion: 1, commandId: proposal.commandId, scopeId: proposal.scopeId, runId: proposal.runId,
      graph: proposalRunGraph(proposal.graph), proposal: { schemaVersion: 1, proposalId: proposal.proposalId, digest,
        budgetCeiling: proposal.budgetCeiling, requiredPermissions: proposal.requiredPermissions, ...(proposal.delivery ? { delivery: { ...proposal.delivery, grantedBy: actor } } : {}), admission: null } };
    // One Run-create policy evaluation. Proposal does not create a second decision/approval owner.
    const evaluation = await this.authority.evaluate(command, principal);
    let record = await this.store.loadProposal(proposal.scopeId, proposal.commandId);
    if (record && record.digest !== digest) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
    if (record && ['rejected', 'parked'].includes(record.status)) return result(record);
    if (!record) {
      record = { schemaVersion: 1, proposal, digest, revision: 0, recordedAt: this.context.clock.sample().wallMs,
        status: 'recorded', binding: command.proposal!, reason: null, approval: null, authority: null };
      try {
        await this.context.verifySource(proposal, principal);
        const admission = await this.validate(proposal, principal, record.recordedAt);
        record = { ...record, binding: { ...record.binding, admission } };
      } catch (error) {
        const code = codeOf(error); if (!code || !ErrorRegistry.has(code)) throw error;
        this.authority.recordUnapplied(command, principal, evaluation);
        return result(await this.store.recordProposal({ ...record, status: 'rejected', reason: code }), null, error);
      }
      // A failed receipt write stops before sealing/approval/Run admission.
      record = await this.store.recordProposal(record);
    }
    const bound = { ...command, proposal: record.binding };
    try {
      // Reconcile an already committed admission before consulting mutable registry/budget/model state.
      const replay = await this.runs.hasReceipt(proposal.scopeId, proposal.commandId);
      if (!replay) {
        await this.context.verifySource(proposal, principal);
        // validate rechecks the approved ceiling against today's money; a parallel charge that still leaves the ceiling covered does not park.
        const current = await this.validate(proposal, principal, record.recordedAt);
        if (encodeCommandProjection('proposal-basis', stableRunProposalBasis(current)) !== encodeCommandProjection('proposal-basis', stableRunProposalBasis(record.binding.admission))) {
          throw ErrorRegistry.createError('RUN_PROPOSAL_BASIS_STALE');
        }
      }
      const admitted = await this.runs.admitEvaluated(bound, principal, evaluation);
      const completed = await this.store.loadProposal(proposal.scopeId, proposal.commandId);
      if (!completed || completed.status !== 'accepted' || completed.digest !== digest
        || encodeCommandProjection('authority', completed.authority) !== encodeCommandProjection('authority', admitted.run.authority)) throw ErrorRegistry.createError('RUN_PROPOSAL_OUTCOME_UNKNOWN');
      return result(completed, admitted.run);
    } catch (error) {
      const code = codeOf(error);
      const pending = error instanceof DeckentError && code === 'RUN_APPROVAL_REQUIRED' ? error.params : undefined;
      // Unknown I/O/commit outcomes cannot be laundered into a rejection or a safe retry claim.
      if (!code || !ErrorRegistry.has(code) || ['RUN_PROPOSAL_OUTCOME_UNKNOWN', 'RUN_COMMAND_CONFLICT', 'RUN_PROPOSAL_COMMAND_CONFLICT'].includes(code)
        || code.startsWith('ATTEMPT_STORE_') || code.startsWith('AUDIT_')) throw error;
      const status = pending ? 'pending' : ['APPROVAL_EXPIRED', 'APPROVAL_STALE', 'APPROVAL_CONFLICT', 'RUN_PROPOSAL_BASIS_STALE'].includes(code) ? 'parked' : 'rejected';
      const next: RunProposalRecord = { ...record, revision: record.revision + 1, status, reason: code, authority: null,
        approval: pending ? { approvalId: String(pending.approvalId), expiresAt: Number(pending.expiresAt), decisionRecordId: String(pending.decisionRecordId) } : null };
      return result(await this.store.transitionProposal(record, next), null, pending ? undefined : error);
    }
  }
}

export class RunProposalInspectionApplication {
  constructor(private readonly store: Pick<RunProposalStore, 'loadProposal'>, private readonly verifier: PrincipalVerifier, private readonly inspection: RunAuthorization) {}
  async inspect(input: RunProposalQuery, credential?: unknown): Promise<RunProposalResult | null> {
    const query = runProposalQuerySchema.parse(input), principal = await authenticate(this.verifier, credential, query.scopeId);
    // authorize the scope before the command lookup, then the exact Run resource before disclosing its plan.
    await this.inspection.authorize('inspect', { scopeId: query.scopeId, runId: query.runId, schemaVersion: 1 }, principal);
    const record = await this.store.loadProposal(query.scopeId, query.commandId);
    if (!record) return null;
    if (record.proposal.runId !== query.runId) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
    return result(record);
  }
}
