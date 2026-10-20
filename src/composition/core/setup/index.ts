// I-D2: the approved execution-environment install flow (policy, witness, card, audit, re-detection) around adapters/core/execution-env-docker.
// I-S3: bare `deckent init`'s observation and apply port (each stage through its existing owner), registered once in the CLI entry.
export { installExecutionEnvironment, type ExecutionInstallDeps, type ExecutionInstallStatus } from './internal/install.js';
export { configuredSetup } from './internal/wiring.js';
