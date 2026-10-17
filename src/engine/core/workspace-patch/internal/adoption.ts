import type { EffectConfirmation } from '#engine/core/effect/index.js';
import { unconfirmedEffect } from './confirmation-default.js';
import { deliverySummary } from './effect-summary.js';
import { clientCommandIdSchema } from '#domain/index.js';
import { z } from 'zod';
import { identitySchema, attemptIdentitySchema, type RunSnapshot } from '#domain/index.js';
import { EMPTY_KNOWN_SECRETS, type KnownSecretSnapshot, type TrustedClock } from '#platform/index.js';
import { authenticateSession, assertSessionActive, type SessionVerifier, type SessionAuthority } from '#engine/core/authentication/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import type { IntegrationDeliveryPlan, IntegrationDeliveryRecord, IntegrationDeliveryTarget } from './delivery.js';
import { WorkspaceAdoptionError, type WorkspaceAdoptionErrorCode } from './adoption-error.js';
import { adoptionVerificationSchema, verifyAdoption, type AdoptionVerification, type AdoptionVerificationPolicy,
  type AdoptionVerificationStore } from './verification.js';
export { WorkspaceAdoptionError, type WorkspaceAdoptionErrorCode };
/** One owner of "this delivery is usable": completed in the ledger and its dedicated reference still names the delivered commit.
 * A reference moved to another commit is the target's PATCH_CONFLICT; everything else is ADOPTION_NOT_DELIVERED. */
export async function requireDelivered(store: Pick<IntegrationAdoptionStore, 'findDelivery'>, deliveries: Pick<IntegrationDeliveryTarget, 'delivered'>,
  scopeId: string, deliveryCommandId: string, belongs: (delivery: IntegrationDeliveryRecord) => boolean = () => true): Promise<IntegrationDeliveryRecord> {
  const delivery = await store.findDelivery(scopeId, deliveryCommandId);
  if (!delivery?.delivered || !belongs(delivery) || !await deliveries.delivered(delivery.intent.plan)) throw new WorkspaceAdoptionError('ADOPTION_NOT_DELIVERED');
  return delivery;
}
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const adoptionTargetRefSchema = z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/);
/** v2 (B06-2b): an adoption may name the verification Run of the delivered commit and the task kind it verifies — both or neither. */
export const integrationAdoptionCommandSchema = z.object({ schemaVersion: z.literal(2), commandId: clientCommandIdSchema,
  identity: attemptIdentitySchema, deliveryCommandId: identitySchema, targetRef: adoptionTargetRefSchema,
  verificationRunId: identitySchema.optional(), verificationKind: identitySchema.optional() }).strict()
  .refine(command => (command.verificationRunId === undefined) === (command.verificationKind === undefined), 'ADOPTION_VERIFICATION_INCOMPLETE').readonly();
export type IntegrationAdoptionCommand = z.infer<typeof integrationAdoptionCommandSchema>;
export const integrationRollbackCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  identity: attemptIdentitySchema, adoptionCommandId: identitySchema }).strict().readonly();
export type IntegrationRollbackCommand = z.infer<typeof integrationRollbackCommandSchema>;
const actorSchema = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict();
/** Evidence basis of an adoption. `task-acceptance` = the attempt's recorded Task acceptance (process-exit criteria today);
 * it is not a verification run of the adopted commit. Verification is the separate, optional `verification` binding (v2). */
export const adoptionBasisSchema = z.literal('task-acceptance');
const move = { targetRef: adoptionTargetRefSchema, fromCommit: oid, toCommit: oid };
export const integrationAdoptionIntentSchema = z.discriminatedUnion('kind', [
  z.object({ schemaVersion: z.literal(2), kind: z.literal('adopt'), command: integrationAdoptionCommandSchema, ...move,
    deliveryRef: z.string().regex(/^refs\/deckent\/deliveries\/[a-f0-9]{64}$/), basis: adoptionBasisSchema,
    acceptance: z.object({ runRevision: z.number().int().nonnegative() }).strict(), verification: adoptionVerificationSchema.nullable(),
    actor: actorSchema }).strict(),
  z.object({ schemaVersion: z.literal(1), kind: z.literal('rollback'), command: integrationRollbackCommandSchema, ...move,
    actor: actorSchema }).strict(),
]).refine(intent => intent.kind === 'rollback' || (intent.verification === null ? intent.command.verificationRunId === undefined
  : intent.verification.runId === intent.command.verificationRunId && intent.verification.kind === intent.command.verificationKind
    && intent.verification.commit === intent.toCommit), 'ADOPTION_VERIFICATION_INCONSISTENT').readonly();
export type IntegrationAdoptionIntent = z.infer<typeof integrationAdoptionIntentSchema>;
/** `sequence` is the per-repository, per-target fence assigned by the store when the intent is claimed. `released`: settled as not applied
 * (proven by observation, never by an error code). `repository` is the physical repository the intent was claimed in; null for an intent
 * recorded before repository identity existed (ledger v58), whose repository only its fence chain can attribute. */
export interface IntegrationAdoptionRecord { readonly intent: IntegrationAdoptionIntent; readonly sequence: number; readonly settled: boolean;
  readonly released?: boolean; readonly repository?: string | null }
/** The repository and fence an intent is claimed against, as the target observed them. */
export type AdoptionClaimObservation = Pick<AdoptionTargetObservation, 'repository' | 'fence'>;
export interface IntegrationAdoptionStore extends AdoptionVerificationStore {
  findDelivery(scopeId: string, commandId: string): Promise<IntegrationDeliveryRecord | null>;
  loadRun(scopeId: string, runId: string): Promise<RunSnapshot | null>;
  loadAdoption(scopeId: string, commandId: string): Promise<IntegrationAdoptionRecord | null>;
  /** Serializes per repository and target: refuses while an intent on it is unsettled (ADOPTION_TARGET_BUSY), when the repository's fence
   * does not name the journal's latest applied record there (ADOPTION_FENCE_MISMATCH; no fence = no record), and a rollback unless its
   * adoption is settled and still that latest record (ADOPTION_SUPERSEDED). */
  claimAdoption(intent: IntegrationAdoptionIntent, observed: AdoptionClaimObservation): Promise<IntegrationAdoptionRecord>;
  /** The claim's busy and fence-agreement refusals without writing anything (the queue runs it before publication). */
  assertAdoptionFence(targetRef: string, observed: AdoptionClaimObservation): Promise<void>;
  finishAdoption(intent: IntegrationAdoptionIntent): Promise<IntegrationAdoptionRecord>;
  /** Settles an unsettled intent as not applied (idempotent). Callers prove non-application first (`adoptionNotApplied`). */
  releaseAdoption(intent: IntegrationAdoptionIntent): Promise<IntegrationAdoptionRecord>;
}
/** Which journal record last moved a target: the per-target sequence and its command. */
export interface AdoptionFence { readonly sequence: number; readonly scopeId: string; readonly commandId: string }
/** `repository`: the physical repository identity (see `adoptionRepositoryIdentity`); a re-clone is a new repository with its own chain.
 * `legacyBinding`: the same repository's queue binding as builds before QUEUE-SMALL 2 recorded it (`legacyQueueBinding`); it only lets a
 * ticket bound then be recognized, never establishes a new identity. */
export interface AdoptionTargetObservation { readonly tip: string | null; readonly checkedOut: boolean; readonly fence: AdoptionFence | null; readonly repository: string;
  readonly legacyBinding?: string }
export interface IntegrationAdoptionTarget {
  observe(targetRef: string): Promise<AdoptionTargetObservation>;
  /** One atomic transaction: the branch moves `fromCommit`→`toCommit` and the target's fence moves `expected`→`next`, or nothing
   * changes. A stale caller whose expected fence is no longer current cannot move the branch. Never touches an index, worktree or HEAD. */
  move(targetRef: string, fromCommit: string, toCommit: string, expected: AdoptionFence | null, next: AdoptionFence): Promise<void>;
}
/** v2: `verified` only when the adoption bound an accepted verification Run of this exact commit (see adoptionVerificationSchema). */
type AdoptionResult = Readonly<{ schemaVersion: 2; status: 'adopted' | 'rolled-back'; command: IntegrationAdoptionCommand | IntegrationRollbackCommand;
  targetRef: string; fromCommit: string; toCommit: string; sequence: number; basis: 'task-acceptance';
  verification: Readonly<{ status: 'not-verified' }> | Readonly<{ status: 'verified' } & AdoptionVerification>; application: 'branch-reference' }>;

const sameFence = (a: AdoptionFence | null, b: AdoptionFence) => a !== null && a.sequence === b.sequence && a.scopeId === b.scopeId && a.commandId === b.commandId;
/** A Deckent branch move provably did not happen. No journal record: never claimed, so never moved, whatever the tip (every move claims
 * first, and a target with a queue generation refuses an unfenced adoption). With a record: the branch still names `fromCommit` and the
 * repository's fence names another record (the move advances branch and fence in one Git transaction), the intent is unsettled or already
 * released, and the observation comes from the repository the intent was claimed in (Astra 2616 F1). That is the recorded repository, or —
 * for a pre-v58 intent, which recorded none — `claimedIn`: the binding of the repository the caller independently knows the claim was
 * made in (a queue ticket's revalidated target binding). Without such evidence nothing counts as not applied: the state of another
 * repository proves nothing about the one that may have moved. The caller holds the target's current physical generation. */
export function adoptionNotApplied(observed: AdoptionTargetObservation, record: IntegrationAdoptionRecord | null, fromCommit: string, claimedIn: string | null = null): boolean {
  if (!record) return true;
  if (observed.tip !== fromCommit) return false;
  const { intent } = record, mine = sameFence(observed.fence, { sequence: record.sequence, scopeId: intent.command.identity.scopeId, commandId: intent.command.commandId });
  const here = record.repository != null ? record.repository === observed.repository
    : claimedIn !== null && (claimedIn === observed.repository || claimedIn === observed.legacyBinding);
  return !mine && !record.settled && intent.fromCommit === fromCommit && here;
}
/** Moves a configured, not-checked-out branch to a delivered commit, or back to its previous tip. Never writes the live checkout,
 * never accepts a Task, and claims verification only through a bound, accepted verification Run of the delivered commit. Deckent's own commands are fenced through the target's fence reference;
 * Git writers outside Deckent are not fenced (a foreign move turns into a conflict, never into attributed success). */
export class WorkspaceAdoptionApplication {
  constructor(private readonly store: IntegrationAdoptionStore, private readonly deliveries: Pick<IntegrationDeliveryTarget, 'delivered'>,
    private readonly target: IntegrationAdoptionTarget, private readonly allowedTargets: readonly string[],
    private readonly sessions: SessionVerifier & SessionAuthority, private readonly authorization: DispatchIdentityAuthorization,
    private readonly clock: TrustedClock, private readonly verification: AdoptionVerificationPolicy, private readonly confirmation: EffectConfirmation = unconfirmedEffect, private readonly known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS) {}

  async adopt(input: unknown, credential?: unknown): Promise<AdoptionResult> {
    const command = integrationAdoptionCommandSchema.parse(input);
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.identity.scopeId);
    const authorize = () => this.authorization.authorizeIdentity('adopt-integration', command.identity, verified.principal);
    await authorize();
    if (!this.allowedTargets.includes(command.targetRef)) throw new WorkspaceAdoptionError('ADOPTION_TARGET_DENIED');
    const settle = async () => { await authorize(); await assertSessionActive(verified.session, this.sessions, this.clock); };
    const previous = await this.resume(command.identity.scopeId, command.commandId, verified.session.principalRef, command, settle);
    if (previous) return previous;
    const delivery = await requireDelivered(this.store, this.deliveries, command.identity.scopeId, command.deliveryCommandId,
      record => JSON.stringify(record.intent.command.identity) === JSON.stringify(command.identity));
    const run = await this.accepted(command);
    const plan: IntegrationDeliveryPlan = delivery.intent.plan;
    const baseCommit = plan.schemaVersion === 2 ? plan.effectiveBaseCommit : plan.baseCommit;
    const verification = await verifyAdoption(this.store, this.verification, verified.principal, { scopeId: command.identity.scopeId,
      commit: plan.commit, ...(command.verificationRunId === undefined ? {} : { runId: command.verificationRunId }),
      ...(command.verificationKind === undefined ? {} : { kind: command.verificationKind }) });
    await this.ready(command.targetRef, baseCommit, 'ADOPTION_BASE_CHANGED');
    const intent = integrationAdoptionIntentSchema.parse({ schemaVersion: 2, kind: 'adopt', command, targetRef: command.targetRef,
      fromCommit: baseCommit, toCommit: plan.commit, deliveryRef: plan.ref, basis: 'task-acceptance',
      acceptance: { runRevision: run.revision }, verification, actor: verified.session.principalRef });
    if (intent.kind !== 'adopt') throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
    const confirm = await this.confirmAdoption(intent, run);
    await settle(); await confirm(); await this.accepted(command);
    const observed = await this.ready(command.targetRef, baseCommit, 'ADOPTION_BASE_CHANGED');
    return this.apply(await this.store.claimAdoption(intent, observed), settle, confirm);
  }

  async rollback(input: unknown, credential?: unknown): Promise<AdoptionResult> {
    const command = integrationRollbackCommandSchema.parse(input);
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.identity.scopeId);
    const authorize = () => this.authorization.authorizeIdentity('rollback-integration', command.identity, verified.principal);
    await authorize();
    const settle = async () => { await authorize(); await assertSessionActive(verified.session, this.sessions, this.clock); };
    const previous = await this.resume(command.identity.scopeId, command.commandId, verified.session.principalRef, command, settle);
    if (previous) return previous;
    const adopted = await this.store.loadAdoption(command.identity.scopeId, command.adoptionCommandId);
    if (!adopted || adopted.intent.kind !== 'adopt' || !adopted.settled
      || JSON.stringify(adopted.intent.command.identity) !== JSON.stringify(command.identity)) throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
    if (!this.allowedTargets.includes(adopted.intent.targetRef)) throw new WorkspaceAdoptionError('ADOPTION_TARGET_DENIED');
    await this.ready(adopted.intent.targetRef, adopted.intent.toCommit, 'ADOPTION_TARGET_MOVED');
    const intent = integrationAdoptionIntentSchema.parse({ schemaVersion: 1, kind: 'rollback', command, targetRef: adopted.intent.targetRef,
      fromCommit: adopted.intent.toCommit, toCommit: adopted.intent.fromCommit, actor: verified.session.principalRef });
    if (intent.kind !== 'rollback') throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
    // TESLIM-GUVENLIK: moving the branch back is a branch move too — the same verified human y/N as adoption, before the journal claim.
    const confirm = await this.confirmRollback(intent);
    await settle(); await confirm();
    const observed = await this.ready(intent.targetRef, intent.fromCommit, 'ADOPTION_TARGET_MOVED');
    return this.apply(await this.store.claimAdoption(intent, observed), settle, confirm);
  }

  /** Replay or crash settlement of an existing command, decided by exact fence ownership (see apply). */
  private async resume(scopeId: string, commandId: string, actor: unknown, command: IntegrationAdoptionCommand | IntegrationRollbackCommand,
    settle: () => Promise<void>): Promise<AdoptionResult | null> {
    const previous = await this.store.loadAdoption(scopeId, commandId);
    if (!previous) return null;
    if (JSON.stringify(previous.intent.command) !== JSON.stringify(command) || JSON.stringify(previous.intent.actor) !== JSON.stringify(actor)) {
      throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
    }
    if (previous.released) throw new WorkspaceAdoptionError('ADOPTION_RELEASED');
    if (previous.settled) return this.result(previous);
    return this.apply(previous, settle);
  }

  /** The target's fence names the last record that moved it. If it is this record, the effect already happened (crash before
   * settle) and the record only settles. A new effect needs the fence of the previous sequence, the branch at `fromCommit`, the
   * target still allow-listed and not checked out; the move then advances branch and fence together. Anything else — including an
   * external writer that placed `toCommit` — is a conflict, never an attributed success. */
  private async apply(record: IntegrationAdoptionRecord, settle: () => Promise<void>, confirmed?: () => Promise<void>): Promise<AdoptionResult> {
    if (record.settled) return this.result(record);
    const { intent } = record;
    const mine: AdoptionFence = { sequence: record.sequence, scopeId: intent.command.identity.scopeId, commandId: intent.command.commandId };
    const observed = await this.target.observe(intent.targetRef);
    if (!sameFence(observed.fence, mine)) {
      // Astra 2616 F2: a new move happens only in the repository the intent was claimed in (a pre-v58 intent recorded none, so never).
      if (record.repository !== observed.repository) throw new WorkspaceAdoptionError('ADOPTION_REPOSITORY_CHANGED');
      if (!this.allowedTargets.includes(intent.targetRef)) throw new WorkspaceAdoptionError('ADOPTION_TARGET_DENIED');
      if (observed.checkedOut) throw new WorkspaceAdoptionError('ADOPTION_TARGET_CHECKED_OUT');
      const previous = observed.fence === null ? record.sequence === 1 : observed.fence.sequence === record.sequence - 1;
      if (!previous || observed.tip !== intent.fromCommit) throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
      // Every new branch move (adoption or rollback, also a resumed unfinished one) needs its own human answer.
      const confirm = confirmed ?? (intent.kind === 'adopt' ? await this.confirmAdoption(intent, await this.accepted(intent.command)) : await this.confirmRollback(intent));
      await settle(); await confirm(); if (intent.kind === 'adopt') await this.accepted(intent.command);
      // Human think time may have changed target custody; re-observe the same physical repository through the existing fenced CAS.
      if ((await this.ready(intent.targetRef, intent.fromCommit, 'ADOPTION_CONFLICT')).repository !== record.repository) throw new WorkspaceAdoptionError('ADOPTION_REPOSITORY_CHANGED');
      await this.target.move(intent.targetRef, intent.fromCommit, intent.toCommit, observed.fence, mine);
    }
    await settle();
    return this.result(await this.store.finishAdoption(intent));
  }

  private async confirmAdoption(intent: Extract<IntegrationAdoptionIntent, { kind: 'adopt' }>, run: RunSnapshot) {
    await this.confirmation.assertAvailable();
    return this.confirmation.confirm({ operation: 'adopt-integration', scopeId: intent.command.identity.scopeId,
      commandId: intent.command.commandId, actor: intent.actor, resource: intent.targetRef, from: intent.fromCommit, to: intent.toCommit,
      runId: intent.command.identity.runId, taskId: intent.command.identity.taskId, ...deliverySummary(run, intent.command.identity, undefined, this.known) });
  }

  private async confirmRollback(intent: Extract<IntegrationAdoptionIntent, { kind: 'rollback' }>) {
    await this.confirmation.assertAvailable();
    const { identity } = intent.command, run = await this.store.loadRun(identity.scopeId, identity.runId);
    if (!run) throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
    return this.confirmation.confirm({ operation: 'rollback-integration', scopeId: identity.scopeId, commandId: intent.command.commandId,
      actor: intent.actor, resource: intent.targetRef, from: intent.fromCommit, to: intent.toCommit, runId: identity.runId, taskId: identity.taskId,
      ...deliverySummary(run, identity, undefined, this.known) });
  }

  private async accepted(command: IntegrationAdoptionCommand): Promise<RunSnapshot> {
    const run = await this.store.loadRun(command.identity.scopeId, command.identity.runId);
    const task = run?.progress.find(entry => entry.taskId === command.identity.taskId);
    const binding = run?.bindings.find(entry => entry.identity.taskId === command.identity.taskId);
    // Acceptance must belong to this exact attempt; another attempt's acceptance never adopts this delivery.
    if (!run || task?.phase !== 'accepted' || JSON.stringify(binding?.identity) !== JSON.stringify(command.identity)) {
      throw new WorkspaceAdoptionError('ADOPTION_NOT_ACCEPTED');
    }
    return run;
  }

  private async ready(targetRef: string, expectedTip: string, moved: WorkspaceAdoptionErrorCode) {
    const observed = await this.target.observe(targetRef);
    if (observed.tip === null) throw new WorkspaceAdoptionError('ADOPTION_TARGET_MISSING');
    if (observed.checkedOut) throw new WorkspaceAdoptionError('ADOPTION_TARGET_CHECKED_OUT');
    if (observed.tip !== expectedTip) throw new WorkspaceAdoptionError(moved);
    return observed;
  }

  private result(record: IntegrationAdoptionRecord): AdoptionResult {
    const { intent } = record;
    const verification = intent.kind === 'adopt' && intent.verification ? Object.freeze({ status: 'verified' as const, ...intent.verification })
      : Object.freeze({ status: 'not-verified' as const });
    return Object.freeze({ schemaVersion: 2, status: intent.kind === 'adopt' ? 'adopted' : 'rolled-back', command: intent.command,
      targetRef: intent.targetRef, fromCommit: intent.fromCommit, toCommit: intent.toCommit, sequence: record.sequence,
      basis: 'task-acceptance', verification, application: 'branch-reference' });
  }
}
