export { InstallationIdentityError } from '#engine/core/bootstrap-identity/index.js';
export { configureNativeTemplate, initializeNativeRegistry, addNativeProfile } from './internal/native-template.js';
export type { NativeTemplatePorts, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ CodingTemplateRequest, CodingTemplateResult, InitialRegistryRequest } from './internal/native-template.js';
export { configuredInstallationPool, installExecutionPool } from './internal/pool.js';
export type { InstallationPoolResult, InstallationPoolStore } from './internal/pool.js';
export { assessInstallationBinding } from '#engine/core/bootstrap-identity/index.js';
export type { InstallationIdentityStore, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ InstallationIdentityErrorCode, InstallationBindingSource, InstallationBindingCapability, InstallationIdentityRead,
  /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ InstallationBindingObservation, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ InstallationBindingAssessment } from '#engine/core/bootstrap-identity/index.js';
export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ installationProfilePayloadSchema, installationProfileSchema, encodeInstallationProfilePayload,
  hashInstallationProfilePayload, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ snapshotInstallationProfile } from './internal/profile.js';
export { ProjectIdentityError } from '#engine/core/bootstrap-identity/index.js';
export type { ProjectIdentityStore, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ProjectIdentityErrorCode, IdentityRead } from '#engine/core/bootstrap-identity/index.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ InstallationProfilePayload, InstallationProfile } from './internal/profile.js';
export { InstallationPreviewApplication, InstallationProfileError } from './internal/application.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ InstallationProfileErrorCode, InstallationPreviewPorts, InstallationPreviewChoices,
  InstallationPreview, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ InstallationMaterial, PreparedInstallation } from './internal/application.js';
export { createInstallationEvidencePreview, InstallationEvidenceApplication, InstallationEvidenceError } from './internal/evidence.js';
export type { InstallationEvidencePreview, InstallationPackageEvidence, InstallationImageEvidence, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ InstallationEvidencePorts } from './internal/evidence.js';
export { createInstallationRecovery, validateInstallationRecovery, InstallationRecoveryError } from './internal/recovery.js';
export type { InstallationRecovery, InstallationConsent } from './internal/recovery.js';
export { InstallationPublicationApplication, InstallationPublicationError, installationPublishTargets } from './internal/publish.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ InstallationPublicationPorts, InstallationPublishTarget, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ InstallationResource } from './internal/publish.js';
export { installerAuthorityChangeEvent } from './internal/authority-audit.js'; export { FIRST_RUN_TOOL_NAMES, FIRST_RUN_EDIT_SHELL_TOOL_NAMES, FIRST_RUN_READ_TOOL_NAMES, FIRST_RUN_SCRATCH_TOOL_NAMES, FIRST_RUN_SCRATCH_WRITE_OPERATION_ID,
  FIRST_RUN_SHELL_OPERATION_ID, FIRST_RUN_FIRST_COMMIT_OPERATION_ID, FIRST_RUN_WRITE_OPERATION_ID, FIRST_RUN_PROPOSE_MCP_TOOL_NAME, FIRST_RUN_MCP_CALL_OPERATION_ID, FIRST_RUN_POLICY_ADMINISTER_OPERATION_ID, FIRST_RUN_EXECUTION_ENVIRONMENT_IDS, FIRST_RUN_RECOVERY_RULES,
  inspectFirstRunPolicyTemplate, inspectAnchoredFirstRunPolicy, firstRunServiceIdentity, suppliedPolicyWithinTemplate, settleFirstRunServiceIdentity, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ SKIPPED_SERVICE_IDENTITY, upgradeInstalledPolicyTemplate,
  PolicyTemplateInstallationApplication, preparePolicyTemplateInstallation, upgradePolicyTemplate } from './internal/policy-template.js';
export { setInstallerPermissionModes, type InstallerPermissionModesResult } from './internal/policy-modes.js';
export type { FirstRunServiceIdentityPort, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ FirstRunServiceIdentityResult, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ InstalledPolicyTemplateUpgrade, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ FirstRunToolNames, PolicyTemplateDocumentWriter, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PolicyTemplateUpgradeResult, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PolicyTemplateInstallationPorts, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PolicyTemplatePreview, PolicyTemplatePublishTarget, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PolicyTemplateResource, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PolicyTemplateSource,
  PreparedPolicyTemplateInstallation, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PreparePolicyTemplateInput } from './internal/policy-template.js';

export { setInstallerOwnerBaseline, ownerBaselineCells, describeOwnerBaseline, ownerBaselineFamilyKnown, type InstallerOwnerBaselineResult } from './internal/owner-baseline.js';

export { createUninstallPlan, assertUninstallPlanCurrent, uninstallBlockerError, uninstallPlanDrift, uninstallLauncherResource, uninstallRegistry, uninstallOperationDescriptors } from './internal/uninstall-plan.js';
export type { UninstallInventory, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ UninstallContribution } from './internal/uninstall-plan.js';
export { uninstallPlanQuerySchema, uninstallApplySchema, UninstallError, UNINSTALL_TIERS } from './internal/uninstall-contract.js';
export type { UninstallPlan, UninstallResult, UninstallResource, UninstallInstallation, UninstallItem, UninstallTier, UninstallQuery, UninstallWork, UninstallService, UninstallBlocker } from './internal/uninstall-contract.js';
export { UninstallApplication, authorizeUninstall, approvedUninstallEffects, authorizeUninstallSteps, uninstallAffectedScopes, uninstallManagedScopes } from './internal/uninstall-application.js';
export type { UninstallApplicationPorts, UninstallAdmission, UninstallInteraction } from './internal/uninstall-application.js';
export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ installSystemPolicyRows, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ upgradeSystemPolicyRows } from './internal/policy-template.js';
