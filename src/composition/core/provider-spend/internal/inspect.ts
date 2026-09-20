import { userInfo } from 'node:os';
import { providerSpendAccountQueryInputSchema, type ProviderSpendAccountQuery } from '#domain/index.js';
import { ProviderSpendAccountInspectionApplication, ProviderSpendAccountPolicyAuthorization, ProviderSpendError } from '#engine/index.js';
import { openSqliteProviderSpendAccountReader, type LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext, loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

export async function inspectConfiguredProviderSpendAccount(projectRoot: string, input: ProviderSpendAccountQuery,
  options: ConfigLoadOptions = {}) {
  return inspect(input, scopeId => loadConfiguredScopeContext(projectRoot, scopeId, options));
}
/** The local runtime supplies kernel-verified peer evidence out of band, never from the query payload. */
export async function inspectPeerConfiguredProviderSpendAccount(projectRoot: string, input: ProviderSpendAccountQuery,
  peer: LocalPeerIdentity, options: ConfigLoadOptions = {}) {
  return inspect(input, scopeId => loadConfiguredPeerScopeContext(projectRoot, scopeId, options, peer));
}
async function inspect(input: ProviderSpendAccountQuery,
  loadContext: (scopeId: string) => ReturnType<typeof loadConfiguredScopeContext>) {
  try {
    let query: ProviderSpendAccountQuery;
    try { query = providerSpendAccountQueryInputSchema.parse(input); }
    catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
    const context = await loadContext(query.scopeId);
    return await new ProviderSpendAccountInspectionApplication({ async verify() { return context.principal; } },
      new ProviderSpendAccountPolicyAuthorization(createLayoutPolicySource(context.layout, userInfo().uid, context.config.inspection.policyMaxBytes)),
      async () => openSqliteProviderSpendAccountReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs })).inspect(query);
  } catch (error) { throw queryFailure(error); }
}
