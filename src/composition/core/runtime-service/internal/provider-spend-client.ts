import type { ProviderSpendAccountQuery, ProviderSpendAuditCommand } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { createConfiguredRuntimeClient } from './client.js';

/** Reads the service-owned account snapshot through authenticated runtime transport.
 * Settled totals may combine local calculations and provider reports; source subtotals and held reasons are absent.
 * Reserved amounts include held reservations and are not confirmed spend. This view does not verify a provider invoice. */
export function inspectRuntimeProviderSpendAccount(projectRoot: string, query: ProviderSpendAccountQuery,
  options: ConfigLoadOptions = {}) {
  return createConfiguredRuntimeClient(projectRoot, options).inspectProviderSpendAccount(query);
}

/** Records one bounded account-history audit through the authenticated runtime owner. */
export function auditRuntimeProviderSpendAccount(projectRoot: string, command: ProviderSpendAuditCommand,
  options: ConfigLoadOptions = {}) {
  return createConfiguredRuntimeClient(projectRoot, options).auditProviderSpendAccount(command);
}
