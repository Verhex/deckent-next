import { randomUUID } from 'node:crypto';
import { ErrorRegistry, loadConfig, inspectProductFile, type ConfigLoadOptions, type DeckentError } from '#platform/index.js';
import { openSqliteAttemptStore, readLocalOsIdentity } from '#adapters/index.js';
import { RunLifecycleRuntimeLoop, RunProgressionFailure, type ProgressionCursor } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { advanceConfiguredRunLifecycle, parkConfiguredRunProgression } from '#composition/core/runs/index.js';
import { advanceConfiguredRun, type RunExecutionAdmission } from './advance.js';
export interface RunProgressionObserver {
  onRun?(query: ProgressionCursor, result: Awaited<ReturnType<typeof advanceConfiguredRun>>): void | Promise<void>;
  onError?(query: ProgressionCursor | null, error: DeckentError): void | Promise<void>;
  onScopeSkipped?(note: DeckentError): void | Promise<void>;
}
export async function prepareConfiguredRunRuntime(projectRoot: string, observer: RunProgressionObserver,
  admitExecution: RunExecutionAdmission, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false }), os = readLocalOsIdentity(), settings = config.runRuntime;
  const actor = { id: os.id, issuer: os.issuer, subject: os.subject };
  let surveyed = false;
  return new RunLifecycleRuntimeLoop({
    async discover(after, dueAfter, now) {
      const current = await loadConfig(projectRoot, { ...options, heal: false });
      const store = await openSqliteAttemptStore(await inspectProductFile(current.productLayout, 'ledger', ['-wal', '-shm', '-journal']), current.storage.sqlite, { now: Date.now, timeoutMs: current.runRuntime.parking.timeoutMs }, 'forbid');
      const companyId = current.company.id;
      try {
        const result = { due: await store.listRunLifecycleDue({ actor, after: dueAfter, limit: settings.pageSize, now, companyId }),
          page: await store.listRunProgression({ actor, after, limit: settings.pageSize, companyId }) };
        if (surveyed) return result;
        const skipped = await store.listForeignProgressionScopes({ actor, companyId, limit: settings.pageSize });
        surveyed = true; return { ...result, skipped };
      } finally { store.close(); }
    },
    async park(query, error) {
      if (!(error instanceof RunProgressionFailure) || error.revision === null) throw ErrorRegistry.createError('RUN_PROGRESSION_PARK_UNAVAILABLE');
      try { await parkConfiguredRunProgression(projectRoot, { schemaVersion: 1, ...query, commandId: randomUUID(), expectedRevision: error.revision, failureCode: queryFailure(error.cause).code }, options); return 'parked'; }
      catch (failure) { if (queryFailure(failure).code === 'RUN_STORE_CONFLICT') return 'changed'; throw failure; }
    },
    async expire(query) { await advanceConfiguredRunLifecycle(projectRoot, { schemaVersion: 1, ...query }, options); },
    advance: (query, signal) => advanceConfiguredRun(projectRoot, { schemaVersion: 1, ...query }, signal, options, admitExecution, settings.maxReservationsPerTurn),
  }, { ...(observer.onRun ? { onRun: observer.onRun } : {}),
    onScopeSkipped: note => observer.onScopeSkipped?.(ErrorRegistry.createError('RUN_PROGRESSION_SCOPE_SKIPPED', { params: { scopeId: note.scopeId, reason: note.reason } })), onError: (query, error) => observer.onError?.(query, queryFailure(error)) }, { ...settings, maxConcurrentRuns: settings.maxConcurrentRuns ?? config.service.maxConcurrentExecutions });
}
