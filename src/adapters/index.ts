export { registerProviderConfig, providerSpendingSchema, providerSpendAuditConfigSchema, readTerminalChatConfig, readTerminalConfig, terminalConfigSchema, type TerminalChatConfig, readOperationsConfig, findOperation, operationsConfigSchema, type OperationsConfig } from '#adapters/core/contract/index.js';
export { openSqliteAttemptStore, openSqliteInventoryReader, upgradeExistingProductLedger, type LedgerUpgrade } from '#adapters/core/attempt-store/index.js';
export type { SqliteAttemptStore, SqliteInventoryReader, SqliteInventoryOptions } from '#adapters/core/attempt-store/index.js';
export type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
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
export { inspectInstallationFile, publishInstallationFile, InstallationFileError } from '#adapters/core/installation-files/index.js';
export { initializeInstallationLedger, verifyInstallationLedger, InstallationLedgerError } from '#adapters/core/attempt-store/index.js';
export { openSqliteModelActivationStore, openSqliteModelActivationReader } from '#adapters/core/sqlite-model-activation/index.js';
export * from '#adapters/core/sqlite-model-invocation/index.js';
export * from '#adapters/core/provider-openai-chat/index.js';
export * from '#adapters/core/provider-openrouter-chat/index.js';
export * from '#adapters/core/provider-openrouter-pricing/index.js';
export * from '#adapters/core/npm-registry/index.js';
export * from '#adapters/core/inference-metrics/index.js';
export * from '#adapters/core/runtime-launcher/index.js';
export * from '#adapters/core/worker-image/index.js';
export type { NativeJsonHttpAuthentication } from '#adapters/core/provider-http-json/index.js';

export { createBoundedMcpTransport } from '#adapters/core/mcp-transport/index.js';
export { compileNativeCodingDockerProfile, nativeCodingInvocationSchema, NativeCodingProfileError } from '#adapters/core/native-coding/index.js';
export type { NativeCodingInvocation } from '#adapters/core/native-coding/index.js';
export * from '#adapters/core/native-connection/index.js';

export * from '#adapters/core/git-patch/index.js';
export * from '#adapters/core/http-conditional-effect/index.js';

export * from '#adapters/core/worker-observation/index.js';
export * from '#adapters/core/local-keyring/index.js';
export * from '#adapters/core/approval-store/index.js';
export { LocalOsSessionAuthority } from '#adapters/core/local-principal/index.js';
