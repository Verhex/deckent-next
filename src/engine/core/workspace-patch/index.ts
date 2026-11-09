export { WorkspacePatchApplication } from './internal/application.js';
export type { WorkspacePatchSource, WorkspacePatchStore, RunBoundTaskStore } from './internal/application.js';
/** @deprecated Import from workspace-adoption; retained for one release. */
export { AttemptCustodyReleaseApplication, sweepAttemptCustodyScopes, idleAttemptWorkspace } from '#engine/core/workspace-adoption/index.js';
/** @deprecated Import from workspace-adoption; retained for one release. */
export type { AttemptCustodyOutcome, AttemptCustodyHoldReason, AttemptCustodyRetention, AttemptCustodySweep, AttemptCustodySweepEntry, AttemptWorkspaceCustody, AttemptCustodyPorts, SourceBaseSweep } from '#engine/core/workspace-adoption/index.js';
/** @deprecated Import from workspace-patch-contract; retained for one release. */
export { classifyPatchScope, assertPatchScope, PATCH_SCOPE_MATCHER, PATCH_SCOPE_ERROR_PATHS } from '#engine/core/workspace-patch-contract/index.js';
/** @deprecated Import from workspace-patch-contract; retained for one release. */
export type { PatchScope, PatchScopeMode } from '#engine/core/workspace-patch-contract/index.js';
/** @deprecated Import from workspace-patch-contract; retained for one release. */
export { workspacePatchSchema, patchPathSchema, historyPathSchema, patchFile, patchDigest, patchExclusions, isPatchExcluded, patchLimitFields, WorkspacePatchError } from '#engine/core/workspace-patch-contract/index.js';
/** @deprecated Import from workspace-patch-contract; retained for one release. */
export type { WorkspacePatch, PatchFile, PatchLimits } from '#engine/core/workspace-patch-contract/index.js';
export { WorkspaceIntegrationApplication } from './internal/integration.js';
/** @deprecated Import from workspace-patch-contract; retained for one release. */
export { integrationCommandSchema, integrationIntentSchema, integrationManifestSchema } from '#engine/core/workspace-patch-contract/index.js';
/** @deprecated Import from workspace-patch-contract; retained for one release. */
export type { IntegrationCommand, IntegrationIntent, IntegrationManifest, IntegrationRecord, IntegrationStore, IntegrationTarget, IntegrationObservation } from '#engine/core/workspace-patch-contract/index.js';
export { WorkspaceIntegrationInspection, integrationQuerySchema } from './internal/inspection.js';
export type { IntegrationQuery, IntegrationReader } from './internal/inspection.js';
export { WorkspaceDeliveryApplication } from './internal/delivery.js';
/** @deprecated Import from workspace-patch-contract; retained for one release. */
export { integrationDeliveryCommandSchema, integrationDeliveryPlanSchema, integrationDeliveryIntentSchema } from '#engine/core/workspace-patch-contract/index.js';
/** @deprecated Import from workspace-patch-contract; retained for one release. */
export type { IntegrationDeliveryCommand, IntegrationDeliveryPlan, IntegrationDeliveryIntent, IntegrationDeliveryRecord, IntegrationDeliveryStore, IntegrationDeliveryTarget } from '#engine/core/workspace-patch-contract/index.js';
/** @deprecated Import from workspace-patch-contract; retained for one release. */
export type { WorkspacePatchLimitDetail } from '#engine/core/workspace-patch-contract/index.js';
export { pinRunToDelivery } from './internal/delivery-run.js';
export type { DeliveryRunPinRequest } from './internal/delivery-run.js';
/** @deprecated Import from workspace-adoption; retained for one release. */
export { WorkspaceAdoptionApplication, WorkspaceAdoptionError, requireDelivered, integrationAdoptionCommandSchema, integrationRollbackCommandSchema, integrationAdoptionIntentSchema, adoptionTargetRefSchema, adoptionNotApplied } from '#engine/core/workspace-adoption/index.js';
/** @deprecated Import from workspace-adoption; retained for one release. */
export type { IntegrationAdoptionCommand, IntegrationRollbackCommand, IntegrationAdoptionIntent, IntegrationAdoptionRecord, IntegrationAdoptionStore, IntegrationAdoptionTarget, AdoptionTargetObservation, AdoptionFence, AdoptionClaimObservation, WorkspaceAdoptionErrorCode } from '#engine/core/workspace-adoption/index.js';
/** @deprecated Import from workspace-adoption; retained for one release. */
export { adoptionVerificationSchema, adoptionVerificationPhaseOutcome, executionProfileFingerprint, verifyDeliveredCommit, verifyAdoption,
  adoptionCriteriaMeet } from '#engine/core/workspace-adoption/index.js';
/** @deprecated Import from workspace-adoption; retained for one release. */
export type { AdoptionVerification, AdoptionVerificationPolicy, AdoptionVerificationStore, AdoptionVerificationRequest,
  AdoptionVerificationRequirement, CriterionWithin } from '#engine/core/workspace-adoption/index.js';

/** @deprecated Import from workspace-patch-contract; retained for one release. */
export type { IntegrationCommitMetadata } from '#engine/core/workspace-patch-contract/index.js';

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
export type { RunDeliveryPorts, RunDeliveryStep, WorkspaceRunDeliveryContext } from './internal/run-intent.js';
/** @deprecated Import from workspace-patch-contract; retained for one release. */
export { workspacePatchChangeFacts, deliverySummary, patchChangeDigests } from '#engine/core/workspace-patch-contract/index.js';
export { assertSameWorkSource } from './internal/work-source.js';
