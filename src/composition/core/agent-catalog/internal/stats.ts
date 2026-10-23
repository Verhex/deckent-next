import { userInfo } from 'node:os';
import { AgentCatalogPolicyAuthorization, AgentStandingApplication, PolicyAuthorizationError, catalogAggregatorFor, CatalogEvolutionApplication, agentStatsQuerySchema, catalogModelFacts, composeModelRolePolicy, memoryCatalogFacts, memoryCatalogKey,
  type AgentStatsView, type CatalogEvolutionDependencies } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAgentCatalogStore, openSqliteCatalogEvolutionStore, openSqliteModelCatalogReader } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { memoryJournalFor } from '#composition/core/memory/index.js';
import { catalogDependencies } from './application.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
const application = (c: Context, path: string, aggregator: Pick<CatalogEvolutionDependencies, 'writer' | 'lessons'> = {}) => new CatalogEvolutionApplication({ ...aggregator, verifier: { verify: async () => c.principal },
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
 * S8-2/S8-3 aggregator pass off the hot path (F8 memory-distiller pattern): one bounded page per scope per reconciliation pass, after Nervous, recovery
 * and memory. `catalogEvolution.mode` off (default: nothing loads) | shadow (sealed suggestions, no narrowing, no card) | on; no model call. Its failure is
 * reported by the loop, never a reconciliation failure; Runs and selection never read its record.
 */
export function prepareConfiguredCatalogAggregation(projectRoot: string, options: ConfigLoadOptions, mode: string) {
  if (mode !== 'shadow' && mode !== 'on') return null;
  return Object.freeze({ async run(scopeId: string) {
    try { const c = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write'); return await application(c, await c.path(), aggregatorOf(c, scopeId)).runPass(scopeId, mode); }
    catch (error) { throw queryFailure(error); }
  } });
}
/**
 * S8-3: the aggregator's own workload identity `<owner>/catalog-aggregator` (composition root only, held to its floor's exact list): it writes through the
 * catalog's standing application, signed by its own enrolled key (none: the pass writes nothing), and counts verified lesson refs under its own
 * `memory`/`inspect` (refs and digests only; a refused or held read counts none).
 */
function aggregatorOf(c: Context, scopeId: string): Pick<CatalogEvolutionDependencies, 'writer' | 'lessons'> {
  const principal = catalogAggregatorFor(c.principal, scopeId), standing = new AgentStandingApplication(catalogDependencies(c, principal));
  return { writer: { producer: { issuer: principal.issuer, subject: principal.subject }, ready: id => standing.ready(id), record: (id, change) => standing.record(id, change) },
    lessons: async id => {
      // Its `memory`/`inspect` refused (not granted) or a held read: no lesson counts, never a pass failure.
      const read = await (await memoryJournalFor({ ...c, principal }, 'read')).lessonRefs(id).catch((error: unknown) => { if (error instanceof PolicyAuthorizationError) return null; throw error; });
      return read?.status === 'ok' ? read.items : [];
    } };
}
