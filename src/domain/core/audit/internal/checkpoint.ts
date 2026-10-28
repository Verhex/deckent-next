import { z } from 'zod';
import type { AuditEvent } from './contract.js';
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
/** BeUser S-04: one page of a scope's audit log, ascending after a sequence (`after` 0 = from the start; `limit` absent = the configured
 * `audit.pageSize`, the application's page bound applies); the read is the `approval/inspect` cell. */
export const auditListQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, after: counterSchema.default(0),
  limit: counterSchema.positive().optional() }).strict().readonly();
export type AuditListQuery = z.input<typeof auditListQuerySchema>;
export type AuditListView = Readonly<{ schemaVersion: 1; scopeId: string; records: readonly Readonly<{ sequence: number; event: AuditEvent }>[]; next: number | null }>;
export const auditVerificationSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  status: z.enum(['match', 'truncated', 'possible-wipe', 'policy-changed', 'producers-changed', 'chain-broken', 'unknown']),
  reason: z.enum(['verified', 'no-checkpoint-yet', 'unavailable', 'limit', 'foreign-witness', 'key-unavailable', 'integrity', 'head-missing', 'checkpoints-missing', 'policy', 'producers']),
  head: z.object({ sequence: counterSchema, digest }).strict().nullable(), checkpoint: auditWitnessSchema.nullable() }).strict().readonly();
/** The explicit operator re-baseline command: the scope and the person's own reason (sealed into the marker event). */
export const auditRebaselineCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  reason: z.string().trim().min(1).max(1024) }).strict().readonly();
export type AuditCheckpoint = z.infer<typeof auditCheckpointSchema>;
export type AuditWitness = z.infer<typeof auditWitnessSchema>;
export type AuditVerifyQuery = z.infer<typeof auditVerifyQuerySchema>;
export type AuditVerification = z.infer<typeof auditVerificationSchema>;
