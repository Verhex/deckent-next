import { randomUUID } from 'node:crypto';
import { executionRegistrySchema, type AttemptIdentity, type MemoryExtractionSource, type VerifiedPrincipal } from '#domain/index.js';
import { MemoryJournalApplication, MemoryPolicyAuthorization, PolicyAuthorizationError, memoryDistillerFor, memoryReportClaimsOf, memoryWorkClassView, type MemoryReportClaims } from '#engine/index.js';
import { FileArtifactStore, memoryKeyedDigest, openLocalIntegrityAuthority, openSqliteInventoryReader, openSqliteMemoryJournalStore, type SqliteInventoryReader, readMemoryExtractionPage, selectWorkTarget } from '#adapters/index.js';
import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import type { ArtifactReceipt } from '#capabilities/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { contextDispatchAuthorization } from '#composition/core/policy/index.js';
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
    let artifacts: FileArtifactStore | undefined;
    const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
    const report = attemptReportClaimReader({ reader, authorization: contextDispatchAuthorization(c, c.document), scopeId,
      artifacts: async () => artifacts ??= new FileArtifactStore({ root: await inspectProductDirectory(c.layout, 'artifacts'), maxBytes: c.config.artifacts.maxBytes }) });
    try { return await app.distilPage(scopeId, run, { page: (after, limit) => readMemoryExtractionPage(path, c.config.storage.sqlite, scopeId, after, limit,
      { workClass: id => memoryWorkClassView(registry, id), workTargetId: selectWorkTarget(c.config.execution)?.id ?? null }), report }); } finally { reader.close(); }
  } catch (error) { throw queryFailure(error); } } });
}

/**
 * S4B-2 (E3): the worker's lesson claims come from the sealed output of an accepted Attempt, read under the distiller's own `attempt/read-output`
 * decision (the one handoff uses). A refused decision or an unreadable/absent claim set yields no E3 candidate, never an error; any other failure
 * of the decision (policy unavailable) propagates and stops the page with its cursor.
 */
export function attemptReportClaimReader(deps: { readonly scopeId: string; readonly artifacts: () => Promise<{ read(scopeId: string, receipt: ArtifactReceipt): Promise<Uint8Array> }>;
  readonly reader: Pick<SqliteInventoryReader, 'loadRun' | 'loadBoundDispatch'>; readonly authorization: { authorizeIdentity(action: 'read-output', identity: AttemptIdentity, principal: VerifiedPrincipal): Promise<void> } }) {
  return async (source: MemoryExtractionSource, principal: VerifiedPrincipal): Promise<MemoryReportClaims | null> => {
    const attempt = (await deps.reader.loadRun(deps.scopeId, source.runId))?.bindings.find(row => row.identity.attemptId === source.attemptId)?.identity;
    if (!attempt) return null;
    try { await deps.authorization.authorizeIdentity('read-output', attempt, principal); } catch (error) { if (error instanceof PolicyAuthorizationError) return null; throw error; }
    // An output that cannot be read back (gone, corrupt) is no claim set; it must not block the cursor for every later Attempt.
    try {
      const output = (await deps.reader.loadBoundDispatch(attempt))?.output; if (!output) return null;
      return memoryReportClaimsOf(output, await (await deps.artifacts()).read(deps.scopeId, output), attempt);
    } catch { return null; }
  };
}
