import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { AuditApplication, MemoryJournalApplication, MemoryPolicyAuthorization, memoryCatalogFacts, memoryCatalogKey, memoryRolloutGated, type MemoryHeld,
  type MemoryRolloutModes, type MemoryRolloutStatus } from '#engine/index.js';
import { FileMemoryPurgeJournal, memoryKeyedDigest, openLocalIntegrityAuthority, openMemoryEvaluationSourceReader, openReadOnlyAuditStore, openSqliteMemoryJournalStore,
  openSqliteModelCatalogReader } from '#adapters/index.js';
import { ErrorRegistry, SystemTrustedClock, getConfigKnownSecrets, productResourcePath, type ConfigLoadOptions, type DeckentConfig } from '#platform/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** The three `memoryAutomation` switch modes of one effective configuration. */
export const memoryRolloutModesOf = (config: Pick<DeckentConfig, 'memoryAutomation'>): MemoryRolloutModes => ({ extraction: config.memoryAutomation.extraction.mode,
  verification: config.memoryAutomation.verification.mode, context: config.memoryAutomation.context.mode });

/**
 * S4B-7 (§11) read-only: the rollout status of one scope under the caller's `memory`/`inspect`, measured from the sealed records of the
 * installation's ledger (memory journal, evaluation records, audit `memory-context` seals verified with the integrity key, the purge journal)
 * and the source models re-derived from the sealed Runs through the catalog makers (N22). Opens nothing for writing and creates no key.
 */
export async function inspectConfiguredMemoryRollout(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<MemoryRolloutStatus | MemoryHeld> {
  try {
    const c = await loadConfiguredScopeContext(projectRoot, scopeId, { ...options, heal: false }, 'read'), { config, layout } = c, sqlite = config.storage.sqlite;
    const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, false).catch(() => null);
    if (!integrity) return { schemaVersion: 1, status: 'held', code: 'MEMORY_UNAVAILABLE' };
    const path = await c.path(), policy = new MemoryPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
    const view = await policy.readFilter(c.principal, scopeId);
    // The sealed-Run re-derivation (independence) opens its own readers; when they cannot open, only that measure is unreadable.
    const sources = await (async () => {
      const catalog = await openSqliteModelCatalogReader(path, { busyTimeoutMs: sqlite.busyTimeoutMs });
      let facts;
      try { facts = await memoryCatalogFacts(catalog); } finally { catalog.close(); }
      return openMemoryEvaluationSourceReader(path, sqlite, (channelId, modelId) => facts.get(memoryCatalogKey(channelId, modelId))?.maker ?? null, runId => view({ kind: 'run', id: runId }, 'inspect'));
    })().catch(() => null);
    try {
      const clock = new SystemTrustedClock(), journal = new MemoryJournalApplication({ verifier: { verify: async () => c.principal }, authorize: (...args) => policy.authorize(...args),
        readFilter: (...args) => policy.readFilter(...args), openStore: async access => openSqliteMemoryJournalStore(path, sqlite, integrity, access), keyedDigest: memoryKeyedDigest(integrity),
        purgeJournal: new FileMemoryPurgeJournal(async () => productResourcePath(layout, 'memoryPurges'), async () => integrity), ...(sources ? { evaluationSources: sources } : {}),
        automation: config.memoryAutomation.overlay, knownSecrets: getConfigKnownSecrets(config), now: () => clock.sample().wallMs, eventId: randomUUID });
      return await journal.rollout({ schemaVersion: 1, scopeId, modes: memoryRolloutModesOf(config) }, { async contextEvents(scope, kind, limit) {
        const store = await openReadOnlyAuditStore(path, sqlite);
        try { return new AuditApplication(store, integrity).listRecentKind(scope, kind, 0, limit).map(record => record.event.subject); } finally { store.close(); }
      } });
    } finally { sources?.close(); }
  } catch (error) { throw queryFailure(error); }
}

/**
 * S4B-7 protected live switches: the config precondition of every configured write path. A change that newly sets a gated phase (phase 3
 * `memoryAutomation.context.mode on`, phase 4 `memoryAutomation.verification.mode on`, from the rollout registry) is refused
 * (`MEMORY_ROLLOUT_CRITERIA_UNMET`, nothing written) unless every exit criterion of that phase holds in the writer's scope, measured as the writer;
 * an unreadable measure refuses. A step back (to shadow or off) and every other key are never measured. The AI floor (A10) refuses AI writers first.
 */
export function configuredMemoryRolloutPrecondition(projectRoot: string, options: ConfigLoadOptions = {}) {
  return async (input: { readonly scopeId: string; readonly principal: VerifiedPrincipal }, before: DeckentConfig, after: DeckentConfig) => {
    const gated = memoryRolloutGated(memoryRolloutModesOf(before), memoryRolloutModesOf(after));
    if (!gated.length) return;
    // A refusal of the read itself (no `memory`/`inspect`, an unreadable policy) refuses the write with its own typed error.
    const status = await inspectConfiguredMemoryRollout(projectRoot, input.scopeId, options);
    const refuse = (phase: number, criteria: string) => ErrorRegistry.createError('MEMORY_ROLLOUT_CRITERIA_UNMET', { params: { phase, criteria, scope: input.scopeId } });
    if (status.status === 'held') throw refuse(gated[0]!, status.code);
    const blocked = status.view.phases.find(phase => gated.includes(phase.phase) && !phase.met);
    if (blocked) throw refuse(blocked.phase, blocked.criteria.filter(row => !row.met).map(row => row.criterion.id).join(', '));
  };
}
