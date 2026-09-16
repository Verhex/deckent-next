import type { ConfigLockOptions } from './lock.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { ErrorRegistry } from '../../errors/index.js';
import { readJsonFile, writeJsonAtomic, type JsonRead } from '../../utils/index.js';
import { resolveConfigDefaults as createDefaultConfig } from './default-policy.js';
import { withConfigWriteLock, assertConfigPreimage, backupConfig, pruneConfigBackups } from './write.js';

export async function healCorruptProjectConfig(path: string, corrupt: Extract<JsonRead, { kind: 'corrupt' }>, options: ConfigLockOptions = {}): Promise<{ config: unknown; backupPath: string }> {
  return withConfigWriteLock(path, async () => {
    await assertConfigPreimage(path, corrupt.digest);
    const backupPath = await backupConfig(path, corrupt.text);
    await assertConfigPreimage(path, corrupt.digest);
    const config = createDefaultConfig();
    await writeJsonAtomic(path, config);
    await pruneConfigBackups(path);
    return { config, backupPath };
  }, 2_000, options);
}
/** A transient read failure is never evidence that a document is corrupt. */
export async function readProjectConfig(path: string, options: ConfigLockOptions & { heal?: boolean; onHeal?: (path: string) => void } = {}): Promise<unknown> {
  let result = await readJsonFile(path);
  if (result.kind === 'corrupt') { await sleep(150); result = await readJsonFile(path); }
  if (result.kind === 'io') throw ErrorRegistry.createError('CONFIG_READ_IO_HOLD', { cause: result.error });
  if (result.kind === 'absent') return {};
  if (result.kind === 'ready') return result.value;
  if (options.heal === false) throw ErrorRegistry.createError('DECKENT_E004');
  const healed = await healCorruptProjectConfig(path, result, options);
  options.onHeal?.(healed.backupPath);
  return healed.config;
}
