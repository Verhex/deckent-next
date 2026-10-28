import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createBackupCoverage, verifyBackupCoverage, type BackupLimits } from '#adapters/core/backup-store/index.js';
import { pathWithin, sha256, readPinnedFile, restorePinnedFile, lineCut, ErrorRegistry } from '#platform/index.js';
import { PROJECT_VAULT, type BackupContributionOwner, type BackupCoverageManifest } from '#engine/index.js';
import { memberStat, type BoundMember, type DataRemovalMember } from './data.js';
import { removalRegistry } from './inventory.js';
import { instructionTrustDirectory } from '#adapters/core/project-instructions/index.js';
const { owner: OWNER, companionSuffix, manifestSuffix } = removalRegistry.archive;
const absent = (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; };
/** One archived file: `<mode>:<result digest of its cut, or empty>:<1 when the standard set restores it too>:<absolute path>\0<bytes>`; the resource id is the path's digest, its version the
 * bytes' digest. A path outside the caller's roots (the project folder and the vault folder of the global home) is never written. */
function owner(roots: readonly string[], members: ReadonlyMap<string, BoundMember>, kept: string[] = []): BackupContributionOwner {
  const open = (resourceId: string, bytes: Uint8Array) => { const all = Buffer.from(bytes), at = all.indexOf(0), [mode = '', after = '', standard = '', ...rest] = all.subarray(0, at).toString('utf8').split(':');
    const path = rest.join(':'), content = all.subarray(at + 1);
    if (at < 0 || sha256(path) !== resourceId || !isAbsolute(path) || !roots.some(root => pathWithin(root, path) && root !== path)) throw new Error('UNINSTALL_ARCHIVE_INVALID');
    return { path, content, after, standard: !!standard, mode: Number.parseInt(mode, 8) & 0o755 }; };
  return { id: OWNER, transfer: () => 'portable',
    async export(resource) {
      const member = members.get(resource.resourceId)!, read = await readPinnedFile(member.path);
      if (!read || read.identity.digest !== resource.version) throw new Error('UNINSTALL_ARCHIVE_CHANGED');
      return Buffer.concat([Buffer.from(`${read.mode.toString(8)}:${member.after ?? ''}:${member.standard ? 1 : ''}:${member.path}\0`), read.bytes]); },
    async validateRestore(resource, bytes) { if (sha256(open(resource.resourceId, bytes).content) !== resource.version) throw new Error('UNINSTALL_ARCHIVE_INVALID'); },
    // Restore never writes over a file the person has, nor through a link: a missing file comes back, a file whose line uninstall cut gets its
    // earlier bytes back only while it still holds exactly uninstall's result; anything else (other bytes, unreadable, linked) is kept and reported.
    async restore(resource, bytes) {
      const { path, content, mode, after, standard } = open(resource.resourceId, bytes);
      // A file the standard set restored first (config) is that restore's own: it is not reported as kept.
      if (await restorePinnedFile(path, content, mode, roots.find(root => pathWithin(root, path) && root !== path)!, after || undefined) === 'kept' && !(standard && await readPinnedFile(path).catch(() => null))) kept.push(path); } };
}
/** K7 uninstall archive (lead 2026-10-27): every file a tier deletes outside the semantic set goes into the backup owner's encrypted coverage
 * companion of the set (same passphrase and envelope), bound to D0, verified by re-reading and decrypting it with each file's digest checked;
 * the returned members bind every file (and a bridge's exact cut) to those bytes. */
export async function createUninstallArchive(set: string, roots: readonly string[], members: readonly DataRemovalMember[], ids: { installationId: string; approved: string; plan: string },
  passphrase: string, limits: BackupLimits, standard: (path: string) => boolean = () => false) {
  const byId = new Map<string, BoundMember>(), resources: BackupCoverageManifest['resources'][number][] = [];
  for (const member of members) {
    const read = await memberStat(member.path, true) && await readPinnedFile(member.path); if (!read) continue;
    const cut = member.line ? lineCut(read.bytes, member.line, member.before) : null;
    if (member.line && !cut) throw new Error('UNINSTALL_ARCHIVE_CHANGED');
    byId.set(sha256(member.path), { path: member.path, ...read.identity, directory: member.directory, archived: true, ...(standard(member.path) ? { standard: true } : {}), ...(cut ? { cut: cut.cut, after: cut.after } : {}) });
    resources.push({ resourceId: sha256(member.path), owner: OWNER, version: read.identity.digest, transfer: 'portable' });
  }
  const manifest = { schemaVersion: 1 as const, installationId: ids.installationId, generation: ids.plan, planDigest: ids.approved, resources };
  const input = { set, companion: set + companionSuffix, manifest, deletionRoots: roots }, owners = [owner(roots, byId)];
  await createBackupCoverage(input, passphrase, limits, owners, work => work());
  (await verifyBackupCoverage(input, passphrase, limits, owners)).close();
  const text = JSON.stringify(manifest); await writeFile(set + manifestSuffix, text, { mode: 0o600, flag: 'wx' });
  return { members: [...byId.values()], archive: { digest: sha256(text), roots } };
}
/** M2: before a resumed tail deletes anything, the archive beside the final set is exactly the one the intent bound, names every archived
 * member's bytes and decrypts and verifies with the person's passphrase. */
export async function verifyUninstallArchive(set: string, archive: { readonly digest: string; readonly roots: readonly string[] }, members: readonly BoundMember[], passphrase: string, limits: BackupLimits) {
  const text = await readFile(set + manifestSuffix, 'utf8').catch(() => ''), manifest = sha256(text) === archive.digest ? JSON.parse(text) as BackupCoverageManifest : null;
  if (!manifest || members.some(member => member.archived && !manifest.resources.some(item => item.resourceId === sha256(member.path) && item.version === member.digest))) throw new Error('UNINSTALL_ARCHIVE_INVALID');
  (await verifyBackupCoverage({ set, companion: set + companionSuffix, manifest, deletionRoots: archive.roots }, passphrase, limits, [owner(archive.roots, new Map())])).close();
}
/** `deckent backup restore <set>` brings back the archive written beside that set: only files that do not exist again are written. */
export async function restoreUninstallArchive(set: string, roots: readonly string[], passphrase: string, limits: BackupLimits) {
  const text = await readFile(set + manifestSuffix, 'utf8').catch(absent); if (text === null) return false;
  const input = { set, companion: set + companionSuffix, manifest: JSON.parse(text) as BackupCoverageManifest, deletionRoots: roots }, kept: string[] = [];
  await (await verifyBackupCoverage(input, passphrase, limits, [owner(roots, new Map(), kept)])).restore();
  if (kept.length) throw ErrorRegistry.createError('UNINSTALL_RESTORE_KEPT', { params: { paths: kept.join(', ') } }); return true;
}
export const hasUninstallArchive = (set: string) => existsSync(set + manifestSuffix);
/** The folders an uninstall archive may write back into: the project folder, the vault folder of the person's global home and the trust store. */
export const uninstallArchiveRoots = (projectRoot: string, globalRoot: string, env: Readonly<Record<string, string | undefined>> = process.env) =>
  [projectRoot, join(globalRoot, PROJECT_VAULT.directory), instructionTrustDirectory(env)];
