import { userInfo } from 'node:os';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { HttpConditionalEffectTarget, LocalOsSessionAuthority, findOperation, openSqliteAttemptStore, readOperationsConfig, registerProviderConfig } from '#adapters/index.js';
import { EffectApplication, OperationPolicyAuthorization, refuseRequiredApproval, type EffectTarget } from '#engine/index.js';
import { effectCommandSchema, type EffectCommand } from '#domain/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

/** Local SDK/CLI producer for catalog operations. Catalog, targets, principal and session come from configuration and the local
 * OS session, never from the wire. Operation approval is not yet a workflow: any required approval stops before the effect (C12). */
async function withEffects<T>(root: string, scopeId: string, options: ConfigLoadOptions, use: (application: EffectApplication) => Promise<T>): Promise<T> {
  try {
    registerProviderConfig();
    const { config, layout, principal, path } = await loadConfiguredScopeContext(root, scopeId, options);
    const operations = readOperationsConfig(config as unknown as Record<string, unknown>);
    const targets = new Map<string, EffectTarget>(operations.targets.map(entry => [entry.options.kind, new HttpConditionalEffectTarget(entry.options)]));
    const clock = new SystemTrustedClock();
    const sessions = await LocalOsSessionAuthority.create(principal.scopeIds, config.approvals.sessionTtlMs, clock);
    const policy = new OperationPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    try {
      return await use(new EffectApplication({ async resolve(ref) { return findOperation(operations, ref.id, ref.version); } },
        { resolve: kind => targets.get(kind) ?? null }, store, refuseRequiredApproval, sessions, policy, clock));
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
function parsed(input: unknown): EffectCommand {
  try { return effectCommandSchema.parse(input); } catch (error) { throw queryFailure(error); }
}
export async function executeConfiguredOperation(root: string, input: EffectCommand, options: ConfigLoadOptions = {}) {
  const command = parsed(input);
  return withEffects(root, command.scopeId, options, application => application.execute(command));
}
export async function compensateConfiguredOperation(root: string, input: EffectCommand, options: ConfigLoadOptions = {}) {
  const command = parsed(input);
  return withEffects(root, command.scopeId, options, application => application.compensate(command));
}
export async function inspectConfiguredOperation(root: string, query: { readonly scopeId: string; readonly commandId: string }, options: ConfigLoadOptions = {}) {
  return withEffects(root, query.scopeId, options, async application => {
    const record = await application.inspect(query.scopeId, query.commandId);
    return Object.freeze({ schemaVersion: 1 as const, record });
  });
}
