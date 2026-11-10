import { persistedString } from '#platform/index.js';
import { z } from 'zod';
const id = persistedString(z.string().min(1).max(256)), digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const backupCoverageResourceSchema = z.strictObject({ resourceId: id, owner: id, version: id,
  transfer: z.enum(['portable', 'protected-renewable-session', 'non-exportable', 'shared']) }).readonly();
export const backupCoverageManifestSchema = z.strictObject({ schemaVersion: z.literal(1), installationId: id, generation: id,
  planDigest: digest, resources: z.array(backupCoverageResourceSchema).max(10000) }).readonly();
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type BackupCoverageResource = z.infer<typeof backupCoverageResourceSchema>;
export type BackupCoverageManifest = z.infer<typeof backupCoverageManifestSchema>;
/** Trusted owner contribution, never request-supplied executable code. Protected sessions use their existing logout/revoke owner. */
export interface BackupContributionOwner {
  readonly id: string;
  transfer(resourceId: string): BackupCoverageResource['transfer'];
  export(resource: BackupCoverageResource): Promise<Uint8Array>;
  validateRestore(resource: BackupCoverageResource, bytes: Uint8Array): Promise<void>;
  restore(resource: BackupCoverageResource, bytes: Uint8Array): Promise<void>;
}
export function assertBackupCoverage(input: unknown, owners: readonly BackupContributionOwner[]): BackupCoverageManifest {
  const manifest = backupCoverageManifestSchema.parse(input);
  if (new Set(owners.map(owner => owner.id)).size !== owners.length
    || new Set(manifest.resources.map(resource => resource.resourceId)).size !== manifest.resources.length) throw new Error('BACKUP_COVERAGE_INVALID');
  for (const resource of manifest.resources) {
    const owner = owners.find(owner => owner.id === resource.owner);
    if (resource.transfer !== 'portable' || !owner || owner.transfer(resource.resourceId) !== 'portable') throw new Error('BACKUP_COVERAGE_INCOMPLETE');
  }
  return manifest;
}
