import { lstat, opendir } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import type { BackupContributionOwner, BackupCoverageResource } from '#engine/index.js';
import { sha256 } from '#platform/index.js';
import { readPrivate, writePrivate, safePath, privateDirectory, refuse } from './files.js';
import type { BackupLimits } from './archive.js';
const child = z.string().refine(value => value === '' || !isAbsolute(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.includes('\\')));
const payload = z.object({ schemaVersion: z.literal(1), entries: z.array(z.object({ path: child, directory: z.boolean(), content: z.string().nullable() }).strict()) }).strict();
export interface BackupTreeResource { readonly resourceId: string; readonly path: string }
/** Private portable file trees are encrypted by the existing coverage envelope. This owner never exports unregistered paths. */
export class FileTreeBackupOwner implements BackupContributionOwner {
  readonly id = 'installation-file-tree';
  constructor(private readonly resources: readonly BackupTreeResource[], private readonly limits: BackupLimits) {}
  transfer(resourceId: string) { return this.resources.some(item => item.resourceId === resourceId) ? 'portable' as const : 'shared' as const; }
  private resource(resource: BackupCoverageResource) {
    const found = this.resources.find(item => item.resourceId === resource.resourceId);
    if (!found || resource.owner !== this.id || resource.transfer !== 'portable') return refuse('BACKUP_COVERAGE_INCOMPLETE');
    return found;
  }
  async export(resource: BackupCoverageResource) {
    const root = this.resource(resource).path, entries: z.infer<typeof payload>['entries'] = []; let total = 0;
    const visit = async (path: string, depth: number): Promise<void> => {
      await safePath(path); const info = await lstat(path);
      if (depth > this.limits.maxDepth || entries.length >= this.limits.maxFiles) return refuse('BACKUP_LIMIT');
      if (info.uid !== process.getuid?.() || info.mode & 0o077 || info.isSymbolicLink()) return refuse('BACKUP_PATH_UNSAFE');
      const name = relative(root, path).split(sep).join('/');
      if (info.isDirectory()) {
        entries.push({ path: name, directory: true, content: null });
        for await (const item of await opendir(path)) await visit(join(path, item.name), depth + 1);
        const after = await lstat(path);
        if (after.ino !== info.ino || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) return refuse('BACKUP_STATE_CHANGED');
      } else {
        const bytes = await readPrivate(path, this.limits.maxFileBytes);
        try { total += bytes.length; if (total > this.limits.maxTotalBytes) return refuse('BACKUP_LIMIT');
          entries.push({ path: name, directory: false, content: bytes.toString('base64') });
        } finally { bytes.fill(0); }
      }
    };
    await visit(root, 0); entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return Buffer.from(JSON.stringify({ schemaVersion: 1, entries }));
  }
  private decode(bytes: Uint8Array) {
    if (bytes.byteLength > this.limits.maxTotalBytes * 2) return refuse('BACKUP_LIMIT');
    let parsed: z.infer<typeof payload>;
    try { parsed = payload.parse(JSON.parse(Buffer.from(bytes).toString())); } catch { return refuse('BACKUP_SET_INVALID'); }
    if (!parsed.entries.length || parsed.entries.length > this.limits.maxFiles || !parsed.entries.some(item => item.path === '')
      || new Set(parsed.entries.map(item => item.path)).size !== parsed.entries.length) return refuse('BACKUP_SET_INVALID');
    let total = 0;
    for (const item of parsed.entries) {
      if (item.path.split('/').length > this.limits.maxDepth + 1 || item.directory !== (item.content === null)) return refuse('BACKUP_SET_INVALID');
      if (item.path && !parsed.entries.some(parent => parent.path === (dirname(item.path) === '.' ? '' : dirname(item.path)) && parent.directory)) return refuse('BACKUP_SET_INVALID');
      if (item.content !== null) {
        const decoded = Buffer.from(item.content, 'base64');
        try { total += decoded.length;
          if (decoded.toString('base64') !== item.content || decoded.length > this.limits.maxFileBytes || total > this.limits.maxTotalBytes) return refuse('BACKUP_LIMIT');
        } finally { decoded.fill(0); }
      }
    }
    return parsed;
  }
  async validateRestore(resource: BackupCoverageResource, bytes: Uint8Array) { this.resource(resource); this.decode(bytes); }
  async restore(resource: BackupCoverageResource, bytes: Uint8Array) {
    const root = this.resource(resource).path, parsed = this.decode(bytes);
    await safePath(root);
    // Existing state is never overwritten. The backup command owns relocation/adoption and a person chooses the target.
    if (await lstat(root).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) return refuse('BACKUP_TARGET_NOT_EMPTY');
    for (const item of [...parsed.entries].sort((a, b) => a.path.length - b.path.length)) {
      const path = join(root, ...item.path.split('/').filter(Boolean));
      if (item.directory) await privateDirectory(path);
      else { const decoded = Buffer.from(item.content!, 'base64'); try { await writePrivate(path, decoded); } finally { decoded.fill(0); } }
    }
  }
  async version(resourceId: string) {
    const found = this.resources.find(item => item.resourceId === resourceId); if (!found) return refuse('BACKUP_COVERAGE_INCOMPLETE');
    await safePath(found.path); const info = await lstat(found.path);
    return sha256(JSON.stringify([resourceId, found.path, info.dev, info.ino]));
  }
}
