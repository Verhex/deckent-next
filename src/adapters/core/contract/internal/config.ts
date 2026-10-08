import { registerIdentityProfileConfig } from './identity-profile.js';
import { registerDecisionConfig } from './decision.js';
import { registerProviderCatalogConfig } from './catalog.js';
import { registerInvocationProfileConfig } from './invocation.js';
import { registerProviderSpendingConfig } from './spending.js';
import { registerProviderSpendAuditConfig } from './spend-audit.js';
import { registerInferenceServingConfig } from './inference-serving.js';
import { registerTerminalConfig } from './terminal.js';
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
  registerOperationsConfig();
  registerSecretStoreConfig();
  registerDecisionConfig();
  registerIdentityProfileConfig();
  registered = true;
}
export { providerSpendingBudgetFor, providerSpendingConfiguredBudget, providerSpendingSchema, registerProviderSpendingConfig, validateProviderSpendingLayers } from './spending.js';
export { providerSpendAuditConfigSchema, validateProviderSpendAuditLayers } from './spend-audit.js';
export { openConfiguredSecretStore, readSecretsConfig, registerSecretStoreBackend, secretsConfigSchema, type SecretsConfig, createInstallationSecretStoreSelection, createInstallationSecretCustody, SECRET_CUSTODY_WAIT_MS,
  isRegisteredSecretStore, openRegisteredSecretStore, registeredSecretStores } from './secrets.js';
export { readOperationsConfig, operationsConfigSchema, registerOperationAdapterModule, resolveOperationCatalog, resolveOperationTargets, type OperationsConfig } from './operations.js';
export { readTerminalChatConfig, resolveTerminalModel, type TerminalModelChoice, type TerminalModelSource, readTerminalConfig, readTerminalFetchConfig, readTerminalScratchConfig, readTerminalShellConfig, terminalConfigSchema, TERMINAL_BANNERS, TERMINAL_THEMES,
  type TerminalChatConfig, type TerminalFetchConfig, type TerminalScratchConfig, type TerminalShellConfig } from './terminal.js';
export { readDecisionPolicy, registerDecisionConfig, validateDecisionPolicyLayers } from './decision.js';
export { readIdentityProfileConfig, registerIdentityProfileConfig } from './identity-profile.js';
