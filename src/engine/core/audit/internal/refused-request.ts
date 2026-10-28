import { randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, AUDIT_SHELL_HEAD_MAX_CHARS, auditEventSchema, type AuditEvent } from '#domain/index.js';
import { redactForRecord, sha256, type KnownSecretSnapshot } from '#platform/index.js';
import type { AuditApplication } from './application.js';

type Refusal = Extract<AuditEvent['subject'], { kind: 'run-request-refused' }>;
/** A refused work request as the person sees it again: when, which typed refusal, and the redacted start of what was asked. */
export type RefusedRunRequest = Readonly<{ atMs: number; commandId: string; code: string; title: string }>;
/**
 * BeUser D-08 (lead 2026-10-28): the sealed event of a work request the planner refused before any Run existed. The request text is never kept
 * whole: its digest binds it, and the title is its first characters after known-secret and pattern redaction, on one line.
 */
export function runRequestRefusedEvent(input: { readonly scopeId: string; readonly principal: { readonly issuer: string; readonly subject: string };
  readonly policyRevision: string; readonly commandId: string; readonly request: string; readonly code: string; readonly atMs: number; readonly known?: KnownSecretSnapshot }): AuditEvent {
  const title = redactForRecord(input.request, input.known).replace(/\s+/gu, ' ').trim().slice(0, AUDIT_SHELL_HEAD_MAX_CHARS) || '-';
  const subject: Refusal = { kind: 'run-request-refused', commandId: input.commandId, requestDigest: sha256(input.request), title, code: input.code };
  return auditEventSchema.parse({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: input.scopeId,
    principal: { issuer: input.principal.issuer, subject: input.principal.subject }, policyRevision: input.policyRevision, atMs: input.atMs, subject });
}
/** The newest refused requests of one scope, newest first (verified sealed records only). */
export function listRefusedRunRequests(audit: AuditApplication, scopeId: string, limit: number): readonly RefusedRunRequest[] {
  return audit.listRecentKind(scopeId, 'run-request-refused', 0, limit).map(record => {
    const subject = record.event.subject as Refusal;
    return { atMs: record.event.atMs, commandId: subject.commandId, code: subject.code, title: subject.title };
  });
}
