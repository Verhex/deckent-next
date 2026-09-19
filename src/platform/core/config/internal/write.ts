import { open, unlink, readdir, lstat } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withConfigWriteLock, type ConfigLockOptions } from './lock.js';
export { withConfigWriteLock } from './lock.js';
import { ErrorRegistry } from '#platform/core/errors/index.js';
import { readJsonFile, writeJsonAtomic, type JsonRecord } from '#platform/core/utils/index.js';
import { createDefaultConfig } from './defaults.js';
import { deepMerge } from '#platform/core/utils/index.js';
import { versionedConfig } from './validate/version.js';
import { validateConfig } from './validate/sections.js';
import { resolveGlobalConfigPaths } from '#platform/core/host/index.js';
import type { PathContext } from '#platform/core/host/index.js';

export async function assertConfigPreimage(path: string, expected: string | null): Promise<void> {
  const current = await readJsonFile(path);
  if (current.kind === 'io') throw ErrorRegistry.createError('CONFIG_READ_IO_HOLD', { cause: current.error });
  const digest = current.kind === 'absent' ? null : current.digest;
  if (digest !== expected) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
}
export async function backupConfig(path: string, text: string): Promise<string> {
  const target = `${path}.bak.${new Date().toISOString().replace(/:/g, '-')}.${randomUUID()}`;
  const handle = await open(target, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  return target;
}
export async function pruneConfigBackups(path: string, keep = 3, protectedBackup?: string): Promise<void> {
  if (!Number.isSafeInteger(keep) || keep < 1) throw ErrorRegistry.createError('CLI_USAGE');
  const prefix = `${basename(path)}.bak.`;
  const names = (await readdir(dirname(path))).filter(name => name.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}T[\dT.Z-]+\.[a-f0-9-]{36}$/.test(name.slice(prefix.length))).sort().reverse();
  const regular: string[] = [];
  for (const name of names) if ((await lstat(join(dirname(path), name))).isFile()) regular.push(name);
  const protectedName = protectedBackup === undefined ? undefined : basename(protectedBackup);
  if (protectedBackup !== undefined && (resolve(dirname(protectedBackup)) !== resolve(dirname(path)) || !regular.includes(protectedName!))) {
    throw ErrorRegistry.createError('CLI_USAGE');
  }
  // Preserve this healing receipt even after clock rollback or same-millisecond UUID ties.
  // Prior backups keep filename ordering; that ordering is not a causal clock.
  const prior = regular.filter(name => name !== protectedName);
  for (const name of prior.slice(keep - (protectedName === undefined ? 0 : 1))) await unlink(join(dirname(path), name));
}
export async function writeConfig(path: string, config: JsonRecord, expectedDigest?: string | null, options: ConfigLockOptions = {}): Promise<void> {
  validateConfig(deepMerge(createDefaultConfig(), versionedConfig(config)));
  await withConfigWriteLock(path, async () => {
    const before = await readJsonFile(path);
    if (before.kind === 'io') throw ErrorRegistry.createError('CONFIG_READ_IO_HOLD', { cause: before.error });
    const expected = expectedDigest === undefined ? before.kind === 'absent' ? null : before.digest : expectedDigest;
    await assertConfigPreimage(path, expected);
    await writeJsonAtomic(path, versionedConfig(config));
  }, 2_000, options);
}
export async function saveGlobalConfig(config: JsonRecord, options: PathContext & ConfigLockOptions = {}): Promise<void> {
  const { platformPath } = resolveGlobalConfigPaths(options.env, options.platform);
  await writeConfig(platformPath, config, undefined, options);
}
