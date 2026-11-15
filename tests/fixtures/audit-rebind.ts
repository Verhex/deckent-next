import { encodeCommandProjection, type AuditEvent, type AuditRecord, type InstallationBinding } from '#domain/index.js';
import type { IntegrityAuthority } from '#platform/index.js';

export type RebindSubject = Extract<AuditEvent['subject'], { kind: 'installation-rebind' }>;
export const rebindIds = { operation: '00000000-0000-4000-8000-000000000001', installation: '00000000-0000-4000-8000-000000000002',
  nextInstallation: '00000000-0000-4000-8000-000000000003', project: '00000000-0000-4000-8000-000000000004' };
// Synthetic retained bindings, not a capture, account or real path. Only their keyed identities enter the fixture event.
const retained: InstallationBinding = { schemaVersion: 2, strength: 'machine', source: 'platform', machineDigest: 'a'.repeat(64),
  canonicalRoot: '/synthetic-installation', device: '10', inode: '20' };
export function rebindSubject(integrity: IntegrityAuthority, scopeId: string, changes: Partial<RebindSubject> = {}): RebindSubject {
  const opaque = (binding: InstallationBinding) => ({ keyId: integrity.keyId,
    digest: integrity.sign(encodeCommandProjection('installation-binding:1/' + scopeId, binding)) });
  return { kind: 'installation-rebind', schemaVersion: 1, operationId: rebindIds.operation, part: 'source', transition: 'keep', phase: 'succeeded',
    class: 'device-only', admission: { basis: 'open-class' }, failure: null,
    previousInstallationId: rebindIds.installation, installationId: rebindIds.installation, projectId: null,
    previousBinding: opaque(retained), binding: opaque({ ...retained, device: '30' }), changedFields: ['device'], attachments: { waiting: 2 }, ...changes };
}
export function rebindEvent(integrity: IntegrityAuthority, scopeId: string, n: number, changes: Partial<RebindSubject> = {}): AuditEvent {
  return { schemaVersion: 1, eventId: `${scopeId}-rebind-${n}`, scopeId, principal: { issuer: 'os', subject: 'fixture-operator' }, policyRevision: 'p7',
    atMs: 1_700_000_000_000 + n, subject: rebindSubject(integrity, scopeId, changes) };
}
/** beta.2.1-written fixture only. Production sealAuditRecord must continue refusing these events. */
export function sealFutureAuditFixture(event: AuditEvent, sequence: number, integrity: IntegrityAuthority): AuditRecord {
  const signed = { event, sequence, keyId: integrity.keyId };
  return { ...signed, mac: integrity.sign(encodeCommandProjection('audit-record:1', signed)) };
}
