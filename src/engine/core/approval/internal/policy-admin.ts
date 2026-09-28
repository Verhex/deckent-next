import { AUTHORITY_DOCUMENT_TARGET_KIND, POLICY_ADMINISTER_OPERATION, ApprovalError, authorityDocuments, delegationWithin, describePolicyChange, planPolicyChange,
  effectCommandSchema, policyChangeSchema, PolicyChangeError, policySchema, resolvePolicyBindings, type ApprovalActor, type DelegatedRule, type EffectCommand, type EffectTargetRef, type OperationDescriptor, type Policy,
  type PolicyChangePlan, type VerifiedPrincipal } from '#domain/index.js';
import type { IntegrityAuthority, TrustedClock } from '#platform/index.js';
import { authenticateSession, type SessionAuthority, type SessionVerifier } from '#engine/core/authentication/index.js';
import { AuthorityChangeError, authorityChangeAuditEvent, authorityRefusalAuditEvent, chainAuthorityRevision, type AuthorityDocumentStore, type PermissionModeAudit, type PolicySource } from '#engine/core/policy/index.js';
import { EffectApplication, EffectTargetError, OperationPolicyAuthorization, type EffectAdmission, type EffectApplyRequest, type EffectApprovalContext,
  type EffectApprovalGate, type EffectOutcome, type EffectStore, type EffectTarget } from '#engine/core/effect/index.js';
import type { ApprovalStore } from './store.js';
import { verifyApproval } from './integrity.js';
import { OperationApprovalBroker } from './operation.js';

/** Refusal codes of an authority submission that are audited (transient or unknown-outcome failures are not refusals). */
const AUDITED_REFUSALS: ReadonlySet<string> = new Set(['POLICY_DELEGATION_EXCEEDS', 'POLICY_DENIED', 'POLICY_CHANGE_INVALID', 'EFFECT_REJECTED',
  'EFFECT_PRECONDITION_CHANGED', 'APPROVAL_DENIED', 'APPROVAL_EXPIRED', 'APPROVAL_STALE']);
/** What the approval gate learned about this submission, for the target that writes inside the store's lock. */
interface AuthoritySubmission { requester?: VerifiedPrincipal; decider?: ApprovalActor; approvalId?: string; inputDigest?: string }
export interface AuthorityTargetHooks {
  /** Throws when the touched rules exceed the bounding principal's authority on exactly this snapshot. */
  bound(snapshot: Policy, touched: readonly DelegatedRule[]): void;
  /** Records the applied change before any file changes (no record, no change). */
  audit(change: { readonly before: string; readonly after: string; readonly counts: PolicyChangePlan['counts'] }): void;
}
const refuse = (cause?: unknown): never => { throw new EffectTargetError('EFFECT_TARGET_REJECTED', cause === undefined ? undefined : { cause }); };

/**
 * The installation's authority documents as the C11 target of `policy.administer@1` (record id `installation`, version = the effective
 * `policy+bindings` revision). `apply` runs entirely inside the authority store's conditional write: the snapshot must still be the
 * expected revision (else precondition), the change must plan on it, the delegation bound is checked again on exactly those bytes, the
 * audit event is written, and only then are the documents (with chained `a-` revisions) replaced, keyed by the wire key for `lookup`.
 */
export class AuthorityDocumentTarget implements EffectTarget {
  readonly kind = AUTHORITY_DOCUMENT_TARGET_KIND;
  constructor(private readonly store: AuthorityDocumentStore & PolicySource, private readonly hooks: AuthorityTargetHooks) {}
  identity() { return this.store.identity(); }
  private record(ref: EffectTargetRef) { if (ref.kind !== this.kind || ref.id !== 'installation') refuse(); }
  async observe(ref: EffectTargetRef) { this.record(ref); return { version: policySchema.parse(await this.store.load()).revision }; }
  async apply(request: EffectApplyRequest): Promise<{ readonly version: string }> {
    this.record(request.target);
    const expected = request.expectedVersion ?? refuse();
    try {
      return await this.store.updateAuthority(snapshot => {
        if (snapshot.bindings === null) refuse();
        let current: Policy, plan: PolicyChangePlan;
        try { current = resolvePolicyBindings(snapshot.policy, snapshot.bindings); } catch (error) { return refuse(error); }
        if (current.revision !== expected) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
        try { plan = planPolicyChange(snapshot.policy, snapshot.bindings, request.input); } catch (error) { return refuse(error); }
        const files = authorityDocuments(current) as { readonly policy: { readonly revision: string }; readonly bindings: { readonly revision: string } };
        const policy = plan.policy && { ...plan.policy, revision: chainAuthorityRevision('authority-policy:1', 'a', files.policy.revision, plan.policy) };
        const bindings = plan.bindings && { ...plan.bindings, revision: chainAuthorityRevision('authority-bindings:1', 'a', files.bindings.revision, plan.bindings) };
        const after = `${(policy ?? files.policy).revision}+${(bindings ?? files.bindings).revision}`;
        try { this.hooks.bound(current, plan.touched); this.hooks.audit({ before: current.revision, after, counts: plan.counts }); } catch (error) { return refuse(error); }
        return { write: { policy, bindings, order: plan.order }, result: { version: after } };
      }, request.idempotencyKey);
    } catch (error) {
      if (error instanceof EffectTargetError) throw error;
      // A conflict found before the first rename left nothing behind (a changed precondition); anything later, or any other failure, may
      // have replaced one file: only the keyed archive record decides (C11 lookup), never a blind resend.
      if (error instanceof AuthorityChangeError && error.code === 'POLICY_CONFLICT' && error.detail !== 'partial') throw new EffectTargetError('EFFECT_TARGET_PRECONDITION', { cause: error });
      throw new EffectTargetError('EFFECT_TARGET_UNKNOWN', { cause: error });
    }
  }
  async lookup(_ref: EffectTargetRef, idempotencyKey: string) { return this.store.lookupAuthority(idempotencyKey); }
}

/**
 * I3 — the bound is carried by whoever decided (POLICY-ADMIN P3). Wraps the operation approval broker: when an admission carries the
 * approval (fresh, or the one the claimed intent consumed), the sealed record is loaded and its decider taken. Before the first claim the
 * bound is checked on the current policy and a decider without the authority is refused (`POLICY_DELEGATION_EXCEEDS`, nothing claimed);
 * the target checks it again inside the write lock on the exact snapshot it replaces (a claimed command is refused there, terminally, so
 * a lost authority never leaves the authority record busy).
 */
export class DelegationBoundGate implements EffectApprovalGate {
  constructor(private readonly inner: EffectApprovalGate, private readonly approvals: ApprovalStore, private readonly integrity: IntegrityAuthority,
    private readonly policy: PolicySource, private readonly submission: AuthoritySubmission) {}
  async admit(descriptor: OperationDescriptor, decision: 'allow' | 'require-approval', command: EffectCommand, principal: VerifiedPrincipal,
    context: EffectApprovalContext): Promise<EffectAdmission | void> {
    const admission = await this.inner.admit(descriptor, decision, command, principal, context);
    if (!admission || !('approval' in admission)) return admission;
    const loaded = this.approvals.load(command.scopeId, admission.approval.approvalId);
    const stored = loaded ? verifyApproval(loaded, this.integrity).decision : null;
    if (!stored || stored.decision !== 'allow') throw new ApprovalError('APPROVAL_CONFLICT');
    Object.assign(this.submission, { requester: principal, decider: stored.actor, approvalId: admission.approval.approvalId, inputDigest: context.inputDigest });
    if (context.record === null) {
      const current = policySchema.parse(await this.policy.load());
      const files = authorityDocuments(current);
      const verdict = delegationWithin(current, stored.actor, planPolicyChange(files.policy, files.bindings, command.input).touched);
      if (!verdict.ok) throw new AuthorityChangeError('POLICY_DELEGATION_EXCEEDS', `${verdict.ruleId}:${verdict.reason}`);
    }
    return admission;
  }
}

export interface PolicyAdministrationDependencies {
  readonly authority: AuthorityDocumentStore & PolicySource; readonly policy: PolicySource; readonly effects: EffectStore; readonly approvals: ApprovalStore;
  readonly integrity: IntegrityAuthority; readonly sessions: SessionVerifier & SessionAuthority; readonly clock: TrustedClock; readonly requestTtlMs: number;
  readonly audit: PermissionModeAudit;
}
/**
 * The authority producer of `policy.administer@1` (POLICY-ADMIN P3): the only `EffectApplication` constructed with `surface: 'authority'`.
 * One submission = the C11/C12 flow of every catalog operation — the first submission opens the approval (the card; `approval:
 * 'required'`, never silent), the same command resubmitted after an `allow` claims the intent and applies once — plus the delegation bound
 * of the decider and the `authority-change` audit event. Surfaces (`/policy`, `deckent policy`, protocol v17) are a later slice.
 */
export class PolicyAdministrationApplication {
  constructor(private readonly deps: PolicyAdministrationDependencies) {}
  async submit(input: unknown, credential?: unknown): Promise<EffectOutcome> {
    const { deps } = this;
    const command = effectCommandSchema.parse(input);
    const submission: AuthoritySubmission = {};
    const previous = await deps.effects.loadEffect(command.scopeId, command.commandId);
    try { return await this.run(command, submission, credential); }
    catch (error) {
      // A replay of a command already refused terminally is the same refusal, not a new event; anything else that stops here is recorded.
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && AUDITED_REFUSALS.has(code) && previous?.state !== 'refused') {
        // `settle`: the command had claimed its intent (now or before) — the refusal came at the effect, not before any intent.
        const stopped = (await deps.effects.loadEffect(command.scopeId, command.commandId))?.state;
        await this.auditRefusal(command, submission, code, previous?.state === 'claimed' || stopped === 'refused' ? 'settle' : 'submit', credential);
      }
      throw error;
    }
  }
  /** Best-effort: the refusal stands with or without its audit record (a refusal changes nothing to protect by failing differently). */
  private async auditRefusal(command: EffectCommand, submission: AuthoritySubmission, code: string, stage: 'submit' | 'settle', credential: unknown) {
    const { deps } = this;
    try {
      const principal = submission.requester ?? (await authenticateSession(deps.sessions, deps.sessions, deps.clock, credential, command.scopeId)).principal;
      deps.audit(authorityRefusalAuditEvent({ scopeId: command.scopeId, principal, atMs: deps.clock.sample().wallMs, policyRevision: (await deps.policy.load() as Policy).revision,
        stage, code, operation: command.operation, commandId: command.commandId, approvalId: submission.approvalId ?? null, decider: submission.decider ?? null }));
    } catch { /* see above */ }
  }
  private run(command: EffectCommand, submission: AuthoritySubmission, credential?: unknown): Promise<EffectOutcome> {
    const { deps } = this;
    // The typed, bounded change set is checked before anything is asked: an invalid input never opens a card. Snapshot-dependent checks
    // (an id that exists, a known role) stay with the plan at the gate and inside the write.
    if (!policyChangeSchema.safeParse(command.input).success) return Promise.reject(new PolicyChangeError('POLICY_CHANGE_INVALID'));
    // The card shows what would change (bounded, redacted, human-readable), computed from the current documents and this exact input.
    const describe = async (asked: EffectCommand, budget: number) => describePolicyChange(authorityDocuments(policySchema.parse(await deps.policy.load())), asked.input, budget);
    const broker = new OperationApprovalBroker(deps.approvals, deps.integrity, deps.policy, deps.clock, { requestTtlMs: deps.requestTtlMs, defaultAdmitWithinMs: deps.requestTtlMs, describe });
    const gate = new DelegationBoundGate(broker, deps.approvals, deps.integrity, deps.policy, submission);
    const target = new AuthorityDocumentTarget(deps.authority, {
      bound(snapshot, touched) {
        const verdict = submission.decider ? delegationWithin(snapshot, submission.decider, touched) : null;
        if (!verdict?.ok) throw new AuthorityChangeError('POLICY_DELEGATION_EXCEEDS', verdict && !verdict.ok ? `${verdict.ruleId}:${verdict.reason}` : null);
      },
      audit(change) {
        const { requester, decider, approvalId, inputDigest } = submission;
        if (!requester || !decider || !approvalId || !inputDigest) throw new ApprovalError('APPROVAL_MISSING');
        deps.audit(authorityChangeAuditEvent({ scopeId: command.scopeId, requester, decider, atMs: deps.clock.sample().wallMs, operation: POLICY_ADMINISTER_OPERATION.operation,
          commandId: command.commandId, approvalId, inputDigest, before: change.before, after: change.after, counts: change.counts }));
      },
    });
    return new EffectApplication({ async resolve(ref) { return ref.id === POLICY_ADMINISTER_OPERATION.operation.id && ref.version === 1 ? POLICY_ADMINISTER_OPERATION : null; } },
      { resolve: kind => kind === AUTHORITY_DOCUMENT_TARGET_KIND ? target : null }, deps.effects, gate, deps.sessions, new OperationPolicyAuthorization(deps.policy), deps.clock,
      { surface: 'authority' }).submit('execute', command, credential);
  }
}
