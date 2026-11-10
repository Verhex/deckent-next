export { readWorkerImageHeldVersion, readWorkerImageSources, prepareWorkerImageBuildContext, runWorkerImageBuild, WorkerImageBuildError, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WORKER_IMAGE_BUILDER_FILES, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WORKER_IMAGE_ASSET_DIRECTORY } from './internal/build.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkerImageBuildErrorCode, WorkerImageBuildRunner } from './internal/build.js';
export { buildWorkerImageInHome, observeWorkerImage, readBuiltWorkerLineage, readNewestWorkerReceipt, workerImagePresence, workerImageSetupPorts } from './internal/setup.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkerImagePresence, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkerImageReceiptView } from './internal/setup.js';

export { resolveWorkerBuildPlan } from './internal/resolve.js';
export type { WorkerResolution } from './internal/resolve.js';

export { withWorkerBuilder, readWorkerHistory, type WorkerReservation } from './internal/custody.js';

export { WorkerImageRemovalTarget, workerRemovalGuard } from './internal/removal.js';
export type { WorkerRemovalResource, WorkerRemovalObservation, WorkerRemovalDriver } from './internal/removal.js';
export { observeWorkerRemovalReferences, nativeWorkerRemovalDriver, workerImageManualCommand } from './internal/removal-driver.js';
export { workerLeaseReferences } from './internal/references.js';
export type { WorkerReferenceOwner, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ NativeWorkerRemovalInput } from './internal/removal-driver.js';
export { observeWorkerRemovalInventory } from './internal/removal-inventory.js';

export { readWorkerImageState, writeWorkerImageState, recoverWorkerImageContext, observeWorkerImageProgress, watchWorkerImageRequests } from './internal/state.js';

export { inspectWorkerImageChoices, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type WorkerImageChoice } from './internal/choices.js';
