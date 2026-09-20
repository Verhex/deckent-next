import { userInfo } from 'node:os';
import { providerSpendAuditCommandInputSchema, type ProviderSpendAuditCommand } from '#domain/index.js';
import { ProviderSpendAuditApplication, ProviderSpendAccountPolicyAuthorization, ProviderSpendError } from '#engine/index.js';
import { openSqliteProviderSpendAuditStore, openSqliteProviderSpendIntegrityReader, providerSpendAuditConfigSchema,
  type LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext, loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

export async function auditConfiguredProviderSpendAccount(projectRoot: string, input: ProviderSpendAuditCommand,
  maxResultBytes: number, options: ConfigLoadOptions = {}) {
  return audit(input, maxResultBytes, scopeId => loadConfiguredScopeContext(projectRoot, scopeId, options));
}
/** Explicit runtime command, authenticated by the kernel peer; no provider call or financial correction. */
export async function auditPeerConfiguredProviderSpendAccount(projectRoot: string, input: ProviderSpendAuditCommand,
  peer: LocalPeerIdentity, maxResultBytes: number, options: ConfigLoadOptions = {}) {
  return audit(input, maxResultBytes, scopeId => loadConfiguredPeerScopeContext(projectRoot, scopeId, options, peer));
}
async function audit(input: ProviderSpendAuditCommand, maxResultBytes: number,
  loadContext: (scopeId: string) => ReturnType<typeof loadConfiguredScopeContext>) {
  try {
    const parsed = providerSpendAuditCommandInputSchema.safeParse(input);
    if (!parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    const command = parsed.data, context = await loadContext(command.scopeId);
    const configured = providerSpendAuditConfigSchema.safeParse(context.config['provider_spend_audit']);
    if (!configured.success) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
    const { pageSize, maxReservations, timeoutMs } = configured.data;
    return await new ProviderSpendAuditApplication({ async verify() { return context.principal; } },
      new ProviderSpendAccountPolicyAuthorization(createLayoutPolicySource(context.layout, userInfo().uid, context.config.inspection.policyMaxBytes)),
      async () => openSqliteProviderSpendAuditStore(await context.path(), context.config.storage.sqlite, 'forbid'),
      async () => openSqliteProviderSpendIntegrityReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs }),
      { pageSize, maxReservations, timeoutMs, maxResultBytes }).audit(command);
  } catch (error) { throw queryFailure(error); }
}
