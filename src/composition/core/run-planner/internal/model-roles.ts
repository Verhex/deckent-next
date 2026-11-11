import type { ModelInvocationCommand } from '#domain/index.js';
import { assertBrainModelRole, inspectRoleModelsInScope, BRAIN_MODEL_ROLE, type RoleModelSources } from '#engine/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { openSqliteModelActivationReader } from '#adapters/index.js';
import type { ModelInspectionSnapshot } from '#composition/core/model-inspection/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
type ScopeContext = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
/** S2 wiring: the scope's composed config (`model_roles`, `provider_catalog`) and one activation-store reader for the call. */
async function withSources<T>(context: ScopeContext, run: (sources: RoleModelSources) => Promise<T>, snapshot?: ModelInspectionSnapshot): Promise<T> {
  const reader = await openSqliteModelActivationReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs });
  try { return await run({ ...(snapshot ? { parsedCatalog: snapshot.declared.catalog } : {}), modelRoles: context.config['model_roles'], providerCatalog: context.config['provider_catalog'], activation: (scopeId, reference) => reader.loadRecord(scopeId, reference) }); }
  finally { reader.close(); }
}
/** The Brain gate where the planner takes its model, before any budget read, count or model POST. */
export const gateConfiguredBrainModel = (context: ScopeContext, command: ModelInvocationCommand) => withSources(context, sources => assertBrainModelRole(sources, command, Date.now(), context.config['brain_planner']));
/** Read port for role consumers (S6R-5 recovery decision, S4B memory evaluator): the models a registered role may use in a scope today, each
 * with its basis and whether the scope has it active. An unregistered role is refused, typed. No CLI, MCP or SDK surface reads it yet. */
export async function inspectConfiguredRoleModels(root: string, scopeId: string, role: string, options: ConfigLoadOptions = {}, snapshot?: ModelInspectionSnapshot) {
  try {
    const context = await (snapshot?.context() ?? loadConfiguredScopeContext(root, scopeId, options, 'read'));
    return await withSources(context, sources => inspectRoleModelsInScope(sources, role, scopeId, Date.now()), snapshot);
  } catch (error) { throw queryFailure(error); }
}
/** R9b (owner D3): the Brain role's models for `/model` (the "recommended" mark only; every model may be chosen and the planner's gate decides at /do). */
export const inspectConfiguredBrainModels = (root: string, scopeId: string, options: ConfigLoadOptions = {}, snapshot?: ModelInspectionSnapshot) => inspectConfiguredRoleModels(root, scopeId, BRAIN_MODEL_ROLE, options, snapshot);
