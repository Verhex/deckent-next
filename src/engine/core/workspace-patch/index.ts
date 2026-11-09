export { WorkspacePatchApplication } from './internal/application.js';
export type { WorkspacePatchSource, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkspacePatchStore, RunBoundTaskStore } from './internal/application.js';
export { AttemptCustodyReleaseApplication, sweepAttemptCustodyScopes, idleAttemptWorkspace } from './internal/custody.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AttemptCustodyOutcome, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AttemptCustodyHoldReason, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AttemptCustodyRetention, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AttemptCustodySweep, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AttemptCustodySweepEntry, AttemptWorkspaceCustody, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AttemptCustodyPorts, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ SourceBaseSweep } from './internal/custody.js';
export { classifyPatchScope, assertPatchScope, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PATCH_SCOPE_MATCHER, PATCH_SCOPE_ERROR_PATHS } from './internal/scope.js';
export type { PatchScope, PatchScopeMode } from './internal/scope.js';
export { workspacePatchSchema, patchPathSchema, historyPathSchema, patchFile, patchDigest, patchExclusions, isPatchExcluded, patchLimitFields, WorkspacePatchError } from './internal/contract.js';
export type { WorkspacePatch, PatchFile, PatchLimits } from './internal/contract.js';
export { WorkspaceIntegrationApplication, integrationCommandSchema, integrationIntentSchema, integrationManifestSchema } from './internal/integration.js';
export type { IntegrationCommand, IntegrationIntent, IntegrationManifest, IntegrationRecord, IntegrationStore, IntegrationTarget, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ IntegrationObservation } from './internal/integration.js';
export { WorkspaceIntegrationInspection, integrationQuerySchema } from './internal/inspection.js';
export type { IntegrationQuery, IntegrationReader } from './internal/inspection.js';
export { WorkspaceDeliveryApplication, integrationDeliveryCommandSchema, integrationDeliveryPlanSchema, integrationDeliveryIntentSchema } from './internal/delivery.js';
export type { IntegrationDeliveryCommand, IntegrationDeliveryPlan, IntegrationDeliveryIntent, IntegrationDeliveryRecord, IntegrationDeliveryStore, IntegrationDeliveryTarget } from './internal/delivery.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkspacePatchLimitDetail } from './internal/contract.js';
export { pinRunToDelivery } from './internal/delivery-run.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ DeliveryRunPinRequest } from './internal/delivery-run.js';
export { WorkspaceAdoptionApplication, WorkspaceAdoptionError, requireDelivered, integrationAdoptionCommandSchema, integrationRollbackCommandSchema, integrationAdoptionIntentSchema, adoptionTargetRefSchema, adoptionNotApplied } from './internal/adoption.js';
export type { IntegrationAdoptionCommand, IntegrationRollbackCommand, IntegrationAdoptionIntent, IntegrationAdoptionRecord, IntegrationAdoptionStore, IntegrationAdoptionTarget, AdoptionTargetObservation, AdoptionFence, AdoptionClaimObservation, WorkspaceAdoptionErrorCode } from './internal/adoption.js';
export { adoptionVerificationSchema, adoptionVerificationPhaseOutcome, executionProfileFingerprint, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ verifyDeliveredCommit, verifyAdoption,
  adoptionCriteriaMeet } from './internal/verification.js';
export type { AdoptionVerification, AdoptionVerificationPolicy, AdoptionVerificationStore, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AdoptionVerificationRequest,
  AdoptionVerificationRequirement, CriterionWithin } from './internal/verification.js';

export type { IntegrationCommitMetadata } from './internal/commit-metadata.js';

export { bindIntegrationCandidate } from './internal/candidate-binding.js';
export { queueCommandIds, queueTicketCommandIds, queueGenerationRef, queueGenerationSchema, assertQueueGitTarget } from './internal/queue-git.js';
export type { GitQueueFence } from './internal/queue-git.js';
export { queueVerificationGraph, assertQueueVerification } from './internal/queue-verification.js';
export { readQueueCandidate, queueCommitMetadata, planQueueCommit, describeWorkspaceQueueCandidate } from './internal/queue-custody.js';

export { SnapshotBudget, parseBaseListing, baseIdentical, gitBlobOid, hashAlgorithmOf, diffAgainstBase, snapshotDigest } from './internal/snapshot.js';
export type { Snapshot, BaseEntry, BaseListing } from './internal/snapshot.js';
export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ patchPathsIntersect, changedHistoryPaths, assertDisjointHistory } from './internal/path-history.js';
export { gitFailure } from './internal/snapshot.js';
export { parseIntegrationDiffStats } from './internal/snapshot.js';
export { assertIntegrationSnapshot } from './internal/snapshot.js';
export { adoptionFenceRef, adoptionFenceText, adoptionFenceObjectSchema, adoptionRepositoryIdentity, legacyQueueBinding } from './internal/git-fence.js';
export { assertIntegrationBefore } from './internal/snapshot.js';
export { capturedWorkspacePatch } from './internal/snapshot.js';
export { prepareIntegrationSnapshot } from './internal/snapshot.js';

export { createWorkspaceQueuePreparation } from './internal/queue-preparation.js';
export { workspaceQueueShadow } from './internal/queue-shadow.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkspaceQueueShadowPorts } from './internal/queue-shadow.js';
export { assertIntegrationBase } from './internal/git-integration-base.js';
export { GitQueueTargetApplication, GIT_QUEUE_DISPLAY, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ QUEUE_PROTECTED_BASE_REFS, queueTargetConfigRefusal } from './internal/git-queue-target.js';
export { createWorkspaceQueueEffects } from './internal/queue-effects.js';
export { createWorkspaceQueueAdmission } from './internal/queue-admission.js';
export { reattemptCommandIds, reattemptEligibility, reattemptGraph, stepDeliveryReattempt, stepWorkspaceQueueReattempt } from './internal/reattempt.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ DeliveryReattemptPorts, ReattemptEffects, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkspaceReattemptContext } from './internal/reattempt.js';
export { assertRunDeliveryIntent, stepRunDelivery, stepWorkspaceRunDelivery } from './internal/run-intent.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ RunDeliveryPorts, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ RunDeliveryStep, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkspaceRunDeliveryContext } from './internal/run-intent.js';
export { workspacePatchChangeFacts, deliverySummary, patchChangeDigests } from './internal/effect-summary.js';
export { assertSameWorkSource } from './internal/work-source.js';
