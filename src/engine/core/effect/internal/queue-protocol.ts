import { persistedString, persistedInteger, attemptIdentitySchema, clientCommandIdSchema, identitySchema, effectTargetRefSchema, targetDisplaySchema, queueReasonSchema, queueDeliveryIntentSchema } from '#domain/index.js';
import { z } from 'zod';
import { targetQueueViewSchema } from './queue-view.js';
/** `deliveryIntent` (D2b) is the human's explicit opt-in on this one Run and target; there is no wire field for a re-attempt or delegation. */
export const queueEnqueueSchema = z.strictObject({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  replacesCommandId: identitySchema.optional(), identity: attemptIdentitySchema, target: effectTargetRefSchema, deliveryIntent: queueDeliveryIntentSchema.optional() }).readonly();
export const queueQuerySchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema, commandId: identitySchema }).readonly();
export const queueListSchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema, after: identitySchema.nullable(),
  limit: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }).readonly();
export const queueChallengeSchema = queueQuerySchema.unwrap().extend({ operation: z.enum(['publish', 'adopt', 'rollback']),
  publishDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().refine(value => (value.operation === 'adopt') === (value.publishDigest !== undefined)).readonly();
export const queueAnswerSchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
  capability: persistedString(z.string().min(1).max(4096)), answer: z.enum(['allow', 'decline']) }).readonly();
const queueForwardExecuteSchema = queueQuerySchema.unwrap().extend({ publishDigest: z.string().regex(/^[a-f0-9]{64}$/), adoptDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly();
export const queueExecuteSchema = z.union([queueForwardExecuteSchema,
  queueQuerySchema.unwrap().extend({ rollbackDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly()]);
export const queueRollbackSchema = queueQuerySchema.unwrap().extend({ sourceCommandId: identitySchema }).strict().readonly();
export type QueueRollback = z.infer<typeof queueRollbackSchema>;
export type QueueEnqueue = z.infer<typeof queueEnqueueSchema>;
export type QueueQuery = z.infer<typeof queueQuerySchema>;
export type QueueList = z.infer<typeof queueListSchema>;
export type QueueChallenge = z.infer<typeof queueChallengeSchema>;
export type QueueAnswer = z.infer<typeof queueAnswerSchema>;
export type QueueExecute = z.infer<typeof queueExecuteSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const queueInspectionSchema = z.strictObject({ schemaVersion: z.literal(1), record: targetQueueViewSchema.nullable() }).readonly();
export const queuePageSchema = z.strictObject({ schemaVersion: z.literal(1), records: z.array(targetQueueViewSchema) }).readonly();
export const queueConsentSchema = z.strictObject({ schemaVersion: z.literal(1), digest, capability: persistedString(z.string().min(1).max(4096)), operation: z.enum(['publish', 'adopt', 'rollback']),
  expiresAt: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), target: effectTargetRefSchema, display: targetDisplaySchema,
  items: z.array(z.strictObject({ commandId: identitySchema, from: persistedString(z.string().min(1)), to: persistedString(z.string().min(1)), candidateDigest: digest, verificationReceipt: digest, changes: z.array(z.string()) })).min(1) }).readonly();
export const queueExecutionSchema = z.strictObject({ settledPrefix: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), items: z.array(z.strictObject({ commandId: identitySchema,
  published: z.boolean(), state: z.enum(['settled', 'refused', 'unknown']), reason: queueReasonSchema.optional() })) }).readonly();
export type QueueConsent = z.infer<typeof queueConsentSchema>;
/** The SDK/MCP shape: inspect and list only (DESIGN §6). */
export interface QueueReadClient {
  inspectTargetQueue(input: QueueQuery): Promise<z.infer<typeof queueInspectionSchema>>;
  listTargetQueue(input: QueueList): Promise<z.infer<typeof queuePageSchema>>;
}
/** Human CLI/Terminal submission; only that composition installs it, and the service refuses it on the MCP channel. */
export interface QueueSubmitClient extends QueueReadClient {
  enqueueTargetQueueRollback(input: QueueRollback): Promise<z.infer<typeof targetQueueViewSchema>>;
  enqueueTargetQueue(input: QueueEnqueue): Promise<z.infer<typeof targetQueueViewSchema>>;
}
