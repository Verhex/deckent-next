import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
/** Loads the native driver only for an explicit existing-installation pool operation. */
export async function openInstallationPoolStore(path: string, options: SqliteLedgerOptions) {
  const { installationPoolStore } = await import('./internal/store.js');
  return installationPoolStore(path, options);
}
