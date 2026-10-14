import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** v1 pull-witness contract: no credentials, raw policy or event content. */
export const auditCheckpointSchema = z.object({ schemaVersion: z.literal(1), installationId: identitySchema, scopeId: identitySchema,
  sequence: counterSchema.positive(), atMs: counterSchema, head: z.object({ sequence: counterSchema, digest }).strict(),
  policyDigest: digest, producersDigest: digest, previousDigest: digest.nullable(), keyId: identitySchema, mac: digest }).strict().readonly();
export const auditWitnessSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('deckent-audit-checkpoint'),
  checkpoint: auditCheckpointSchema, digest }).strict().readonly();
export const auditVerifyQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  witness: auditWitnessSchema.optional() }).strict().readonly();
export const auditVerificationSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  status: z.enum(['match', 'truncated', 'possible-wipe', 'policy-changed', 'producers-changed', 'chain-broken', 'unknown']),
  reason: z.enum(['verified', 'no-checkpoint-yet', 'unavailable', 'limit', 'foreign-witness', 'key-unavailable', 'integrity', 'head-missing', 'checkpoints-missing', 'policy', 'producers']),
  head: z.object({ sequence: counterSchema, digest }).strict().nullable(), checkpoint: auditWitnessSchema.nullable() }).strict().readonly();
export type AuditCheckpoint = z.infer<typeof auditCheckpointSchema>;
export type AuditWitness = z.infer<typeof auditWitnessSchema>;
export type AuditVerifyQuery = z.infer<typeof auditVerifyQuerySchema>;
export type AuditVerification = z.infer<typeof auditVerificationSchema>;
