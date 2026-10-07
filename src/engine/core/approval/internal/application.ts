import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { identitySchema, counterSchema, approvalRequestSchema, approvalSubject, ApprovalError, commandEnvelopeSchema, encodeCommandProjection, evaluatePolicy, policySchema,
  separationOfDutiesViolation, type ApprovalRequest, type ApprovalRecord, type AuditEvent, type VerifiedPrincipal } from '#domain/index.js';
import { sha256, type TrustedClock, type IntegrityAuthority } from '#platform/index.js';
import { authenticate, authenticateSession, assertSessionActive, DECISION_CAPABILITY_PATTERN, type ApprovalAssuranceProducer, type PrincipalVerifier, type SessionVerifier,
  type SessionAuthority } from '#engine/core/authentication/index.js';
import { PolicyAuthorizationError, authorityRefusalAuditEvent, type PolicySource } from '#engine/core/policy/index.js';
import type { OperationCatalog } from '#engine/core/effect/index.js';
import type { ApprovalStore, ApprovalSubjectKind, ApprovalSettlement } from './store.js';
import { approvalRequestDigest, expireApproval, verifyApproval, sealApproval } from './integrity.js';
import { approvalAssuranceRegistry, requiredApprovalAssurance } from './assurance.js';

export const approvalQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, approvalId: identitySchema }).strict();
export const approvalListSchema = approvalQuerySchema.omit({ approvalId: true }).extend({ afterId: identitySchema.nullable(), limit: counterSchema.positive() });
/** v19 (B1): `channel` is the surface the client declares (recorded, never authority); `decisionCapability` is the one-time capability an agent
 * turn sent on its own stream. There is no assurance field: a client cannot claim one (strict schema → `APPROVAL_INVALID`). */
const onceApprovalCommandSchema = approvalQuerySchema.extend({ commandId: identitySchema, expectedRevision: counterSchema,
  decision: z.enum(['allow', 'deny']), reason: z.string().min(1).max(2048).refine(v => v.trim() === v), channel: identitySchema.optional(),
  decisionCapability: z.string().regex(DECISION_CAPABILITY_PATTERN).optional(),
  /** v21 APPROVER-NOTE: `reason` is the decider's own words (sealed; a tool-call turn gives it to the model as the approver's note). */
  approverNote: z.literal(true).optional() }).strict();
export const approvalCommandSchema = z.union([onceApprovalCommandSchema, onceApprovalCommandSchema.extend({ decision: z.literal('allow'), standing: z.literal('session') }).strict()]);
export const approvalRenewalSchema = onceApprovalCommandSchema.omit({ decision: true, channel: true, decisionCapability: true, approverNote: true });
export type ApprovalCommand = z.infer<typeof approvalCommandSchema>;
export function authorizeApproval(policy: unknown, action: 'inspect' | 'decide' | 'renew', scopeId: string, id: string, principal: VerifiedPrincipal) {
  const decision = evaluatePolicy(policy, { principal, scopeId, action, resource: { kind: 'approval', id } }).decision;
  // C12 Q8: outside the operation catalog there is no approval broker yet; require-approval must not silently collapse into denial.
  if (decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
  if (decision !== 'allow') throw new ApprovalError('APPROVAL_DENIED');
}
export function approvalCommandFingerprint(tag: string, command: z.infer<typeof approvalRenewalSchema> | ApprovalCommand, actor: VerifiedPrincipal | { id: string; issuer: string; subject: string }) {
  const envelope = commandEnvelopeSchema.parse({ schemaVersion: 1, commandId: command.commandId, scopeId: command.scopeId,
    principalRef: { id: actor.id, issuer: actor.issuer, subject: actor.subject }, expectedRevision: command.expectedRevision, idempotencyKeyHash: sha256(command.commandId) });
  return sha256(encodeCommandProjection(tag, { envelope, approvalId: command.approvalId, reason: command.reason,
    ...('decision' in command ? { decision: command.decision } : {}), ...('standing' in command ? { standing: command.standing } : {}),
    ...('approverNote' in command && command.approverNote ? { approverNote: true } : {}) }));
}
/**
 * Which approvals this decision surface may allow (POLICY-HARDEN K3). Approvals of an operation whose descriptor is `surface: 'authority'`
 * (`policy.administer@1`) are decided only where the composition names the authority surface (`/policy`, later); every other approval
 * surface — SDK, CLI, the terminal's y/N card — is refused with `APPROVAL_SURFACE_RESTRICTED` and the request stays
 * pending (a deny only withdraws a request and stays open). `refused` records that refusal (audit is best-effort here: it never turns
 * the refusal into something else).
 */
export interface ApprovalDecisionRestriction { readonly catalog: OperationCatalog; readonly surface?: 'authority'; readonly refused?: (event: AuditEvent) => void | Promise<void> }
/**
 * B1 evidence of this decision path: the assurance producers the service holds (its turn capability ring; Enterprise's own), the registered
 * channel ids a client may declare (absent: any id), and the socket peer's process (null: an in-process SDK call, never turn-bound).
 */
export interface ApprovalAssuranceOptions { readonly producers?: readonly ApprovalAssuranceProducer[]; readonly channels?: ReadonlySet<string>; readonly peerPid?: number | null }
export class ApprovalApplication {
  constructor(private readonly store: ApprovalStore, private readonly verifier: PrincipalVerifier,
    private readonly sessions: SessionVerifier & SessionAuthority, private readonly policy: PolicySource,
    private readonly integrity: IntegrityAuthority, private readonly clock: TrustedClock,
    private readonly channel: string, private readonly pageLimit: number, private readonly beforeCommit: (record: ApprovalRecord) => void = () => undefined,
    private readonly restriction?: ApprovalDecisionRestriction, private readonly assurance: ApprovalAssuranceOptions = {}) {
    identitySchema.parse(channel); counterSchema.positive().parse(pageLimit);
  }
  private async authorize(action: 'inspect' | 'decide' | 'renew', scopeId: string, id: string, principal: VerifiedPrincipal) {
    const policy = policySchema.parse(await this.policy.load());
    authorizeApproval(policy, action, scopeId, id, principal);
    return policy;
  }
  private async assertDecidableHere(record: ApprovalRecord, actor: { readonly issuer: string; readonly subject: string }) {
    const { restriction } = this, subject = approvalSubject(record.request);
    if (!restriction || restriction.surface === 'authority' || subject.kind !== 'operation') return;
    if ((await restriction.catalog.resolve(subject.operation))?.surface !== 'authority') return;
    try {
      await restriction.refused?.(authorityRefusalAuditEvent({ scopeId: record.request.scopeId, principal: actor, atMs: this.clock.sample().wallMs, policyRevision: record.request.policyRevision,
        stage: 'decide', code: 'APPROVAL_SURFACE_RESTRICTED', operation: subject.operation, commandId: subject.commandId, approvalId: record.request.approvalId, decider: null }));
    } catch { /* the refusal stands without its audit record */ }
    throw new ApprovalError('APPROVAL_SURFACE_RESTRICTED');
  }
  private expired(record: ApprovalRecord, now: number) {
    // I40-c B: only the producing turn judges tool-call expiry, through its wall clock and monotonic TTL.
    // A decision is durable history; the producer still checks expiry before consuming it at the effect claim.
    if (approvalSubject(record.request).kind === 'agent-tool-call' || record.status !== 'pending' || now < record.request.expiresAt) return record;
    return expireApproval(this.store, this.integrity, record);
  }
  async inspect(input: unknown, credential?: unknown) {
    const query = approvalQuerySchema.parse(input); const principal = await authenticate(this.verifier, credential, query.scopeId);
    await this.authorize('inspect', query.scopeId, query.approvalId, principal);
    const record = this.store.load(query.scopeId, query.approvalId);
    return record ? verifyApproval(record, this.integrity) : null;
  }
  /** `view.excludeSubjects` narrows the page selection itself (never a post-filter): a page of `limit` visible records after `afterId`. */
  async list(input: unknown, credential?: unknown, view: { readonly excludeSubjects?: readonly ApprovalSubjectKind[] } = {}) {
    const query = approvalListSchema.parse(input); const principal = await authenticate(this.verifier, credential, query.scopeId);
    if (query.limit > this.pageLimit) throw new ApprovalError('APPROVAL_INVALID');
    // List permission is explicit, never an inference from a grant on one specific approval.
    await this.authorize('inspect', query.scopeId, query.scopeId, principal);
    return this.store.list(query.scopeId, query.afterId, query.limit, view.excludeSubjects ?? []).map(row => verifyApproval(row, this.integrity));
  }
  async renew(input: unknown, ttlMs: number, credential?: unknown) {
    const command = approvalRenewalSchema.parse(input);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ApprovalError('APPROVAL_INVALID');
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.scopeId);
    const policy = await this.authorize('renew', command.scopeId, command.approvalId, verified.principal);
    await assertSessionActive(verified.session, this.sessions, this.clock);
    const actor = verified.session.principalRef;
    const fingerprint = approvalCommandFingerprint('approval-renewal:1', command, actor);
    const replay = this.store.receipt(command.scopeId, command.commandId);
    if (replay) {
      if (replay.operation !== 'renew' || replay.fingerprint !== fingerprint) throw new ApprovalError('APPROVAL_CONFLICT');
      return verifyApproval(replay.record, this.integrity);
    }
    const current = this.store.load(command.scopeId, command.approvalId); if (!current) throw new ApprovalError('APPROVAL_MISSING');
    await assertSessionActive(verified.session, this.sessions, this.clock);
    const now = this.clock.sample().wallMs;
    const previous = this.expired(verifyApproval(current, this.integrity), now);
    if (previous.request.policyRevision !== policy.revision) throw new ApprovalError('APPROVAL_STALE');
    if (previous.revision !== command.expectedRevision) throw new ApprovalError('APPROVAL_CONFLICT');
    const next = sealApproval({ request: { ...previous.request, approvalId: randomUUID(), createdAt: now, expiresAt: now + ttlMs,
      renewal: { previousApprovalId: previous.request.approvalId, commandId: command.commandId, commandDigest: fingerprint, actor, reason: command.reason } },
      revision: 0, status: 'pending', decision: null }, this.integrity);
    this.beforeCommit(next);
    return this.store.renew(previous, next, { operation: 'renew', scopeId: command.scopeId, commandId: command.commandId, fingerprint, record: next });
  }
  async decide(input: unknown, credential?: unknown) {
    return (await this.decideWithSettlement(input, credential)).record;
  }
  /** Trusted producer result: exactly one decision owner; settlement is supplied by the atomic store transaction. */
  async decideWithSettlement(input: unknown, credential?: unknown, sessionGuard?: (record: ApprovalRecord, actor: VerifiedPrincipal) => void): Promise<ApprovalSettlement> {
    const parsed = approvalCommandSchema.safeParse(input); if (!parsed.success) throw new ApprovalError('APPROVAL_INVALID');
    const command = parsed.data, { channels } = this.assurance;
    if (command.channel !== undefined && channels && !channels.has(command.channel)) throw new ApprovalError('APPROVAL_INVALID');
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    await this.authorize('decide', command.scopeId, command.approvalId, principal);
    const loaded = this.store.load(command.scopeId, command.approvalId); if (!loaded) throw new ApprovalError('APPROVAL_MISSING');
    let record = verifyApproval(loaded, this.integrity);
    if ('standing' in command && approvalSubject(record.request).kind !== 'agent-tool-call') throw new ApprovalError('APPROVAL_INVALID');
    const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    if (command.decision === 'allow') await this.assertDecidableHere(record, actor);
    const fingerprint = approvalCommandFingerprint('approval-command:1', command, actor);
    const replay = this.store.receipt(command.scopeId, command.commandId);
    // A replay returns the exact receipt; it never issues a new authorization or reopens the request.
    if (replay) {
      if (replay.operation !== 'decide' || replay.fingerprint !== fingerprint) throw new ApprovalError('APPROVAL_CONFLICT');
      const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.scopeId);
      if (JSON.stringify(verified.session.principalRef) !== JSON.stringify(actor)) throw new ApprovalError('APPROVAL_DENIED');
      return { record: verifyApproval(replay.record, this.integrity), commit: 'replay' };
    }
    record = this.expired(record, this.clock.sample().wallMs);
    if (record.status === 'expired') throw new ApprovalError('APPROVAL_EXPIRED');
    if (record.status !== 'pending' || record.revision !== command.expectedRevision) throw new ApprovalError('APPROVAL_CONFLICT');
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.scopeId);
    if (JSON.stringify(verified.session.principalRef) !== JSON.stringify(actor)) throw new ApprovalError('APPROVAL_DENIED');
    const policy = await this.authorize('decide', command.scopeId, command.approvalId, verified.principal);
    // Four-eyes (policy v2 data, C12 Q6): the session-verified decider may not approve a request it made; withdrawing it grants nothing.
    if (command.decision === 'allow' && separationOfDutiesViolation(policy, { scopeId: command.scopeId, requester: record.request.requester,
      decider: verified.session.principalRef }) !== null) throw new ApprovalError('APPROVAL_DENIED');
    await assertSessionActive(verified.session, this.sessions, this.clock);
    const now = this.clock.sample().wallMs;
    record = this.expired(record, now);
    if (record.status === 'expired') throw new ApprovalError('APPROVAL_EXPIRED');
    // B1: the service derives the assurance from evidence it holds; an allow below the minimum (Core's, raised by policy) is refused and the
    // request stays pending. A deny needs no minimum (withdrawing grants nothing). A single-use capability is spent only after the commit.
    const registry = approvalAssuranceRegistry(this.assurance.producers);
    const attested = registry.derive({ scopeId: command.scopeId, approvalId: command.approvalId, decider: verified.session.principalRef, peerPid: this.assurance.peerPid ?? null,
      capability: command.decisionCapability ?? null, nowMs: now });
    if (command.decision === 'allow' && attested.rank < registry.rank(requiredApprovalAssurance(policy, record.request, registry))) throw new ApprovalError('APPROVAL_ASSURANCE_INSUFFICIENT');
    const decision = { schemaVersion: 2 as const, commandId: command.commandId, decision: command.decision, actor, sessionId: verified.session.sessionId,
      // Another process may have created the request at a later wall time than this host's (stepped-back) clock reports;
      // the decision certainly happened after creation, so it is never recorded earlier than it.
      channel: command.channel ?? this.channel, reason: command.reason, decidedAt: Math.max(now, record.request.createdAt), requestDigest: approvalRequestDigest(record.request),
      commandDigest: fingerprint, idempotencyKeyHash: sha256(command.commandId), assurance: attested.level, ...(command.approverNote ? { approverNote: true as const } : {}) };
    const next = sealApproval({ request: record.request, revision: 1, status: 'decided', decision }, this.integrity);
    this.beforeCommit(next);
    if ('standing' in command) {
      if (approvalSubject(record.request).kind !== 'agent-tool-call' || !sessionGuard) throw new ApprovalError('APPROVAL_INVALID');
      sessionGuard(record, verified.principal);
    }
    const committed = this.store.transitionWithSettlement(record, next, { scopeId: command.scopeId, commandId: command.commandId, fingerprint, record: next });
    // A competing caller can win after our receipt miss. Only this transaction's fresh commit spends B1 evidence.
    const settled = { record: verifyApproval(committed.record, this.integrity), commit: committed.commit };
    if (settled.commit === 'fresh') attested.settle();
    return settled;
  }
}
/** Producer-only trusted port. No surface accepts caller-authored action bindings or request timestamps. */
export function requestTaskApproval(store: ApprovalStore, integrity: IntegrityAuthority,
  input: Omit<Extract<ApprovalRequest, { schemaVersion: 1 }>, 'schemaVersion' | 'approvalId'>) {
  const existing = store.find(input.scopeId, input.runId, input.taskId, input.actionDigest);
  if (existing) return verifyApproval(existing, integrity);
  const request = approvalRequestSchema.parse({ schemaVersion: 1, approvalId: randomUUID(), ...input });
  return verifyApproval(store.create(sealApproval({ request, revision: 0, status: 'pending', decision: null }, integrity)), integrity);
}
