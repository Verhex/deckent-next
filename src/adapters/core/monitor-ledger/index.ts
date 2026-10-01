export type { MonitorLedgerOptions } from './internal/reader.js';
/** MONITOR-DATA: read-only monitor view of an existing ledger; loads the native driver only when composition selects this reader. */
export async function readMonitorLedger(path: string, options: import('./internal/reader.js').MonitorLedgerOptions) {
  const { readMonitorLedger: read } = await import('./internal/reader.js');
  return read(path, options);
}
/** MONITOR v1.1: the ledger view plus recorded-output first failures, recent worker events and the install map, read-only, from a resolved config. */
export async function readMonitorInstall(config: import('#platform/index.js').ResolvedConfig, env: import('#platform/index.js').Environment | undefined,
  readOutput: (identity: import('#domain/index.js').AttemptIdentity) => Promise<boolean>) {
  const { readMonitorInstall: read } = await import('./internal/install.js');
  return read(config, env, readOutput);
}
