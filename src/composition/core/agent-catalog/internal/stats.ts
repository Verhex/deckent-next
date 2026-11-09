import { AgentCatalogPolicyAuthorization, AgentStandingApplication, PolicyAuthorizationError, catalogAggregatorFor, CatalogEvolutionApplication, agentStatsQuerySchema, catalogModelFacts, composeModelRolePolicy, memoryCatalogFacts, memoryCatalogKey,
  type AgentStatsView, type CatalogEvolutionDependencies } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAgentCatalogStore, openSqliteCatalogEvolutionStore, openSqliteModelCatalogReader } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { memoryJournalFor } from '#composition/core/memory/index.js';
import { catalogDependencies } from './application.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
const application = (c: Context, path: string, aggregator: Pick<CatalogEvolutionDependencies, 'writer' | 'lessons'> = {}) => new CatalogEvolutionApplication({ ...aggregator, verifier: { verify: async () => c.principal },
  authorize: (...args) => new AgentCatalogPolicyAuthorization(contextPolicySource(c)).authorize(...args),
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
/** Off: no loads; shadow/on: one bounded page off the hot path, no model call. The loop reports failures; Runs never read this record. */
export function prepareConfiguredCatalogAggregation(projectRoot: string, options: ConfigLoadOptions, mode: string) {
  if (mode !== 'shadow' && mode !== 'on') return null;
  return Object.freeze({ async run(scopeId: string) {
    try { const c = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write'); return await application(c, await c.path(), aggregatorOf(c, scopeId)).runPass(scopeId, mode); }
    catch (error) { throw queryFailure(error); }
  } });
}
/** The aggregator uses its own workload principal, enrolled key and memory read filter; no key means no write, refused/held lessons count none. */
function aggregatorOf(c: Context, scopeId: string): Pick<CatalogEvolutionDependencies, 'writer' | 'lessons'> {
  const principal = catalogAggregatorFor(c.principal, scopeId), standing = new AgentStandingApplication(catalogDependencies(c, principal));
  return { writer: { producer: { issuer: principal.issuer, subject: principal.subject }, ready: id => standing.ready(id), record: (id, change) => standing.record(id, change) },
    lessons: async id => {
      // Its `memory`/`inspect` refused (not granted) or a held read: no lesson counts, never a pass failure.
      const read = await (await memoryJournalFor({ ...c, principal }, 'read')).lessonRefs(id).catch((error: unknown) => { if (error instanceof PolicyAuthorizationError) return null; throw error; });
      return read?.status === 'ok' ? read.items : [];
    } };
}
