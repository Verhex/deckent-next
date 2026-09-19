export { registerProviderConfig, assertProviderLimitPolicyLayerPrecedence } from '#adapters/core/contract/index.js';
export { openSqliteAttemptStore, openSqliteInventoryReader } from '#adapters/core/attempt-store/index.js';
export type { SqliteAttemptStore, SqliteAttemptOptions, SqliteInventoryReader, SqliteInventoryOptions } from '#adapters/core/attempt-store/index.js';
export { DockerSupervisor, validateDockerSupervisorProfile, validateDockerTaskProfile, resolveDockerTaskProfile, DockerTaskProfileError, identifyDockerRequest, runNodeDockerCommand, DockerCommandFailure } from '#adapters/core/docker-supervisor/index.js';
export type { DockerSupervisorOptions } from '#adapters/core/docker-supervisor/index.js';
export { LocalOsPrincipalVerifier, readLocalOsIdentity } from '#adapters/core/local-principal/index.js';
export { GitWorkspaceBroker } from '#adapters/core/git-workspace/index.js';
export type { GitWorkspaceOptions, GitWorkspaceLease } from '#adapters/core/git-workspace/index.js';
export { gitSourcePreimageSchema, gitSourceBaseSchema, fingerprintGitSource } from '#adapters/core/git-workspace/index.js';
export type { GitSourcePreimage, GitSourceBase } from '#adapters/core/git-workspace/index.js';
export { GitRunWorkspaceProvider } from '#adapters/core/git-workspace/index.js';
export { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
export type { FileArtifactOptions } from '#adapters/core/file-artifacts/index.js';
export { FilePolicySource, PolicyFileError } from '#adapters/core/file-policy/index.js';
export type { FilePolicyOptions } from '#adapters/core/file-policy/index.js';
export { ProcessSupervisor } from '#adapters/core/process-supervisor/index.js';
export type { ProcessSupervisorOptions } from '#adapters/core/process-supervisor/index.js';
export type { DockerCommand, DockerCommandOutput, DockerCommandRunner } from '#adapters/core/docker-supervisor/index.js';
export { processCommandSchema, processEvidenceSchema, validateProcessEvidence, ProcessRunnerError, runNodeProcess, createScopedNodeDockerRunner } from '#adapters/core/process-runner/index.js';
export type { ProcessCommand, ProcessEvidence } from '#adapters/core/process-runner/index.js';

export { LocalPeerShutdownAuthentication } from '#adapters/core/local-runtime-socket/index.js';
export * from '#adapters/core/local-runtime-socket/index.js';

export { readInstallationProfileFile, InstallationProfileFileError } from '#adapters/core/installation-profile-file/index.js';
export { measureInstalledPackage, InstallationArtifactError } from '#adapters/core/installation-artifacts/index.js';
export { probeDockerImageAvailability, DockerImageProbeError } from '#adapters/core/docker-supervisor/index.js';

export { withInstallationJournal, InstallationJournalError } from '#adapters/core/installation-journal/index.js';
export type { InstallationJournalOptions, InstallationJournalSession, InstallationJournalErrorCode } from '#adapters/core/installation-journal/index.js';
