import type { InitialRegistryRequest, CodingTemplateResult, InstallationPoolResult, ProjectInstructionPort } from '#engine/index.js';
import type { InstallationIdentityChoice, InstallationIdentityResolution } from '#domain/index.js';
import type { ConfigLoadOptions, Locale, OutputSink } from '#platform/index.js';
import type { InstallationPreviewHandler, InstallationInspectionHandler, InstallationApplyHandler, InstallationResumeHandler,
  PolicyTemplatePreviewHandler, PolicyTemplateApplyHandler, PolicyTemplateUpgradeHandler } from './init.js';
import type { OwnerBaselineHandler } from './owner-baseline.js';
import type { PolicyModesHandler } from './policy-modes.js';

/** Installation commands receive only their local bootstrap ports. */
export interface InstallationCommandContext {
  initializeNativeCodingRegistry?: (root: string, input: InitialRegistryRequest, options: ConfigLoadOptions) => Promise<CodingTemplateResult>;
  /** U4C: the second-provider profile add (a person card; the host's coding template owner), reached by the onboarding preview and apply. */
  addCodingProfile?: (root: string, input: unknown, options: ConfigLoadOptions, dependencies?: { readonly witness?: { attest(): Promise<boolean> } }) => Promise<CodingTemplateResult>;
  openProjectInstructions?: (root: string, options: ConfigLoadOptions) => Promise<ProjectInstructionPort>;
  root?: string; env?: NodeJS.ProcessEnv; stdout?: OutputSink; stderr?: OutputSink;
  onLocale?: (locale: Locale) => void;
  /** The locale the host resolved once for this call (config language included). */
  locale?: Locale;
  previewUninstall?: (root: string, query: import('#engine/index.js').UninstallQuery, options: ConfigLoadOptions) => Promise<import('#engine/index.js').UninstallPlan>;
  applyUninstall?: (root: string, input: unknown, interaction: import('#engine/index.js').UninstallInteraction,
    options: ConfigLoadOptions, signal?: AbortSignal) => Promise<import('#engine/index.js').UninstallResult>;
  loadInstallationIdentity?: (root: string, options: ConfigLoadOptions) => Promise<import('#engine/index.js').InstallationIdentityRead>;
  resolveInstallationIdentity?: (root: string, choice: InstallationIdentityChoice, options: ConfigLoadOptions) => Promise<InstallationIdentityResolution>;
  previewInstallation?: InstallationPreviewHandler;
  inspectInstallation?: InstallationInspectionHandler;
  applyInstallation?: InstallationApplyHandler;
  resumeInstallation?: InstallationResumeHandler;
  previewPolicyTemplateInstallation?: PolicyTemplatePreviewHandler;
  applyPolicyTemplateInstallation?: PolicyTemplateApplyHandler;
  upgradePolicyTemplateInstallation?: PolicyTemplateUpgradeHandler;
  /** PRE-9: `init policy --modes` (the installer's permission-mode change). */
  openOwnerBaselineInstallation?: OwnerBaselineHandler;
  openPermissionModesInstallation?: PolicyModesHandler;
  installConfiguredExecutionPool?: (root: string, scopeId: string, apply: boolean) => Promise<InstallationPoolResult>;
}
