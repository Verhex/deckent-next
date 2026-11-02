import { configSections, deepMerge, persistedString, persistedDateTime, isRecord, ErrorRegistry } from '#platform/index.js';
import { z } from 'zod';
import { gzipSync, gunzipSync } from 'node:zlib';
const refuse = (code: 'BACKUP_LIMIT' | 'BACKUP_SET_INVALID' | 'BACKUP_STATE_MISSING'): never => { throw ErrorRegistry.createError(code); };
const layer = (bytes: Buffer): Record<string, unknown> => { const value: unknown = JSON.parse(bytes.toString('utf8')); return isRecord(value) ? value : refuse('BACKUP_SET_INVALID'); };
/** Logical resources, never paths selected by an archive. Worker clones, provider sessions and plaintext approval keys are excluded. */
export const BACKUP_RESOURCES = ['config', 'installationIdentity', 'projectIdentity', 'projectAttachment', 'policy', 'bindings', 'audit', 'artifacts'] as const;
const resource = z.enum(BACKUP_RESOURCES);
const entry = z.strictObject({ resource, path: persistedString(z.string().max(4096)).refine(value => value === '' || value.split('/').every(part =>
  /^[^\\:]+$/.test(part) && Array.from(part).every(char => char.charCodeAt(0) > 31) && part !== '.' && part !== '..' && !part.endsWith('.') && !part.endsWith(' '))), content: z.string() });
const stateFields = { createdAt: persistedDateTime(), installationId: persistedString(z.string().min(1)),
  projectRoot: persistedString(z.string().min(1)), layoutRoot: persistedString(z.string().min(1)), resources: z.record(z.string(), z.string()), keyFile: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  entries: z.array(entry) };
/** v1 (alpha.18): `config` is the merged global+project document. v2 (S1 D1): `config` is the project layer alone; `globalConfig` the
 * authored global layer (base64 JSON, null when absent). Both stay readable; the restore splits a v1 document (see `splitArchivedConfig`). */
export const backupStateSchema = z.discriminatedUnion('schemaVersion', [z.strictObject({ schemaVersion: z.literal(1), ...stateFields }),
  z.strictObject({ schemaVersion: z.literal(2), ...stateFields, globalConfig: z.string().nullable() }),
  z.strictObject({ schemaVersion: z.literal(3), ...stateFields, sharedRegistrationId: z.string().uuid(), globalConfig: z.null() })]);
export type BackupState = z.infer<typeof backupStateSchema>;
export interface BackupLimits { readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number; readonly maxDepth: number }
export function unpackBackupState(bytes: Buffer, limits: BackupLimits): BackupState {
  try {
    // Base64 and JSON overhead are bounded independently from decoded content.
    const state = backupStateSchema.parse(JSON.parse(gunzipSync(bytes, { maxOutputLength: limits.maxTotalBytes * 2 }).toString('utf8')));
    if (state.entries.length > limits.maxFiles) return refuse('BACKUP_LIMIT');
    let total = 0; const seen = new Set<string>();
    for (const item of state.entries) {
      const id = `${item.resource}/${item.path}`, decoded = Buffer.from(item.content, 'base64');
      if (seen.has(id) || decoded.toString('base64') !== item.content) return refuse('BACKUP_SET_INVALID');
      seen.add(id); total += decoded.length;
      if (decoded.length > limits.maxFileBytes || item.path.split('/').length > limits.maxDepth || total > limits.maxTotalBytes) return refuse('BACKUP_LIMIT');
    }
    if (state.schemaVersion !== 3 && state.entries.some(item => item.resource === 'projectAttachment')) return refuse('BACKUP_SET_INVALID');
    if (state.schemaVersion === 3 && state.entries.some(item => item.resource === 'installationIdentity')) return refuse('BACKUP_SET_INVALID');
    for (const required of state.schemaVersion === 3 ? ['config', 'projectIdentity', 'projectAttachment', 'policy', 'bindings'] : ['config', 'installationIdentity', 'policy', 'bindings'])
      if (!state.entries.some(item => item.resource === required)) return refuse('BACKUP_SET_INVALID');
    if (state.schemaVersion === 3) {
      const document = layer(Buffer.from(state.entries.find(item => item.resource === 'config')!.content, 'base64'));
      const reference = layer(Buffer.from(state.entries.find(item => item.resource === 'projectAttachment')!.content, 'base64'));
      if (!isRecord(document['installation']) || document['installation']['sharedRegistrationId'] !== state.sharedRegistrationId || reference['registrationId'] !== state.sharedRegistrationId) return refuse('BACKUP_SET_INVALID');
    }
    if (state.schemaVersion === 2 && state.globalConfig !== null) {
      const decoded = Buffer.from(state.globalConfig, 'base64');
      if (decoded.toString('base64') !== state.globalConfig || decoded.length > limits.maxFileBytes || total + decoded.length > limits.maxTotalBytes) return refuse('BACKUP_SET_INVALID');
    }
    return state;
  } catch (error) { if (error && typeof error === 'object' && 'code' in error) throw error; return refuse('BACKUP_SET_INVALID'); }
}

export function packBackupState(input: Omit<BackupState, 'schemaVersion' | 'entries' | 'globalConfig' | 'sharedRegistrationId'>, entries: BackupState['entries'], global: Buffer | null, total: number, maximum: number): Buffer {
  const config = entries.find(item => item.resource === 'config'); if (!config) return refuse('BACKUP_STATE_MISSING');
  const projectConfig = layer(Buffer.from(config.content, 'base64')) as { installation?: { sharedRegistrationId?: string } };
  const sharedRegistrationId = projectConfig.installation?.sharedRegistrationId;
  if (sharedRegistrationId && entries.some(item => item.resource === 'installationIdentity')) return refuse('BACKUP_STATE_MISSING');
  for (const required of sharedRegistrationId ? ['config', 'projectIdentity', 'projectAttachment', 'policy', 'bindings'] : ['config', 'installationIdentity', 'policy', 'bindings'])
    if (!entries.some(item => item.resource === required)) return refuse('BACKUP_STATE_MISSING');
  const globalConfig = !sharedRegistrationId && global ? global.toString('base64') : null;
  if (globalConfig && total + global!.length > maximum) return refuse('BACKUP_LIMIT');
  return gzipSync(JSON.stringify(backupStateSchema.parse({ ...input, schemaVersion: sharedRegistrationId ? 3 : 2, entries, globalConfig, ...(sharedRegistrationId ? { sharedRegistrationId } : {}) })));
}
type Layer = Record<string, unknown>;
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
