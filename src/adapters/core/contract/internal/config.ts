import { registerIdentityProfileConfig } from './identity-profile.js';
import { registerBrainPlannerConfig } from './brain.js';
import { registerDecisionConfig } from './decision.js';
import { registerProviderCatalogConfig } from './catalog.js';
import { registerInvocationProfileConfig } from './invocation.js';
import { registerProviderSpendingConfig } from './spending.js';
import { registerProviderSpendAuditConfig } from './spend-audit.js';
import { registerInferenceServingConfig } from './inference-serving.js';
import { registerTerminalConfig } from './terminal.js';
export { effectiveTerminalOutputCap } from './terminal-output.js';
import { registerOperationsConfig } from './operations.js';
import { registerSecretStoreConfig } from './secrets.js';
let registered = false;
/** Called by application ingress before config resolution; kernel never imports provider policy. */
export function registerProviderConfig(): void {
  if (registered) return;
  registerProviderCatalogConfig();
  registerInvocationProfileConfig();
  registerProviderSpendingConfig();
  registerProviderSpendAuditConfig();
  registerInferenceServingConfig();
  registerTerminalConfig();
  registerBrainPlannerConfig();
  registerOperationsConfig();
  registerSecretStoreConfig();
  registerDecisionConfig();
  registerIdentityProfileConfig();
  registered = true;
}
export { providerSpendingBudgetFor, providerSpendingConfiguredBudget, providerSpendingTemplate, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ providerSpendingSchema, registerProviderSpendingConfig, validateProviderSpendingLayers } from './spending.js';
export { providerSpendAuditConfigSchema, validateProviderSpendAuditLayers } from './spend-audit.js';
export { openConfiguredSecretStore, readSecretsConfig, secretsConfigSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type SecretsConfig, createInstallationSecretStoreSelection, createInstallationSecretCustody, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ SECRET_CUSTODY_WAIT_MS,
  isRegisteredSecretStore, openRegisteredSecretStore, registeredSecretStores, installationSecretRoot, openProjectVaultStore, openSecretGrantStore } from './secrets.js';
export { readOperationsConfig, operationsConfigSchema, resolveOperationCatalog, resolveOperationTargets, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type OperationsConfig } from './operations.js';
export { readTerminalChatConfig, resolveTerminalModel, type TerminalModelChoice, type TerminalModelSource, readTerminalConfig, readTerminalFetchConfig, readTerminalResponseStyle, readTerminalScratchConfig, readTerminalShellConfig, terminalConfigSchema, TERMINAL_BANNERS, TERMINAL_RESPONSE_STYLES, TERMINAL_THEMES,
  /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type TerminalChatConfig, type TerminalFetchConfig, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type TerminalResponseStyle, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type TerminalScratchConfig, type TerminalShellConfig } from './terminal.js';
export { readDecisionPolicy, registerDecisionConfig, validateDecisionPolicyLayers } from './decision.js';
export { readIdentityProfileConfig, registerIdentityProfileConfig } from './identity-profile.js';
