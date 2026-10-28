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

type Dismissal = Extract<AuditEvent['subject'], { kind: 'delivery-dismissed' }>;
/** BeUser M-33: the sealed event of a person setting a task's undelivered result aside, or bringing it back. */
export function deliveryDismissalEvent(input: { readonly scopeId: string; readonly principal: { readonly issuer: string; readonly subject: string }; readonly policyRevision: string;
  readonly runId: string; readonly taskId: string; readonly attemptId: string; readonly action: Dismissal['action']; readonly atMs: number }): AuditEvent {
  const subject: Dismissal = { kind: 'delivery-dismissed', runId: input.runId, taskId: input.taskId, attemptId: input.attemptId, action: input.action };
  return auditEventSchema.parse({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: input.scopeId,
    principal: { issuer: input.principal.issuer, subject: input.principal.subject }, policyRevision: input.policyRevision, atMs: input.atMs, subject });
}
/** The tasks of one scope whose latest dismissal record is `dismiss` (newest records first, at most `limit` read). */
export function dismissedDeliveries(audit: AuditApplication, scopeId: string, limit: number): readonly Readonly<{ runId: string; taskId: string; atMs: number }>[] {
  const latest = new Map<string, Readonly<{ runId: string; taskId: string; atMs: number; action: string }>>();
  for (const record of audit.listRecentKind(scopeId, 'delivery-dismissed', 0, limit)) {
    const subject = record.event.subject as Dismissal, key = `${subject.runId}\0${subject.taskId}`;
    if (!latest.has(key)) latest.set(key, { runId: subject.runId, taskId: subject.taskId, atMs: record.event.atMs, action: subject.action });
  }
  return [...latest.values()].filter(row => row.action === 'dismiss').map(({ runId, taskId, atMs }) => ({ runId, taskId, atMs }));
}
