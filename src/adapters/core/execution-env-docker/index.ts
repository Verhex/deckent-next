// I-D2: the person's approved Docker Engine install (INIT-D2): dated apt data with the pinned key, a pure planner, read-only host probes,
// the foreground sudo executor and the card text. The decision and audit owner is engine/core/setup (ExecutionEnvironmentInstallApplication).
export { DOCKER_APT, dockerAptSchema, type DockerAptData } from './internal/registry.js';
export { dockerCommandLines, dockerSource, dockerSourcesFile, dockerSteps, planDockerInstall, type DockerHostFacts, type DockerInstallPlan, type DockerInstallStep,
  type DockerPrintReason, type DockerSource } from './internal/plan.js';
export { HOST_DOCKER_PORTS, observeDockerHost, stageDockerFiles, type DockerHostPorts } from './internal/host.js';
export { installedDockerVersion, resolveSudo, runDockerInstall, spawnForeground, sudoEnvironment, verifyInstalledSource, type DockerInstallPorts, type DockerInstallResult, type DockerTerminalInput,
  type DockerStepRun } from './internal/install.js';
export { EXECUTION_ENVIRONMENT_INSTALL, dockerCardBody, dockerInstallOffer, dockerPrintLines, dockerResultLines } from './internal/card.js';
