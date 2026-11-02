import { BACKUP_RESOURCES, packBackupState, type BackupState, type BackupLimits } from '#engine/index.js';
export { splitArchivedConfig, archivedConfigDocument, BACKUP_RESOURCES, packBackupState, unpackBackupState as unpackState } from '#engine/index.js';
export type { BackupState, BackupLimits } from '#engine/index.js';
import { productResourcePath, type ProductLayout, type ProductResource } from '#platform/index.js';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { readPrivate, refuse } from './files.js';
export async function archiveState(layout: ProductLayout, projectRoot: string, installationId: string, keyFile: string,
  limits: BackupLimits, createdAt: string, config?: BackupConfigLayers): Promise<Buffer> {
  const entries: BackupState['entries'] = []; let total = 0, visited = 0;
  async function collect(resource: typeof BACKUP_RESOURCES[number], file: string, path: string, depth: number) {
    if (++visited > limits.maxFiles || depth > limits.maxDepth || entries.length >= limits.maxFiles) return refuse('BACKUP_LIMIT');
    const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return;
    if (info.isDirectory()) {
      if (info.uid !== process.getuid?.() || (info.mode & 0o022)) return refuse('BACKUP_DIRECTORY_UNSAFE', { path: file });
      const names: string[] = [];
      for await (const item of await opendir(file)) { if (names.length >= limits.maxFiles) return refuse('BACKUP_LIMIT'); names.push(item.name); }
      for (const name of names.sort()) await collect(resource, join(file, name), path ? path + '/' + name : name, depth + 1);
      const after = await lstat(file);
      if (after.ino !== info.ino || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) return refuse('BACKUP_STATE_CHANGED');
    } else {
      if (!info.isFile()) return refuse('BACKUP_PATH_UNSAFE');
      const bytes = resource === 'config' && config ? config.project : await readPrivate(file, limits.maxFileBytes); total += bytes.length;
      if (total > limits.maxTotalBytes) return refuse('BACKUP_LIMIT');
      entries.push({ resource, path, content: bytes.toString('base64') });
    }
  }
  for (const resource of BACKUP_RESOURCES) await collect(resource, productResourcePath(layout, resource), '', 0);
  return packBackupState({ createdAt, installationId, projectRoot, layoutRoot: layout.root, resources: layout.resources, keyFile }, entries, config?.global ?? null, total, limits.maxTotalBytes);
}
export const directoryResources = new Set<ProductResource>(['installationIdentity', 'projectIdentity', 'audit', 'artifacts']);
export interface BackupConfigLayers { readonly project: Buffer; readonly global: Buffer | null }
/** The authored layers, each as written (no secret reference resolved, nothing merged): the project layer and the per-user global layer. */
export async function readBackupConfig(projectPath: string, globalPath: string, limits: BackupLimits): Promise<BackupConfigLayers> {
  const read = async (path: string) => {
    try { return JSON.parse((await readPrivate(path, limits.maxFileBytes)).toString('utf8')) as unknown; }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  };
  const [project, global] = [await read(projectPath), await read(globalPath)];
  const bytes = (value: unknown) => { const out = Buffer.from(JSON.stringify(value)); return out.length > limits.maxFileBytes ? refuse('BACKUP_LIMIT') : out; };
  return { project: bytes(project ?? {}), global: global === null ? null : bytes(global) };
}
