export { GitWorkspacePatchSource } from './internal/source.js';
export { GitIntegrationTarget } from './internal/integration-target.js';
export { GitIntegrationDelivery } from './internal/delivery.js';
/** Pure snapshot helpers exposed for contract tests and future non-Git patch sources; they grant no custody. */
export { SnapshotBudget, gitFailure, gitBlobOid, hashAlgorithmOf, listBase, readBaseBlobs, readWorkspace, diffAgainstBase, snapshotDigest } from './internal/snapshot.js';
export type { Snapshot, BaseEntry, BaseListing } from './internal/snapshot.js';
