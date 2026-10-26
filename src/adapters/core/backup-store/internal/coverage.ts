import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { assertBackupCoverage, backupCoverageManifestSchema, type BackupCoverageManifest, type BackupContributionOwner } from '#engine/index.js';
import { sha256 } from '#platform/index.js';
import { verifyBackupSet } from './set.js';
import type { BackupLimits } from './archive.js';
import { encryptBackupContribution, decryptBackupContribution } from './crypto.js';
import { inside, readPrivate, safePath, writePrivate, refuse } from './files.js';
import policyData from './coverage-limits.json' with { type: 'json' };
const coverageLimits = z.object({ schemaVersion: z.literal(1), encryptedJsonExpansion: z.number().int().positive().safe() }).strict().parse(policyData);
const payloadSchema = z.object({ schemaVersion: z.literal(1), manifest: backupCoverageManifestSchema,
  ledgerDigest: z.string().regex(/^[a-f0-9]{64}$/u), setDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  entries: z.array(z.object({ resourceId: z.string(), content: z.string(), digest: z.string() }).strict()) }).strict();
export interface BackupCoverageRequest {
  readonly set: string; readonly companion: string; readonly manifest: BackupCoverageManifest;
  readonly deletionRoots: readonly string[];
}
function admitted(input: BackupCoverageRequest, owners: readonly BackupContributionOwner[]) {
  try { return assertBackupCoverage(input.manifest, owners); } catch { return refuse('BACKUP_COVERAGE_INCOMPLETE'); }
}
async function paths(input: BackupCoverageRequest) {
  if (!process.getuid || typeof constants.O_NOFOLLOW !== 'number') return refuse('BACKUP_PATH_UNSAFE');
  if (!input.deletionRoots.length) return refuse('BACKUP_PATH_UNSAFE');
  for (const root of input.deletionRoots) {
    await safePath(root);
    if (inside(resolve(root), resolve(input.set)) || inside(resolve(input.set), resolve(root)) || inside(resolve(root), resolve(input.companion))) return refuse('BACKUP_PATH_UNSAFE');
  }
  await safePath(input.companion);
  // Companion is external to the immutable v1/v2 backup set, so older verification remains unchanged.
  if (inside(resolve(input.set), resolve(input.companion))) return refuse('BACKUP_PATH_UNSAFE');
}
const aad = (manifest: BackupCoverageManifest, ledgerDigest: string, setDigest: string) => JSON.stringify({ domain: 'backup-coverage:1', manifest, ledgerDigest, setDigest });
/** Called under the backup owner's lifecycle snapshot custody and governed create/verify authorization, before any purge effect. */
export async function createBackupCoverage(input: BackupCoverageRequest, passphrase: string, limits: BackupLimits,
  owners: readonly BackupContributionOwner[], withSnapshot: <T>(work: () => Promise<T>) => Promise<T>) {
  const manifest = admitted(input, owners); await paths(input);
  return withSnapshot(async () => {
    const base = await verifyBackupSet(input.set, passphrase, limits);
    try {
      if (base.state.installationId !== manifest.installationId) return refuse('BACKUP_COVERAGE_INCOMPLETE');
      const setDigest = sha256(await readPrivate(join(input.set, 'MANIFEST.sha256'), 4096));
      const entries: z.infer<typeof payloadSchema>['entries'] = []; let total = 0;
      if (manifest.resources.length > limits.maxFiles) return refuse('BACKUP_LIMIT');
      for (const resource of manifest.resources) {
        const bytes = Buffer.from(await owners.find(owner => owner.id === resource.owner)!.export(resource));
        try {
          total += bytes.length;
          if (bytes.length > limits.maxFileBytes || total > limits.maxTotalBytes) return refuse('BACKUP_LIMIT');
          entries.push({ resourceId: resource.resourceId, content: bytes.toString('base64'), digest: sha256(bytes) });
        } finally { bytes.fill(0); }
      }
      const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, manifest, ledgerDigest: base.ledgerDigest, setDigest, entries }));
      try { await writePrivate(input.companion, await encryptBackupContribution(payload, passphrase, aad(manifest, base.ledgerDigest, setDigest))); }
      finally { payload.fill(0); }
      return { schemaVersion: 1 as const, manifest, ledgerDigest: base.ledgerDigest, setDigest, companion: input.companion };
    } finally { base.close(); }
  });
}
/** Verify every owner and exact manifest before returning data or restoring anything. Possessing a path grants no restore authority. */
export async function verifyBackupCoverage(input: BackupCoverageRequest, passphrase: string, limits: BackupLimits, owners: readonly BackupContributionOwner[]) {
  const manifest = admitted(input, owners); await paths(input);
  const base = await verifyBackupSet(input.set, passphrase, limits);
  try {
    if (base.state.installationId !== manifest.installationId) return refuse('BACKUP_COVERAGE_INCOMPLETE');
    const setDigest = sha256(await readPrivate(join(input.set, 'MANIFEST.sha256'), 4096));
    const encrypted = await readPrivate(input.companion, limits.maxTotalBytes * coverageLimits.encryptedJsonExpansion);
    const bytes = await decryptBackupContribution(encrypted.toString('utf8'), passphrase, aad(manifest, base.ledgerDigest, setDigest), limits.maxTotalBytes * 2);
    try {
      let payload: z.infer<typeof payloadSchema>;
      try { payload = payloadSchema.parse(JSON.parse(bytes.toString('utf8'))); } catch { return refuse('BACKUP_SET_INVALID'); }
      if (JSON.stringify(payload.manifest) !== JSON.stringify(manifest) || payload.ledgerDigest !== base.ledgerDigest || payload.setDigest !== setDigest
        || payload.entries.length !== manifest.resources.length || payload.entries.length > limits.maxFiles) return refuse('BACKUP_COVERAGE_INCOMPLETE');
      const restored: { resource: BackupCoverageManifest['resources'][number]; bytes: Buffer }[] = []; let total = 0;
      try {
        for (const resource of manifest.resources) {
          const matches = payload.entries.filter(entry => entry.resourceId === resource.resourceId);
          if (matches.length !== 1) return refuse('BACKUP_COVERAGE_INCOMPLETE');
          const entry = matches[0]!, decoded = Buffer.from(entry.content, 'base64');
          restored.push({ resource, bytes: decoded }); total += decoded.length;
          if (decoded.length > limits.maxFileBytes || total > limits.maxTotalBytes || decoded.toString('base64') !== entry.content || sha256(decoded) !== entry.digest) return refuse('BACKUP_SET_INVALID');
          try { await owners.find(owner => owner.id === resource.owner)!.validateRestore(resource, decoded); } catch { return refuse('BACKUP_COVERAGE_INCOMPLETE'); }
        }
        let closed = false;
        return { manifest, ledgerDigest: base.ledgerDigest,
          async restore() {
            if (closed) return refuse('BACKUP_SET_INVALID');
            try {
              admitted(input, owners);
              try { for (const entry of restored) await owners.find(owner => owner.id === entry.resource.owner)!.validateRestore(entry.resource, entry.bytes); }
              catch { return refuse('BACKUP_COVERAGE_INCOMPLETE'); }
              try { for (const entry of restored) await owners.find(owner => owner.id === entry.resource.owner)!.restore(entry.resource, entry.bytes); }
              catch { return refuse('BACKUP_RESTORE_INCOMPLETE'); }
            }
            finally { closed = true; restored.forEach(entry => entry.bytes.fill(0)); }
          },
          close() { closed = true; restored.forEach(entry => entry.bytes.fill(0)); },
        };
      } catch (error) { restored.forEach(entry => entry.bytes.fill(0)); throw error; }
    } finally { bytes.fill(0); }
  } finally { base.close(); }
}
