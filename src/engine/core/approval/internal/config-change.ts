import { randomUUID } from 'node:crypto';
import { approvalRequestSchema, configChangeSubjectConsistent, encodeCommandProjection, ApprovalError, type ApprovalActor, type ApprovalFacts,
  type ApprovalRecord, type ApprovalSubject } from '#domain/index.js';
import { MAX_WALL_SKEW_MS, sha256, type IntegrityAuthority, type TrustedClock } from '#platform/index.js';
import type { ApprovalStore } from './store.js';
import { approvalRequestDigest, expireApproval, sealApproval, verifyApproval } from './integrity.js';
import { minimumApprovalAssurance } from './assurance.js';

export type ConfigChangeSubject = Extract<ApprovalSubject, { kind: 'config-change' }>;
/**
 * The action a config-change approval authorizes (T3 L2): this scope, this requester and exactly this command — layer, key, set/unset, the
 * exact value (its digest) and the layer digest it was previewed against. Display copies and the asking rule are not bound: they describe.
 */
export const configChangeApprovalActionDigest = (scopeId: string, subject: ConfigChangeSubject, requester: ApprovalActor) =>
  sha256(encodeCommandProjection('config-change-approval:1', { scopeId, requester, commandId: subject.commandId, action: subject.action, layer: subject.layer,
    keyPath: subject.keyPath, valueDigest: subject.valueDigest, expectDigest: subject.expectDigest }));

/** Card facts of a config change: it writes a configuration layer (no authority surface); how it is undone is not declared (no evidence). */
export function configChangeApprovalFacts(policy: unknown, scopeId: string): ApprovalFacts {
  const risk = { source: 'effect-class' as const, effectClass: 'write' as const, authority: false };
  return Object.freeze({ risk, reversibility: null, onExpiry: 'nothing-runs' as const, requiredAssurance: minimumApprovalAssurance(policy, scopeId, 'config-change', risk) });
}

export interface ConfigChangeApprovalRequest {
  readonly scopeId: string; readonly requester: ApprovalActor; readonly subject: ConfigChangeSubject;
  /** The current policy document (facts) and its revision (the request's `policyRevision`). */
  readonly policy: unknown; readonly policyRevision: string;
  /** The card's bounded, human-readable sentence (the producer's words in the requester's language). */
  readonly summary: string;
}
export type ConfigChangeApprovalAdmission =
  | { readonly pending: { readonly approvalId: string; readonly revision: number; readonly expiresAt: number; readonly summary: string } }
  | { readonly approved: { readonly approvalId: string; readonly actionDigest: string } };

/**
 * Approval broker for config writes (T3 L2, the `OperationApprovalBroker` pattern): a policy `require-approval` opens — or finds — the
 * request for exactly this change and reports it as pending; nothing is written until a stored, verified `allow` of the same change is
 * found again within its admission window. Producer-only: subject, digest and times come from the engine, never from a caller. Denied,
 * expired or unused approvals are typed refusals; another command (a new command id) opens its own request.
 */
export class ConfigChangeApprovalBroker {
  constructor(private readonly store: ApprovalStore, private readonly integrity: IntegrityAuthority, private readonly clock: TrustedClock,
    private readonly options: { readonly requestTtlMs: number; readonly admitWithinMs: number }) {
    for (const value of [options.requestTtlMs, options.admitWithinMs]) if (!Number.isSafeInteger(value) || value < 1) throw new ApprovalError('APPROVAL_INVALID');
  }

  admit(input: ConfigChangeApprovalRequest): ConfigChangeApprovalAdmission {
    if (!configChangeSubjectConsistent(input.subject)) throw new ApprovalError('APPROVAL_INVALID');
    const actionDigest = configChangeApprovalActionDigest(input.scopeId, input.subject, input.requester);
    const now = this.clock.sample().wallMs;
    const found = this.store.findConfigChange(input.scopeId, actionDigest);
    if (!found) return { pending: this.pending(this.open(input, actionDigest, now)) };
    let current = verifyApproval(found, this.integrity);
    if (current.status === 'pending' && now >= current.request.expiresAt) current = expireApproval(this.store, this.integrity, current);
    if (current.status === 'pending') return { pending: this.pending(current) };
    if (current.status === 'expired') throw new ApprovalError('APPROVAL_EXPIRED');
    const stored = current.decision!;
    if (stored.decision !== 'allow') throw new ApprovalError('APPROVAL_DENIED');
    if (stored.requestDigest !== approvalRequestDigest(current.request)) throw new ApprovalError('APPROVAL_INTEGRITY');
    // Another process may have decided on a clock ahead of this one; only the bounded skew is tolerated (I40), never a window extension.
    if (stored.decidedAt > now + MAX_WALL_SKEW_MS) throw new ApprovalError('APPROVAL_CONFLICT');
    if (now > stored.decidedAt + this.options.admitWithinMs) throw new ApprovalError('APPROVAL_EXPIRED');
    return { approved: { approvalId: current.request.approvalId, actionDigest } };
  }

  private open(input: ConfigChangeApprovalRequest, actionDigest: string, now: number): ApprovalRecord {
    const request = approvalRequestSchema.parse({ schemaVersion: 3, approvalId: randomUUID(), scopeId: input.scopeId, subject: input.subject, requester: input.requester,
      actionDigest, policyRevision: input.policyRevision, summary: input.summary.slice(0, 2048), createdAt: now, expiresAt: now + this.options.requestTtlMs,
      facts: configChangeApprovalFacts(input.policy, input.scopeId) });
    // `create` is idempotent on the digest: a concurrent open of the same change returns the one stored request.
    return verifyApproval(this.store.create(sealApproval({ request, revision: 0, status: 'pending', decision: null }, this.integrity)), this.integrity);
  }

  private pending(record: ApprovalRecord) {
    return { approvalId: record.request.approvalId, revision: record.revision, expiresAt: record.request.expiresAt, summary: record.request.summary };
  }
}

/** First runtime protocol version whose approval records may carry the `config-change` subject (T3 L2; the integration raises the protocol to it). */
export const CONFIG_CHANGE_SUBJECT_PROTOCOL_VERSION = 22;
