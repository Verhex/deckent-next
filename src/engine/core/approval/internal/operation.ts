import { randomUUID } from 'node:crypto';
import { approvalRequestSchema, approvalSubject, encodeCommandProjection, policySchema, ApprovalError, type ApprovalActor, type ApprovalRecord,
  type ApprovalSubject, type EffectCommand, type EffectIntentApproval, type OperationDescriptor, type VerifiedPrincipal } from '#domain/index.js';
import { MAX_WALL_SKEW_MS, sha256, type IntegrityAuthority, type TrustedClock } from '#platform/index.js';
import type { PolicySource } from '#engine/core/policy/index.js';
import type { EffectAdmission, EffectApprovalContext, EffectApprovalGate } from '#engine/core/effect/index.js';
import type { ApprovalStore, ApprovalSubjectKind } from './store.js';
import { approvalRequestDigest, expireApproval, sealApproval, verifyApproval } from './integrity.js';
import { operationApprovalFacts } from './assurance.js';
import { CONFIG_CHANGE_SUBJECT_PROTOCOL_VERSION } from './config-change.js';

type OperationSubject = Extract<ApprovalSubject, { kind: 'operation' }>;
/** The action an operation approval authorizes (C12 G1): this scope, this requester and exactly this command — operation id@version, target
 * record, canonical input digest, descriptor + endpoint binding, expected version and compensation reference. */
export const operationApprovalActionDigest = (scopeId: string, subject: OperationSubject, requester: ApprovalActor) =>
  sha256(encodeCommandProjection('operation-approval:1', { scopeId, subject, requester }));

export interface OperationApprovalBrokerOptions {
  /** Pending request lifetime (`approvals.requestTtlMs`). */
  readonly requestTtlMs: number;
  /** Admission window of an `allow` when the descriptor declares no `admitWithinMs`. */
  readonly defaultAdmitWithinMs: number;
  /** A bounded, redacted, human-readable description of this command for the card (≤ 2048), instead of the default id + digest line; null keeps the default. */
  readonly describe?: (command: EffectCommand, budget: number) => Promise<string | null> | string | null;
}

/**
 * Approval broker for catalog operations (C12 G2): the one `EffectApprovalGate` of SDK/CLI (and later every) operation submission.
 * A `require-approval` decision (policy or `approval: 'required'` descriptor) opens — or finds — the request for exactly this command and
 * reports it as pending; nothing is sent and no intent exists until a stored, verified `allow` admits the same command within its
 * admission window. The intent then pins the approval (its single use); every later pass of that command verifies the pinned record.
 * Producer-only: subject, digest and times come from the engine, never from a caller. Denied, expired or unused approvals are typed
 * refusals; a new command opens its own request (operation approvals are never renewed).
 */
export class OperationApprovalBroker implements EffectApprovalGate {
  constructor(private readonly store: ApprovalStore, private readonly integrity: IntegrityAuthority, private readonly policy: PolicySource,
    private readonly clock: TrustedClock, private readonly options: OperationApprovalBrokerOptions) {
    for (const value of [options.requestTtlMs, options.defaultAdmitWithinMs]) if (!Number.isSafeInteger(value) || value < 1) throw new ApprovalError('APPROVAL_INVALID');
  }

  async admit(descriptor: OperationDescriptor, decision: 'allow' | 'require-approval', command: EffectCommand, principal: VerifiedPrincipal,
    context: EffectApprovalContext): Promise<EffectAdmission | void> {
    if (descriptor.approval !== 'required' && decision === 'allow') return;
    const { record } = context;
    // A terminal record replays its outcome: no approval is read or opened for it.
    if (record && (record.state === 'settled' || record.state === 'refused')) return;
    if (record?.intent.approval) return { approval: this.consumed(record.intent.approval, command) };
    const requester: ApprovalActor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    const subject: OperationSubject = { kind: 'operation', operation: command.operation, target: command.target, commandId: command.commandId,
      inputDigest: context.inputDigest, targetBinding: context.targetBinding, expectedVersion: command.expectedVersion, compensates: command.compensates ?? null };
    const actionDigest = operationApprovalActionDigest(command.scopeId, subject, requester);
    const now = this.clock.sample().wallMs;
    const found = this.store.findOperation(command.scopeId, actionDigest);
    if (!found) return { pending: this.pending(await this.open(descriptor, command, subject, requester, actionDigest, now)) };
    let current = verifyApproval(found, this.integrity);
    if (current.status === 'pending' && now >= current.request.expiresAt) current = expireApproval(this.store, this.integrity, current);
    if (current.status === 'pending') return { pending: this.pending(current) };
    if (current.status === 'expired') throw new ApprovalError('APPROVAL_EXPIRED');
    const stored = current.decision!;
    if (stored.decision !== 'allow') throw new ApprovalError('APPROVAL_DENIED');
    if (stored.requestDigest !== approvalRequestDigest(current.request)) throw new ApprovalError('APPROVAL_INTEGRITY');
    // Another process may have decided on a clock ahead of this one; only the bounded skew is tolerated (I40), never a window extension.
    if (stored.decidedAt > now + MAX_WALL_SKEW_MS) throw new ApprovalError('APPROVAL_CONFLICT');
    if (now > stored.decidedAt + (descriptor.admitWithinMs ?? this.options.defaultAdmitWithinMs)) throw new ApprovalError('APPROVAL_EXPIRED');
    return { approval: { approvalId: current.request.approvalId, actionDigest } };
  }

  /** The approval an intent already consumed: still the sealed `allow` of exactly this command, or a typed refusal. */
  private consumed(reference: EffectIntentApproval, command: EffectCommand): EffectIntentApproval {
    const loaded = this.store.load(command.scopeId, reference.approvalId);
    if (!loaded) throw new ApprovalError('APPROVAL_MISSING');
    const record = verifyApproval(loaded, this.integrity), subject = approvalSubject(record.request);
    if (record.status !== 'decided' || record.decision?.decision !== 'allow' || record.request.actionDigest !== reference.actionDigest
      || subject.kind !== 'operation' || subject.commandId !== command.commandId || record.decision.requestDigest !== approvalRequestDigest(record.request)) {
      throw new ApprovalError('APPROVAL_CONFLICT');
    }
    return reference;
  }

  private async open(descriptor: OperationDescriptor, command: EffectCommand, subject: OperationSubject, requester: ApprovalActor, actionDigest: string, now: number): Promise<ApprovalRecord> {
    let policy: ReturnType<typeof policySchema.parse>;
    try { policy = policySchema.parse(await this.policy.load()); } catch { throw new ApprovalError('APPROVAL_INVALID'); }
    const scopeId = command.scopeId;
    const binding = `${subject.operation.id}@${subject.operation.version} · ${subject.target.kind}/${subject.target.id} · ${subject.inputDigest.slice(0, 12)}`.slice(0, 2048);
    let described: string | null = null;
    try { described = await this.options.describe?.(command, 2048 - binding.length - 1) ?? null; } catch { /* the card shows the binding line only */ }
    // APPROVAL-SURFACE §B: the binding line (operation · target · digest) comes first, so no description can push it off a card.
    const summary = described !== null && described.length > 0 ? `${binding}\n${described}`.slice(0, 2048) : binding;
    const request = approvalRequestSchema.parse({ schemaVersion: 3, approvalId: randomUUID(), scopeId, subject, requester, actionDigest,
      policyRevision: policy.revision, summary, createdAt: now, expiresAt: now + this.options.requestTtlMs, facts: operationApprovalFacts(policy, scopeId, descriptor) });
    // `create` is idempotent on the digest: a concurrent open of the same command returns the one stored request.
    return verifyApproval(this.store.create(sealApproval({ request, revision: 0, status: 'pending', decision: null }, this.integrity)), this.integrity);
  }

  private pending(record: ApprovalRecord) {
    return { approvalId: record.request.approvalId, revision: record.revision, expiresAt: record.request.expiresAt, summary: record.request.summary };
  }
}

/** First runtime protocol version whose approval records may carry the `operation` subject (C12 G4/v15). */
export const OPERATION_SUBJECT_PROTOCOL_VERSION = 15;
/**
 * What a runtime client speaking a released protocol below `OPERATION_SUBJECT_PROTOCOL_VERSION` may receive from an approval query: such a
 * client parses records with the strict schema it shipped with, so an operation-subject record (and, below
 * `CONFIG_CHANGE_SUBJECT_PROTOCOL_VERSION`, a config-change record) would be unparseable for it. Lists omit such approvals; inspecting one is
 * the typed `APPROVAL_MISSING` (for that client the record does not exist). Decisions by id are
 * untouched: the pending outcome names the approval and released clients do not parse a decision's answer strictly.
 */
export function approvalResultForProtocol(version: number, action: 'list' | 'inspect' | 'decide' | 'renew', result: unknown): unknown {
  if (action !== 'inspect' || !result) return result;
  const kind = approvalSubject((result as ApprovalRecord).request).kind;
  if (approvalSubjectsHiddenFromProtocol(version).includes(kind)) throw new ApprovalError('APPROVAL_MISSING');
  return result;
}
/** Subject kinds a client of `version` cannot parse: excluded from list page selection itself (Astra 2128), never filtered after the
 * page was cut, so a page of `limit` is `limit` visible records and its cursor is always a record the client received. */
export function approvalSubjectsHiddenFromProtocol(version: number): readonly ApprovalSubjectKind[] {
  // T3 L2: a client below `CONFIG_CHANGE_SUBJECT_PROTOCOL_VERSION` (alpha.10's v21) cannot parse a config-change record the same way.
  return [...(version >= OPERATION_SUBJECT_PROTOCOL_VERSION ? [] : ['operation' as const]),
    ...(version >= CONFIG_CHANGE_SUBJECT_PROTOCOL_VERSION ? [] : ['config-change' as const])];
}

export type OperationApprovalWait = 'allow' | 'deny' | 'expired' | 'timeout' | 'cancelled';
/**
 * Optional wait of a surface (SDK/terminal) for the decision of one operation approval: `allow`/`deny` as decided, `expired` when the
 * stored request expired (or vanished), `timeout` at `deadline`, `cancelled` on `signal`. The request belongs to the command, not to the
 * waiter: a timed-out or cancelled wait closes nothing (the request stays decidable until its own expiry). Nothing here admits a command;
 * the caller resubmits it and the broker verifies the stored decision.
 */
export async function awaitOperationApproval(store: ApprovalStore, integrity: IntegrityAuthority, key: { readonly scopeId: string; readonly approvalId: string },
  now: () => number, deadline: number, signal?: AbortSignal, pollMs = 250): Promise<OperationApprovalWait> {
  for (;;) {
    const loaded = store.load(key.scopeId, key.approvalId);
    const current = loaded ? verifyApproval(loaded, integrity) : null;
    if (!current || current.status === 'expired') return 'expired';
    if (current.status === 'decided') return current.decision?.decision === 'allow' ? 'allow' : 'deny';
    if (signal?.aborted) return 'cancelled';
    const at = now();
    if (at >= current.request.expiresAt) return 'expired';
    if (at >= deadline) return 'timeout';
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, Math.max(1, Math.min(pollMs, current.request.expiresAt - at, deadline - at)));
      function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
