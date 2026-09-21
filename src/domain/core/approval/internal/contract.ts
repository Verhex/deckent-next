import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const approvalActorSchema = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly();
export const approvalRequestSchema = z.object({ schemaVersion: z.literal(1), approvalId: identitySchema,
  scopeId: identitySchema, runId: identitySchema, taskId: identitySchema, requester: approvalActorSchema,
  actionDigest: digest, policyRevision: identitySchema, summary: z.string().min(1).max(2048),
  createdAt: counterSchema, expiresAt: counterSchema,
  renewal: z.object({ previousApprovalId: identitySchema, commandId: identitySchema, commandDigest: digest, actor: approvalActorSchema, reason: z.string().min(1).max(2048) }).strict().readonly().optional(),
}).strict().refine(r => r.expiresAt > r.createdAt).readonly();
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
    | 'APPROVAL_EXPIRED' | 'APPROVAL_INTEGRITY' | 'APPROVAL_STALE' | 'APPROVAL_REQUIRED') { super(code); this.name = 'ApprovalError'; }
}
