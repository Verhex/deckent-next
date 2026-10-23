import { AGENT_CATALOG_LIMITS, composeCatalogEvolutionRegistry, encodeDeckentJson, type CatalogEvolutionRegistry, type JsonValue } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { catalogSuggestionKeyDigest, type CatalogSuggestionKey } from '#engine/core/agent-catalog/index.js';
import { catalogEvolutionPassSchema, type CatalogEvolutionDependencies, type CatalogEvolutionPass, type CatalogEvolutionWindow } from './contract.js';
import { catalogEntries, keepWindow, keyStats, mergeEntries, type CatalogEntries } from './aggregate.js';
import { agentRuleCandidates, catalogSuggestionRecord, lessonRuleCandidates, workClassRuleCandidates, type RuleCandidate } from './rules.js';

type PassKey = Extract<CatalogSuggestionKey, { kind: 'agent' | 'work-class' }>;
const only = (entries: CatalogEntries, key: PassKey): CatalogEntries => {
  const match = (row: { workClass: string | null; agent: { agentId: string; revision: number } | null }) => row.workClass === key.workClass
    && (key.kind === 'work-class' || (row.agent?.agentId === key.agentId && row.agent.revision === key.revision));
  return { tasks: entries.tasks.filter(match), events: entries.events.filter(match) };
};
export const catalogRegistryRef = (registry: CatalogEvolutionRegistry) => ({ revision: registry.revision, digest: sha256(encodeDeckentJson(registry as unknown as JsonValue)) });

/**
 * One bounded, incremental aggregator pass of a scope (S8-DESIGN §4, §6, §10; F8 pattern). It reads only the rows after its durable position (a page of
 * `passPageRows`, at most `maxKeysPerPass` touched keys — the position stops before the row that would exceed it, never skipping one) and each touched
 * key's cached window (O(new rows + touched keys × window)); a key without a valid window (first seen, the registry changed, held back by the bound) is
 * rebuilt once per pass from the bounded `readRowsMax` rows before the position. Then the rules, sealed suggestions signed by the aggregator (a calibrated
 * D1 in mode `on` also narrows, in the same transaction), and one compare-and-set pass record with the windows. Without the aggregator's active key the
 * pass writes nothing (read-only, §8); the same rows wait for it. `asOfMs` is the newest sealed row time, so a replayed pass seals the same bytes (N10).
 */
export async function runCatalogEvolutionPass(deps: CatalogEvolutionDependencies, scopeId: string, mode: 'shadow' | 'on'): Promise<CatalogEvolutionPass | null> {
  const registry = composeCatalogEvolutionRegistry(deps.overlay), ref = catalogRegistryRef(registry), writer = deps.writer;
  if (!writer || !(await writer.ready(scopeId))) return null;
  const store = await deps.openStore('write');
  try {
    const previous = await store.lastPass(scopeId), previousPosition = previous?.position ?? 0, page = await store.rowsAfter(scopeId, previousPosition, registry.pass.passPageRows);
    if (!page.length) return null;
    const touched = new Map<string, PassKey>(), skipped = new Map<string, PassKey>();
    let position = previousPosition;
    for (const row of page) {
      const workClass = row.metric.workClass, agent = row.metric.schemaVersion === 2 ? row.metric.agent : undefined;
      const keys: PassKey[] = workClass === null ? [] : [{ kind: 'work-class', workClass }, ...agent ? [{ kind: 'agent' as const, agentId: agent.agentId, revision: agent.revision, workClass }] : []];
      const fresh = keys.filter(key => !touched.has(catalogSuggestionKeyDigest(key)));
      if (position !== previousPosition && touched.size + fresh.length > registry.pass.maxKeysPerPass) break;
      for (const key of fresh) (touched.size < registry.pass.maxKeysPerPass ? touched : skipped).set(catalogSuggestionKeyDigest(key), key);
      position = row.position;
    }
    const fresh = catalogEntries(scopeId, page.filter(row => row.position <= position)), times = [...fresh.tasks, ...fresh.events].flatMap(row => row.atMs === null ? [] : [row.atMs]);
    const asOfMs = times.length ? Math.max(...times) : previous?.asOfMs ?? deps.now();
    const cached = new Map(await store.windows(scopeId, [...touched.keys()])), windows = new Map<string, { key: PassKey; entries: CatalogEntries }>();
    let rebuilt: CatalogEntries | null = null, rowsRead = page.length, truncated = false;
    const held = async (digest: string, key: PassKey): Promise<CatalogEntries> => {
      const hit = cached.get(digest);
      if (hit && hit.registryDigest === ref.digest) return { tasks: hit.tasks as CatalogEntries['tasks'], events: hit.events };
      if (!rebuilt) {
        const rows = await store.recentRows(scopeId, registry.stats.readRowsMax, previousPosition);
        rowsRead += rows.length; truncated = rows.length >= registry.stats.readRowsMax; rebuilt = catalogEntries(scopeId, rows);
      }
      return only(rebuilt, key);
    };
    for (const [digest, key] of touched) windows.set(digest, { key, entries: keepWindow(mergeEntries(await held(digest, key), only(fresh, key)), registry) });
    /** A key no row of this page touched (the WorkClass's active agent): its window is current, or rebuilt from the bounded read. */
    const windowOf = async (key: PassKey) => {
      const digest = catalogSuggestionKeyDigest(key);
      if (!windows.has(digest)) {
        for (const [found, value] of await store.windows(scopeId, [digest])) cached.set(found, value);
        windows.set(digest, { key, entries: keepWindow(await held(digest, key), registry) });
      }
      return windows.get(digest)!.entries;
    };
    const keys = [...touched].map(([digest, key]) => {
      const stats = keyStats(windows.get(digest)!.entries, registry, asOfMs, () => true);
      return { ...key, decided: stats.decided, n: stats.n, successes: stats.successes, wilson: stats.wilson, inputDigest: stats.window.inputDigest };
    });
    const catalog = await deps.openCatalog(), facts = deps.modelFacts ? await deps.modelFacts(scopeId) : undefined;
    let summary;
    try {
      // Per kind, the last position of the previous decided or dismissed window of a key (restore decides the narrowing's suggestion too): windows never overlap.
      const closed = async (key: CatalogSuggestionKey) => {
        const out: Partial<Record<RuleCandidate['kind'], number>> = {};
        for (const row of await catalog.suggestions(scopeId, { keyDigest: catalogSuggestionKeyDigest(key), limit: AGENT_CATALOG_LIMITS.pageMax }))
          if (row.state.state === 'decided' || row.state.state === 'dismissed') out[row.record.kind] = Math.max(out[row.record.kind] ?? 0, row.record.window.lastPosition ?? 0);
        return out;
      };
      const candidates: RuleCandidate[] = [], agents = new Map<string, Extract<PassKey, { kind: 'agent' }>>();
      for (const [digest, key] of touched) {
        if (key.kind === 'agent') { agents.set(digest, key); continue; }
        const eligible = await catalog.eligibleAgents(scopeId, key.workClass, registry.pass.maxKeysPerPass);
        candidates.push(...workClassRuleCandidates({ registry, asOfMs, workClass: key.workClass, entries: windows.get(digest)!.entries, facts, closed: (await closed(key))['propose-agent'],
          eligibleAgents: eligible.length }));
        // A changed WorkClass window is a changed baseline: its eligible agents' rules are read again (bounded), so page-by-page equals one pass.
        for (const row of eligible) { const agent = { kind: 'agent' as const, agentId: row.agent.agentId, revision: row.agent.revision, workClass: key.workClass }; agents.set(catalogSuggestionKeyDigest(agent), agent); }
      }
      for (const key of [...agents.values()].slice(0, registry.pass.maxKeysPerPass)) {
        // Rules read only the agent's current revision: selection never picks an older one.
        const head = await catalog.loadAgent(scopeId, key.agentId), entries = await windowOf(key);
        if (!head || head.revision !== key.revision) continue;
        const standing = (await catalog.standings(scopeId, key.agentId, key.revision)).find(row => row.workClass === key.workClass) ?? null;
        const other = (await catalog.eligibleAgents(scopeId, key.workClass, AGENT_CATALOG_LIMITS.agentsPerScopeMax)).find(row => row.standing.standing === 'active' && row.agent.agentId !== key.agentId);
        const activeKey = other ? { kind: 'agent' as const, agentId: other.agent.agentId, revision: other.agent.revision, workClass: key.workClass } : null;
        candidates.push(...agentRuleCandidates({ registry, asOfMs, facts, key, standing, own: entries, workClass: await windowOf({ kind: 'work-class', workClass: key.workClass }),
          active: activeKey ? { agentId: activeKey.agentId, revision: activeKey.revision, entries: await windowOf(activeKey) } : null, closed: await closed(key) }));
      }
      if (deps.lessons) {
        const covered = new Set((await catalog.listSkills(scopeId, AGENT_CATALOG_LIMITS.agentsPerScopeMax)).flatMap(skill => skill.provenance.origin?.lessonSetDigest ? [skill.provenance.origin.lessonSetDigest] : []));
        candidates.push(...lessonRuleCandidates({ registry, lessons: await deps.lessons(scopeId), covered }));
      }
      const records = candidates.map(candidate => catalogSuggestionRecord(candidate, { scopeId, mode, producer: writer.producer, asOfMs, registry, registryRef: ref }));
      // Bound (§6): unexpired open suggestions no new record replaces, plus the new ones, stay within `maxOpenSuggestions`; the lowest-n new ones are not written (counted).
      const open = (await catalog.suggestions(scopeId, { open: true, limit: registry.suggestions.maxOpenSuggestions + records.length + 1 })).filter(row => row.record.expiresAtMs > asOfMs);
      // A newer window of the key supersedes its open suggestion; the same window (only the baseline moved) keeps it — no churn on a busy WorkClass.
      const held = new Set(open.map(row => JSON.stringify([row.record.keyDigest, row.record.kind, row.record.window.inputDigest])));
      const fresher = records.filter(record => !held.has(JSON.stringify([record.keyDigest, record.kind, record.window.inputDigest])));
      const replaced = open.filter(row => fresher.some(record => record.keyDigest === row.record.keyDigest && record.kind === row.record.kind)).length;
      const kept = [...fresher].sort((a, b) => b.window.n - a.window.n || (a.suggestionId < b.suggestionId ? -1 : 1))
        .slice(0, Math.max(registry.suggestions.maxOpenSuggestions - (open.length - replaced), 0));
      // N3: narrowing only from a calibrated rule in mode `on` (shadow writes records only).
      const narrow = mode === 'on' ? kept.filter(record => record.kind === 'redesign-agent' && record.rule.status === 'calibrated').map(record => record.suggestionId) : [];
      summary = { ...(kept.length ? await writer.record(scopeId, { suggestions: kept, narrow }) : { written: 0, superseded: 0, narrowed: 0 }), skipped: fresher.length - kept.length };
    } finally { catalog.close(); }
    const record = catalogEvolutionPassSchema.parse({ schemaVersion: 1, scopeId, mode, previousPosition, position, asOfMs, registry: ref, rowsRead, truncated, keys, skippedKeys: skipped.size, suggestions: summary });
    const kept: CatalogEvolutionWindow[] = [...windows].map(([keyDigest, { entries }]) => ({ schemaVersion: 1, scopeId, keyDigest, registryDigest: ref.digest, position,
      tasks: entries.tasks as CatalogEvolutionWindow['tasks'], events: entries.events as CatalogEvolutionWindow['events'] }));
    // A key held back by the bound absorbed rows it did not see: its window is invalid until rebuilt.
    for (const keyDigest of skipped.keys()) kept.push({ schemaVersion: 1, scopeId, keyDigest, registryDigest: null, position, tasks: [], events: [] });
    await store.recordPass(record, previousPosition, kept);
    return record;
  } finally { store.close(); }
}
