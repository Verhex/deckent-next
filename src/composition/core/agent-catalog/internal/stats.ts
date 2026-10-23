import { userInfo } from 'node:os';
import { AgentCatalogPolicyAuthorization, CatalogEvolutionApplication, agentStatsQuerySchema, catalogModelFacts, composeModelRolePolicy, memoryCatalogFacts, memoryCatalogKey, type AgentStatsView } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAgentCatalogStore, openSqliteCatalogEvolutionStore, openSqliteModelCatalogReader } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
const application = (c: Context, path: string) => new CatalogEvolutionApplication({ verifier: { verify: async () => c.principal },
  authorize: (...args) => new AgentCatalogPolicyAuthorization(createLayoutPolicySource(c.layout, userInfo().uid, c.config.inspection.policyMaxBytes)).authorize(...args),
  openCatalog: async () => openSqliteAgentCatalogStore(path, c.config.storage.sqlite, await openLocalIntegrityAuthority(c.layout, c.config.approvals.keyFile, false), 'read'),
  openStore: async access => openSqliteCatalogEvolutionStore(path, c.config.storage.sqlite, access), overlay: c.config.catalogEvolution.overlay,
  modelFacts: async () => {
    const reader = await openSqliteModelCatalogReader(path, { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
    try { return catalogModelFacts(await memoryCatalogFacts(reader), memoryCatalogKey, composeModelRolePolicy(c.config['model_roles']).models); } finally { reader.close(); }
  }, mode: c.config.catalogEvolution.mode, now: Date.now });

/** S8-2 `deckent agents stats` / MCP `inspect_agent_stats`: the catalog's `inspect` read; never creates a key, database or migration. */
export async function inspectConfiguredAgentStats(root: string, input: unknown, options: ConfigLoadOptions = {}): Promise<AgentStatsView> {
  try {
    const query = agentStatsQuerySchema.parse(input), c = await loadConfiguredScopeContext(root, query.scopeId, { ...options, heal: false }, 'read');
    return await application(c, await c.path()).inspectStats(query);
  } catch (error) { throw queryFailure(error); }
}
/**
 * S8-2 aggregator pass off the hot path (F8 memory-distiller pattern): one bounded page per scope per reconciliation pass, after Nervous, recovery
 * and memory. `catalogEvolution.mode` off (default: nothing loads) | shadow | on; no model call, no standing change. Its failure is reported by the
 * loop, never a reconciliation failure; Runs, selection and standing never read its record.
 */
export function prepareConfiguredCatalogAggregation(projectRoot: string, options: ConfigLoadOptions, mode: string) {
  if (mode !== 'shadow' && mode !== 'on') return null;
  return Object.freeze({ async run(scopeId: string) {
    try { const c = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write'); return await application(c, await c.path()).runPass(scopeId, mode); }
    catch (error) { throw queryFailure(error); }
  } });
}
