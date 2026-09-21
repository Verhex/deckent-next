import { z } from 'zod';
import { identitySchema, attemptIdentitySchema } from '#domain/index.js';
import { artifactReceiptSchema } from '#capabilities/index.js';
import type { TrustedClock } from '#platform/index.js';
import { authenticateSession, assertSessionActive, type SessionVerifier, type SessionAuthority } from '#engine/core/authentication/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { WorkspacePatchApplication } from './application.js';
import { WorkspaceIntegrationInspection } from './inspection.js';
import { WorkspacePatchError, type WorkspacePatch } from './contract.js';
import type { IntegrationManifest, IntegrationTarget } from './integration.js';
export const integrationDeliveryCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: identitySchema,
  identity: attemptIdentitySchema, integrationCommandId: identitySchema }).strict().readonly();
export type IntegrationDeliveryCommand = z.infer<typeof integrationDeliveryCommandSchema>;
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const integrationDeliveryPlanSchema = z.object({ schemaVersion: z.literal(1), baseCommit: oid, commit: oid,
  ref: z.string().regex(/^refs\/deckent\/deliveries\/[a-f0-9]{64}$/), snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly();
export type IntegrationDeliveryPlan = z.infer<typeof integrationDeliveryPlanSchema>;
export const integrationDeliveryIntentSchema = z.object({ schemaVersion: z.literal(1), command: integrationDeliveryCommandSchema,
  manifest: artifactReceiptSchema, patch: artifactReceiptSchema, plan: integrationDeliveryPlanSchema,
  actor: z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict() }).strict().readonly();
export type IntegrationDeliveryIntent = z.infer<typeof integrationDeliveryIntentSchema>;
export interface IntegrationDeliveryRecord { readonly intent: IntegrationDeliveryIntent; readonly delivered: boolean }
export interface IntegrationDeliveryStore {
  loadDelivery(command: IntegrationDeliveryCommand): Promise<IntegrationDeliveryRecord | null>;
  claimDelivery(intent: IntegrationDeliveryIntent): Promise<IntegrationDeliveryRecord>;
  finishDelivery(intent: IntegrationDeliveryIntent): Promise<IntegrationDeliveryRecord>;
}
export interface IntegrationDeliveryTarget {
  plan(command: IntegrationDeliveryCommand, manifest: IntegrationManifest, patch: WorkspacePatch): Promise<IntegrationDeliveryPlan>;
  delivered(plan: IntegrationDeliveryPlan): Promise<boolean>;
  publish(plan: IntegrationDeliveryPlan): Promise<void>;
}
/** Delivers an immutable Git reference. It never updates the live source checkout or accepts a Task. */
export class WorkspaceDeliveryApplication {
  constructor(private readonly patches: WorkspacePatchApplication, private readonly inspection: WorkspaceIntegrationInspection,
    private readonly candidate: IntegrationTarget, private readonly target: IntegrationDeliveryTarget,
    private readonly store: IntegrationDeliveryStore, private readonly sessions: SessionVerifier & SessionAuthority,
    private readonly authorization: DispatchIdentityAuthorization, private readonly clock: TrustedClock) {}
  async deliver(input: unknown, credential?: unknown) {
    const command = integrationDeliveryCommandSchema.parse(input);
    const verified = await authenticateSession(this.sessions, this.sessions, this.clock, credential, command.identity.scopeId);
    const authorize = () => this.authorization.authorizeIdentity('deliver-integration', command.identity, verified.principal);
    await authorize();
    const actor = verified.session.principalRef;
    const previous = await this.store.loadDelivery(command);
    if (previous && JSON.stringify(previous.intent.actor) !== JSON.stringify(actor)) throw new WorkspacePatchError('PATCH_CONFLICT');
    const result = (record: IntegrationDeliveryRecord) => Object.freeze({ schemaVersion: 1 as const, status: 'reference-delivered' as const,
      command: record.intent.command, plan: record.intent.plan, manifest: record.intent.manifest, application: 'reference-only' as const });
    if (previous?.delivered) return result(previous);
    // A crash after atomic Git publication can settle from exact reference custody, without rebuilding or reapplying.
    if (previous && await this.target.delivered(previous.intent.plan)) {
      await authorize(); await assertSessionActive(verified.session, this.sessions, this.clock);
      return result(await this.store.finishDelivery(previous.intent));
    }
    const inspected = await this.inspection.inspect({ schemaVersion: 1, identity: command.identity, commandId: command.integrationCommandId }, credential);
    if (!inspected.manifest || !inspected.receipt) throw new WorkspacePatchError('PATCH_INTEGRATION_PENDING');
    const preview = await this.patches.preview(command.identity, credential);
    await this.candidate.verify(inspected.manifest, preview.patch);
    if (JSON.stringify(inspected.manifest.patch) !== JSON.stringify(preview.receipt)) throw new WorkspacePatchError('PATCH_CORRUPT');
    if ((await this.candidate.observe(preview.patch)).digest !== inspected.manifest.observation) throw new WorkspacePatchError('PATCH_CONFLICT');
    const plan = integrationDeliveryPlanSchema.parse(await this.target.plan(command, inspected.manifest, preview.patch));
    const intent = integrationDeliveryIntentSchema.parse({ schemaVersion: 1, command, manifest: inspected.receipt, patch: preview.receipt, plan, actor });
    const claimed = await this.store.claimDelivery(intent);
    if (claimed.delivered) return result(claimed);
    await this.candidate.verify(inspected.manifest, preview.patch);
    if ((await this.candidate.observe(preview.patch)).digest !== inspected.manifest.observation) throw new WorkspacePatchError('PATCH_CONFLICT');
    await authorize(); await assertSessionActive(verified.session, this.sessions, this.clock);
    await this.target.publish(plan);
    return result(await this.store.finishDelivery(intent));
  }
}
