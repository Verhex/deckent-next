import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createBackupCoverage, verifyBackupCoverage, type BackupLimits } from '#adapters/core/backup-store/index.js';
import { pathWithin, sha256 } from '#platform/index.js';
import { PROJECT_VAULT, type BackupContributionOwner, type BackupCoverageManifest } from '#engine/index.js';
import { fileDigest, memberStat, type DataRemovalMember, type DataRemovalSnapshot } from './data.js';
import { removalRegistry } from './inventory.js';
const { owner: OWNER, companionSuffix, manifestSuffix } = removalRegistry.archive;
const absent = (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; };
/** One archived file: `<mode>:<absolute path>\0<bytes>`; the resource id is the path's digest, its version the bytes' digest. A path outside the
 * caller's roots (the project folder and the vault folder of the global home) is never written. */
function owner(roots: readonly string[], members: ReadonlyMap<string, string>): BackupContributionOwner {
  const open = (resourceId: string, bytes: Uint8Array) => { const all = Buffer.from(bytes), at = all.indexOf(0), head = all.subarray(0, at).toString('utf8'), colon = head.indexOf(':');
    const path = head.slice(colon + 1), content = all.subarray(at + 1);
    if (at < 0 || sha256(path) !== resourceId || !isAbsolute(path) || !roots.some(root => pathWithin(root, path) && root !== path)) throw new Error('UNINSTALL_ARCHIVE_INVALID');
    return { path, content, mode: Number.parseInt(head.slice(0, colon), 8) & 0o755 }; };
  return { id: OWNER, transfer: () => 'portable',
    async export(resource) {
      const path = members.get(resource.resourceId)!, info = await memberStat(path, true), bytes = await readFile(path);
      if (!info || sha256(bytes) !== resource.version) throw new Error('UNINSTALL_ARCHIVE_CHANGED');
      return Buffer.concat([Buffer.from(`${(info.mode & 0o777).toString(8)}:${path}\0`), bytes]);
    },
    async validateRestore(resource, bytes) { if (sha256(open(resource.resourceId, bytes).content) !== resource.version) throw new Error('UNINSTALL_ARCHIVE_INVALID'); },
    // Restore never overwrites: a file that exists again (the semantic restore's own, or the person's) stays as it is.
    async restore(resource, bytes) {
      const { path, content, mode } = open(resource.resourceId, bytes);
      if (await lstat(path).catch(absent)) return;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, content, { mode, flag: 'wx' });
    } };
}
/**
 * K7 uninstall archive (lead 2026-10-27): every file a tier deletes outside the semantic backup set goes into the backup owner's encrypted
 * coverage companion of the verified final set (same passphrase and envelope), bound to the confirmed plan D0, then verified by re-reading
 * and decrypting it with each file's digest checked; the returned snapshot binds every file to those bytes before the first deletion.
 */
export async function createUninstallArchive(set: string, roots: readonly string[], members: readonly DataRemovalMember[], ids: { installationId: string; approved: string; plan: string },
  passphrase: string, limits: BackupLimits): Promise<DataRemovalSnapshot['members']> {
  const byId = new Map(members.map(member => [sha256(member.path), member.path])), bound: DataRemovalSnapshot['members'][number][] = [];
  const resources: BackupCoverageManifest['resources'][number][] = [];
  for (const [resourceId, path] of byId) {
    const info = await memberStat(path, true);
    if (!info) continue;
    const digest = await fileDigest(path);
    resources.push({ resourceId, owner: OWNER, version: digest, transfer: 'portable' });
    bound.push({ path, digest, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, directory: null, archived: true });
  }
  const manifest = { schemaVersion: 1 as const, installationId: ids.installationId, generation: ids.plan, planDigest: ids.approved, resources };
  const input = { set, companion: set + companionSuffix, manifest, deletionRoots: roots }, owners = [owner(roots, byId)];
  await createBackupCoverage(input, passphrase, limits, owners, work => work());
  (await verifyBackupCoverage(input, passphrase, limits, owners)).close();
  await writeFile(set + manifestSuffix, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
  return bound;
}
/** `deckent backup restore <set>` brings back the archive written beside that set: only files that do not exist again are written. */
export async function restoreUninstallArchive(set: string, roots: readonly string[], passphrase: string, limits: BackupLimits) {
  const text = await readFile(set + manifestSuffix, 'utf8').catch(absent);
  if (text === null) return false;
  const input = { set, companion: set + companionSuffix, manifest: JSON.parse(text) as BackupCoverageManifest, deletionRoots: roots };
  await (await verifyBackupCoverage(input, passphrase, limits, [owner(roots, new Map())])).restore();
  return true;
}
export const hasUninstallArchive = (set: string) => existsSync(set + manifestSuffix);
/** The folders an uninstall archive may write back into: the project folder and the vault folder of the person's global home. */
export const uninstallArchiveRoots = (projectRoot: string, globalRoot: string) => [projectRoot, join(globalRoot, PROJECT_VAULT.directory)];
