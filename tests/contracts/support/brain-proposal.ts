import { runProposalDigest, type RunProposalResult } from '#engine/index.js';
import { proposalFixture } from './run-proposal.js';
export function pendingBrainFixture(): RunProposalResult {
  const proposal = proposalFixture(), digest = runProposalDigest(proposal);
  return { schemaVersion: 1, run: null, runtimeTotalSpendEnforced: false, budgetSemantics: 'admission-check-only',
    proposal: { schemaVersion: 1, proposal, digest, revision: 1, recordedAt: Date.now(), status: 'pending', reason: 'RUN_APPROVAL_REQUIRED', authority: null,
      approval: { approvalId: 'brain-approval', expiresAt: Date.now() + 600_000, decisionRecordId: 'decision' },
      binding: { schemaVersion: 1, proposalId: proposal.proposalId, digest, requiredPermissions: [], budgetCeiling: proposal.budgetCeiling,
        admission: { registryRevision: 'registry', registryDigest: 'a'.repeat(64), standingAdmission: false,
          budget: { budgetId: 'scope-budget', budgetRevision: 1, checkpointDigest: 'b'.repeat(64), checkedAt: 100, remainingMinorUnits: 1000 } } } } };
}
