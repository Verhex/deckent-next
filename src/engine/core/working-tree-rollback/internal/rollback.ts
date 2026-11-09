import { z } from 'zod';
import { attemptIdentitySchema, clientCommandIdSchema, identitySchema, sameAttemptIdentity } from '#domain/index.js';
import { EMPTY_KNOWN_SECRETS, ErrorRegistry, type KnownSecretSnapshot, type TrustedClock } from '#platform/index.js';
import { assertSessionActive, authenticateSession, type SessionAuthority, type SessionVerifier } from '#engine/core/authentication/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import type { EffectConfirmation } from '#engine/core/effect/index.js';
import { deliverySummary, patchChangeDigests, WorkspacePatchError, type IntegrationDeliveryPlan, type IntegrationDeliveryStore, type IntegrationDeliveryTarget, type WorkspacePatch } from '#engine/core/workspace-patch-contract/index.js';
import { requireDelivered, type IntegrationAdoptionStore } from '#engine/core/workspace-adoption/index.js';
import { type WorkspacePatchApplication } from '#engine/core/workspace-patch/index.js';

/** L1c (lead 2026-11-05): put back the files one written working-tree delivery (`deliveryCommandId`) replaced. */
export const workingTreeRollbackCommandSchema = z.strictObject({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  identity: attemptIdentitySchema, deliveryCommandId: identitySchema }).readonly();
export type WorkingTreeRollbackCommand = z.infer<typeof workingTreeRollbackCommandSchema>;
/** The working-tree target's undo: the delivered patch's `before` contents back, only while every path still holds its `after` (same lock and writer). */
export interface WorkingTreeRollbackTarget extends Pick<IntegrationDeliveryTarget, 'delivered'> { rollback(plan: IntegrationDeliveryPlan, patch: WorkspacePatch): Promise<readonly string[] | void> }

/**
 * The one owner of a working-tree delivery's rollback. The same authority, session and card as the delivery it undoes (`deliver-integration`; the
 * company lever `deliver-working-tree` is the caller's authorization); the card shows every path going from the delivery's `after` back to its
 * `before`. Only a delivery the ledger and its journal prove written, of this exact attempt and patch, is rolled back. The ledger delivery stays.
 */
export class WorkingTreeRollbackApplication {
  constructor(private readonly patches: Pick<WorkspacePatchApplication, 'preview'>, private readonly target: WorkingTreeRollbackTarget,
    private readonly store: Pick<IntegrationAdoptionStore, 'findDelivery'> & Pick<IntegrationDeliveryStore, 'loadRun'>, private readonly sessions: SessionVerifier & SessionAuthority,
    private readonly authorization: DispatchIdentityAuthorization, private readonly clock: TrustedClock, private readonly confirmation: EffectConfirmation | undefined,
    private readonly known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS) {}
  async rollback(input: unknown, credential?: unknown) {
    const command = workingTreeRollbackCommandSchema.parse(input), identity = command.identity, confirmation = this.confirmation;
    if (!confirmation) throw ErrorRegistry.createError('DELIVERY_INTERACTIVE_REQUIRED'); // an SDK caller has no person at a terminal for the card
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, identity.scopeId);
    const authorize = () => this.authorization.authorizeIdentity('deliver-integration', identity, verified.principal);
    await authorize(); await confirmation.assertAvailable();
    const delivery = await requireDelivered(this.store, this.target, identity.scopeId, command.deliveryCommandId, record => sameAttemptIdentity(record.intent.command.identity, identity));
    const preview = await this.patches.preview(identity, credential), run = await this.store.loadRun(identity.scopeId, identity.runId), plan = delivery.intent.plan;
    if (!run || JSON.stringify(preview.receipt) !== JSON.stringify(delivery.intent.patch)) throw new WorkspacePatchError('PATCH_CORRUPT');
    const summary = deliverySummary(run, identity, preview.patch, this.known);
    const confirm = await confirmation.confirm({ operation: 'rollback-working-tree', scopeId: identity.scopeId, commandId: command.commandId, actor: verified.session.principalRef,
      resource: plan.ref, from: plan.commit, to: plan.schemaVersion === 2 ? plan.effectiveBaseCommit : plan.baseCommit, runId: identity.runId, taskId: identity.taskId,
      ...summary, added: summary.removed, removed: summary.added, changes: patchChangeDigests(preview.patch, 'reverse') });
    await authorize(); await assertSessionActive(verified.session, this.sessions, this.clock); await confirm();
    const setAside = await this.target.rollback(plan, preview.patch);
    return Object.freeze({ schemaVersion: 1 as const, status: 'working-tree-rolled-back' as const, command, plan, paths: summary.files, ...(setAside?.length ? { setAside } : {}) });
  }
}
