// Platform part of the SDK: an explicit list (DEPS-TYPES, owner 2026-09-29, DEPS-SCHEMA C2-b). Live zod schema objects (CORE_SCHEMA, the storage and
// execution settings, bootstrapJournalSchema) stay Core-internal; the data types derived from them are exported. Inventory: tests/contracts/composition/sdk-public-exports.json.
export { PACKAGE_NAME, PACKAGE_VERSION, resolveLocale, t, DECKENT_DIR, CONFIG_FILE, PROJECT_CONFIG_PATH, CONFIG_SCHEMA_VERSION,
  CONFIG_CONTRACT_SINCE, OUTPUT_MODES, DECKENT_VERSION, NODE_ENGINE_RANGE, SUPPORTED_LANGUAGES, DeckentError, ErrorRegistry, ERROR_CODES,
  createCrossVerifyContractError, createExecutionAuthorityError, createExecutionAdmissionError, createDockerLifecycleError, EXIT_CODES, exitCodeFor,
  lintErrorRegistry, assertErrorRegistry, redactSensitive, formatHumanError, buildCrashArtifact, writeCrashArtifact, reportFatal, ENVIRONMENT_KEYS,
  envValue, isMainModule, normalizeGlobalScopePlatform, resolveGlobalScopePaths, resolveGlobalConfigPaths, resolveGlobalConfigReadPath,
  resolveProductPaths, detectHostMemory, suggestMaxWorkers, calcRecommendedMaxWorkers, suggestMaxWorkersFromCapacity, getSystemProfile,
  detectEnvironment, readBuildIdentity, validatePath, validateExistingPath, validateTaskId, isStandardSchemaV1, validateStandardSchemaSync,
  deepMerge, readJsonFile, writeJsonAtomic, formatDuration, estimateRemaining, registerConfigSection, createDefaultConfig, ConfigValidationError,
  validateConfig, versionedConfig, resolveConfigSecrets, configDisplayView, loadConfig, loadGlobalConfig, clearConfigCache, saveGlobalConfig,
  writeConfig, withConfigWriteLock, pruneConfigBackups, healCorruptProjectConfig, getConfigMetadata, getConfigValue, resolveLocalOsActorId,
  resolveLocalOsPrincipal, principalToActor, assessActorAssurance, assertActorAssurance, colorTier, shouldUseColor, stripAnsi, formatValue,
  formatTable, formatStatus, readMemoryKnowledge, emit, createEmitter, LOCALES, MESSAGE_KEYS, MESSAGE_REGISTRY, createMessageRegistry,
  getConfigFieldDefault, resolveProductLayout, productResourcePath, LayoutError, inspectProductLayout, inspectProductPaths, prepareProductFile,
  prepareProductCompanionPath, prepareProductSocket, inspectProductFile, prepareProductDirectory, inspectProductDirectory, ManagedFileError,
  SystemTrustedClock, MAX_WALL_SKEW_MS, sha256, constantTimeDigestEqual, createHmacIntegrity, GLOB_WILDCARD, globLiteralHead, hasGlobWildcard,
  BOOTSTRAP_JOURNAL_MAX_BYTES, BootstrapStateError, assertBootstrapUnchanged, assertBootstrapUsable, encodeBootstrapJournal, hashBootstrapJournal,
  observeBootstrapState } from '#platform/index.js';
export type { Locale, MessageKey, OutputMode, Params, ErrorCategory, ExitCode, CrashArtifactV1, Environment, GlobalScopePlatform, GlobalScopePaths,
  BuildIdentity, StandardTypedV1, StandardSchemaV1, StandardJSONSchemaV1, StandardSyncValidation, DeckentConfig, CoreConfig, ConfigSectionOptions,
  ConfigWarning, ResolvedConfig, ConfigLoadOptions, PrincipalEvidence, ActorContext, OutputSink, EmitOptions, MessageFamily, MessageRegistry,
  ProductLayout, ProductLayoutInput, ProductResource, SecretResolver, SecretResolution, ProductPathInspection, TrustedClock, ClockSample,
  IntegrityAuthority, BootstrapJournal, BootstrapJournalPayload, BootstrapObservation, BootstrapStateErrorCode } from '#platform/index.js';
export { prepareNativeCodingProfile } from '#composition/index.js';

export { inspectConfiguredInventory as inspectInventory } from '#composition/index.js';
export type { DispatchInventoryInput, DispatchInventoryPage, DispatchInventoryEntry } from '#engine/index.js';
export { inspectConfiguredRun as inspectRun } from '#composition/index.js';
export { applyConfiguredRunLifecycle as applyRunLifecycle } from '#composition/index.js';
export type { RunQuery, RunLifecycleCommand } from '#engine/index.js';
export type { RunView } from '#engine/index.js';
export { getPolicyVocabulary } from '#engine/index.js';
export { createConfiguredRun as createRun, createConfiguredDeliveryRun as createDeliveryRun } from '#composition/index.js';
export type { RunAdmission, RunDeliveryAdmission } from '#engine/index.js';
export { requestConfiguredRunCancellation as requestRunCancellation } from '#composition/index.js';
export type { RunCommand } from '#engine/index.js';
export { deliverConfiguredRunCancellation as deliverRunCancellation } from '#composition/index.js';
export { reconcileConfiguredAttempt as reconcileAttempt } from '#composition/index.js';
export type { AttemptIdentity } from '#domain/index.js';
export { executeConfiguredTask as executeTask, evaluateConfiguredTask as evaluateTask } from '#composition/index.js';
export type { TaskEvaluationCommand } from '#engine/index.js';
export { reserveConfiguredRunTasks as reserveRunTasks } from '#composition/index.js';
export type { RunReservationCommand } from '#engine/index.js';
export { recoverConfiguredCancellations as recoverCancellations } from '#composition/index.js';
export type { CancellationRecoveryCommand } from '#engine/index.js';
export { runConfiguredCancellationRuntime } from '#composition/index.js';
export type { ConfiguredCancellationRuntimeInput, ConfiguredCancellationRuntimeObserver } from '#composition/index.js';

export { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '#composition/index.js';

export type { ShutdownCommand, RuntimeServiceDescriptor, ServiceShutdownAdmissionResult } from '#engine/index.js';

export { previewSuppliedInstallation as previewInstallation } from '#composition/index.js';
export { inspectSuppliedInstallation as inspectInstallation } from '#composition/index.js';
export { applySuppliedInstallation as applyInstallation, resumeInstallation } from '#composition/index.js';
export type { InstallationApplyChoices } from '#composition/index.js';
export { hashInstallationProfilePayload, encodeInstallationProfilePayload } from '#engine/index.js';
export type { InstallationProfile, InstallationPreview, InstallationEvidencePreview } from '#engine/index.js';
export { inspectDeclaredModels } from '#composition/index.js';
export type { DeclaredModelsInspection } from '#engine/index.js';
export { inspectModelBinding } from '#composition/index.js';
export type { ModelBindingInspection } from '#engine/index.js';
export type { ModelReference, ModelBindingDefinition } from '#domain/index.js';
export { admitConfiguredModelActivation as admitModelActivation, inspectConfiguredModelActivation as inspectModelActivation,
  applyConfiguredModelCatalog as applyModelCatalog, inspectConfiguredModelCatalog as inspectModelCatalog } from '#composition/index.js';
export type { ModelCatalogCommand, ModelCatalogQuery, ModelCatalogReceipt, WorkerModelView, TaskEvaluationModel } from '#domain/index.js';
export type { ModelCatalogInspection, ModelCatalogChannelView, ModelCatalogResult, TaskWorkerModel } from '#engine/index.js';
export type { ModelActivationCommand, ModelActivationQuery, ModelActivationRecord, ModelActivationReceipt } from '#domain/index.js';
// K5 typed execution pool hold: the same application as CLI `pool hold|resume|status` and MCP `apply_pool_hold` / `inspect_pool_hold`.
export { applyConfiguredPoolHold as applyPoolHold, inspectConfiguredPoolHold as inspectPoolHold } from '#composition/index.js';
export type { PoolHoldCommand, PoolHoldQuery, PoolHoldReceipt, PoolHoldRecord, PoolHoldView, PoolOccupancy } from '#engine/index.js';
export type { ModelActivationResult, ModelActivationInspection } from '#engine/index.js';
export { invokeRuntimeModel as invokeModel, inspectRuntimeModelInvocation as inspectModelInvocation, purgeRuntimeModelInvocationContent as purgeModelInvocationContent,
  cancelRuntimeModelInvocation as cancelModelInvocation } from '#composition/index.js';
export type { ModelInvocationCommand, ModelInvocationQuery, ModelInvocationReceipt,
  ModelInvocationCancellationCommand, ModelInvocationCancellationReceipt, ModelInvocationContentDescriptor, ModelInvocationResponseContent, ModelInvocationPurgeCommand, ModelInvocationPurgeReceipt } from '#domain/index.js';
export type { ModelInvocationCancellationResult, ModelInvocationResult, ModelInvocationInspection, ModelInvocationPurgeResult, ProviderSpendReservation } from '#engine/index.js';
export { inspectRuntimeProviderSpendAccount as inspectProviderSpendAccount } from '#composition/index.js';
export { auditRuntimeProviderSpendAccount as auditProviderSpendAccount } from '#composition/index.js';
export type { ProviderSpendAccountQuery, ProviderSpendAuditCommand } from '#domain/index.js';
export type { ProviderSpendAccountInspection, ProviderSpendAuditResult } from '#engine/index.js';

export { inspectConfiguredWorkspaceIntegration, checkConfiguredWorkspaceIntegration, prepareConfiguredWorkspaceIntegration, prepareConfiguredWorkspacePatch, previewConfiguredWorkspacePatch } from '#composition/index.js';
export type { WorkspacePatch, IntegrationQuery, IntegrationCommand, IntegrationManifest } from '#engine/index.js';

export { inspectConfiguredWorkers } from '#composition/index.js';
export { inspectConfiguredToolchainCurrency as inspectToolchainCurrency, updateConfiguredToolchains as updateToolchains } from '#composition/index.js';
export type { ToolchainUpdateResult } from '#composition/index.js';
export type { ToolchainUpdatePlan, ProfileRevisionProposal } from '#engine/index.js';
export type { ToolchainCurrencyReport, ToolchainCurrencyEntry, ToolchainStatus } from '#engine/index.js';
export type { WorkerObservationQuery, WorkerObservationReport } from '#engine/index.js';

export { configuredApproval } from '#composition/index.js';
export { deliverConfiguredWorkspaceIntegration, adoptConfiguredWorkspaceIntegration, rollbackConfiguredWorkspaceIntegration } from '#composition/index.js';
export { executeConfiguredOperation, compensateConfiguredOperation, inspectConfiguredOperation } from '#composition/index.js';
export { inspectConfiguredWorkerTranscript } from '#composition/index.js';
