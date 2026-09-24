import { createHash } from 'node:crypto';
import { effectCommandSchema, effectIntentSchema, encodeCommandProjection, EffectError, settleEffect, markEffectUnknown, refuseEffect, assertCompensation,
  evaluatePolicy, policyResources, type EffectCommand, type EffectRecord, type EffectTargetRef, type OperationDescriptor, type OperationRef,
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
/** Approval gate. C11-1 has no operation approval workflow yet: any required approval stops before the effect. */
export interface EffectApprovalGate { admit(descriptor: OperationDescriptor, decision: Decision, command: EffectCommand, principal: VerifiedPrincipal): Promise<void> }
export const refuseRequiredApproval: EffectApprovalGate = {
  async admit(descriptor, decision) { if (descriptor.approval === 'required' || decision === 'require-approval') throw new EffectError('EFFECT_APPROVAL_REQUIRED'); },
};
export type EffectResult = Readonly<{ schemaVersion: 1; status: 'settled'; commandId: string; scopeId: string; operation: OperationRef; target: EffectTargetRef;
  sequence: number; version: string | null; compensates: string | null; evidence: 'idempotency-record' | 'fence' }>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const wireKey = (command: EffectCommand) => digest(['effect-key:1', command.scopeId, command.target.kind, command.target.id,
  `${command.operation.id}@${command.operation.version}`, command.idempotencyKey].join('\0'));
const binding = (descriptor: OperationDescriptor, target: EffectTarget) =>
  digest(`effect-binding:1\0${encodeCommandProjection('effect-descriptor', descriptor)}\0${target.identity()}`);

/** Executes catalog operations against external targets through one contract: intent before effect, conditional write, idempotency,
 * re-authorization and live session right before the effect, evidence-based settlement, typed unknown without blind retry, and
 * compensation as a new operation. Nothing here is specific to Git or to one ERP. */
export class EffectApplication {
  constructor(private readonly catalog: OperationCatalog, private readonly targets: EffectTargets, private readonly store: EffectStore,
    private readonly approvals: EffectApprovalGate, private readonly sessions: SessionVerifier & SessionAuthority,
    private readonly authorization: OperationPolicyAuthorization, private readonly clock: TrustedClock) {}

  execute(input: unknown, credential?: unknown) {
    const command = effectCommandSchema.parse(input);
    if (command.compensates !== undefined) throw new EffectError('EFFECT_INVALID');
    return this.run(command, 'execute', credential);
  }
  async compensate(input: unknown, credential?: unknown) {
    const command = effectCommandSchema.parse(input);
    if (command.compensates === undefined) throw new EffectError('EFFECT_INVALID');
    return this.run(command, 'compensate', credential);
  }
  async inspect(scopeId: string, commandId: string, credential?: unknown) {
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, scopeId);
    const record = await this.store.loadEffect(scopeId, commandId);
    if (!record) return null;
    await this.authorization.authorize('inspect', scopeId, record.intent.command.operation, verified.principal);
    return record;
  }

  private async run(command: EffectCommand, action: 'execute' | 'compensate', credential?: unknown): Promise<EffectResult> {
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.scopeId);
    const descriptor = await this.catalog.resolve(command.operation);
    const target = descriptor ? this.targets.resolve(descriptor.targetKind) : null;
    if (!descriptor || !target || descriptor.targetKind !== command.target.kind || target.kind !== descriptor.targetKind) throw new EffectError('EFFECT_OPERATION_UNKNOWN');
    const authorize = async () => {
      const decision = await this.authorization.authorize(action, command.scopeId, command.operation, verified.principal);
      await this.approvals.admit(descriptor, decision, command, verified.principal);
    };
    await authorize();
    const settle = async () => { await authorize(); await assertSessionActive(verified.session, this.sessions, this.clock); };
    const previous = await this.store.loadEffect(command.scopeId, command.commandId);
    if (previous) {
      if (JSON.stringify(previous.intent.command) !== JSON.stringify(command) || JSON.stringify(previous.intent.actor) !== JSON.stringify(verified.session.principalRef)) {
        throw new EffectError('EFFECT_CONFLICT');
      }
      return this.resume(previous, target, settle, binding(descriptor, target));
    }
    if (action === 'compensate') {
      const original = await this.store.loadEffect(command.scopeId, command.compensates!);
      if (!original) throw new EffectError('EFFECT_NOT_COMPENSABLE');
      assertCompensation(original, command);
    }
    let encoded: string;
    try { encoded = encodeCommandProjection('effect-input', command.input ?? null); } catch { throw new EffectError('EFFECT_INVALID'); }
    if (Buffer.byteLength(encoded) > descriptor.inputMaxBytes) throw new EffectError('EFFECT_INVALID');
    if (descriptor.precondition === 'record-version') {
      if (command.expectedVersion === null) throw new EffectError('EFFECT_INVALID');
      // A stale decision is refused before any intent: the target changed since the caller read it.
      let observed;
      try { observed = await target.observe(command.target); } catch (error) { throw new EffectError('EFFECT_TARGET_UNAVAILABLE', { cause: error }); }
      if (observed.version !== command.expectedVersion) throw new EffectError('EFFECT_PRECONDITION_CHANGED');
    }
    const intent = effectIntentSchema.parse({ schemaVersion: 1, command, descriptor, actor: verified.session.principalRef,
      idempotencyKeyHash: digest(`${command.scopeId}\0${command.idempotencyKey}`), inputDigest: digest(encoded),
      wireKey: wireKey(command), targetBinding: binding(descriptor, target) });
    return this.apply(await this.store.claimEffect(intent), target, settle);
  }

  /** Crash/replay settlement from target evidence: applied → settle; absent → the idempotent write is (re)sent; the target cannot tell →
   * unknown, never a blind retry. Terminal records replay their outcome. */
  private async resume(record: EffectRecord, target: EffectTarget, settle: () => Promise<void>, current: string): Promise<EffectResult> {
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

  private async apply(record: EffectRecord, target: EffectTarget, settle: () => Promise<void>): Promise<EffectResult> {
    const { command } = record.intent;
    await settle();
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
  private result(record: EffectRecord): EffectResult {
    const { command } = record.intent;
    return Object.freeze({ schemaVersion: 1, status: 'settled', commandId: command.commandId, scopeId: command.scopeId, operation: command.operation,
      target: command.target, sequence: record.sequence, version: record.evidence!.version, compensates: command.compensates ?? null, evidence: record.evidence!.kind });
  }
}
