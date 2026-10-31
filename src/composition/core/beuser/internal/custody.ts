import { join } from 'node:path';
import { ErrorRegistry, prepareProductDirectory, withConfigWriteLock, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

/** Existing exclusive custody, generation-safe release and dead-owner recovery; a second walk never queues. */
export async function withConfiguredBeuserWalkCustody<T>(root: string, scopeId: string, options: ConfigLoadOptions, work: () => Promise<T>) {
  const c = await loadConfiguredScopeContext(root, scopeId, { ...options, heal: false }, 'read');
  const path = join(await prepareProductDirectory(c.layout, 'crashes'), 'beuser-walk-lock');
  let acquired = false;
  try { return await withConfigWriteLock(path, async () => { acquired = true; return work(); }, 0); }
  catch (error) {
    if (!acquired && (error as { code?: string }).code === 'CONFIG_WRITE_LOCKED') throw ErrorRegistry.createError('BEUSER_WALK_RUNNING');
    throw error;
  }
}
