import { z } from 'zod';
import { attemptIdentitySchema, clientCommandIdSchema, identitySchema, effectTargetRefSchema, targetDisplaySchema } from '#domain/index.js';
import { targetQueueViewSchema } from './queue-view.js';
export const queueEnqueueSchema = z.object({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  replacesCommandId: identitySchema.optional(), identity: attemptIdentitySchema, target: effectTargetRefSchema }).strict().readonly();
export const queueQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, commandId: identitySchema }).strict().readonly();
export const queueListSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, after: identitySchema.nullable(),
  limit: z.number().int().positive().safe() }).strict().readonly();
export const queueChallengeSchema = queueQuerySchema.unwrap().extend({ operation: z.enum(['publish', 'adopt', 'rollback']),
  publishDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().refine(value => (value.operation === 'adopt') === (value.publishDigest !== undefined)).readonly();
export const queueAnswerSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
  capability: z.string().min(1).max(4096), answer: z.enum(['allow', 'decline']) }).strict().readonly();
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
export const queueInspectionSchema = z.object({ schemaVersion: z.literal(1), record: targetQueueViewSchema.nullable() }).strict().readonly();
export const queuePageSchema = z.object({ schemaVersion: z.literal(1), records: z.array(targetQueueViewSchema) }).strict().readonly();
export const queueConsentSchema = z.object({ schemaVersion: z.literal(1), digest, capability: z.string().min(1).max(4096), operation: z.enum(['publish', 'adopt', 'rollback']),
  expiresAt: z.number().int().positive().safe(), target: effectTargetRefSchema, display: targetDisplaySchema,
  items: z.array(z.object({ commandId: identitySchema, from: z.string().min(1), to: z.string().min(1), candidateDigest: digest, verificationReceipt: digest, changes: z.array(z.string()) }).strict()).min(1) }).strict().readonly();
export const queueExecutionSchema = z.object({ settledPrefix: z.number().int().nonnegative().safe(), items: z.array(z.object({ commandId: identitySchema,
  published: z.boolean(), state: z.enum(['settled', 'refused', 'unknown']) }).strict()) }).strict().readonly();
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
