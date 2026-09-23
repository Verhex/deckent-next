import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { identitySchema, counterSchema, approvalRequestSchema, ApprovalError, commandEnvelopeSchema, encodeCommandProjection, evaluatePolicy, policySchema,
  type ApprovalRequest, type ApprovalRecord, type VerifiedPrincipal } from '#domain/index.js';
import { sha256, type TrustedClock, type IntegrityAuthority } from '#platform/index.js';
import { authenticate, authenticateSession, assertSessionActive, type PrincipalVerifier, type SessionVerifier, type SessionAuthority } from '#engine/core/authentication/index.js';
import type { PolicySource } from '#engine/core/policy/index.js';
import type { ApprovalStore } from './store.js';
import { approvalRequestDigest, verifyApproval, sealApproval } from './integrity.js';

export const approvalQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, approvalId: identitySchema }).strict();
export const approvalListSchema = approvalQuerySchema.omit({ approvalId: true }).extend({ afterId: identitySchema.nullable(), limit: counterSchema.positive() });
export const approvalCommandSchema = approvalQuerySchema.extend({ commandId: identitySchema, expectedRevision: counterSchema,
  decision: z.enum(['allow', 'deny']), reason: z.string().min(1).max(2048).refine(v => v.trim() === v) }).strict();
export const approvalRenewalSchema = approvalCommandSchema.omit({ decision: true });
export type ApprovalCommand = z.infer<typeof approvalCommandSchema>;
export function authorizeApproval(policy: unknown, action: 'inspect' | 'decide' | 'renew', scopeId: string, id: string, principal: VerifiedPrincipal) {
  if (evaluatePolicy(policy, { principal, scopeId, action, resource: { kind: 'approval', id } }).decision !== 'allow') throw new ApprovalError('APPROVAL_DENIED');
}
function commandFingerprint(tag: string, command: z.infer<typeof approvalRenewalSchema> | ApprovalCommand, actor: VerifiedPrincipal | { id: string; issuer: string; subject: string }) {
  const envelope = commandEnvelopeSchema.parse({ schemaVersion: 1, commandId: command.commandId, scopeId: command.scopeId,
    principalRef: { id: actor.id, issuer: actor.issuer, subject: actor.subject }, expectedRevision: command.expectedRevision, idempotencyKeyHash: sha256(command.commandId) });
  return sha256(encodeCommandProjection(tag, { envelope, approvalId: command.approvalId, reason: command.reason,
    ...('decision' in command ? { decision: command.decision } : {}) }));
}
export class ApprovalApplication {
  constructor(private readonly store: ApprovalStore, private readonly verifier: PrincipalVerifier,
    private readonly sessions: SessionVerifier & SessionAuthority, private readonly policy: PolicySource,
    private readonly integrity: IntegrityAuthority, private readonly clock: TrustedClock,
    private readonly channel: string, private readonly pageLimit: number, private readonly beforeCommit: (record: ApprovalRecord) => void = () => undefined) { identitySchema.parse(channel); counterSchema.positive().parse(pageLimit); }
  private async authorize(action: 'inspect' | 'decide' | 'renew', scopeId: string, id: string, principal: VerifiedPrincipal) {
    const policy = policySchema.parse(await this.policy.load());
    authorizeApproval(policy, action, scopeId, id, principal);
    return policy;
  }
  private expired(record: ApprovalRecord, now: number) {
    if (record.status !== 'pending' || now < record.request.expiresAt) return record;
    return this.store.transition(record, sealApproval({ request: record.request, revision: 1, status: 'expired', decision: null }, this.integrity));
  }
  async inspect(input: unknown, credential?: unknown) {
    const query = approvalQuerySchema.parse(input); const principal = await authenticate(this.verifier, credential, query.scopeId);
    await this.authorize('inspect', query.scopeId, query.approvalId, principal);
    const record = this.store.load(query.scopeId, query.approvalId);
    return record ? verifyApproval(record, this.integrity) : null;
  }
  async list(input: unknown, credential?: unknown) {
    const query = approvalListSchema.parse(input); const principal = await authenticate(this.verifier, credential, query.scopeId);
    if (query.limit > this.pageLimit) throw new ApprovalError('APPROVAL_INVALID');
    // List permission is explicit, never an inference from a grant on one specific approval.
    await this.authorize('inspect', query.scopeId, query.scopeId, principal);
    return this.store.list(query.scopeId, query.afterId, query.limit).map(row => verifyApproval(row, this.integrity));
  }
  async renew(input: unknown, ttlMs: number, credential?: unknown) {
    const command = approvalRenewalSchema.parse(input);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ApprovalError('APPROVAL_INVALID');
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.scopeId);
    const policy = await this.authorize('renew', command.scopeId, command.approvalId, verified.principal);
    await assertSessionActive(verified.session, this.sessions, this.clock);
    const actor = verified.session.principalRef;
    const fingerprint = commandFingerprint('approval-renewal:1', command, actor);
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
    const parsed = approvalCommandSchema.safeParse(input); if (!parsed.success) throw new ApprovalError('APPROVAL_INVALID');
    const command = parsed.data;
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    await this.authorize('decide', command.scopeId, command.approvalId, principal);
    const loaded = this.store.load(command.scopeId, command.approvalId); if (!loaded) throw new ApprovalError('APPROVAL_MISSING');
    let record = verifyApproval(loaded, this.integrity);
    const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    const fingerprint = commandFingerprint('approval-command:1', command, actor);
    const replay = this.store.receipt(command.scopeId, command.commandId);
    // A replay returns the exact receipt; it never issues a new authorization or reopens the request.
    if (replay) {
      if (replay.operation !== 'decide' || replay.fingerprint !== fingerprint) throw new ApprovalError('APPROVAL_CONFLICT');
      const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.scopeId);
      if (JSON.stringify(verified.session.principalRef) !== JSON.stringify(actor)) throw new ApprovalError('APPROVAL_DENIED');
      return verifyApproval(replay.record, this.integrity);
    }
    record = this.expired(record, this.clock.sample().wallMs);
    if (record.status === 'expired') throw new ApprovalError('APPROVAL_EXPIRED');
    if (record.status !== 'pending' || record.revision !== command.expectedRevision) throw new ApprovalError('APPROVAL_CONFLICT');
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.scopeId);
    if (JSON.stringify(verified.session.principalRef) !== JSON.stringify(actor)) throw new ApprovalError('APPROVAL_DENIED');
    await this.authorize('decide', command.scopeId, command.approvalId, verified.principal);
    await assertSessionActive(verified.session, this.sessions, this.clock);
    const now = this.clock.sample().wallMs;
    record = this.expired(record, now);
    if (record.status === 'expired') throw new ApprovalError('APPROVAL_EXPIRED');
    const decision = { commandId: command.commandId, decision: command.decision, actor, sessionId: verified.session.sessionId,
      // Another process may have created the request at a later wall time than this host's (stepped-back) clock reports;
      // the decision certainly happened after creation, so it is never recorded earlier than it.
      channel: this.channel, reason: command.reason, decidedAt: Math.max(now, record.request.createdAt), requestDigest: approvalRequestDigest(record.request),
      commandDigest: fingerprint, idempotencyKeyHash: sha256(command.commandId) };
    const next = sealApproval({ request: record.request, revision: 1, status: 'decided', decision }, this.integrity);
    this.beforeCommit(next);
    return this.store.transition(record, next, { scopeId: command.scopeId, commandId: command.commandId, fingerprint, record: next });
  }
}
/** Producer-only trusted port. No surface accepts caller-authored action bindings or request timestamps. */
export function requestTaskApproval(store: ApprovalStore, integrity: IntegrityAuthority,
  input: Omit<ApprovalRequest, 'schemaVersion' | 'approvalId'>) {
  const existing = store.find(input.scopeId, input.runId, input.taskId, input.actionDigest);
  if (existing) return verifyApproval(existing, integrity);
  const request = approvalRequestSchema.parse({ schemaVersion: 1, approvalId: randomUUID(), ...input });
  return verifyApproval(store.create(sealApproval({ request, revision: 0, status: 'pending', decision: null }, integrity)), integrity);
}
