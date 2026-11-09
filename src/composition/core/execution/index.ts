export { openConfiguredExecution } from './internal/open.js';
export { executeConfiguredTask } from './internal/task.js';
export { releaseConfiguredPreflightProbes, settleConfiguredEnvironmentProbes } from './internal/preflight.js';
/** @deprecated B1-17 (KG7 F3): adapter symbols re-exported here have no importer; kept one release for unverified Enterprise callers. Import them from `#adapters/index.js`. */
export { validateExecutionSupervisorProfile, executionTaskSilenceDeadline, executionTaskHiddenPaths } from '#adapters/index.js';
export { nativeWorkerAdmission } from '#composition/core/runs/index.js';
export { createConfiguredNativeCliWorkerPorts } from './internal/native-runtime.js';
export type { NativeCliWorkerRuntime } from './internal/native-runtime.js';
/** @deprecated B1-17 (KG7 F3): as above; import from `#adapters/index.js`. */
export { recordedTaskSupervisor, inspectRecordedTaskActivity, taskProfileObservesWorker } from '#adapters/index.js';
export { createConfiguredNativeCliWorkerRuntime, withNativeCliWorkerOptions } from './internal/worker-runtime.js';
