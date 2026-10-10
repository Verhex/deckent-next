import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
/** Sequence adjacency and checkpoint format version are protocol invariants. */
export const AUDIT_SEQUENCE_STEP = 1;
export const AUDIT_CHECKPOINT_SCHEMA_VERSION = 1;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Checkpoints are sealed audit records; the subject binds the covered interval and previous checkpoint. */
export const auditCheckpointSubjectSchema = z.object({ kind: z.literal('audit-checkpoint'), schemaVersion: z.literal(AUDIT_CHECKPOINT_SCHEMA_VERSION),
  firstSequence: counterSchema.positive(), lastSequence: counterSchema.positive(), records: counterSchema.positive(),
  cadence: counterSchema.positive(), intervalDigest: digest, previousCheckpointDigest: digest.nullable() }).strict()
  .refine(value => value.lastSequence >= value.firstSequence && value.records === value.lastSequence - value.firstSequence + AUDIT_SEQUENCE_STEP);
/** An external high-water mark is a trusted consumer input, never a signing key. */
export const auditCheckpointAnchorSchema = z.object({ sequence: counterSchema.positive(), digest }).strict().readonly();
export const auditCheckpointVerifyCommandSchema = z.object({ schemaVersion: z.literal(AUDIT_CHECKPOINT_SCHEMA_VERSION), scopeId: identitySchema,
  anchor: auditCheckpointAnchorSchema.optional() }).strict().readonly();
export type AuditCheckpointSubject = z.infer<typeof auditCheckpointSubjectSchema>;
export type AuditCheckpointVerifyCommand = z.infer<typeof auditCheckpointVerifyCommandSchema>;
