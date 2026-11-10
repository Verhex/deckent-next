import { persistedString, clientCommandIdSchema, attemptIdentitySchema, identitySchema } from '#domain/index.js';
import { z } from 'zod';
import { artifactReceiptSchema } from '#capabilities/index.js';
import type { WorkspacePatch } from './contract.js';
export const integrationCommandSchema = z.strictObject({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  identity: attemptIdentitySchema, replacesCommandId: identitySchema.optional(), proposal: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{20}$/) }).readonly();
export type IntegrationCommand = z.infer<typeof integrationCommandSchema>;
export interface IntegrationObservation { readonly digest: string; readonly source: string; readonly head: string }
const manifestFields = { kind: z.literal('integration-candidate'),
  command: integrationCommandSchema, patch: artifactReceiptSchema, observation: z.string().regex(/^[a-f0-9]{64}$/),
  workspace: persistedString(z.string().min(1)), snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  application: z.literal('candidate-only') };
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const integrationManifestSchema = z.discriminatedUnion('schemaVersion', [z.strictObject({ schemaVersion: z.literal(1), ...manifestFields }),
  z.strictObject({ schemaVersion: z.literal(2), ...manifestFields, baseCommit: oid, effectiveBaseCommit: oid })]).readonly();
export type IntegrationManifest = z.infer<typeof integrationManifestSchema>;
export const integrationIntentSchema = z.strictObject({ schemaVersion: z.literal(1), command: integrationCommandSchema,
  patch: artifactReceiptSchema, observation: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.strictObject({ id: identitySchema, issuer: identitySchema, subject: identitySchema }) }).readonly();
export type IntegrationIntent = z.infer<typeof integrationIntentSchema>;
export interface IntegrationRecord { readonly intent: IntegrationIntent; readonly manifest: z.infer<typeof artifactReceiptSchema> | null }
export interface IntegrationStore {
  claimIntegration(intent: IntegrationIntent): Promise<{ readonly acquired: boolean; readonly record: IntegrationRecord }>;
  finishIntegration(intent: IntegrationIntent, manifest: z.infer<typeof artifactReceiptSchema>): Promise<void>;
}
export interface IntegrationTarget {
  observe(patch: WorkspacePatch): Promise<IntegrationObservation>;
  prepare(intent: IntegrationIntent, patch: WorkspacePatch): Promise<IntegrationManifest>;
  verify(manifest: IntegrationManifest, patch: WorkspacePatch): Promise<void>;
}
