import { asPolicy, approvalDecisionClass, approvalDecisionAssurance, requiresPersonProposalDecision, isWorkloadPrincipalRef, samePrincipalRef, approvalRecordSchema, ApprovalError, encodeCommandProjection, type ApprovalRecord, type ApprovalRequest,
  type RunSnapshot, type ApprovalActor } from '#domain/index.js';
import { MAX_WALL_SKEW_MS, sha256, type ClockSample, type IntegrityAuthority } from '#platform/index.js';
import type { ApprovalStore } from './store.js';
export function approvalActionDigest(run: RunSnapshot, taskId: string, actor: ApprovalActor, policyInput: unknown) {
  if (!run.graph.tasks.some(task => task.id === taskId)) throw new ApprovalError('APPROVAL_INVALID');
  return sha256(encodeCommandProjection('task-admission:2', { identity: run.identity, taskId,
    graph: run.graph, execution: run.execution, actor, policy: asPolicy(policyInput) }));
}
export function approvalRequestDigest(request: ApprovalRequest) { return sha256(encodeCommandProjection('approval-request:1', request)); }
function projection(record: Omit<ApprovalRecord, 'mac'>) {
  return encodeCommandProjection('approval-record:1', { request: record.request, revision: record.revision,
    status: record.status, decision: record.decision, keyId: record.keyId });
}
export function sealApproval(record: Omit<ApprovalRecord, 'mac' | 'keyId'>, authority: IntegrityAuthority): ApprovalRecord {
  const signed = { ...record, keyId: authority.keyId };
  const sealed = approvalRecordSchema.safeParse({ ...signed, mac: authority.sign(projection(signed)) });
  if (!sealed.success) throw new ApprovalError('APPROVAL_INVALID');
  return sealed.data;
}
export function verifyApproval(input: unknown, authority: IntegrityAuthority): ApprovalRecord {
  const parsed = approvalRecordSchema.safeParse(input);
  if (!parsed.success || !authority.verify(projection(parsed.data), parsed.data.mac, parsed.data.keyId)) throw new ApprovalError('APPROVAL_INTEGRITY');
  return parsed.data;
}
/** The one pending → expired transition (lazy expiry, tool-call close, service-start sweep): sealed, conditional on `record`. */
export function expireApproval(store: ApprovalStore, integrity: IntegrityAuthority, record: ApprovalRecord): ApprovalRecord {
  return store.transition(record, sealApproval({ request: record.request, revision: record.revision + 1, status: 'expired', decision: null }, integrity));
}
export const expireDue = (store: ApprovalStore, integrity: IntegrityAuthority, record: ApprovalRecord, now: number) =>
  record.status === 'pending' && now >= record.request.expiresAt ? expireApproval(store, integrity, record) : record;
/** The existing sealed person class, never inferred from the declared channel or a legacy decision. */
export const witnessedPersonDecision = (record: ApprovalRecord): boolean => record.decision !== null && approvalDecisionClass(record.decision) === 'human-tty'
  && approvalDecisionAssurance(record.decision) !== 'ai-policy' && !isWorkloadPrincipalRef(record.decision.actor) && !samePrincipalRef(record.decision.actor, record.request.requester);
/**
 * KG4 F2 (S1-D1): why a stored record does not admit its command, or null: not decided, not an allow, a decision on another request, a decider
 * the caller does not accept; then the time. A decision dated beyond the clock skew is a conflict everywhere (owner B2-2; another process may
 * decide on a clock ahead of this one, I40), never a window extension; an allow is usable `window` ms after its decision. A null `at` checks
 * no time (a consumed decision replays whatever the clock says).
 */
export function decidedRefusal(record: ApprovalRecord, at: { readonly now: number; readonly window: number } | null, accepted = true) {
  if (record.status !== 'decided') return 'APPROVAL_EXPIRED' as const;
  const decision = record.decision!;
  if (decision.decision !== 'allow') return 'APPROVAL_DENIED' as const;
  if (decision.requestDigest !== approvalRequestDigest(record.request)) return 'APPROVAL_INTEGRITY' as const;
  if (requiresPersonProposalDecision(record.request) && !witnessedPersonDecision(record)) return 'APPROVAL_DENIED' as const;
  if (!accepted) return 'APPROVAL_DENIED' as const;
  if (at && decision.decidedAt > at.now + MAX_WALL_SKEW_MS) return 'APPROVAL_CONFLICT' as const;
  return at && at.now > decision.decidedAt + at.window ? 'APPROVAL_EXPIRED' as const : null;
}
/** The one expiry rule of a tool-call request (I40-c): ms left until `expiresAt` on the wall clock and of the producer's monotonic TTL from `started`. */
export const agentToolApprovalLeft = (expiresAt: number, started: ClockSample, now: ClockSample) =>
  Math.min(expiresAt - now.wallMs, expiresAt - started.wallMs - (now.monotonicMs - started.monotonicMs));
export function admitDecided(record: ApprovalRecord, at: { readonly now: number; readonly window: number } | null, accepted = true) {
  const refusal = decidedRefusal(record, at, accepted); if (refusal) throw new ApprovalError(refusal);
  return record.decision!;
}
/** The approval reference shape of a principal or requester (X4: compare with `samePrincipalRef` after projecting both sides). */
export const approvalActorRef = ({ id, issuer, subject }: ApprovalActor): ApprovalActor => ({ id, issuer, subject });
