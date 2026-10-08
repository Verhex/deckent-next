import { z } from 'zod';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { configSections, deepMerge, isRecord, productResourcePath, type ProductLayout, type ProductResource } from '#platform/index.js';
import { readPrivate, refuse } from './files.js';
/** Logical resources, never paths selected by an archive. Worker clones, provider sessions and plaintext approval keys are excluded. */
export const BACKUP_RESOURCES = ['config', 'installationIdentity', 'projectIdentity', 'policy', 'bindings', 'audit', 'artifacts'] as const;
const resource = z.enum(BACKUP_RESOURCES);
const entry = z.object({ resource, path: z.string().max(4096).refine(value => value === '' || value.split('/').every(part =>
  /^[^\\:]+$/.test(part) && Array.from(part).every(char => char.charCodeAt(0) > 31) && part !== '.' && part !== '..' && !part.endsWith('.') && !part.endsWith(' '))), content: z.string() }).strict();
const stateFields = { createdAt: z.string().datetime(), installationId: z.string().min(1),
  projectRoot: z.string().min(1), layoutRoot: z.string().min(1), resources: z.record(z.string()), keyFile: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  entries: z.array(entry) };
/** v1 (alpha.18): `config` is the merged global+project document. v2 (S1 D1): `config` is the project layer alone; `globalConfig` the
 * authored global layer (base64 JSON, null when absent). Both stay readable; the restore splits a v1 document (see `splitArchivedConfig`). */
export const stateSchema = z.discriminatedUnion('schemaVersion', [z.object({ schemaVersion: z.literal(1), ...stateFields }).strict(),
  z.object({ schemaVersion: z.literal(2), ...stateFields, globalConfig: z.string().nullable() }).strict()]);
export type BackupState = z.infer<typeof stateSchema>;
export interface BackupLimits { readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number; readonly maxDepth: number }
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
  for (const required of ['config', 'installationIdentity', 'policy', 'bindings'] as const)
    if (!entries.some(item => item.resource === required)) return refuse('BACKUP_STATE_MISSING');
  const globalConfig = config?.global ? config.global.toString('base64') : null;
  if (globalConfig && total + config!.global!.length > limits.maxTotalBytes) return refuse('BACKUP_LIMIT');
  return gzipSync(JSON.stringify({ schemaVersion: 2, createdAt, installationId, projectRoot, layoutRoot: layout.root,
    resources: layout.resources, keyFile, entries, globalConfig } satisfies BackupState));
}
export function unpackState(bytes: Buffer, limits: BackupLimits): BackupState {
  try {
    // Base64 and JSON overhead are bounded independently from decoded content.
    const state = stateSchema.parse(JSON.parse(gunzipSync(bytes, { maxOutputLength: limits.maxTotalBytes * 2 }).toString('utf8')));
    if (state.entries.length > limits.maxFiles) return refuse('BACKUP_LIMIT');
    let total = 0; const seen = new Set<string>();
    for (const item of state.entries) {
      const id = `${item.resource}/${item.path}`, decoded = Buffer.from(item.content, 'base64');
      if (seen.has(id) || decoded.toString('base64') !== item.content) return refuse('BACKUP_SET_INVALID');
      seen.add(id); total += decoded.length;
      if (decoded.length > limits.maxFileBytes || item.path.split('/').length > limits.maxDepth || total > limits.maxTotalBytes) return refuse('BACKUP_LIMIT');
    }
    for (const required of ['config', 'installationIdentity', 'policy', 'bindings'] as const)
      if (!state.entries.some(item => item.resource === required)) return refuse('BACKUP_SET_INVALID');
    if (state.schemaVersion === 2 && state.globalConfig !== null) {
      const decoded = Buffer.from(state.globalConfig, 'base64');
      if (decoded.toString('base64') !== state.globalConfig || decoded.length > limits.maxFileBytes || total + decoded.length > limits.maxTotalBytes) return refuse('BACKUP_SET_INVALID');
    }
    return state;
  } catch (error) { if (error && typeof error === 'object' && 'code' in error) throw error; return refuse('BACKUP_SET_INVALID'); }
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
type Layer = Record<string, unknown>;
const layer = (bytes: Buffer): Layer => { const value: unknown = JSON.parse(bytes.toString('utf8')); return isRecord(value) ? value : refuse('BACKUP_SET_INVALID'); };
/**
 * S1 D1: the archived configuration as its two authored layers. A v2 set carries them apart. A v1 set carries one merged document: every
 * section a project layer may not hold (a registered `validateLayers` refuses it there, e.g. the installation's `secrets` selection) moves
 * to the global layer; other global settings stay in the project layer, as v1 restored them. Registry-driven, so an Enterprise section
 * with the same rule is handled without editing this code.
 */
export function splitArchivedConfig(state: BackupState): { project: Layer; global: Layer } {
  const item = state.entries.find(entry => entry.resource === 'config' && entry.path === '');
  const project = layer(Buffer.from(item!.content, 'base64')), archived = state.schemaVersion === 2 && state.globalConfig ? layer(Buffer.from(state.globalConfig, 'base64')) : {};
  const moved: Layer = {};
  for (const [name, section] of configSections()) {
    if (!Object.hasOwn(project, name) || !section.options.validateLayers) continue;
    try { section.options.validateLayers(undefined, project[name]); } catch { moved[name] = project[name]; delete project[name]; }
  }
  return { project, global: { ...moved, ...archived } };
}
/** The effective archived document (global under project), for layout and limits before any target state exists. */
export const archivedConfigDocument = (state: BackupState): Layer => { const { project, global } = splitArchivedConfig(state); return deepMerge(global, project); };
