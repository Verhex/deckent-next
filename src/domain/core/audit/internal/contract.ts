import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Versioned audit event contract (general Core audit port, first slice — owner 2026-09-27 q4/q5). */
export const AUDIT_EVENT_SCHEMA_VERSION = 1;
export const AUDIT_SHELL_HEAD_MAX_CHARS = 200;
/** Who the decision was made for: exact issuer and subject; a persona is never part of the record. */
export const auditPrincipalSchema = z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly();
/**
 * What the event summarizes — never the raw command or file content (design note §4): an edit names its workspace-relative
 * path; a shell call keeps the first `AUDIT_SHELL_HEAD_MAX_CHARS` characters (the approval subject's head) and the argument digest.
 */
export const auditSummarySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('shell'), head: z.string().min(1).max(AUDIT_SHELL_HEAD_MAX_CHARS), argsDigest: digest }).strict(),
]);
/** The person's terminal permission modes (domain policy catalog; the audit contract keeps its own copy to stay dependency-free). */
const permissionMode = z.enum(['ask', 'auto-edit', 'full-auto']);
/**
 * A silent decision produced by the terminal permission mode (slice 4): the mode relaxed a cell the company policy marked
 * mode-eligible, turning `require-approval` into `allow` for exactly this tool call. Other subject kinds join this union as
 * further Core decisions gain an audit record; a SIEM adapter reads them all through the same port.
 */
export const auditSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('permission-mode'), mode: z.enum(['auto-edit', 'full-auto']), cell: z.enum(['edit-non-floor', 'shell-modify']),
    tool: z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), version: counterSchema.positive() }).strict(),
    call: z.object({ turnId: identitySchema, round: counterSchema.positive(), index: counterSchema, callId: identitySchema }).strict(),
    grants: z.object({ company: identitySchema, person: identitySchema }).strict(),
    decision: z.object({ previous: z.literal('require-approval'), next: z.literal('allow') }).strict(),
    summary: auditSummarySchema }).strict(),
  /**
   * A person's request to set their own terminal permission mode (slice 4c): the authorization decision on `permission-mode`/`set`
   * and, when allowed, the bindings revision it writes (`after` null: nothing was written — refused or already that mode). Recorded
   * before the bindings file is replaced; no record, no change.
   */
  z.object({ kind: z.literal('permission-mode-change'), requested: permissionMode, previous: permissionMode,
    decision: z.object({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }).strict(),
    bindingsRevision: z.object({ before: identitySchema, after: identitySchema.nullable() }).strict() }).strict(),
  /**
   * An applied governed authority change (POLICY-ADMIN P3, `policy.administer@1`): the command and the approval it consumed, who decided
   * it (the delegation bound is that person's authority, I3), the effective revision before and after, the change's size and the digest
   * of its canonical input — never the grants themselves (the revision archive keeps the documents). Recorded before any file changes.
   */
  z.object({ kind: z.literal('authority-change'), operation: z.object({ id: identitySchema, version: counterSchema.positive() }).strict(),
    commandId: identitySchema, approvalId: identitySchema, decider: auditPrincipalSchema, inputDigest: digest,
    revision: z.object({ before: identitySchema, after: identitySchema }).strict(),
    counts: z.object({ grantsAdded: counterSchema, grantsRemoved: counterSchema, bindingsAdded: counterSchema, bindingsRemoved: counterSchema }).strict() }).strict(),
  /**
   * A refused authority change (POLICY-HARDEN P3-R): where it stopped (`decide` = an approval surface that may not decide authority
   * approvals, `submit` = before any intent, `settle` = a claimed intent refused terminally at the effect), the stable refusal code and the
   * command; `approvalId`/`decider` are null while none exists. Nothing of the change itself is recorded.
   */
  z.object({ kind: z.literal('authority-refusal'), stage: z.enum(['decide', 'submit', 'settle']), code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    operation: z.object({ id: identitySchema, version: counterSchema.positive() }).strict(), commandId: identitySchema.nullable(), approvalId: identitySchema.nullable(),
    decider: auditPrincipalSchema.nullable() }).strict(),
]);
export const auditEventSchema = z.object({ schemaVersion: z.literal(AUDIT_EVENT_SCHEMA_VERSION), eventId: identitySchema, scopeId: identitySchema,
  principal: auditPrincipalSchema, policyRevision: identitySchema, atMs: counterSchema, subject: auditSubjectSchema }).strict().readonly();
/** The durable, sealed form: the event, its scope-local sequence and the key that sealed both (the approval MAC line). */
export const auditRecordSchema = z.object({ event: auditEventSchema, sequence: counterSchema.positive(), keyId: identitySchema, mac: digest }).strict().readonly();
/** Summary counters (owner q5: decisions that were silent already are counted, not recorded): mutable totals, not evidence. */
export const auditCounterSchema = z.object({ scopeId: identitySchema, counter: identitySchema, count: counterSchema, updatedAtMs: counterSchema }).strict().readonly();
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditSubject = z.infer<typeof auditSubjectSchema>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;
export type AuditCounter = z.infer<typeof auditCounterSchema>;
export class AuditError extends Error {
  constructor(readonly code: 'AUDIT_INVALID' | 'AUDIT_INTEGRITY' | 'AUDIT_CONFLICT' | 'AUDIT_UNAVAILABLE') { super(code); this.name = 'AuditError'; }
}
