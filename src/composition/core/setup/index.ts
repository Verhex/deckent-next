// I-D2: the approved execution-environment install flow (policy, witness, card, audit, re-detection) around adapters/core/execution-env-docker.
// I-S3 adds the setup observation/apply wiring to this unit.
export { installExecutionEnvironment, type ExecutionInstallDeps, type ExecutionInstallStatus } from './internal/install.js';
