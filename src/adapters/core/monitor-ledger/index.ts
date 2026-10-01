export type { MonitorLedgerOptions } from './internal/reader.js';
/** MONITOR-DATA: read-only monitor view of an existing ledger; loads the native driver only when composition selects this reader. */
export async function readMonitorLedger(path: string, options: import('./internal/reader.js').MonitorLedgerOptions) {
  const { readMonitorLedger: read } = await import('./internal/reader.js');
  return read(path, options);
}
