import { randomUUID } from 'node:crypto';
import { executionRegistrySchema } from '#domain/index.js';
import { MemoryJournalApplication, MemoryPolicyAuthorization, memoryDistillerFor, memoryWorkClassView } from '#engine/index.js';
import { memoryKeyedDigest, openLocalIntegrityAuthority, openSqliteMemoryJournalStore, readMemoryExtractionPage, selectWorkTarget } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
/**
 * S4B-1 (owner S-M1/S-M11/S-M14): the memory distiller off the hot path — one bounded page of a scope's accepted Tasks per reconciliation pass,
 * under the composition-root workload identity `<owner>/memory-distiller` (floor D1–D4). `memoryAutomation.extraction.mode` off (default: nothing
 * loads) | shadow (receipts only) | on (inert candidates; they reach no worker or Brain before S4B-5/6).
 */
export function prepareConfiguredMemoryExtraction(projectRoot: string, options: ConfigLoadOptions, mode: string) {
  const run = mode === 'on' ? 'live' as const : mode === 'shadow' ? 'shadow' as const : null;
  if (!run) return null;
  return Object.freeze({ async run(scopeId: string) { try {
    const c = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write'), path = await c.path(), integrity = await openLocalIntegrityAuthority(c.layout, c.config.approvals.keyFile, true);
    const policy = new MemoryPolicyAuthorization({ async load() { return c.document; } }), distiller = memoryDistillerFor(c.principal, scopeId);
    const app = new MemoryJournalApplication({ verifier: { verify: async () => distiller }, authorize: (...args) => policy.authorize(...args), keyedDigest: memoryKeyedDigest(integrity),
      openStore: async access => openSqliteMemoryJournalStore(path, c.config.storage.sqlite, integrity, access), automation: c.config.memoryAutomation.overlay, now: Date.now, eventId: randomUUID });
    const registry = c.config.admission ? executionRegistrySchema.parse(c.config.admission.registry).workClasses : undefined;
    return await app.distilPage(scopeId, run, { page: (after, limit) => readMemoryExtractionPage(path, c.config.storage.sqlite, scopeId, after, limit,
      { workClass: id => memoryWorkClassView(registry, id), workTargetId: selectWorkTarget(c.config.execution)?.id ?? null }) });
  } catch (error) { throw queryFailure(error); } } });
}
