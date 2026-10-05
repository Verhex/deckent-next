import { watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { openLedgerSurfaceTail, type LedgerSurfaceKind } from '#adapters/core/sqlite-ledger/index.js';
import type { ResolvedConfig } from '#platform/index.js';
import type { SurfaceFollowEvent } from '#engine/index.js';

export type RuntimeSurfaceEvent = SurfaceFollowEvent;
export interface AuthorizedSurfaceRead {
  readonly config: ResolvedConfig;
  readonly ledger: string;
  readonly scopeId: string;
  readonly kinds: readonly LedgerSurfaceKind[];
}

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
export async function* followLedgerSurface(initial: AuthorizedSurfaceRead, authorize: () => Promise<AuthorizedSurfaceRead | null>,
  signal: AbortSignal, onReady?: () => void): AsyncGenerator<RuntimeSurfaceEvent> {
  const { config, ledger, scopeId, kinds } = initial;
  if (signal.aborted) return;
  const denied = (['approval', 'run', 'worker'] as const).filter(kind => !kinds.includes(kind));
  if (denied.length) yield { access: 'denied', scopeId, kinds: denied, stopped: kinds.length === 0 };
  if (kinds.length === 0 || signal.aborted) return;
  const fresh = async () => {
    const current = await authorize();
    return current !== null && current.scopeId === scopeId && current.ledger === ledger && current.config.company.id === config.company.id
      && kinds.every(kind => current.kinds.includes(kind));
  };
  // A consumer can pause at a denial or publication: recheck before opening and before every subsequent read/yield.
  if (!(await fresh())) { yield { access: 'denied', scopeId, kinds, stopped: true }; return; }
  if (signal.aborted) return;
  const tail = openLedgerSurfaceTail(ledger, config.storage.sqlite, scopeId, kinds);
  let closed = false;
  const close = () => { if (!closed) { closed = true; tail.close(); } };
  const sequence = { approval: 0, run: 0, worker: 0 };
  try {
    onReady?.();
    while (!signal.aborted) {
      if (!(await fresh())) { close(); yield { access: 'denied', scopeId, kinds, stopped: true }; return; }
      if (signal.aborted) return;
      const rows = tail.read();
      if (rows.length === 0) { await waitForLedger(ledger, config.inspection.workers.heartbeatMs, signal); continue; }
      for (const row of rows) {
        if (!(await fresh())) { close(); yield { access: 'denied', scopeId, kinds, stopped: true }; return; }
        if (signal.aborted) return;
        sequence[row.kind] += 1 + row.missed;
        yield { kind: row.kind, scopeId, sequence: sequence[row.kind], id: row.id, text: `${row.kind}:${row.id}` };
      }
    }
  } finally { close(); }
}
