export { GitWorkspacePatchSource } from './internal/source.js';
export { gitDockerAttemptCustody } from './internal/custody.js';
export { GitIntegrationTarget } from './internal/integration-target.js';
export { GitIntegrationDelivery } from './internal/delivery.js';
export { GitIntegrationAdoption } from './internal/adoption.js';
export { GIT_QUEUE_DISPLAY, GitQueueTarget } from './internal/queue-target.js';
export { gitQueueCandidateSource } from './internal/queue-source.js';
/** Pure snapshot helpers exposed for contract tests and future non-Git patch sources; they grant no custody. */
export { SnapshotBudget, gitFailure, gitBlobOid, hashAlgorithmOf, listBase, readBaseBlobs, readWorkspace, completeHiddenBase, diffAgainstBase, snapshotDigest } from './internal/snapshot.js';
export type { Snapshot, BaseEntry, BaseListing } from './internal/snapshot.js';
/** The shared local-only Git invocation construction (network-denial args/env), exposed for a contract test to
 * assert its exact contents rather than only its effect. */
export { GIT_LOCAL_ENV, localGitArgs } from './internal/local-git.js';
export { applyAcceptedPredecessorPatches } from './internal/handoff-start.js';
