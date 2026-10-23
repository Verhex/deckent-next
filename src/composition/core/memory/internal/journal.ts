import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { MemoryJournalApplication, MemoryPolicyAuthorization, ModelInvocationPolicyAuthorization, ModelInvocationPurgeApplication, MemoryJournalError,
  type MemoryInvocationContentPurge, type PolicySource } from '#engine/index.js';
import { FileMemoryPurgeJournal, memoryKeyedDigest, openLocalIntegrityAuthority, openSqliteMemoryJournalStore, openSqliteModelInvocationReader,
  openSqliteModelInvocationStore } from '#adapters/index.js';
import { SystemTrustedClock, productResourcePath, type IntegrityAuthority, type ProductLayout } from '#platform/index.js';
import type { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
/** The journal application over one scope context: keyed digests, the source filter, the purge journal and (write) the evaluator-content purge. */
export async function memoryJournalFor(context: Context, mode: 'read' | 'write') {
  const { layout, config } = context, clock = new SystemTrustedClock();
  const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes), policy = new MemoryPolicyAuthorization(source);
  // A write opens (or creates) the key first; a read opens it inside the store, so a missing key is a typed hold, never an empty answer.
  const integrity = mode === 'write' ? await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true) : null;
  const readKey = () => integrity ? Promise.resolve(integrity) : openLocalIntegrityAuthority(layout, config.approvals.keyFile, false);
  return new MemoryJournalApplication({ verifier: { verify: async () => context.principal }, authorize: (...args) => policy.authorize(...args), readFilter: (...args) => policy.readFilter(...args),
    openStore: async access => openSqliteMemoryJournalStore(await context.path(), config.storage.sqlite, await readKey(), access),
    keyedDigest: integrity ? memoryKeyedDigest(integrity) : () => { throw new MemoryJournalError('MEMORY_UNAVAILABLE'); },
    purgeJournal: memoryPurgeJournalOf(layout, readKey), ...(mode === 'write' ? { purgeInvocationContent: memoryInvocationContentPurge(context, source) } : {}),
    automation: config.memoryAutomation.overlay, now: () => clock.sample().wallMs, eventId: randomUUID });
}
/** S4B-4 §6.6: the sealed purge journal of the installation (`state/memory-purges`, not a backup resource: a restore leaves it in place). */
export const memoryPurgeJournalOf = (layout: ProductLayout, integrity: () => Promise<IntegrityAuthority>) =>
  new FileMemoryPurgeJournal(async () => productResourcePath(layout, 'memoryPurges'), integrity);
/**
 * The evaluator calls' stored content of a purged entry, removed through the existing `model-invocation`/`purge-content` application under the
 * caller's own principal and policy (the person on the purge card; the installation owner when the service re-applies the journal). Nothing held
 * (never captured, already purged, no such invocation): `absent`.
 */
export function memoryInvocationContentPurge(context: Context, policy: PolicySource): MemoryInvocationContentPurge {
  const clock = new SystemTrustedClock(), sqlite = context.config.storage.sqlite;
  return async (scopeId, invocationId, commandId) => {
    const path = await context.path(), reader = await openSqliteModelInvocationReader(path, { busyTimeoutMs: sqlite.busyTimeoutMs });
    let held;
    try { held = await reader.loadInspection(scopeId, invocationId); } finally { reader.close(); }
    const content = held?.record.content;
    if (!held || held.record.purge || !content) return 'absent';
    await new ModelInvocationPurgeApplication({ async verify() { return context.principal; } }, new ModelInvocationPolicyAuthorization(policy),
      async () => openSqliteModelInvocationStore(path, sqlite, 'forbid'), { now: () => clock.sample().wallMs })
      .purge({ schemaVersion: 1, commandId, scopeId, invocationId, reference: held.record.receipt.request.reference, expectedContentDigest: content.descriptor.digest });
    return 'purged';
  };
}
