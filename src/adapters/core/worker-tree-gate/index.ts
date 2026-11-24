export { scanWorkerTree, workerTreeDenied, workerTreeViews, WORKER_TREE_DENY, WORKER_TREE_PATTERN_RULES } from './internal/scan.js';
export { configSecretHit, isConfigFile } from './internal/content.js';
export type { WorkerTreeGateOptions, WorkerTreeKnownSecrets, WorkerTreeView } from './internal/scan.js';
export { inspectSealedWorkerTree, reviewSealedWorkerTree, sealWorkerTree, reopenWorkerTree, sealedWorkerTreeLocation, verifySealedWorkerTree } from './internal/sealed-tree.js';
export { inspectPreparedInputEntry, readPreparedInputFile, writePreparedInputFile, type TreeSelection, type TreeSelectionEntry } from './internal/sealed-capture.js';
export { openSealedNativeInput, verifyPackageObject } from './internal/sealed-input.js';
