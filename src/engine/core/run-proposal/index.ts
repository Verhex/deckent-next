export { RunProposalApplication, proposalRunGraph, RunProposalInspectionApplication } from './internal/proposal-application.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ RunProposalContext, RunProposalResult, PlanningMemoryNote } from './internal/proposal-application.js';
export { runProposalQuerySchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ runProposalRecordSchema, parseRunProposal, parseRunProposalRecord, runProposalDigest } from './internal/proposal-contract.js';
export type { RunProposalQuery, RunProposalRecord, RunProposalStore } from './internal/proposal-contract.js';
export { validateRunProposal, assertRunProposalSource, recheckRunProposalBudget, stableRunProposalBasis, unrecognisedRunProposalPermissions, configuredProposalRegistry } from './internal/proposal-validation.js';

export { RunIntentApplication, isRunIntentResult, intentResult } from './internal/intent-application.js';
export type { RunIntentResult, RunPlanningResult } from './internal/intent-application.js';
export { parseRunProposalEnvelope, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ runIntentRecordSchema, setupIntentFactSchema, runIntentDigest, isRunIntent, proposalIdentity } from './internal/proposal-contract.js';
export type { RunIntentRecord, RunProposalEnvelope, SetupIntentFact } from './internal/proposal-contract.js';

export { intentStartExpectedRevision } from './internal/intent-application.js';
export { localRunOffered, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type LocalRunContext } from './internal/local-run.js';
