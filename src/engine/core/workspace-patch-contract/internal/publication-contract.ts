import { clientCommandIdSchema, identitySchema, attemptIdentitySchema, type RunSnapshot } from '#domain/index.js';
import { z } from 'zod';
import { artifactReceiptSchema } from '#capabilities/index.js';
import type { IntegrationCommitMetadata } from './commit-metadata.js';
import type { WorkspacePatch } from './contract.js';
import type { IntegrationManifest } from './integration-contract.js';
export const integrationDeliveryCommandSchema = z.strictObject({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  identity: attemptIdentitySchema, integrationCommandId: identitySchema }).readonly();
export type IntegrationDeliveryCommand = z.infer<typeof integrationDeliveryCommandSchema>;
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const planFields = { baseCommit: oid, commit: oid,
  ref: z.string().regex(/^refs\/deckent\/deliveries\/[a-f0-9]{64}$/), snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/) };
export const integrationDeliveryPlanSchema = z.discriminatedUnion('schemaVersion', [z.strictObject({ schemaVersion: z.literal(1), ...planFields }),
  z.strictObject({ schemaVersion: z.literal(2), ...planFields, effectiveBaseCommit: oid })]).readonly();
export type IntegrationDeliveryPlan = z.infer<typeof integrationDeliveryPlanSchema>;
export const integrationDeliveryIntentSchema = z.strictObject({ schemaVersion: z.literal(1), command: integrationDeliveryCommandSchema,
  manifest: artifactReceiptSchema, patch: artifactReceiptSchema, plan: integrationDeliveryPlanSchema,
  actor: z.strictObject({ id: identitySchema, issuer: identitySchema, subject: identitySchema }) }).readonly();
export type IntegrationDeliveryIntent = z.infer<typeof integrationDeliveryIntentSchema>;
export interface IntegrationDeliveryRecord { readonly intent: IntegrationDeliveryIntent; readonly delivered: boolean }
export interface IntegrationDeliveryStore {
  loadRun(scopeId: string, runId: string): Promise<RunSnapshot | null>;
  loadDelivery(command: IntegrationDeliveryCommand): Promise<IntegrationDeliveryRecord | null>;
  claimDelivery(intent: IntegrationDeliveryIntent): Promise<IntegrationDeliveryRecord>;
  finishDelivery(intent: IntegrationDeliveryIntent): Promise<IntegrationDeliveryRecord>;
}
export interface IntegrationDeliveryTarget {
  /** Absent: a reference only. `working-tree`: `publish` writes the patch into the source checkout's files (no reference there). */
  readonly application?: 'working-tree';
  plan(command: IntegrationDeliveryCommand, manifest: IntegrationManifest, patch: WorkspacePatch, metadata: IntegrationCommitMetadata): Promise<IntegrationDeliveryPlan>;
  delivered(plan: IntegrationDeliveryPlan): Promise<boolean>;
  publish(plan: IntegrationDeliveryPlan, manifest: IntegrationManifest, patch: WorkspacePatch): Promise<readonly string[] | void>; // working-tree: the files set aside (R1, Astra 3017)
}
