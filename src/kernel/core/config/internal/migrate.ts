import type { ConfigLockOptions } from './lock.js';
import { isDeepStrictEqual } from 'node:util';
import { ErrorRegistry } from '../../errors/index.js';
import { isRecord, deepMerge, readJsonFile, writeJsonAtomic, type JsonRecord } from '../../utils/index.js';
import { resolveConfigDefaults as createDefaultConfig } from './default-policy.js';
import { versionedConfig } from './validate/aliases.js';
import { validateConfig } from './validate/sections.js';
import { ConfigValidationError } from './validate/issues.js';
import { withConfigWriteLock, assertConfigPreimage, backupConfig, pruneConfigBackups } from './write.js';

export interface MigrationPlan {
  readonly fromVersion: number;
  readonly toVersion: 2;
  readonly migrated: boolean;
  readonly addedFields: readonly string[];
  readonly changedFields: readonly string[];
  readonly config: JsonRecord;
}
export function migrateConfigInMemory(input: unknown): MigrationPlan {
  if (!isRecord(input)) throw new ConfigValidationError([{ path: '$', reason: 'OBJECT_REQUIRED' }]);
  const normalized = versionedConfig(JSON.parse(JSON.stringify(input, (_key, value: unknown) => value === undefined ? null : value)) as JsonRecord);
  const fromVersion = (input['schema_version'] ?? 1) as number;
  const next = fromVersion === 2 ? normalized : deepMerge(createDefaultConfig(), normalized);
  // Undefined values have a durable representation; no field disappears at JSON serialization.
  const config = JSON.parse(JSON.stringify(next, (_key, value: unknown) => value === undefined ? null : value)) as JsonRecord;
  validateConfig(deepMerge(createDefaultConfig(), config));
  const addedFields = Object.keys(config).filter(key => !Object.hasOwn(input, key));
  const changedFields = [...new Set([...Object.keys(input), ...Object.keys(config)])].filter(key => !isDeepStrictEqual(input[key], config[key]));
  return { fromVersion, toVersion: 2, migrated: changedFields.length > 0, addedFields, changedFields, config };
}
export async function migrateConfig(path: string, options: ConfigLockOptions & { dryRun?: boolean; targetPath?: string } = {}): Promise<MigrationPlan & { backupPath: string | null; dryRun: boolean }> {
  const initial = await readJsonFile(path);
  if (initial.kind === 'io') throw ErrorRegistry.createError('CONFIG_READ_IO_HOLD', { cause: initial.error });
  if (initial.kind === 'absent') throw ErrorRegistry.createError('DECKENT_E020');
  if (initial.kind !== 'ready') throw ErrorRegistry.createError('DECKENT_E004');
  const target = options.targetPath ?? path;
  const planned = migrateConfigInMemory(initial.value);
  const plan = target === path ? planned : { ...planned, migrated: true };
  if (options.dryRun || !plan.migrated) return { ...plan, backupPath: null, dryRun: options.dryRun ?? false };
  return withConfigWriteLock(target, async () => {
    await assertConfigPreimage(path, initial.digest);
    if (target !== path) await assertConfigPreimage(target, null);
    const backupPath = target === path ? await backupConfig(path, initial.text) : null;
    await assertConfigPreimage(path, initial.digest);
    await writeJsonAtomic(target, plan.config);
    await pruneConfigBackups(target);
    return { ...plan, backupPath, dryRun: false };
  }, 2_000, options);
}
