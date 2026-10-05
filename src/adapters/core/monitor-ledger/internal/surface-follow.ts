import { watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { openLedgerSurfaceTail, type LedgerSurfaceRow } from '#adapters/core/sqlite-ledger/index.js';
import { loadConfig, productResourcePath, type ConfigLoadOptions } from '#platform/index.js';

export type RuntimeSurfaceEvent = {
  readonly kind: LedgerSurfaceRow['kind'];
  readonly scopeId: string;
  readonly sequence: number;
  readonly id: string;
  readonly text: string;
};

function waitForLedger(ledger: string, pace: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const watchers: FSWatcher[] = [];
    const timer = setTimeout(finish, pace);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      for (const watcher of watchers) watcher.close();
      resolve();
    }
    for (const path of [ledger, dirname(ledger)]) {
      try {
        const watcher = watch(path, finish);
        watcher.on('error', finish);
        watchers.push(watcher);
      } catch { /* a missing companion is the disconnected case; the pace still bounds the wait */ }
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Follow the runtime ledger publications (approval outbox, run revisions, worker event logs).
 * The service stays the writer. This reader does not delete outbox rows and does not open an effect.
 * `onReady` runs after the baseline is taken and before the first wait.
 */
export async function* followLedgerSurface(root: string, scopeId: string, options: ConfigLoadOptions, signal: AbortSignal,
  onReady?: () => void): AsyncGenerator<RuntimeSurfaceEvent> {
  const config = await loadConfig(root, { ...options, heal: false });
  const ledger = productResourcePath(config.productLayout, 'ledger');
  const pace = config.inspection.workers.heartbeatMs;
  const tail = openLedgerSurfaceTail(ledger, config.storage.sqlite, scopeId);
  const sequence = { approval: 0, run: 0, worker: 0 };
  try {
    onReady?.();
    while (!signal.aborted) {
      const rows = tail.read();
      if (rows.length === 0) { await waitForLedger(ledger, pace, signal); continue; }
      for (const row of rows) {
        if (signal.aborted) return;
        sequence[row.kind] += 1 + row.missed;
        yield { kind: row.kind, scopeId, sequence: sequence[row.kind], id: row.id, text: `${row.kind}:${row.id}` };
      }
    }
  } finally { tail.close(); }
}
