import { inspectProductFile, ManagedFileError, type ConfigLoadOptions } from '#platform/index.js';
import type { TargetQueueRecord } from '#domain/index.js';
import { SqliteTargetQueue, captureLocalInteractiveTerminal, localPrincipalChannel, withLocalPrincipalChannel, readLocalOsIdentity, type LocalPeerIdentity, SqliteAuditStore, openSqliteLedgerReadOnly } from '#adapters/index.js';
import { createTargetQueueService, selectQueueActor, recordTargetBatchDecision, type BatchPeer, type TargetBatch } from '#engine/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { queuePreparation, queueReattempt, queueRunDelivery } from './queue-prepare.js';
import { queueEffects } from './queue-effects.js';
import { withQueueContext, type QueueContext } from './queue-context.js';
export async function createTargetQueueHost(root: string, instanceId: string, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(root, { ...options, heal: false });
  const read = async <T>(work: (queue: SqliteTargetQueue) => T, empty: T): Promise<T> => {
    let path: string;
    try { path = await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']); }
    catch (error) { if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return empty; throw error; }
    const db = openSqliteLedgerReadOnly(path, config.storage.sqlite);
    try { return work(new SqliteTargetQueue(db)); } finally { db.close(); }
  };
  const snapshot = () => read(queue => { const records: TargetQueueRecord[] = [];
      let after: { key: string; ordinal: number } | null = null;
      for (;;) { const page = queue.pending(config.targetQueue.capacity, after); records.push(...page); const last = page.at(-1); if (!last || page.length < config.targetQueue.capacity) return records;
        after = { key: last.key, ordinal: last.ordinal }; } }, [] as TargetQueueRecord[]);
  return createTargetQueueService<QueueContext, LocalPeerIdentity>({ instanceId, config, snapshot, reattempts: () => read(queue => queue.reattemptable(Date.now() - config.targetQueue.reattemptWindowMs, config.targetQueue.capacity), []),
    intents: () => read(queue => queue.intentRuns(config.targetQueue.capacity), []), deliver: (c, ref) => queueRunDelivery(root, c, options, ref),
    withActor: (record, work) => withLocalPrincipalChannel(selectQueueActor(record, channel => withLocalPrincipalChannel(channel, readLocalOsIdentity)), work),
    withScope: (scopeId, peer, readOnly, work) => withQueueContext(root, scopeId, options, peer, readOnly, work),
    effects: queueEffects, preparation: c => queuePreparation(root, c, options), captureProcess: captureLocalInteractiveTerminal,
    reattempt: (c, record, act) => queueReattempt(root, c, options, record, act),
    isMcp: () => localPrincipalChannel() === 'mcp',
    async record(peer: BatchPeer, digest: string, operation: TargetBatch['operation'], answer: 'allow' | 'decline') {
      await withQueueContext(root, peer.scopeId, options, undefined, false, async c => {
        recordTargetBatchDecision(peer, digest, operation, answer, await captureLocalInteractiveTerminal(peer.peerPid, Number(peer.principal.subject)), new SqliteAuditStore(c.db), c.integrity, c.document.revision, Date.now());
      });
    },
  });
}
