import { z } from 'zod';
import { identitySchema, attemptIdentitySchema, type RunSnapshot } from '#domain/index.js';
import type { TrustedClock } from '#platform/index.js';
import { authenticateSession, assertSessionActive, type SessionVerifier, type SessionAuthority } from '#engine/core/authentication/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import type { IntegrationDeliveryPlan, IntegrationDeliveryRecord, IntegrationDeliveryTarget } from './delivery.js';

export type WorkspaceAdoptionErrorCode = 'ADOPTION_TARGET_DENIED' | 'ADOPTION_TARGET_MISSING' | 'ADOPTION_TARGET_CHECKED_OUT'
  | 'ADOPTION_BASE_CHANGED' | 'ADOPTION_NOT_DELIVERED' | 'ADOPTION_NOT_ACCEPTED' | 'ADOPTION_TARGET_BUSY' | 'ADOPTION_SUPERSEDED'
  | 'ADOPTION_TARGET_MOVED' | 'ADOPTION_CONFLICT' | 'ADOPTION_CORRUPT';
export class WorkspaceAdoptionError extends Error {
  constructor(readonly code: WorkspaceAdoptionErrorCode, options?: ErrorOptions) { super(code, options); this.name = 'WorkspaceAdoptionError'; }
}
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const adoptionTargetRefSchema = z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/);
export const integrationAdoptionCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: identitySchema,
  identity: attemptIdentitySchema, deliveryCommandId: identitySchema, targetRef: adoptionTargetRefSchema }).strict().readonly();
export type IntegrationAdoptionCommand = z.infer<typeof integrationAdoptionCommandSchema>;
export const integrationRollbackCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: identitySchema,
  identity: attemptIdentitySchema, adoptionCommandId: identitySchema }).strict().readonly();
export type IntegrationRollbackCommand = z.infer<typeof integrationRollbackCommandSchema>;
const actorSchema = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict();
/** Evidence basis of an adoption. `task-acceptance` = the attempt's recorded Task acceptance (process-exit criteria today);
 * it is not a verification run of the adopted commit, so an adoption is never reported as verified. */
export const adoptionBasisSchema = z.literal('task-acceptance');
const move = { targetRef: adoptionTargetRefSchema, fromCommit: oid, toCommit: oid };
export const integrationAdoptionIntentSchema = z.discriminatedUnion('kind', [
  z.object({ schemaVersion: z.literal(1), kind: z.literal('adopt'), command: integrationAdoptionCommandSchema, ...move,
    deliveryRef: z.string().regex(/^refs\/deckent\/deliveries\/[a-f0-9]{64}$/), basis: adoptionBasisSchema,
    acceptance: z.object({ runRevision: z.number().int().nonnegative() }).strict(), actor: actorSchema }).strict(),
  z.object({ schemaVersion: z.literal(1), kind: z.literal('rollback'), command: integrationRollbackCommandSchema, ...move,
    actor: actorSchema }).strict(),
]).readonly();
export type IntegrationAdoptionIntent = z.infer<typeof integrationAdoptionIntentSchema>;
/** `sequence` is the per-target fence assigned by the store when the intent is claimed. */
export interface IntegrationAdoptionRecord { readonly intent: IntegrationAdoptionIntent; readonly sequence: number; readonly settled: boolean }
export interface IntegrationAdoptionStore {
  findDelivery(scopeId: string, commandId: string): Promise<IntegrationDeliveryRecord | null>;
  loadRun(scopeId: string, runId: string): Promise<RunSnapshot | null>;
  loadAdoption(scopeId: string, commandId: string): Promise<IntegrationAdoptionRecord | null>;
  /** Serializes per target: refuses while any intent on the target is unsettled (ADOPTION_TARGET_BUSY) and a rollback
   * unless its adoption is settled and still the latest record on the target (ADOPTION_SUPERSEDED). */
  claimAdoption(intent: IntegrationAdoptionIntent): Promise<IntegrationAdoptionRecord>;
  finishAdoption(intent: IntegrationAdoptionIntent): Promise<IntegrationAdoptionRecord>;
}
export interface AdoptionTargetObservation { readonly tip: string | null; readonly checkedOut: boolean }
export interface IntegrationAdoptionTarget {
  observe(targetRef: string): Promise<AdoptionTargetObservation>;
  /** Atomic compare-and-swap of one branch reference; never touches an index, worktree or HEAD. */
  move(targetRef: string, fromCommit: string, toCommit: string): Promise<void>;
}
type AdoptionResult = Readonly<{ schemaVersion: 1; status: 'adopted' | 'rolled-back'; command: IntegrationAdoptionCommand | IntegrationRollbackCommand;
  targetRef: string; fromCommit: string; toCommit: string; sequence: number; basis: 'task-acceptance'; verification: 'not-verified'; application: 'branch-reference' }>;

/** Moves a configured, not-checked-out branch to a delivered commit, or back to its previous tip. Never writes the live checkout,
 * never accepts a Task and never claims verification of the adopted commit. There is no fence against Git writers outside Deckent. */
export class WorkspaceAdoptionApplication {
  constructor(private readonly store: IntegrationAdoptionStore, private readonly deliveries: Pick<IntegrationDeliveryTarget, 'delivered'>,
    private readonly target: IntegrationAdoptionTarget, private readonly allowedTargets: readonly string[],
    private readonly sessions: SessionVerifier & SessionAuthority, private readonly authorization: DispatchIdentityAuthorization,
    private readonly clock: TrustedClock) {}

  async adopt(input: unknown, credential?: unknown): Promise<AdoptionResult> {
    const command = integrationAdoptionCommandSchema.parse(input);
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.identity.scopeId);
    const authorize = () => this.authorization.authorizeIdentity('adopt-integration', command.identity, verified.principal);
    await authorize();
    if (!this.allowedTargets.includes(command.targetRef)) throw new WorkspaceAdoptionError('ADOPTION_TARGET_DENIED');
    const settle = async () => { await authorize(); await assertSessionActive(verified.session, this.sessions, this.clock); };
    const previous = await this.resume(command.identity.scopeId, command.commandId, verified.session.principalRef, command, settle);
    if (previous) return previous;
    const delivery = await this.store.findDelivery(command.identity.scopeId, command.deliveryCommandId);
    if (!delivery?.delivered || JSON.stringify(delivery.intent.command.identity) !== JSON.stringify(command.identity)
      || !await this.deliveries.delivered(delivery.intent.plan)) throw new WorkspaceAdoptionError('ADOPTION_NOT_DELIVERED');
    const run = await this.accepted(command);
    const plan: IntegrationDeliveryPlan = delivery.intent.plan;
    await this.ready(command.targetRef, plan.baseCommit, 'ADOPTION_BASE_CHANGED');
    const intent = integrationAdoptionIntentSchema.parse({ schemaVersion: 1, kind: 'adopt', command, targetRef: command.targetRef,
      fromCommit: plan.baseCommit, toCommit: plan.commit, deliveryRef: plan.ref, basis: 'task-acceptance',
      acceptance: { runRevision: run.revision }, actor: verified.session.principalRef });
    return this.apply(await this.store.claimAdoption(intent), settle);
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
    return this.apply(await this.store.claimAdoption(intent), settle);
  }

  /** Replay or crash settlement of an existing command. A branch tip is shared, so an unsettled intent settles only from tip
   * equality: at `toCommit` it finishes, at `fromCommit` it performs the move, anything else is a conflict. */
  private async resume(scopeId: string, commandId: string, actor: unknown, command: IntegrationAdoptionCommand | IntegrationRollbackCommand,
    settle: () => Promise<void>): Promise<AdoptionResult | null> {
    const previous = await this.store.loadAdoption(scopeId, commandId);
    if (!previous) return null;
    if (JSON.stringify(previous.intent.command) !== JSON.stringify(command) || JSON.stringify(previous.intent.actor) !== JSON.stringify(actor)) {
      throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
    }
    if (previous.settled) return this.result(previous);
    return this.apply(previous, settle);
  }

  private async apply(record: IntegrationAdoptionRecord, settle: () => Promise<void>): Promise<AdoptionResult> {
    if (record.settled) return this.result(record);
    const { intent } = record;
    const observed = await this.target.observe(intent.targetRef);
    if (observed.checkedOut) throw new WorkspaceAdoptionError('ADOPTION_TARGET_CHECKED_OUT');
    if (observed.tip !== intent.toCommit) {
      if (observed.tip !== intent.fromCommit) throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
      await settle();
      await this.target.move(intent.targetRef, intent.fromCommit, intent.toCommit);
    }
    await settle();
    return this.result(await this.store.finishAdoption(intent));
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
  }

  private result(record: IntegrationAdoptionRecord): AdoptionResult {
    const { intent } = record;
    return Object.freeze({ schemaVersion: 1, status: intent.kind === 'adopt' ? 'adopted' : 'rolled-back', command: intent.command,
      targetRef: intent.targetRef, fromCommit: intent.fromCommit, toCommit: intent.toCommit, sequence: record.sequence,
      basis: 'task-acceptance', verification: 'not-verified', application: 'branch-reference' });
  }
}
