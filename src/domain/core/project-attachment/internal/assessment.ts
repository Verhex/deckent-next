import type { FilesystemIdentity } from '#domain/core/primitives/index.js';
import type { AttachmentLocation, ReadableAttachmentLocation, ReadableInstallationRegistration, ReadableProjectAttachment } from './contract.js';

export function assessAttachmentLocation(retained: ReadableAttachmentLocation, observed: AttachmentLocation & { readonly filesystemIdentity?: FilesystemIdentity | null }) {
  if (retained.canonicalRoot !== observed.canonicalRoot || retained.inode !== observed.inode) return false;
  return 'filesystemIdentity' in retained ? retained.filesystemIdentity.kind === observed.filesystemIdentity?.kind
    && retained.filesystemIdentity.value === observed.filesystemIdentity.value : retained.device === observed.device;
}
export const attachmentRegistrationAllowance = (cap: number) => 884 + 51 * Math.floor(cap / 600);
export function normalizeAttachmentRegistration(record: ReadableInstallationRegistration) {
  const { lineage: ignoredLineage, unregistered: ignoredFlag, ...value } = { lineage: undefined, ...record }; void ignoredLineage; void ignoredFlag;
  const location = (item: ReadableAttachmentLocation) => ({ ...item, device: /^\d{1,20}$/.test(item.device) ? '0' : item.device });
  return { ...value, source: { ...value.source, location: location(value.source.location) }, entries: value.entries.map(entry => ({ ...entry,
    attachment: { ...entry.attachment, location: location(entry.attachment.location) }, state: 'active',
    ...(entry.modelLease ? { modelLease: { ...entry.modelLease, state: 'active' } } : {}) })) };
}
export const isNewAttachment = (value: ReadableProjectAttachment | null | undefined) => !!value && (value.schemaVersion === 2 || 'filesystemIdentity' in value.location);
export const isNewAttachmentRegistration = (value: ReadableInstallationRegistration | null | undefined) => !!value && (value.schemaVersion === 3
  || 'filesystemIdentity' in value.source.location || value.entries.some(entry => isNewAttachment(entry.attachment)));
export const isNewerAttachmentVersion = (value: unknown, max: number) => typeof value === 'object' && value !== null && !Array.isArray(value)
  && 'schemaVersion' in value && Number.isInteger(value.schemaVersion) && Number(value.schemaVersion) > max;
export type AttachmentRevocation = Readonly<{ action: 'revoke' | 'detach'; projectId: string } | { action: 'unregister' }>;
/** Only the three answer-104 operations may call the durable writer. Preserve even non-schema key order in its raw input. */
export function attachmentRevocationRecord(record: ReadableInstallationRegistration, change: AttachmentRevocation): ReadableInstallationRegistration {
  if (change.action === 'unregister') {
    if ('unregistered' in record) return { ...record, unregistered: true };
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) { result[key] = value; if (key === 'registrationId') result['unregistered'] = true; }
    return result as ReadableInstallationRegistration;
  }
  return { ...record, entries: record.entries.map(entry => entry.attachment.projectId !== change.projectId ? entry : { ...entry, state: 'revoked',
    ...(change.action === 'detach' && entry.modelLease ? { modelLease: { ...entry.modelLease, state: 'revoked' } } : {}) }) } as ReadableInstallationRegistration;
}
export function isAttachmentRevocationDiff(before: ReadableInstallationRegistration, after: ReadableInstallationRegistration, change: AttachmentRevocation) {
  if (change.action === 'unregister' ? before.entries.some(entry => entry.state !== 'revoked') : !before.entries.some(entry => entry.attachment.projectId === change.projectId)) return false;
  return JSON.stringify(attachmentRevocationRecord(before, change)) === JSON.stringify(after);
}
export function countMismatchedAttachments(record: ReadableInstallationRegistration, projectRoot: string,
  observations: readonly (AttachmentLocation & { readonly filesystemIdentity?: FilesystemIdentity | null } | null)[]) {
  if (record.schemaVersion !== 3 || !record.lineage || record.source.projectRoot !== projectRoot) return 0;
  return record.entries.filter((entry, index) => entry.state === 'active' && (!observations[index] || !assessAttachmentLocation(entry.attachment.location, observations[index]))).length;
}
