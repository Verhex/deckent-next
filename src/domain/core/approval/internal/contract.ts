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
 * What an approval authorizes (C12, operation-keyed): a task admission; one agent tool call — exactly this turn, round, call index,
 * tool version, canonical resource and argument digest (T-L4); or one catalog operation command — exactly this command id, operation
 * id@version, target record, canonical input digest, descriptor + endpoint binding, expected version and compensation reference (G1).
 * The action digest binds the same fields (plus scope and requester), so an approval is call-exact and command-exact: another command,
 * another input or a changed catalog/endpoint is another subject, never covered by an earlier allow.
 */
export const approvalSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), runId: identitySchema, taskId: identitySchema }).strict(),
  z.object({ kind: z.literal('agent-tool-call'), turnId: identitySchema, round: counterSchema.positive(), index: counterSchema,
    tool: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), toolVersion: counterSchema.positive(), resource: z.string().min(1).max(4096),
    argsDigest: digest }).strict(),
  z.object({ kind: z.literal('operation'), operation: z.object({ id: identitySchema, version: z.number().int().positive().safe() }).strict(),
    target: z.object({ kind: identitySchema, id: z.string().min(1).max(512) }).strict(), commandId: identitySchema, inputDigest: digest,
    targetBinding: digest, expectedVersion: z.string().min(1).max(256).nullable(), compensates: identitySchema.nullable() }).strict(),
]);
/**
 * B1 (owner 2026-10-01 `attested_assurance`): how strongly the service attests that a decision passed a human ceremony — never what a client
 * says. `peer-session`: a session-verified peer of the owner's OS user; `turn-bound`: the one-time capability the agent turn sent only to the
 * connection that started it. A level is an id, not a closed list: Enterprise producers (IdP step-up, WebAuthn) register further levels.
 */
export const APPROVAL_ASSURANCE = Object.freeze({ peerSession: 'peer-session', turnBound: 'turn-bound' } as const);
export const approvalAssuranceSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
/**
 * What a card must show besides the binding line (request v3, filled by the producer, never derived by a surface): the risk from the existing
 * vocabularies (`cell`: the tool call's permission cell; `effect-class`: the operation descriptor's class and authority surface; null = not
 * declared), how it is undone (null = not declared), what happens on expiry (nothing runs) and the required assurance at request time
 * (information; `decide` evaluates the authoritative minimum again).
 */
export const approvalFactsSchema = z.object({
  risk: z.discriminatedUnion('source', [z.object({ source: z.literal('cell'), cell: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/) }).strict(),
    z.object({ source: z.literal('effect-class'), effectClass: z.enum(['read', 'write', 'irreversible']), authority: z.boolean() }).strict()]).nullable(),
  reversibility: z.discriminatedUnion('kind', [z.object({ kind: z.literal('compensation'), operation: z.object({ id: identitySchema,
    version: z.number().int().positive().safe() }).strict() }).strict(), z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('irreversible') }).strict()]).nullable(),
  onExpiry: z.literal('nothing-runs'), requiredAssurance: approvalAssuranceSchema,
}).strict().readonly();
const requestShape = { approvalId: identitySchema, scopeId: identitySchema, subject: approvalSubjectSchema, requester: approvalActorSchema, actionDigest: digest,
  policyRevision: identitySchema, summary: z.string().min(1).max(2048), createdAt: counterSchema, expiresAt: counterSchema, renewal: renewalSchema.optional() };
/** Operation-keyed approval request (v2, C12): agent tool calls and catalog operation commands; task admission keeps v1. */
const operationApprovalRequestSchema = z.object({ schemaVersion: z.literal(2), ...requestShape }).strict().refine(r => r.expiresAt > r.createdAt).readonly();
/** Card-facts approval request (v3, B1/APPROVAL-SURFACE): the v2 shape plus the producer's `facts`; v1/v2 records stay readable as written. */
const factualApprovalRequestSchema = z.object({ schemaVersion: z.literal(3), ...requestShape, facts: approvalFactsSchema }).strict().refine(r => r.expiresAt > r.createdAt).readonly();
export const approvalRequestSchema = z.union([taskApprovalRequestSchema, operationApprovalRequestSchema, factualApprovalRequestSchema]);
export type ApprovalSubject = z.infer<typeof approvalSubjectSchema>;
export type ApprovalFacts = z.infer<typeof approvalFactsSchema>;
/** The subject of any request version (a v1 request is a task subject). */
export function approvalSubject(request: z.infer<typeof approvalRequestSchema>): ApprovalSubject {
  return request.schemaVersion === 1 ? Object.freeze({ kind: 'task' as const, runId: request.runId, taskId: request.taskId }) : request.subject;
}
/** The producer's facts of a v3 request; null for v1/v2 records (a card says "not declared"). */
export const approvalFacts = (request: z.infer<typeof approvalRequestSchema>): ApprovalFacts | null => request.schemaVersion === 3 ? request.facts : null;
const decisionShape = { commandId: identitySchema, decision: z.enum(['allow', 'deny']), actor: approvalActorSchema, sessionId: identitySchema,
  /** The surface the client declared (a registered channel id): recorded, never an input of any authorization. */
  channel: identitySchema, reason: z.string().min(1).max(2048).refine(v => v.trim() === v), decidedAt: counterSchema,
  requestDigest: digest, commandDigest: digest, idempotencyKeyHash: digest };
/** A decision sealed before B1 (unversioned, no assurance): read as `peer-session`, never rewritten (the MAC covers it as stored). */
const sessionDecisionSchema = z.object(decisionShape).strict().readonly();
/** Decision v2 (B1): the service-derived `assurance` is part of the sealed record. */
const attestedDecisionSchema = z.object({ schemaVersion: z.literal(2), ...decisionShape, assurance: approvalAssuranceSchema }).strict().readonly();
/**
 * Decision v3 (APPROVER-NOTE, owner 2026-10-07; lead decision 2026-10-07): a v2 decision whose `reason` is the decider's own words (typed on the
 * card), so a tool-call turn gives it to the model as the approver's note. Only a noted decision is written as v3 — every other decision stays
 * v2, readable by earlier builds; an earlier build refuses a v3 record with its typed `APPROVAL_INTEGRITY` (strict schema, store decode).
 */
const notedDecisionSchema = z.object({ schemaVersion: z.literal(3), ...decisionShape, assurance: approvalAssuranceSchema, approverNote: z.literal(true) }).strict().readonly();
export const approvalDecisionSchema = z.union([notedDecisionSchema, attestedDecisionSchema, sessionDecisionSchema]);
/** The dual reader: a decision's assurance, `peer-session` for a decision sealed before B1. */
export const approvalDecisionAssurance = (decision: z.infer<typeof approvalDecisionSchema>): string =>
  'assurance' in decision ? decision.assurance : APPROVAL_ASSURANCE.peerSession;
export const approvalRecordSchema = z.object({ request: approvalRequestSchema, revision: counterSchema,
  status: z.enum(['pending', 'decided', 'expired']), decision: approvalDecisionSchema.nullable(),
  keyId: identitySchema, mac: digest,
}).strict().superRefine((v, c) => {
  if ((v.status === 'pending' && (v.revision !== 0 || v.decision !== null))
    || (v.status !== 'pending' && v.revision !== 1)
    || (v.status === 'expired' && v.decision !== null)
    || (v.status === 'decided' && (!v.decision || v.decision.decidedAt < v.request.createdAt || (approvalSubject(v.request).kind !== 'agent-tool-call' && v.decision.decidedAt >= v.request.expiresAt)))) {
    c.addIssue({ code: z.ZodIssueCode.custom, message: 'APPROVAL_CORRUPT' });
  }
}).readonly();
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export type ApprovalActor = z.infer<typeof approvalActorSchema>;
export class ApprovalError extends Error {
  constructor(readonly code: 'APPROVAL_INVALID' | 'APPROVAL_DENIED' | 'APPROVAL_MISSING' | 'APPROVAL_CONFLICT'
    | 'APPROVAL_EXPIRED' | 'APPROVAL_INTEGRITY' | 'APPROVAL_STALE' | 'APPROVAL_REQUIRED' | 'APPROVAL_UNSETTLED' | 'APPROVAL_SURFACE_RESTRICTED'
    | 'APPROVAL_ATTENDED_REQUIRED' | 'APPROVAL_ASSURANCE_INSUFFICIENT') { super(code); this.name = 'ApprovalError'; }
}
