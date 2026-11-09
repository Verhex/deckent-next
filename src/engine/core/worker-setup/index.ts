// BR1 (owner Q2 2026-10-23): the first durable job's setup: the worker image owner (build after a card, or adopt), the execution family's worker
// image and settings stages, and the `work` family (first kind and pool). Kept out of engine/core/setup, whose Core stays free of
// container-runtime, source-control and coding vocabulary (I-S1).
export { WorkerImageSetupApplication, planFirstWorkerImage } from './internal/worker-image.js';
export type { WorkerImageBuildInput, WorkerImageCard, WorkerImagePorts, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkerImageStatus } from './internal/worker-image.js';
export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ RUNTIME_STAGE_ID, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ SETTINGS_STAGE_ID, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WORKER_STAGE_ID, workerFactsSchema, workerSetupStages } from './internal/worker-stages.js';
export { WORK_SETUP_FAMILY, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WORK_DEFAULTS, WORK_PROVIDERS, WORK_KIND_STAGE_ID, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WORK_POOL_STAGE_ID, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ workFactsSchema } from './internal/work-family.js';

export { workerImageBudget, workerConsentBinding, matchingWorkerConsent, interruptedWorkerImage, workerImageStateSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ consentProviders } from './internal/acquisition.js';
export type { WorkerImageState, WorkerConsentBinding } from './internal/acquisition.js';

export { hasWorkerKind } from './internal/worker-stages.js';
