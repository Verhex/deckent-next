import { loadConfig, prepareProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';

/** Composition chooses the configured adapter; application/domain never branch on database brand.
 * No command ingress is exposed here: caller must still supply verified principal/policy to the application.
 */
export async function openConfiguredAttemptStore(projectRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const layout = config.productLayout;
  const path = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
  const store = await openSqliteAttemptStore(path, config.storage.sqlite);
  return Object.freeze({ store, layout, path });
}
