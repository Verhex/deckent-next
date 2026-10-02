import { createHash, randomBytes } from 'node:crypto';

/**
 * The approval-assurance producer port (B1, owner 2026-10-01 `attested_assurance`). A producer attests one level for one decision from
 * evidence the service holds — never from anything the client declares about itself. The registry derives the highest attested level;
 * the baseline (a session-verified peer of the owner's OS user) always holds. Enterprise registers further producers (IdP step-up,
 * WebAuthn user verification, a paired channel) with their own level id and rank; Core is not edited for that.
 */
export interface ApprovalAssuranceEvidence {
  readonly scopeId: string;
  readonly approvalId: string;
  /** The session-verified decider. */
  readonly decider: { readonly issuer: string; readonly subject: string };
  /** The socket peer's process (SO_PEERCRED), null for an in-process SDK call. */
  readonly peerPid: number | null;
  /** The one-time decision capability the client presented, if any. */
  readonly capability: string | null;
  readonly nowMs: number;
}
export interface ApprovalAssuranceProducer {
  readonly level: string;
  readonly rank: number;
  attests(evidence: ApprovalAssuranceEvidence): boolean;
  /** Called once after the decision that used this attestation committed (a single-use producer spends it here). */
  settle?(evidence: ApprovalAssuranceEvidence): void;
}
export interface DerivedApprovalAssurance { readonly level: string; readonly rank: number; settle(): void }

export class ApprovalAssuranceRegistry {
  private readonly producers: readonly ApprovalAssuranceProducer[];
  constructor(private readonly baseline: { readonly level: string; readonly rank: number }, producers: readonly ApprovalAssuranceProducer[] = []) {
    this.producers = [...producers].sort((a, b) => b.rank - a.rank);
  }
  /** Rank of a level; a level no producer here can attest is unsatisfiable (`Infinity`), so a minimum naming it fails closed. */
  rank(level: string): number {
    if (level === this.baseline.level) return this.baseline.rank;
    return this.producers.find(producer => producer.level === level)?.rank ?? Number.POSITIVE_INFINITY;
  }
  derive(evidence: ApprovalAssuranceEvidence): DerivedApprovalAssurance {
    for (const producer of this.producers) {
      if (producer.rank > this.baseline.rank && producer.attests(evidence)) return { level: producer.level, rank: producer.rank, settle: () => producer.settle?.(evidence) };
    }
    return { level: this.baseline.level, rank: this.baseline.rank, settle: () => undefined };
  }
}

/** A capability's wire form: 256 random bits, base64url (43 characters). */
export const DECISION_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
type Binding = { readonly scopeId: string; readonly approvalId: string; readonly principal: { readonly issuer: string; readonly subject: string };
  readonly peerPid: number; readonly expiresAt: number };
const hashOf = (capability: string) => createHash('sha256').update(`decision-capability:1\0${capability}`).digest('hex');

/**
 * One-time decision capabilities in service memory (B1 turn-bound): minted for one approval, one principal and the socket peer process that
 * started the turn, held only as a hash, spent by the decision that used it, revoked when the card settles or the turn ends, and gone with
 * the service (a restart closes the turn's cards anyway). Bounded: expired entries are dropped on every mint; the oldest go first at the cap.
 */
export class DecisionCapabilityRing implements ApprovalAssuranceProducer {
  private readonly entries = new Map<string, Binding>();
  constructor(readonly level: string, readonly rank: number, private readonly capacity = 4096) {}
  /** `nowMs` is the service's trusted wall clock (the same clock the decision compares the expiry with). */
  mint(binding: Binding, nowMs: number): string {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= nowMs) this.entries.delete(key);
    while (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    const capability = randomBytes(32).toString('base64url');
    this.entries.set(hashOf(capability), Object.freeze({ ...binding, principal: { issuer: binding.principal.issuer, subject: binding.principal.subject } }));
    return capability;
  }
  private find(evidence: ApprovalAssuranceEvidence): string | null {
    if (evidence.capability === null || !DECISION_CAPABILITY_PATTERN.test(evidence.capability)) return null;
    // Only the hash is held: the lookup compares digests, never the presented secret itself.
    const key = hashOf(evidence.capability), entry = this.entries.get(key);
    if (!entry) return null;
    const bound = entry.scopeId === evidence.scopeId && entry.approvalId === evidence.approvalId && entry.principal.issuer === evidence.decider.issuer
      && entry.principal.subject === evidence.decider.subject && evidence.peerPid !== null && entry.peerPid === evidence.peerPid && evidence.nowMs < entry.expiresAt;
    return bound ? key : null;
  }
  attests(evidence: ApprovalAssuranceEvidence): boolean { return this.find(evidence) !== null; }
  settle(evidence: ApprovalAssuranceEvidence): void { const key = this.find(evidence); if (key) this.entries.delete(key); }
  /** Revokes every capability of one approval (the card settled, the turn ended). */
  revoke(scopeId: string, approvalId: string): void {
    for (const [key, entry] of this.entries) if (entry.scopeId === scopeId && entry.approvalId === approvalId) this.entries.delete(key);
  }
}
