import { AGENT_CATALOG_LIMITS, CatalogEvolutionError, composeCatalogEvolutionRegistry, roleModelKey, type AgentDefinition, type CatalogEvolutionRegistry } from '#domain/index.js';
import { authenticate } from '#engine/core/authentication/index.js';
import { agentStatsQuerySchema, type AgentStatsKey, type AgentStatsView, type CatalogEvolutionDependencies, type CatalogEvolutionPass, type KeyStats, type ModelFacts } from './contract.js';
import { catalogEntries, effortRatioMicro, keyStats, rollupStats, type CatalogEntries } from './aggregate.js';
import { catalogRegistryRef as registryRef, runCatalogEvolutionPass } from './pass.js';

/** Read-time model display facts (§4: display only, never a branch): the catalog's canonical maker and the S2 tier registry row, null when absent. */
export function catalogModelFacts(makers: ReadonlyMap<string, { readonly maker: string | null }>, makerKey: (channelId: string, modelId: string) => string,
  tiers: readonly Readonly<{ channelId: string; modelId: string; tier: string }>[]): ModelFacts {
  const tier = new Map(tiers.map(row => [roleModelKey(row), row.tier] as const));
  return (channelId, modelId) => ({ maker: makers.get(makerKey(channelId, modelId))?.maker ?? null, tier: tier.get(roleModelKey({ channelId, modelId })) ?? null });
}

type Catalog = Awaited<ReturnType<CatalogEvolutionDependencies['openCatalog']>>;
const LABELS = Object.freeze({ relation: 'association-not-causation', rate: 'acceptance-rate-not-accuracy' } as const);

/**
 * S8-2/S8-3 catalog evolution (S8-DESIGN §4, §6): agent, skill and WorkClass statistics from sealed metrics v2 rows, and the aggregator pass off the hot
 * path, whose only writes are the catalog's signed suggestions and rule narrowing. Nothing here calls a model or reads a model id as a branch. Statistics are
 * associations ("ilişki, nedensellik değil") and acceptance rates ("kabul oranı, doğruluk değil"); only attributable failures enter n.
 */
export class CatalogEvolutionApplication {
  constructor(private readonly deps: CatalogEvolutionDependencies) {}

  /** `agent-catalog`/`inspect` read: one agent in detail (every revision in the window, pinned-skill association, org roll-up) or a page of agents. */
  async inspectStats(input: unknown, credential?: unknown): Promise<AgentStatsView> {
    const query = agentStatsQuerySchema.parse(input), principal = await authenticate(this.deps.verifier, credential, query.scopeId);
    await this.deps.authorize('inspect', query.scopeId, principal);
    const registry = composeCatalogEvolutionRegistry(this.deps.overlay), asOfMs = this.deps.now(), scopeId = query.scopeId;
    const catalog = await this.deps.openCatalog();
    try {
      const store = await this.deps.openStore('read');
      let rows, lastPass;
      try { rows = await store.recentRows(scopeId, registry.stats.readRowsMax); lastPass = await store.lastPass(scopeId); } finally { store.close(); }
      const entries = catalogEntries(scopeId, rows), detail = query.agentId !== undefined, facts = detail && this.deps.modelFacts ? await this.deps.modelFacts(scopeId) : undefined;
      const all = await catalog.listAgents(scopeId, AGENT_CATALOG_LIMITS.agentsPerScopeMax), stats = (match: Parameters<typeof keyStats>[3]) => keyStats(entries, registry, asOfMs, match, facts);
      const chosen = detail ? await catalog.loadAgent(scopeId, query.agentId!) : null;
      const targets = detail ? (chosen ? [chosen] : []) : all.slice(0, query.limit ?? AGENT_CATALOG_LIMITS.pageMax);
      const agents = [];
      for (const agent of targets) {
        if (agent.scopeId !== scopeId) throw new CatalogEvolutionError('CATALOG_EVOLUTION_CORRUPT');
        const revisions = detail ? [...new Set([agent.revision, ...entries.tasks.flatMap(row => row.agent?.agentId === agent.agentId ? [row.agent.revision] : [])])].sort((a, b) => b - a) : [agent.revision];
        const keys: AgentStatsKey[] = [];
        for (const revision of revisions) {
          const definition = revision === agent.revision ? agent : await catalog.loadAgent(scopeId, agent.agentId, revision);
          if (!definition || definition.scopeId !== scopeId || definition.revision !== revision) throw new CatalogEvolutionError('CATALOG_EVOLUTION_CORRUPT');
          const standings = await catalog.standings(scopeId, agent.agentId, revision);
          const seen = entries.tasks.flatMap(row => row.agent?.agentId === agent.agentId && row.agent.revision === revision && row.workClass ? [row.workClass] : []);
          for (const workClass of [...new Set([...definition.content.workClasses, ...seen])].sort()) {
            const own = stats(row => row.workClass === workClass && row.agent?.agentId === agent.agentId && row.agent.revision === revision);
            const baseline = stats(row => row.workClass === workClass && row.agent?.agentId !== agent.agentId);
            const active = (await catalog.eligibleAgents(scopeId, workClass, AGENT_CATALOG_LIMITS.agentsPerScopeMax)).find(row => row.standing.standing === 'active' && row.agent.agentId !== agent.agentId);
            keys.push(Object.freeze({ revision, workClass, standing: standings.find(row => row.workClass === workClass)?.standing ?? null, stats: own, baseline,
              active: active ? Object.freeze({ agentId: active.agent.agentId, revision: active.agent.revision,
                stats: stats(row => row.workClass === workClass && row.agent?.agentId === active.agent.agentId && row.agent.revision === active.agent.revision) }) : null,
              effortRatioMicro: effortRatioMicro(own, baseline), skills: detail ? await this.skillStats(catalog, scopeId, definition, workClass, entries, stats) : null }));
          }
        }
        agents.push(Object.freeze({ agentId: agent.agentId, name: agent.content.name, revision: agent.revision, parentAgentId: agent.content.parentAgentId, keys: Object.freeze(keys),
          rollup: this.rollup(agent, all, registry, stats) }));
      }
      const classes = [...new Set(agents.flatMap(row => row.keys.map(key => key.workClass)))].sort();
      return Object.freeze({ schemaVersion: 1, scopeId, labels: LABELS, mode: this.deps.mode, registry: { ...registryRef(registry), status: registry.status }, asOfMs,
        rows: { read: rows.length, truncated: rows.length >= registry.stats.readRowsMax }, lastPass, status: detail && !chosen ? 'not-found' : 'ok', agents: Object.freeze(agents),
        workClasses: Object.freeze(classes.map(workClass => Object.freeze({ workClass, stats: stats(row => row.workClass === workClass) }))) });
    } finally { catalog.close(); }
  }

  /** Association of each pinned skill of this revision (§4: labelled "not causal"): the rows of every agent revision that pins the exact skill revision. */
  private async skillStats(catalog: Catalog, scopeId: string, definition: AgentDefinition, workClass: string, entries: CatalogEntries, stats: (match: Parameters<typeof keyStats>[3]) => KeyStats) {
    const pins = new Map<string, Set<string>>();
    for (const pair of new Set(entries.tasks.flatMap(row => row.agent && row.workClass === workClass ? [JSON.stringify([row.agent.agentId, row.agent.revision])] : []))) {
      const [agentId, revision] = JSON.parse(pair) as [string, number], row = await catalog.loadAgent(scopeId, agentId, revision);
      if (!row || row.scopeId !== scopeId || row.agentId !== agentId || row.revision !== revision) throw new CatalogEvolutionError('CATALOG_EVOLUTION_CORRUPT');
      pins.set(pair, new Set(row.content.skills.map(ref => JSON.stringify(ref))));
    }
    return Object.freeze(definition.content.skills.map(ref => Object.freeze({ skillId: ref.skillId, revision: ref.revision, digest: ref.digest,
      stats: stats(row => row.workClass === workClass && row.agent !== null && (pins.get(JSON.stringify([row.agent.agentId, row.agent.revision]))?.has(JSON.stringify(ref)) ?? false)) })));
  }
  /** A manager's subtree (current revisions, depth ≤ the catalog's org-tree bound), summed per WorkClass the manager binds; none without reports. */
  private rollup(agent: AgentDefinition, all: readonly AgentDefinition[], registry: CatalogEvolutionRegistry, stats: (match: Parameters<typeof keyStats>[3]) => KeyStats) {
    const members = [agent];
    for (let depth = 0, frontier = [agent.agentId]; depth < AGENT_CATALOG_LIMITS.orgTreeDepthMax && frontier.length; depth++) {
      const next = all.filter(row => row.content.parentAgentId !== null && frontier.includes(row.content.parentAgentId) && !members.some(member => member.agentId === row.agentId));
      members.push(...next); frontier = next.map(row => row.agentId);
    }
    if (members.length === 1) return Object.freeze([]);
    return Object.freeze(agent.content.workClasses.map(workClass => rollupStats(workClass, members.filter(row => row.content.workClasses.includes(workClass))
      .map(row => stats(entry => entry.workClass === workClass && entry.agent?.agentId === row.agentId && entry.agent.revision === row.revision)), registry)));
  }

  /** One bounded, incremental aggregator pass of a scope (`runCatalogEvolutionPass`). */
  runPass(scopeId: string, mode: 'shadow' | 'on'): Promise<CatalogEvolutionPass | null> { return runCatalogEvolutionPass(this.deps, scopeId, mode); }
}
