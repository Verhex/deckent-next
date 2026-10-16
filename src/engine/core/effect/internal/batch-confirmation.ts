import { encodeCommandProjection, TargetQueueError } from '#domain/index.js';
import { DecisionCapabilityRing } from '#engine/core/authentication/index.js';
import { targetBatchDigest, type TargetBatch } from './target-batch.js';
export interface BatchPeer {
  readonly scopeId: string; readonly sessionId: string; readonly principal: { readonly issuer: string; readonly subject: string };
  readonly peerPid: number; readonly channel: 'terminal' | 'mcp' | 'sdk' | 'ai';
}
export interface BatchTerminalWitness { readonly processStart: string; readonly terminal: string }
export interface BatchWitnessAuthority {
  /** Service derives this from SO_PEERCRED and the controlling terminal; never from request fields. */
  capture(peer: BatchPeer): Promise<BatchTerminalWitness | null>;
  sessionActive(peer: BatchPeer): Promise<boolean>;
  /** Sealed decision and capability consumption must commit before any existing effect owner is called. */
  record(peer: BatchPeer, batchDigest: string, operation: TargetBatch['operation'], answer: 'allow' | 'decline'): Promise<void>;
}
interface Challenge { readonly peer: string; readonly witness: string; readonly digest: string; readonly batch: TargetBatch; readonly issuedAt: number; readonly monotonicExpiresAt: number }
/** Exact-batch, operation-separated one-use capabilities. Service restart loses them; neither TTL nor a client boolean grants consent. */
export class TargetBatchConfirmation {
  private readonly ring: DecisionCapabilityRing;
  private readonly challenges = new Map<string, Challenge>();
  constructor(private readonly authority: BatchWitnessAuthority, private readonly capacity: number, private readonly now: () => number, private readonly monotonic: () => number = now) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TargetQueueError('QUEUE_CAPACITY');
    this.ring = new DecisionCapabilityRing('target-batch', 1, capacity);
  }
  private async witness(peer: BatchPeer): Promise<string> {
    if (peer.channel !== 'terminal' || !Number.isSafeInteger(peer.peerPid) || peer.peerPid < 1 || !await this.authority.sessionActive(peer))
      throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
    const witness = await this.authority.capture(peer);
    if (!witness) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
    return encodeCommandProjection('batch-terminal-witness:1', witness);
  }
  async challenge(peer: BatchPeer, batch: TargetBatch): Promise<string> {
    const witness = await this.witness(peer), now = this.now(), digest = targetBatchDigest(batch);
    if (batch.expiresAt <= now || batch.items.some(item => item.scopeId !== peer.scopeId)) throw new TargetQueueError('QUEUE_EXPIRED');
    for (const [key, entry] of this.challenges) if (entry.batch.expiresAt <= now) { this.challenges.delete(key); this.ring.revoke(entry.batch.items[0]!.scopeId, key); }
    if (this.challenges.size >= this.capacity) throw new TargetQueueError('QUEUE_CAPACITY');
    const frozen = JSON.parse(JSON.stringify(batch)) as TargetBatch;
    this.challenges.set(digest, { peer: encodeCommandProjection('batch-peer:1', peer), witness, digest, batch: frozen, issuedAt: now, monotonicExpiresAt: this.monotonic() + batch.expiresAt - now });
    return this.ring.mint({ scopeId: peer.scopeId, approvalId: digest, principal: peer.principal, peerPid: peer.peerPid, expiresAt: batch.expiresAt }, now);
  }
  /** Only the trusted terminal producer supplies the answer after showing the manifest. Public SDK/MCP have no decision producer. */
  async answer(peer: BatchPeer, batch: TargetBatch, capability: string, answer: 'allow' | 'decline'): Promise<() => Promise<void>> {
    const digest = targetBatchDigest(batch), challenge = this.challenges.get(digest);
    const witness = await this.witness(peer);
    if (challenge && (this.now() < challenge.issuedAt || this.monotonic() >= challenge.monotonicExpiresAt)) throw new TargetQueueError('QUEUE_EXPIRED');
    const evidence = { scopeId: peer.scopeId, approvalId: digest, decider: peer.principal, peerPid: peer.peerPid, capability, nowMs: this.now() };
    if (!challenge || challenge.peer !== encodeCommandProjection('batch-peer:1', peer) || witness !== challenge.witness || !this.ring.attests(evidence))
      throw new TargetQueueError('QUEUE_CONFIRMATION_REQUIRED');
    // Revoke before awaiting audit, closing two-answer races. Audit failure loses this capability and never applies an effect.
    this.ring.revoke(peer.scopeId, digest); this.challenges.delete(digest);
    await this.authority.record(peer, digest, batch.operation, answer);
    if (answer !== 'allow') throw new TargetQueueError('QUEUE_CONFIRMATION_REQUIRED');
    return async () => {
      const currentWitness = await this.witness(peer);
      if (this.now() < challenge.issuedAt || this.now() >= challenge.batch.expiresAt || this.monotonic() >= challenge.monotonicExpiresAt) throw new TargetQueueError('QUEUE_EXPIRED');
      if (targetBatchDigest(batch) !== challenge.digest || currentWitness !== challenge.witness) throw new TargetQueueError('QUEUE_CONFIRMATION_REQUIRED');
    };
  }
}
