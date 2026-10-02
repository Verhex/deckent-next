import { loadConfig, inspectProductFile, type ConfigLoadOptions, type DeckentError } from '#platform/index.js';
import { openSqliteAttemptStore, readLocalOsIdentity } from '#adapters/index.js';
import { RunLifecycleRuntimeLoop, type ProgressionCursor } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { advanceConfiguredRunLifecycle } from '#composition/core/runs/index.js';
import { advanceConfiguredRun } from './advance.js';
export interface RunProgressionObserver {
  onRun?(query: ProgressionCursor, result: Awaited<ReturnType<typeof advanceConfiguredRun>>): void | Promise<void>;
  onError?(query: ProgressionCursor | null, error: DeckentError): void | Promise<void>;
}
/** Fresh config/policy on every operation; local discovery matches the admission actor and never grants execution. */
export async function prepareConfiguredRunRuntime(projectRoot: string, observer: RunProgressionObserver,
  admitExecution: (work: () => Promise<void>) => Promise<void>, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false }), os = readLocalOsIdentity(), settings = config.runRuntime;
  const actor = { id: os.id, issuer: os.issuer, subject: os.subject };
  return new RunLifecycleRuntimeLoop({
    async discover(after, dueAfter, now) {
      const current = await loadConfig(projectRoot, { ...options, heal: false });
      const store = await openSqliteAttemptStore(await inspectProductFile(current.productLayout, 'ledger', ['-wal', '-shm', '-journal']), current.storage.sqlite, 'forbid');
      try { return { due: await store.listRunLifecycleDue({ actor, after: dueAfter, limit: settings.pageSize, now }),
        page: await store.listRunProgression({ actor, after, limit: settings.pageSize }) }; } finally { store.close(); }
    },
    async expire(query) { await advanceConfiguredRunLifecycle(projectRoot, { schemaVersion: 1, ...query }, options); },
    advance: (query, signal) => advanceConfiguredRun(projectRoot, { schemaVersion: 1, ...query }, signal, options, admitExecution, settings.maxReservationsPerTurn),
  }, { ...(observer.onRun ? { onRun: observer.onRun } : {}), onError: (query, error) => observer.onError?.(query, queryFailure(error)) }, settings);
}
