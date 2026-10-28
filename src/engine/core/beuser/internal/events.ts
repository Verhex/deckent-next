import { AUDIT_EVENT_SCHEMA_VERSION, auditEventSchema, encodeCommandProjection, type AuditEvent } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import type { BeuserContext } from '#engine/core/beuser-contract/index.js';

export function beuserRefusalEvent(context: BeuserContext, policyRevision: string, atMs: number): AuditEvent {
  const { identity, realmId, nonce } = context.binding;
  return auditEventSchema.parse({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
    eventId: `beuser-refusal:${sha256(encodeCommandProjection('beuser-refusal:1', { identity, realmId, nonce }))}`,
    scopeId: identity.scopeId, principal: { issuer: context.principal.issuer, subject: context.principal.subject }, policyRevision, atMs,
    subject: { kind: 'beuser-target-refusal', code: 'BEUSER_TARGET_NOT_SANDBOX', identity, realmId, nonce } });
}
