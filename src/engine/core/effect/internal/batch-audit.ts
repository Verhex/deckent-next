import { createHash, randomUUID } from 'node:crypto';
import { TargetQueueError } from '#domain/index.js';
import { AuditApplication, type AuditStore } from '#engine/core/audit/index.js';
import type { BatchPeer, BatchTerminalWitness } from './batch-confirmation.js';
import type { TargetBatch } from './target-batch.js';
/** Failure to capture the existing terminal or seal its answer never releases an effect capability. */
export function recordTargetBatchDecision(peer: BatchPeer, digest: string, operation: TargetBatch['operation'], answer: 'allow' | 'decline',
  witness: BatchTerminalWitness | null, store: AuditStore, integrity: ConstructorParameters<typeof AuditApplication>[1] | null, policyRevision: string, now: number) {
  if (!witness || !integrity) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
  return new AuditApplication(store, integrity).record({ schemaVersion: 1, eventId: randomUUID(), scopeId: peer.scopeId, principal: peer.principal, policyRevision, atMs: now,
    subject: { kind: 'target-batch-decision', batchDigest: digest, operation, answer, peerPid: peer.peerPid,
      witnessDigest: createHash('sha256').update(JSON.stringify(witness)).digest('hex') } });
}
