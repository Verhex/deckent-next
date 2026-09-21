import { loadConfig, inspectProductFile, type ConfigLoadOptions, type DeckentError } from '#platform/index.js';
import { openSqliteAttemptStore, readLocalOsIdentity } from '#adapters/index.js';
import type { ProgressionCursor } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { advanceConfiguredRun } from './advance.js';

export interface RunProgressionObserver {
  onRun?(query: ProgressionCursor, result: Awaited<ReturnType<typeof advanceConfiguredRun>>): void | Promise<void>;
  onError?(query: ProgressionCursor | null, error: DeckentError): void | Promise<void>;
}
/** Host owns its lifetime; intent is discovered durably, never inferred from a disconnected client.
 * Each turn retains current policy checks. Dispatch admission shares the service's execution limiter.
 */
export async function prepareConfiguredRunRuntime(projectRoot: string, observer: RunProgressionObserver,
  admitExecution: (work: () => Promise<void>) => Promise<void>, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const actor = readLocalOsIdentity();
  const settings = config.runRuntime;
  let running = false;
  return Object.freeze({ async run(signal: AbortSignal) {
    if (running) throw new Error('RUN_RUNTIME_ALREADY_RUNNING');
    running = true;
    let cursor: ProgressionCursor | null = null;
    try {
      // Polling cadence applies from startup too; shutdown interrupts this wait without cancelling work.
      await wait(settings.pollIntervalMs, signal);
      while (!signal.aborted) {
        let failed = false;
        try {
          // No automatic migration at service start. Explicit installer/writer owns schema changes.
          const current = await loadConfig(projectRoot, { ...options, heal: false });
          const store = await openSqliteAttemptStore(await inspectProductFile(current.productLayout, 'ledger', ['-wal', '-shm', '-journal']), current.storage.sqlite, 'forbid');
          let page;
          try { page = await store.listRunProgression({ actor: { id: actor.id, issuer: actor.issuer, subject: actor.subject }, after: cursor, limit: settings.pageSize }); }
          finally { store.close(); }
          cursor = page.next;
          for (const query of page.items) {
            if (signal.aborted) break;
            try {
              const result = await advanceConfiguredRun(projectRoot, { schemaVersion: 1, ...query }, signal, options, admitExecution, settings.maxReservationsPerTurn);
              await observer.onRun?.(query, result);
            } catch (error) { failed = true; await observer.onError?.(query, queryFailure(error)); }
          }
        } catch (error) { failed = true; cursor = null; await observer.onError?.(null, queryFailure(error)); }
        if (!signal.aborted) await wait(failed ? settings.failureBackoffMs : settings.pollIntervalMs, signal);
      }
    } finally { running = false; }
  } });
}
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds); signal.addEventListener('abort', finish, { once: true });
  });
}
