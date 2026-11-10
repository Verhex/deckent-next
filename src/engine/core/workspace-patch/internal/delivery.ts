import type { EffectConfirmation } from '#engine/core/effect/index.js';
import { unconfirmedEffect, deliverySummary, patchChangeDigests, WorkspacePatchError, type WorkspacePatch, integrationDeliveryCommandSchema, integrationDeliveryIntentSchema, integrationDeliveryPlanSchema, type IntegrationManifest, type IntegrationDeliveryRecord, type IntegrationDeliveryStore, type IntegrationDeliveryTarget, type IntegrationTarget } from '#engine/core/workspace-patch-contract/index.js';
import { EMPTY_KNOWN_SECRETS, type KnownSecretSnapshot, type TrustedClock } from '#platform/index.js';
import { authenticateSession, assertSessionActive, type SessionVerifier, type SessionAuthority } from '#engine/core/authentication/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { WorkspacePatchApplication } from './application.js';
import { WorkspaceIntegrationInspection } from './inspection.js';
/** Delivers through its target: an immutable Git reference, or (a working-tree target) the patch written into the checkout's files. Never accepts a Task. */
export class WorkspaceDeliveryApplication {
  constructor(private readonly patches: WorkspacePatchApplication, private readonly inspection: WorkspaceIntegrationInspection,
    private readonly candidate: IntegrationTarget, private readonly target: IntegrationDeliveryTarget,
    private readonly store: IntegrationDeliveryStore, private readonly sessions: SessionVerifier & SessionAuthority,
    private readonly authorization: DispatchIdentityAuthorization, private readonly clock: TrustedClock, private readonly confirmation: EffectConfirmation = unconfirmedEffect, private readonly known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS) {}
  private async assertObservation(manifest: IntegrationManifest, patch: WorkspacePatch) {
    const observed = await this.candidate.observe(patch);
    if (observed.head !== (manifest.schemaVersion === 2 ? manifest.effectiveBaseCommit : patch.baseCommit)) throw new WorkspacePatchError('PATCH_BASE_ADVANCED');
    if (observed.digest !== manifest.observation) throw new WorkspacePatchError('PATCH_CONFLICT');
  }
  async deliver(input: unknown, credential?: unknown) {
    const command = integrationDeliveryCommandSchema.parse(input);
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.identity.scopeId);
    const authorize = () => this.authorization.authorizeIdentity('deliver-integration', command.identity, verified.principal);
    await authorize();
    const actor = verified.session.principalRef;
    const previous = await this.store.loadDelivery(command);
    if (previous && JSON.stringify(previous.intent.actor) !== JSON.stringify(actor)) throw new WorkspacePatchError('PATCH_CONFLICT');
    const files = this.target.application === 'working-tree';
    const result = (record: IntegrationDeliveryRecord, setAside: readonly string[] | void = []) => Object.freeze({ schemaVersion: 1 as const, status: files ? 'working-tree-delivered' as const : 'reference-delivered' as const,
      command: record.intent.command, plan: record.intent.plan, manifest: record.intent.manifest, application: files ? 'working-tree' as const : 'reference-only' as const, ...(setAside?.length ? { setAside } : {}) });
    if (previous?.delivered) return result(previous);
    // A crash after atomic Git publication can settle from exact reference custody, without rebuilding or reapplying.
    if (previous && await this.target.delivered(previous.intent.plan)) {
      await authorize(); await assertSessionActive(verified.session, this.sessions, this.clock);
      return result(await this.store.finishDelivery(previous.intent));
    }
    await this.confirmation.assertAvailable();
    const inspected = await this.inspection.inspect({ schemaVersion: 1, identity: command.identity, commandId: command.integrationCommandId }, credential);
    if (!inspected.manifest || !inspected.receipt) throw new WorkspacePatchError('PATCH_INTEGRATION_PENDING');
    const preview = await this.patches.preview(command.identity, credential);
    this.patches.assertScope(preview.scope); // K6 enforce: refused before the delivery intent or any Git reference is written
    await this.candidate.verify(inspected.manifest, preview.patch);
    if (JSON.stringify(inspected.manifest.patch) !== JSON.stringify(preview.receipt)) throw new WorkspacePatchError('PATCH_CORRUPT');
    await this.assertObservation(inspected.manifest, preview.patch);
    const run = await this.store.loadRun(command.identity.scopeId, command.identity.runId);
    if (!run) throw new WorkspacePatchError('PATCH_CORRUPT');
    const summary = deliverySummary(run, command.identity, preview.patch, this.known);
    const plan = previous?.intent.plan ?? integrationDeliveryPlanSchema.parse(await this.target.plan(command, inspected.manifest, preview.patch,
      { title: summary.title, acceptance: summary.acceptance, deliveredAtMs: this.clock.sample().wallMs }));
    const confirm = await this.confirmation.confirm({ operation: 'deliver-integration', scopeId: command.identity.scopeId,
      commandId: command.commandId, actor, resource: plan.ref,
      from: plan.schemaVersion === 2 ? plan.effectiveBaseCommit : plan.baseCommit, to: plan.commit,
      runId: command.identity.runId, taskId: command.identity.taskId, ...summary,
      ...(files ? { changes: patchChangeDigests(preview.patch, 'forward') } : {}) });
    await authorize(); await assertSessionActive(verified.session, this.sessions, this.clock); await confirm();
    const intent = integrationDeliveryIntentSchema.parse({ schemaVersion: 1, command, manifest: inspected.receipt, patch: preview.receipt, plan, actor });
    const claimed = await this.store.claimDelivery(intent);
    if (claimed.delivered) return result(claimed);
    await this.candidate.verify(inspected.manifest, preview.patch);
    await this.assertObservation(inspected.manifest, preview.patch);
    await authorize(); await assertSessionActive(verified.session, this.sessions, this.clock);
    await confirm();
    const setAside = await this.target.publish(plan, inspected.manifest, preview.patch);
    return result(await this.store.finishDelivery(intent), setAside);
  }
}
