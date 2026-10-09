import { randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, type AuditEvent } from '#domain/index.js';

/** Metadata of the installer's planned authority change. The archive holds documents; the sealed ledger holds this event before publication. */
export function installerAuthorityChangeEvent(input: { readonly scopeId: string; readonly caller: { issuer: string; subject: string };
  readonly person: { issuer: string; subject: string }; readonly basis: 'first-run' | 'named-person'; readonly template: { id: string; version: number };
  readonly commandId: string; readonly inputDigest: string; readonly before: string; readonly after: string; readonly grantsAdded: number; readonly atMs: number }): AuditEvent {
  return { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: input.scopeId, principal: { ...input.caller },
    policyRevision: input.before, atMs: input.atMs, subject: { kind: 'authority-change', installer: { basis: input.basis, template: { ...input.template }, person: { ...input.person } },
      commandId: input.commandId, inputDigest: input.inputDigest, revision: { before: input.before, after: input.after },
      counts: { grantsAdded: input.grantsAdded, grantsRemoved: 0, bindingsAdded: 0, bindingsRemoved: 0 } } };
}
