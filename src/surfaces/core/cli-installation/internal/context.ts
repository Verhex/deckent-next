import type { InitialRegistryRequest, CodingTemplateResult, InstallationPoolResult, ProjectInstructionPort } from '#engine/index.js';
import type { InstallationIdentityChoice, InstallationIdentityResolution } from '#domain/index.js';
import type { ConfigLoadOptions, Locale, OutputSink } from '#platform/index.js';
import type { InstallationPreviewHandler, InstallationInspectionHandler, InstallationApplyHandler, InstallationResumeHandler,
  PolicyTemplatePreviewHandler, PolicyTemplateApplyHandler, PolicyTemplateUpgradeHandler } from './init.js';

/** Installation commands receive only their local bootstrap ports. */
export interface InstallationCommandContext {
  initializeNativeCodingRegistry?: (root: string, input: InitialRegistryRequest, options: ConfigLoadOptions) => Promise<CodingTemplateResult>;
  openProjectInstructions?: (root: string, options: ConfigLoadOptions) => Promise<ProjectInstructionPort>;
  root?: string; env?: NodeJS.ProcessEnv; stdout?: OutputSink; stderr?: OutputSink;
  onLocale?: (locale: Locale) => void;
  resolveInstallationIdentity?: (root: string, choice: InstallationIdentityChoice, options: ConfigLoadOptions) => Promise<InstallationIdentityResolution>;
  previewInstallation?: InstallationPreviewHandler;
  inspectInstallation?: InstallationInspectionHandler;
  applyInstallation?: InstallationApplyHandler;
  resumeInstallation?: InstallationResumeHandler;
  previewPolicyTemplateInstallation?: PolicyTemplatePreviewHandler;
  applyPolicyTemplateInstallation?: PolicyTemplateApplyHandler;
  upgradePolicyTemplateInstallation?: PolicyTemplateUpgradeHandler;
  installConfiguredExecutionPool?: (root: string, scopeId: string, apply: boolean) => Promise<InstallationPoolResult>;
}
