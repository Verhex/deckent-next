// I-S2: setup detection for the execution-environment family (registry-driven; Docker today) and the shared read-only process boundary.
export { detectExecutionFacts, parseExecutionRuntimes, EXECUTION_RUNTIMES, HOST_EXECUTION_PORTS, type ExecutionDetectPorts, type ExecutionRuntimeEntry } from './internal/detect.js';
export { executionSetupFamily, executionFactsSchema, EXECUTION_STAGE_ID, WORKER_IMAGE_ESTIMATED_GB, type ExecutionFacts, type RuntimeFacts, type ExecutionInstallOffer, type ExecutionFamilyOptions } from './internal/family.js';
export { workerImageEstimate } from './internal/estimate.js';
export { findExecutable, runDetectCommand, type DetectEnvironment, type DetectProcessResult, type DetectRunner } from './internal/process.js';
