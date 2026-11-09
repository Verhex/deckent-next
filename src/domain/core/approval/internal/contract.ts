import { CodedError, persistedString, persistedInteger, identitySchema, counterSchema } from '#domain/core/primitives/index.js';
import { z } from 'zod';
import { approvalPreviewCutSchema } from '#domain/core/agent-turn/index.js';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const approvalActorSchema = z.strictObject({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).readonly();
const renewalSchema = z.strictObject({ previousApprovalId: identitySchema, commandId: identitySchema, commandDigest: digest, actor: approvalActorSchema,
  get reason() { return persistedString(z.string().min(1).max(2048)); } }).readonly();
/** Task-admission approval (v1): unchanged, so every sealed v1 record keeps verifying byte for byte. */
const taskApprovalRequestSchema = z.strictObject({ get schemaVersion() { return z.literal(1); }, approvalId: identitySchema,
  scopeId: identitySchema, runId: identitySchema, taskId: identitySchema, requester: approvalActorSchema,
  actionDigest: digest, policyRevision: identitySchema, get summary() { return persistedString(z.string().min(1).max(2048)); },
  createdAt: counterSchema, expiresAt: counterSchema, get renewal() { return renewalSchema.optional(); },
}).refine(r => r.expiresAt > r.createdAt).readonly();
/** A bounded display copy of a config value on a card: the redacted JSON text (never a secret value); the exact value is bound by `valueDigest`. */
const configDisplay = persistedString(z.string().max(256));
export const CONFIG_CHANGE_DISPLAY_MAX = configDisplay.maxLength!;
/**
 * One config write a policy `require-approval` holds (T3 L2 CONFIG-APPROVAL, Jev 9181d2be): this command, layer and key, the value before
 * (effective, redacted) and after (redacted; null for `unset`), the layer digest the change was previewed against (`expectDigest`, null: the
 * layer file was absent), the exact value's digest (null for `unset`) and why (the policy rule that asked). Apply re-checks the digest and the policy.
 */
const configChangeSubjectSchema = z.strictObject({ get kind() { return z.literal('config-change'); }, commandId: identitySchema, get action() { return z.enum(['set', 'unset']); },
  get layer() { return z.enum(['project', 'global']); }, get keyPath() { return persistedString(z.string().min(1).max(512)); }, before: configDisplay, get after() { return configDisplay.nullable(); },
  get expectDigest() { return digest.nullable(); }, get valueDigest() { return digest.nullable(); }, ruleId: identitySchema });
/** The `unset` ⇔ no value invariant of a config-change subject (a discriminated union member cannot carry a refinement). */
export const configChangeSubjectConsistent = (subject: z.infer<typeof configChangeSubjectSchema>) =>
  (subject.action === 'unset') === (subject.after === null && subject.valueDigest === null);
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17).
 * What an approval authorizes (C12, operation-keyed): a task admission; one agent tool call — exactly this turn, round, call index,
 * tool version, canonical resource and argument digest (T-L4); or one catalog operation command — exactly this command id, operation
 * id@version, target record, canonical input digest, descriptor + endpoint binding, expected version and compensation reference (G1).
 * The action digest binds the same fields (plus scope and requester), so an approval is call-exact and command-exact: another command,
 * another input or a changed catalog/endpoint is another subject, never covered by an earlier allow. A config change (T3 L2) binds its command,
 * layer, key, value digest and previewed layer digest the same way.
 */
export const approvalSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ get kind() { return z.literal('run-create'); }, commandId: identitySchema, runId: identitySchema,
    inputDigest: digest, admissionDigest: digest, decisionRecordId: identitySchema }),
  z.strictObject({ get kind() { return z.literal('task'); }, runId: identitySchema, taskId: identitySchema }),
  z.strictObject({ get kind() { return z.literal('agent-tool-call'); }, turnId: identitySchema, get round() { return counterSchema.positive(); }, index: counterSchema,
    get tool() { return z.string().regex(/^[a-z][a-z0-9_]{1,63}$/); }, get toolVersion() { return counterSchema.positive(); }, get resource() { return persistedString(z.string().min(1).max(4096)); },
    argsDigest: digest }),
  z.strictObject({ get kind() { return z.literal('operation'); }, get operation() { return z.strictObject({ id: identitySchema, version: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }); },
    get target() { return z.strictObject({ kind: identitySchema, id: persistedString(z.string().min(1).max(512)) }); }, commandId: identitySchema, inputDigest: digest,
    targetBinding: digest, get expectedVersion() { return persistedString(z.string().min(1).max(256)).nullable(); }, get compensates() { return identitySchema.nullable(); } }),
  configChangeSubjectSchema,
]);
/**
 * B1 (owner 2026-10-01 `attested_assurance`): how strongly the service attests that a decision passed a human ceremony — never what a client
 * says. `peer-session`: a session-verified peer of the owner's OS user; `turn-bound`: the one-time capability the agent turn sent only to the
 * connection that started it. A level is an id, not a closed list: Enterprise producers (IdP step-up, WebAuthn) register further levels.
 */
export const APPROVAL_ASSURANCE = Object.freeze({ peerSession: 'peer-session', turnBound: 'turn-bound' } as const);
export const approvalAssuranceSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17).
 * What a card must show besides the binding line (request v3, filled by the producer, never derived by a surface): the risk from the existing
 * vocabularies (`cell`: the tool call's permission cell; `effect-class`: the operation descriptor's class and authority surface; null = not
 * declared), how it is undone (null = not declared), what happens on expiry (nothing runs) and the required assurance at request time
 * (information; `decide` evaluates the authoritative minimum again).
 */
export const approvalFactsSchema = z.strictObject({
  get risk() { return z.discriminatedUnion('source', [z.strictObject({ source: z.literal('cell'), cell: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/) }),
    z.strictObject({ source: z.literal('effect-class'), effectClass: z.enum(['read', 'write', 'irreversible']), authority: z.boolean() })]).nullable(); },
  get reversibility() { return z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('compensation'), operation: z.strictObject({ id: identitySchema,
    version: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }) }), z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('irreversible') })]).nullable(); },
  get onExpiry() { return z.literal('nothing-runs'); }, requiredAssurance: approvalAssuranceSchema,
}).readonly();
/** The card summary a v2/v3 request stores; a producer that must fit a structured summary checks it against this schema. */
export const approvalSummarySchema = persistedString(z.string().min(1).max(2048));
const requestShape = { approvalId: identitySchema, scopeId: identitySchema, subject: approvalSubjectSchema, requester: approvalActorSchema, actionDigest: digest,
  policyRevision: identitySchema, summary: approvalSummarySchema, createdAt: counterSchema, expiresAt: counterSchema, renewal: renewalSchema.optional() };
/** Operation-keyed approval request (v2, C12): agent tool calls and catalog operation commands; task admission keeps v1. */
const operationApprovalRequestSchema = z.strictObject({ get schemaVersion() { return z.literal(2); }, ...requestShape }).refine(r => r.expiresAt > r.createdAt).readonly();
/** Card-facts approval request (v3, B1/APPROVAL-SURFACE): the v2 shape plus the producer's `facts`; v1/v2 records stay readable as written. */
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). Versioned display expansion: sealed with the request and bound to the exact tool arguments. Older v3 records retain their bytes. */
export const approvalPreviewSchema = z.strictObject({ schemaVersion: z.literal(1), argsDigest: digest,
  text: persistedString(z.string().max(16_384)), cut: approvalPreviewCutSchema.nullable() }).readonly();
/** KG4 F3 expand: the worker fact as a sealed, typed field instead of the display summary. Nothing writes it yet: an earlier build's strict schema
 * refuses a record carrying it, so the writer lands one release after this reader (APPR-4, with its rollback proof). */
const workerOriginSchema = z.strictObject({ kind: z.literal('worker-tool-call'), identity: attemptIdentitySchema, turnId: identitySchema, resourceDigest: digest, argsDigest: digest }).readonly();
const factualApprovalRequestSchema = z.strictObject({ get schemaVersion() { return z.literal(3); }, ...requestShape, facts: approvalFactsSchema,
  preview: approvalPreviewSchema.optional(), origin: workerOriginSchema.optional() }).refine(r => r.expiresAt > r.createdAt).readonly();
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
  channel: identitySchema, reason: persistedString(z.string().min(1).max(2048)).refine(v => v.trim() === v), decidedAt: counterSchema,
  requestDigest: digest, commandDigest: digest, idempotencyKeyHash: digest };
/** A decision sealed before B1 (unversioned, no assurance): read as `peer-session`, never rewritten (the MAC covers it as stored). */
const sessionDecisionSchema = z.strictObject(decisionShape).readonly();
/** Decision v2 (B1): the service-derived `assurance` is part of the sealed record. */
const attestedDecisionSchema = z.strictObject({ get schemaVersion() { return z.literal(2); }, ...decisionShape, assurance: approvalAssuranceSchema }).readonly();
/**
 * Decision v3 (APPROVER-NOTE, owner 2026-10-07; lead decision 2026-10-07): a v2 decision whose `reason` is the decider's own words (typed on the
 * card), so a tool-call turn gives it to the model as the approver's note. Only a noted decision is written as v3 — every other decision stays
 * v2, readable by earlier builds; an earlier build refuses a v3 record with its typed `APPROVAL_INTEGRITY` (strict schema, store decode).
 */
const notedDecisionSchema = z.strictObject({ get schemaVersion() { return z.literal(3); }, ...decisionShape, assurance: approvalAssuranceSchema, get approverNote() { return z.literal(true); } }).readonly();
export const deciderClassSchema = z.enum(['human-tty', 'ai-policy', 'system']);
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type DeciderClass = z.infer<typeof deciderClassSchema>;
/** D0 v4 seals the producer-derived decider class. Older MAC payloads remain byte-identical. */
const classifiedDecisionSchema = z.strictObject({ get schemaVersion() { return z.literal(4); }, ...decisionShape, assurance: approvalAssuranceSchema,
  deciderClass: deciderClassSchema, get approverNote() { return z.literal(true).optional(); } }).readonly();
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const approvalDecisionSchema = z.union([classifiedDecisionSchema, notedDecisionSchema, attestedDecisionSchema, sessionDecisionSchema]);
/** The dual reader: a decision's assurance, `peer-session` for a decision sealed before B1. */
export const approvalDecisionAssurance = (decision: z.infer<typeof approvalDecisionSchema>): string =>
  'assurance' in decision ? decision.assurance : APPROVAL_ASSURANCE.peerSession;
/** Legacy custody cannot prove the decision class; do not reinterpret it as a human decision. */
export const approvalDecisionClass = (decision: z.infer<typeof approvalDecisionSchema>): DeciderClass | 'unknown' =>
  'deciderClass' in decision ? decision.deciderClass : 'unknown';
export const approvalRecordSchema = z.strictObject({ request: approvalRequestSchema, revision: counterSchema,
  get status() { return z.enum(['pending', 'decided', 'expired']); }, get decision() { return approvalDecisionSchema.nullable(); },
  keyId: identitySchema, mac: digest,
}).superRefine((v, c) => {
  if ((v.status === 'pending' && (v.revision !== 0 || v.decision !== null))
    || (v.status !== 'pending' && v.revision !== 1)
    || (v.status === 'expired' && v.decision !== null)
    || (v.status === 'decided' && (!v.decision || v.decision.decidedAt < v.request.createdAt || (approvalSubject(v.request).kind !== 'agent-tool-call' && v.decision.decidedAt >= v.request.expiresAt)))
    || (v.request.schemaVersion !== 1 && v.request.subject.kind === 'config-change' && !configChangeSubjectConsistent(v.request.subject))) {
    c.addIssue({ code: z.ZodIssueCode.custom, message: 'APPROVAL_CORRUPT' });
  }
}).readonly();
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
/** S1-D5, owner B1-16: expired, denied or admission-window-aged task approvals renew into a bound pending request.
 * Tool-call and operation approvals stay single use. Engine and store both enforce this; the successor TTL is the configured admission window. */
export function approvalRenewalRefusal(previous: ApprovalRecord, next: ApprovalRecord): 'APPROVAL_INVALID' | 'APPROVAL_CONFLICT' | null {
  if (approvalSubject(previous.request).kind !== 'task' || approvalSubject(next.request).kind !== 'task') return 'APPROVAL_INVALID';
  return next.status !== 'pending' || next.request.renewal?.previousApprovalId !== previous.request.approvalId || next.request.scopeId !== previous.request.scopeId
    || next.request.actionDigest !== previous.request.actionDigest || !(previous.status === 'expired' || previous.status === 'decided' && (previous.decision?.decision === 'deny' || previous.decision?.decision === 'allow' && next.request.createdAt > previous.decision.decidedAt + next.request.expiresAt - next.request.createdAt)) ? 'APPROVAL_CONFLICT' : null;
}
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export type ApprovalActor = z.infer<typeof approvalActorSchema>;
export class ApprovalError extends CodedError {
  constructor(override readonly code: 'APPROVAL_INVALID' | 'APPROVAL_DENIED' | 'APPROVAL_MISSING' | 'APPROVAL_CONFLICT'
    | 'APPROVAL_EXPIRED' | 'APPROVAL_INTEGRITY' | 'APPROVAL_STALE' | 'APPROVAL_REQUIRED' | 'APPROVAL_UNSETTLED' | 'APPROVAL_SURFACE_RESTRICTED'
    | 'AI_AUTHORITY_NON_DELEGABLE' | 'APPROVAL_ATTENDED_REQUIRED' | 'APPROVAL_ASSURANCE_INSUFFICIENT') { super(code); this.name = 'ApprovalError'; }
}
