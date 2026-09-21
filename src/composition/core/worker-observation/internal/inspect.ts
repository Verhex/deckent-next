import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { inspectProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { openSqliteInventoryReader, DockerSupervisor, readWorkerSidecars, inspectLegacyWorkers } from '#adapters/index.js';
import { workerObservationQuerySchema, WorkerObservationError, DispatchInventoryPolicyAuthorization, DispatchPolicyAuthorization,
  type WorkerObservation, type WorkerObservationQuery, type WorkerObservationReport, type WorkerObservationSource } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
export async function inspectConfiguredWorkers(root: string, input: WorkerObservationQuery, options: ConfigLoadOptions = {}): Promise<WorkerObservationReport> {
  try {
    const query = workerObservationQuerySchema.parse(input);
    const c = await loadConfiguredScopeContext(root, query.scopeId, options);
    await new DispatchInventoryPolicyAuthorization({ async load() { return c.document; } }).authorize(query.scopeId, c.principal);
    const limit = query.limit ?? c.config.inspection.maxPageSize;
    if (limit > c.config.inspection.maxPageSize || (query.after && !query.source)) throw new WorkerObservationError('WORKER_OBSERVATION_INVALID');
    const definitions = [{ id: 'current', kind: 'next-project', path: resolve(root), scopeId: query.scopeId }, ...c.config.inspection.workers.sources]
      .filter(source => source.scopeId === query.scopeId && (!query.source || source.id === query.source));
    if (!definitions.length) throw new WorkerObservationError('WORKER_OBSERVATION_INVALID');
    const sources: WorkerObservationSource[] = []; let remaining = limit;
    for (const source of definitions) {
      if (!remaining) { sources.push({ ...source, status: 'not-sampled', workers: [], nextAfter: null, truncated: true }); continue; }
      try {
        if (source.kind === 'legacy-tasks') {
          const page = await inspectLegacyWorkers(source.path, c.config.inspection.workers, remaining, query.after);
          sources.push({ ...source, status: 'available', ...page }); remaining -= page.workers.length; continue;
        }
        const target = await loadConfiguredScopeContext(source.path, query.scopeId, options);
        const page = await inspectConfiguredInventory(source.path, { schemaVersion: 1, scopeId: query.scopeId, limit: Math.min(remaining, target.config.inspection.maxPageSize), after: query.after }, options);
        const authorization = new DispatchPolicyAuthorization(createLayoutPolicySource(target.layout, userInfo().uid, target.config.inspection.policyMaxBytes));
        const reader = await openSqliteInventoryReader(await inspectProductFile(target.layout, 'ledger', ['-wal', '-shm', '-journal']), { busyTimeoutMs: target.config.storage.sqlite.busyTimeoutMs });
        const workers: WorkerObservation[] = [];
        try {
          for (const entry of page.page.entries) {
            const basic: WorkerObservation = { taskId: entry.identity.taskId, identity: entry.identity, authority: 'next-ledger',
              provider: 'unknown', workspace: null, process: 'unknown', handle: entry.terminal?.handle ?? null,
              terminal: entry.terminal, outputRecorded: entry.outputRecorded, patchRecorded: false, files: null, diagnostics: [] };
            try {
              await authorization.authorizeIdentity('read-output', entry.identity, target.principal);
              const record = await reader.loadBoundDispatch(entry.identity); if (!record) throw new WorkerObservationError('WORKER_OBSERVATION_UNAVAILABLE');
              const activity = await DockerSupervisor.restoreProfile(record.profile).then(supervisor => supervisor.inspectActivity(record.request)).catch(() => ({ state: 'unknown' as const, handle: null }));
              const files = await readWorkerSidecars(dirname(record.request.workspace), 'worker', c.config.inspection.workers, Date.now(), entry.identity).catch(() => null);
              workers.push({ ...basic, provider: files?.provider ?? 'unknown', workspace: record.request.workspace, process: activity.state, handle: activity.handle,
                patchRecorded: !!record.patch, files, diagnostics: [...(activity.state === 'unknown' ? ['process-unavailable'] : []),
                  ...(files ? files.log.diagnostics : ['activity-unavailable'])] });
            } catch (error) { workers.push({ ...basic, diagnostics: [queryFailure(error).code === 'POLICY_DENIED' ? 'output-denied' : 'observation-unavailable'] }); }
          }
        } finally { reader.close(); }
        remaining -= workers.length;
        sources.push({ ...source, status: 'available', workers, nextAfter: page.page.nextAfter, truncated: page.page.nextAfter !== null });
      } catch (error) { sources.push({ ...source, status: queryFailure(error).code === 'POLICY_DENIED' ? 'denied' : 'unavailable', workers: [], nextAfter: null, truncated: false }); }
    }
    return Object.freeze({ schemaVersion: 1, observedAt: Date.now(), scopeId: query.scopeId, sources, control: 'observe-only' });
  } catch (error) { throw queryFailure(error); }
}
