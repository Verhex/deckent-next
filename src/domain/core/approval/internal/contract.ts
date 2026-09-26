import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const approvalActorSchema = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly();
const renewalSchema = z.object({ previousApprovalId: identitySchema, commandId: identitySchema, commandDigest: digest, actor: approvalActorSchema,
  reason: z.string().min(1).max(2048) }).strict().readonly();
/** Task-admission approval (v1): unchanged, so every sealed v1 record keeps verifying byte for byte. */
const taskApprovalRequestSchema = z.object({ schemaVersion: z.literal(1), approvalId: identitySchema,
  scopeId: identitySchema, runId: identitySchema, taskId: identitySchema, requester: approvalActorSchema,
  actionDigest: digest, policyRevision: identitySchema, summary: z.string().min(1).max(2048),
  createdAt: counterSchema, expiresAt: counterSchema, renewal: renewalSchema.optional(),
}).strict().refine(r => r.expiresAt > r.createdAt).readonly();
/**
 * What an approval authorizes (C12, operation-keyed): a task admission, or one agent tool call — exactly this turn, round, call index,
 * tool version, canonical resource and argument digest (T-L4). The action digest binds the same fields, so an approval is call-exact.
 */
export const approvalSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), runId: identitySchema, taskId: identitySchema }).strict(),
  z.object({ kind: z.literal('agent-tool-call'), turnId: identitySchema, round: counterSchema.positive(), index: counterSchema,
    tool: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), toolVersion: counterSchema.positive(), resource: z.string().min(1).max(4096),
    argsDigest: digest }).strict(),
]);
/** Operation-keyed approval request (v2, C12). Only agent tool calls use it today; task admission keeps v1. */
const operationApprovalRequestSchema = z.object({ schemaVersion: z.literal(2), approvalId: identitySchema, scopeId: identitySchema,
  subject: approvalSubjectSchema, requester: approvalActorSchema, actionDigest: digest, policyRevision: identitySchema,
  summary: z.string().min(1).max(2048), createdAt: counterSchema, expiresAt: counterSchema, renewal: renewalSchema.optional(),
}).strict().refine(r => r.expiresAt > r.createdAt).readonly();
export const approvalRequestSchema = z.union([taskApprovalRequestSchema, operationApprovalRequestSchema]);
export type ApprovalSubject = z.infer<typeof approvalSubjectSchema>;
/** The subject of any request version (a v1 request is a task subject). */
export function approvalSubject(request: z.infer<typeof approvalRequestSchema>): ApprovalSubject {
  return request.schemaVersion === 1 ? Object.freeze({ kind: 'task' as const, runId: request.runId, taskId: request.taskId }) : request.subject;
}
export const approvalDecisionSchema = z.object({ commandId: identitySchema, decision: z.enum(['allow', 'deny']),
  actor: approvalActorSchema, sessionId: identitySchema, channel: identitySchema,
  reason: z.string().min(1).max(2048).refine(v => v.trim() === v), decidedAt: counterSchema,
  requestDigest: digest, commandDigest: digest, idempotencyKeyHash: digest,
}).strict().readonly();
export const approvalRecordSchema = z.object({ request: approvalRequestSchema, revision: counterSchema,
  status: z.enum(['pending', 'decided', 'expired']), decision: approvalDecisionSchema.nullable(),
  keyId: identitySchema, mac: digest,
}).strict().superRefine((v, c) => {
  if ((v.status === 'pending' && (v.revision !== 0 || v.decision !== null))
    || (v.status !== 'pending' && v.revision !== 1)
    || (v.status === 'expired' && v.decision !== null)
    || (v.status === 'decided' && (!v.decision || v.decision.decidedAt < v.request.createdAt || v.decision.decidedAt >= v.request.expiresAt))) {
    c.addIssue({ code: z.ZodIssueCode.custom, message: 'APPROVAL_CORRUPT' });
  }
}).readonly();
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export type ApprovalActor = z.infer<typeof approvalActorSchema>;
export class ApprovalError extends Error {
  constructor(readonly code: 'APPROVAL_INVALID' | 'APPROVAL_DENIED' | 'APPROVAL_MISSING' | 'APPROVAL_CONFLICT'
    | 'APPROVAL_EXPIRED' | 'APPROVAL_INTEGRITY' | 'APPROVAL_STALE' | 'APPROVAL_REQUIRED' | 'APPROVAL_UNSETTLED') { super(code); this.name = 'ApprovalError'; }
}
