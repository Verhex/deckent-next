import { registerProviderCatalogConfig } from './catalog.js';
import { registerInvocationProfileConfig } from './invocation.js';
import { registerProviderSpendingConfig } from './spending.js';
import { registerProviderSpendAuditConfig } from './spend-audit.js';
import { registerInferenceServingConfig } from './inference-serving.js';
import { registerTerminalConfig } from './terminal.js';
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
  registered = true;
}
export { providerSpendingSchema, registerProviderSpendingConfig, validateProviderSpendingLayers } from './spending.js';
export { providerSpendAuditConfigSchema, validateProviderSpendAuditLayers } from './spend-audit.js';
export { readTerminalChatConfig, terminalConfigSchema, type TerminalChatConfig } from './terminal.js';
