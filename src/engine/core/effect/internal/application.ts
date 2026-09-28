import { createHash } from 'node:crypto';
import { effectCommandSchema, effectIntentSchema, encodeCommandProjection, EffectError, settleEffect, markEffectUnknown, refuseEffect, assertCompensation,
  evaluatePolicy, policyResources, type EffectCommand, type EffectIntentApproval, type EffectRecord, type EffectTargetRef, type OperationDescriptor, type OperationRef,
  type VerifiedPrincipal } from '#domain/index.js';
import type { TrustedClock } from '#platform/index.js';
import { authenticateSession, assertSessionActive, type SessionVerifier, type SessionAuthority } from '#engine/core/authentication/index.js';
import { PolicyAuthorizationError, type PolicySource } from '#engine/core/policy/index.js';

/** Versioned operation catalog (registry/config data). */
export interface OperationCatalog { resolve(operation: OperationRef): Promise<OperationDescriptor | null> }
/** Failure classes a target reports: the precondition no longer holds (412-like), the request was refused before any effect,
 * or the outcome is unknown (transport/timeout/5xx after sending). */
export class EffectTargetError extends Error {
  constructor(readonly code: 'EFFECT_TARGET_PRECONDITION' | 'EFFECT_TARGET_REJECTED' | 'EFFECT_TARGET_UNKNOWN', options?: ErrorOptions) {
    super(code, options); this.name = 'EffectTargetError';
  }
}
export interface EffectApplyRequest {
  readonly target: EffectTargetRef; readonly operation: OperationRef; readonly idempotencyKey: string;
  readonly expectedVersion: string | null; readonly input: unknown;
}
/** One external system addressed through the effect contract (generic HTTP record service, an ERP adapter, ...). */
export interface EffectTarget {
  readonly kind: string;
  /** Stable identity of the physical service this target addresses (e.g. its normalized endpoint). One kind maps to one
   * identity per installation (validated in config); an unsettled intent is only ever resumed against the same identity. */
  identity(): string;
  observe(target: EffectTargetRef): Promise<{ readonly version: string | null }>;
  /** Conditional, idempotent write. Resolves with the record version after the effect, or throws EffectTargetError. */
  apply(request: EffectApplyRequest): Promise<{ readonly version: string | null }>;
  /** The target's own idempotency record for the key: applied (with version), absent, or null when the target cannot tell. */
  lookup(target: EffectTargetRef, idempotencyKey: string): Promise<{ readonly status: 'applied'; readonly version: string | null } | { readonly status: 'absent' } | null>;
}
export interface EffectTargets { resolve(kind: string): EffectTarget | null }
export interface EffectStore {
  loadEffect(scopeId: string, commandId: string): Promise<EffectRecord | null>;
  /** Records the intent before any effect: the scoped idempotency key maps to one command, and a target with a claimed or unknown
   * intent is busy (EFFECT_TARGET_BUSY) — uncertain effects are reconciled before new ones on the same record. */
  claimEffect(intent: EffectRecord['intent']): Promise<EffectRecord>;
  /** Replaces `previous` with `next` only if the stored record still equals `previous` (compare-and-swap). */
  saveEffect(previous: EffectRecord, next: EffectRecord): Promise<EffectRecord>;
}
type Decision = 'allow' | 'require-approval';
/** Operation-resource authorization that keeps `require-approval` distinct from denial (the approval gate decides what it means). */
export class OperationPolicyAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: typeof policyResources.operation.actions[number], scopeId: string, operation: OperationRef, principal: VerifiedPrincipal): Promise<Decision> {
    let decision;
    try { decision = evaluatePolicy(await this.source.load(), { principal, action, scopeId, resource: { kind: policyResources.operation.kind, id: operation.id } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision === 'deny') throw new PolicyAuthorizationError('POLICY_DENIED');
    return decision.decision;
  }
}
/** The open approval request a pending outcome reports: enough for a surface to decide it and resubmit the same command. */
export type EffectApprovalPendingRequest = Readonly<{ approvalId: string; revision: number; expiresAt: number; summary: string }>;
/** What the gate asks against (C12 G2): the command's stored record (null before the first claim), the descriptor + endpoint binding the
 * intent pins, and the canonical input digest the intent records. A terminal record is replayed, never re-approved. */
export interface EffectApprovalContext { readonly record: EffectRecord | null; readonly targetBinding: string; readonly inputDigest: string }
export type EffectAdmission = { readonly approval: EffectIntentApproval } | { readonly pending: EffectApprovalPendingRequest };
/**
 * Approval gate. Admits (void, or the approval reference the intent will carry), reports the open request as `pending` (nothing is
 * sent and no intent is claimed), or throws a typed refusal. Catalog operations use the operation broker; agent edits/shell use the
 * durable agent-tool-call record of exactly the executed call (C12 G3) — neither admits from in-memory turn state.
 */
export interface EffectApprovalGate {
  admit(descriptor: OperationDescriptor, decision: Decision, command: EffectCommand, principal: VerifiedPrincipal, context: EffectApprovalContext): Promise<EffectAdmission | void>;
}
/** Gate without any operation approval workflow: a required approval stops before the effect (kept for compositions without a broker). */
export const refuseRequiredApproval: EffectApprovalGate = {
  async admit(descriptor, decision) { if (descriptor.approval === 'required' || decision === 'require-approval') throw new EffectError('EFFECT_APPROVAL_REQUIRED'); },
};
/** Settled outcome (contract v1, unchanged byte for byte on every surface). */
export type EffectResult = Readonly<{ schemaVersion: 1; status: 'settled'; commandId: string; scopeId: string; operation: OperationRef; target: EffectTargetRef;
  sequence: number; version: string | null; compensates: string | null; evidence: 'idempotency-record' | 'fence' }>;
/** Pending outcome (contract v2, C12 G2): the command needs a decision on `approval`; nothing was sent and no intent exists for it. The
 * same command (same `commandId`, same input) is resubmitted after an `allow`; a deny or an unused allow is a typed refusal. */
export type EffectApprovalPending = Readonly<{ schemaVersion: 2; status: 'approval-pending'; commandId: string; scopeId: string; operation: OperationRef;
  target: EffectTargetRef; approval: EffectApprovalPendingRequest }>;
export type EffectOutcome = EffectResult | EffectApprovalPending;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const wireKey = (command: EffectCommand) => digest(['effect-key:1', command.scopeId, command.target.kind, command.target.id,
  `${command.operation.id}@${command.operation.version}`, command.idempotencyKey].join('\0'));
const binding = (descriptor: OperationDescriptor, target: EffectTarget) =>
  digest(`effect-binding:1\0${encodeCommandProjection('effect-descriptor', descriptor)}\0${target.identity()}`);
/** Unwinds `run` at the gate with the pending outcome (an outcome, never surfaced as an error). */
class PendingSignal { constructor(readonly outcome: EffectApprovalPending) {} }

/** Executes catalog operations against external targets through one contract: approval before intent, intent before effect, conditional
 * write, idempotency, re-authorization and live session right before the effect, evidence-based settlement, typed unknown without blind
 * retry, and compensation as a new operation. Nothing here is specific to Git or to one ERP. */
export class EffectApplication {
  constructor(private readonly catalog: OperationCatalog, private readonly targets: EffectTargets, private readonly store: EffectStore,
    private readonly approvals: EffectApprovalGate, private readonly sessions: SessionVerifier & SessionAuthority,
    private readonly authorization: OperationPolicyAuthorization, private readonly clock: TrustedClock,
    /** The producer's surface class (POLICY-ADMIN I5-i). Absent: a generic producer, which refuses `surface: 'authority'` operations. */
    private readonly options: { readonly surface?: 'authority' } = {}) {}

  /** Runs to settlement or throws; a pending approval is `EFFECT_APPROVAL_REQUIRED` here (callers that handle pending use `submit`). */
  async execute(input: unknown, credential?: unknown): Promise<EffectResult> { return this.settledOnly(await this.submit('execute', input, credential)); }
  async compensate(input: unknown, credential?: unknown): Promise<EffectResult> { return this.settledOnly(await this.submit('compensate', input, credential)); }
  /** Submits the command: settled, or approval-pending with the open request (nothing sent, no intent). */
  async submit(action: 'execute' | 'compensate', input: unknown, credential?: unknown): Promise<EffectOutcome> {
    const command = effectCommandSchema.parse(input);
    if ((command.compensates !== undefined) !== (action === 'compensate')) throw new EffectError('EFFECT_INVALID');
    try { return await this.run(command, action, credential); }
    catch (error) { if (error instanceof PendingSignal) return error.outcome; throw error; }
  }
  async inspect(scopeId: string, commandId: string, credential?: unknown) {
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, scopeId);
    const record = await this.store.loadEffect(scopeId, commandId);
    if (!record) return null;
    await this.authorization.authorize('inspect', scopeId, record.intent.command.operation, verified.principal);
    return record;
  }
  private settledOnly(outcome: EffectOutcome): EffectResult {
    if (outcome.status !== 'settled') throw new EffectError('EFFECT_APPROVAL_REQUIRED');
    return outcome;
  }

  private async run(command: EffectCommand, action: 'execute' | 'compensate', credential?: unknown): Promise<EffectResult> {
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.scopeId);
    const descriptor = await this.catalog.resolve(command.operation);
    // Before the target, policy, approval or ledger is touched: a generic producer never runs an authority operation, even if some
    // registry made a target of its kind reachable (default-closed; only the authority producer passes `surface: 'authority'`).
    if (descriptor?.surface === 'authority' && this.options.surface !== 'authority') throw new EffectError('OPERATION_SURFACE_RESTRICTED');
    const target = descriptor ? this.targets.resolve(descriptor.targetKind) : null;
    if (!descriptor || !target || descriptor.targetKind !== command.target.kind || target.kind !== descriptor.targetKind) throw new EffectError('EFFECT_OPERATION_UNKNOWN');
    const current = binding(descriptor, target);
    // Policy before any ledger access (no grant → POLICY_DENIED, never a conflict probe); the gate follows once the record is known.
    const policy = () => this.authorization.authorize(action, command.scopeId, command.operation, verified.principal);
    const decision = await policy();
    const previous = await this.store.loadEffect(command.scopeId, command.commandId);
    if (previous && (JSON.stringify(previous.intent.command) !== JSON.stringify(command) || JSON.stringify(previous.intent.actor) !== JSON.stringify(verified.session.principalRef))) {
      throw new EffectError('EFFECT_CONFLICT');
    }
    // A new command fixes its canonical input before any approval is asked: the subject and the intent bind the same digest, and an input
    // the catalog refuses never opens a request. A recorded command keeps the digest its intent pinned (a terminal record replays as is).
    let inputDigest: string;
    if (previous) inputDigest = previous.intent.inputDigest;
    else {
      let encoded: string;
      try { encoded = encodeCommandProjection('effect-input', command.input ?? null); } catch { throw new EffectError('EFFECT_INVALID'); }
      if (Buffer.byteLength(encoded) > descriptor.inputMaxBytes) throw new EffectError('EFFECT_INVALID');
      inputDigest = digest(encoded);
    }
    // The approval gate: a pending approval ends the submission here (or before the effect, see `settle`); nothing is sent.
    const gate = async (decided: Decision, record: EffectRecord | null) => {
      const admission = await this.approvals.admit(descriptor, decided, command, verified.principal, { record, targetBinding: current, inputDigest });
      if (admission && 'pending' in admission) throw new PendingSignal(this.pending(command, admission.pending));
      return admission?.approval;
    };
    await gate(decision, previous);
    const settle = async (record: EffectRecord) => { await gate(await policy(), record); await assertSessionActive(verified.session, this.sessions, this.clock); };
    if (previous) return this.resume(previous, target, settle, current);
    if (action === 'compensate') {
      const original = await this.store.loadEffect(command.scopeId, command.compensates!);
      if (!original) throw new EffectError('EFFECT_NOT_COMPENSABLE');
      assertCompensation(original, command);
    }
    if (descriptor.precondition === 'record-version') {
      if (command.expectedVersion === null) throw new EffectError('EFFECT_INVALID');
      // A stale decision is refused before any intent: the target changed since the caller read it.
      let observed;
      try { observed = await target.observe(command.target); } catch (error) { throw new EffectError('EFFECT_TARGET_UNAVAILABLE', { cause: error }); }
      if (observed.version !== command.expectedVersion) throw new EffectError('EFFECT_PRECONDITION_CHANGED');
    }
    // Approval → intent → effect (owner Q1). The gate is asked again right before the first claim (Astra 2128): the admission window is
    // measured at the claim, after the target observation, so an allow that expired meanwhile claims nothing and sends nothing. The
    // claim carries the approval it consumed; every later pass of this command verifies that record, not a window.
    const approval = await gate(await policy(), null);
    const intent = effectIntentSchema.parse({ schemaVersion: 1, command, descriptor, actor: verified.session.principalRef,
      idempotencyKeyHash: digest(`${command.scopeId}\0${command.idempotencyKey}`), inputDigest, wireKey: wireKey(command), targetBinding: current,
      ...(approval ? { approval } : {}) });
    return this.apply(await this.store.claimEffect(intent), target, settle);
  }

  /** Crash/replay settlement from target evidence: applied → settle; absent → the idempotent write is (re)sent; the target cannot tell →
   * unknown, never a blind retry. Terminal records replay their outcome. */
  private async resume(record: EffectRecord, target: EffectTarget, settle: (record: EffectRecord) => Promise<void>, current: string): Promise<EffectResult> {
    if (record.state === 'settled') return this.result(record);
    if (record.state === 'refused') throw new EffectError(record.refusal!);
    // Never redirect an unsettled effect: a changed descriptor/endpoint (or an older intent without a pinned binding and
    // namespaced key) stops before any send or lookup and is left for operator recovery.
    if (!record.intent.wireKey || record.intent.targetBinding !== current) throw new EffectError('EFFECT_TARGET_CHANGED');
    const found = await this.lookup(target, record);
    if (found?.status === 'applied') return this.result(await this.save(record, settleEffect(record, this.evidence(found.version))));
    if (!found) {
      if (record.state !== 'unknown') await this.save(record, markEffectUnknown(record));
      throw new EffectError('EFFECT_OUTCOME_UNKNOWN');
    }
    return this.apply(record, target, settle);
  }

  private async apply(record: EffectRecord, target: EffectTarget, settle: (record: EffectRecord) => Promise<void>): Promise<EffectResult> {
    const { command } = record.intent;
    try { await settle(record); }
    catch (error) {
      // The grant that admitted this claimed command is gone before anything was sent: a terminal refusal, so the claimed intent never
      // keeps its target record busy (an unknown record might already have an effect and is never refused here).
      if (error instanceof PolicyAuthorizationError && error.code === 'POLICY_DENIED' && record.state === 'claimed') await this.save(record, refuseEffect(record, 'EFFECT_REJECTED'));
      throw error;
    }
    try {
      const applied = await target.apply({ target: command.target, operation: command.operation, idempotencyKey: record.intent.wireKey!,
        expectedVersion: command.expectedVersion, input: command.input ?? null });
      return this.result(await this.save(record, settleEffect(record, this.evidence(applied.version))));
    } catch (error) {
      if (!(error instanceof EffectTargetError)) throw error;
      if (error.code !== 'EFFECT_TARGET_UNKNOWN' && record.state === 'claimed') {
        const refusal = error.code === 'EFFECT_TARGET_PRECONDITION' ? 'EFFECT_PRECONDITION_CHANGED' : 'EFFECT_REJECTED';
        await this.save(record, refuseEffect(record, refusal));
        throw new EffectError(refusal, { cause: error });
      }
      // Sent but unconfirmed (or refused after an earlier unknown attempt): only the target's idempotency record decides.
      const found = await this.lookup(target, record);
      if (found?.status === 'applied') return this.result(await this.save(record, settleEffect(record, this.evidence(found.version))));
      if (record.state !== 'unknown') await this.save(record, markEffectUnknown(record));
      throw new EffectError('EFFECT_OUTCOME_UNKNOWN', { cause: error });
    }
  }

  private async lookup(target: EffectTarget, record: EffectRecord) {
    try { return await target.lookup(record.intent.command.target, record.intent.wireKey!); } catch { return null; }
  }
  private evidence(version: string | null) { return { kind: 'idempotency-record' as const, version, observedAt: this.clock.sample().wallMs }; }
  /** Compare-and-swap; a concurrent identical replay that lost the race returns the durable outcome the winner recorded. */
  private async save(previous: EffectRecord, next: EffectRecord) {
    try { return await this.store.saveEffect(previous, next); }
    catch (error) {
      if (!(error instanceof EffectError) || error.code !== 'EFFECT_CONFLICT' || next.state !== 'settled') throw error;
      const current = await this.store.loadEffect(previous.intent.command.scopeId, previous.intent.command.commandId);
      if (current?.state === 'settled' && JSON.stringify(current.intent) === JSON.stringify(previous.intent)) return current;
      throw error;
    }
  }
  private pending(command: EffectCommand, approval: EffectApprovalPendingRequest): EffectApprovalPending {
    return Object.freeze({ schemaVersion: 2, status: 'approval-pending', commandId: command.commandId, scopeId: command.scopeId, operation: command.operation,
      target: command.target, approval: Object.freeze({ ...approval }) });
  }
  private result(record: EffectRecord): EffectResult {
    const { command } = record.intent;
    return Object.freeze({ schemaVersion: 1, status: 'settled', commandId: command.commandId, scopeId: command.scopeId, operation: command.operation,
      target: command.target, sequence: record.sequence, version: record.evidence!.version, compensates: command.compensates ?? null, evidence: record.evidence!.kind });
  }
}
