import { runSnapshotSchema } from '#domain/index.js';
import { RunStoreError } from '#engine/index.js';
/** One canonical row decoder for Run writers and cross-scope resource occupancy readers. */
export function decodeLedgerRunSnapshot(snapshot: unknown, scopeId: string, runId: string) {
  try {
    const value = runSnapshotSchema.parse(JSON.parse(String(snapshot)));
    if (value.identity.scopeId !== scopeId || value.identity.runId !== runId) throw new RunStoreError('RUN_STORE_CORRUPT');
    return value;
  } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
}
