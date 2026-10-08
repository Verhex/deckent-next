import { userInfo } from 'node:os';
import { providerSpendManagementCommandInputSchema, type ProviderSpendManagementCommand } from '#domain/index.js';
import { ProviderSpendError, ProviderSpendManagementApplication, ProviderSpendAccountPolicyAuthorization } from '#engine/index.js';
import { openSqliteProviderSpendManagementStore, providerSpendingConfiguredBudget, type LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext, loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
export async function manageConfiguredProviderSpend(projectRoot: string, input: ProviderSpendManagementCommand, options: ConfigLoadOptions = {}, maxResultBytes = Number.MAX_SAFE_INTEGER) {
  return manage(input, scopeId => loadConfiguredScopeContext(projectRoot, scopeId, options, 'write'), maxResultBytes);
}
export async function managePeerConfiguredProviderSpend(projectRoot: string, input: ProviderSpendManagementCommand, peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, maxResultBytes = Number.MAX_SAFE_INTEGER) {
  return manage(input, scopeId => loadConfiguredPeerScopeContext(projectRoot, scopeId, options, peer, 'write'), maxResultBytes);
}
async function manage(input: ProviderSpendManagementCommand, loadContext: (scopeId: string) => ReturnType<typeof loadConfiguredScopeContext>, maxResultBytes: number) {
  try {
    const command = providerSpendManagementCommandInputSchema.parse(input), context = await loadContext(command.scopeId);
    // Stage 1: a configured budget opens its own account at the first call, so a governed create beside it would conflict: change that one instead.
    if (command.kind === 'budget-create' && providerSpendingConfiguredBudget(context.config as never, command.scopeId)) throw new ProviderSpendError('PROVIDER_SPEND_BUDGET_EXISTS');
    return await new ProviderSpendManagementApplication({ async verify() { return context.principal; } },
      new ProviderSpendAccountPolicyAuthorization(createLayoutPolicySource(context.layout, userInfo().uid, context.config.inspection.policyMaxBytes)),
      async () => openSqliteProviderSpendManagementStore(await context.path(), context.config.storage.sqlite)).execute(command, undefined, maxResultBytes);
  } catch (error) { throw queryFailure(error); }
}
