import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { MemoryJournalApplication, MemoryPolicyAuthorization, MemoryJournalError, type MemoryEvaluatorInvocations } from '#engine/index.js';
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
    purgeJournal: memoryPurgeJournalOf(layout, readKey), ...(mode === 'write' ? { evaluatorInvocations: memoryEvaluatorInvocations(context) } : {}),
    automation: config.memoryAutomation.overlay, now: () => clock.sample().wallMs, eventId: randomUUID });
}
/** S4B-4 §6.6: the sealed purge journal of the installation (`state/memory-purges`, not a backup resource: a restore leaves it in place). */
export const memoryPurgeJournalOf = (layout: ProductLayout, integrity: () => Promise<IntegrityAuthority>) =>
  new FileMemoryPurgeJournal(async () => productResourcePath(layout, 'memoryPurges'), integrity);
/**
 * S4B-4 (lead review 2026-10-23): the evaluator invocations a purge may reach, read from the ledger as stored. The content is removed by the
 * model-invocation store's own purge write under the purge record's `memory`/`purge` decision (no model-invocation grant, no policy read); the
 * engine has already bound each invocation to the entry's sealed evaluation records and the memory evaluator.
 */
export function memoryEvaluatorInvocations(context: Context): MemoryEvaluatorInvocations {
  const sqlite = context.config.storage.sqlite;
  return {
    async load(scopeId, invocationId) {
      const reader = await openSqliteModelInvocationReader(await context.path(), { busyTimeoutMs: sqlite.busyTimeoutMs });
      let held;
      try { held = await reader.loadInspection(scopeId, invocationId); } finally { reader.close(); }
      if (!held) return null;
      const { receipt, content, purge } = held.record;
      return { commandId: receipt.claim.commandId, invokedBy: receipt.actor, reference: receipt.request.reference, contentDigest: purge || !content ? null : content.descriptor.digest };
    },
    async purgeContent(input) {
      const store = await openSqliteModelInvocationStore(await context.path(), sqlite, 'forbid');
      try {
        return await store.purgeContent({ command: { schemaVersion: 1, commandId: input.commandId, scopeId: input.scopeId, invocationId: input.invocationId,
          reference: input.reference as never, expectedContentDigest: input.expectedContentDigest },
        actor: { id: input.actor.id, issuer: input.actor.issuer, subject: input.actor.subject, assurance: input.actor.assurance }, authorization: input.decision, purgedAtMs: input.atMs });
      } finally { store.close(); }
    },
  };
}
