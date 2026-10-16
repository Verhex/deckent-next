import type { ProviderSpendManagementCommand, ProviderSpendAccountQuery, ProviderSpendAuditCommand } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { createRuntimeServiceClient } from './client.js';
export function createRuntimeSpendCalls(createConfiguredRuntimeClient: (root: string, options: ConfigLoadOptions) => ReturnType<typeof createRuntimeServiceClient>) {
/** Reads the service-owned account snapshot through authenticated runtime transport.
 * Settled totals may combine local calculations and provider reports; source subtotals and held reasons are absent.
 * Reserved amounts include held reservations and are not confirmed spend. This view does not verify a provider invoice. */
function inspectRuntimeProviderSpendAccount(projectRoot: string, query: ProviderSpendAccountQuery, options: ConfigLoadOptions = {}) {
  return createConfiguredRuntimeClient(projectRoot, options).inspectProviderSpendAccount(query);
}
/** Records one bounded account-history audit through the authenticated runtime owner. */
function auditRuntimeProviderSpendAccount(projectRoot: string, command: ProviderSpendAuditCommand, options: ConfigLoadOptions = {}) {
  return createConfiguredRuntimeClient(projectRoot, options).auditProviderSpendAccount(command);
}
/** Governed spend management (held reconcile, budget create and revision) through the authenticated runtime owner. */
function manageRuntimeProviderSpend(projectRoot: string, command: ProviderSpendManagementCommand, options: ConfigLoadOptions = {}) {
  return createConfiguredRuntimeClient(projectRoot, options).manageProviderSpend(command);
}
  return { inspectRuntimeProviderSpendAccount, auditRuntimeProviderSpendAccount, manageRuntimeProviderSpend };
}
