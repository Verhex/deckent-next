import { dirname, resolve } from 'node:path';
import { SystemTrustedClock, inspectProductDirectory, inspectProductFile, mapBounded, HOST_LIMITS_REGISTRY, type ConfigLoadOptions } from '#platform/index.js';
import { openSqliteInventoryReader, DockerSupervisor, FileArtifactStore, readWorkerSidecars, inspectLegacyWorkers } from '#adapters/index.js';
import { workerObservationQuerySchema, WorkerObservationError, DispatchInventoryApplication, DispatchInventoryPolicyAuthorization, assertRequestCompany, observeAttemptWorkerModels, readThrough,
  type DispatchInventoryEntry, type MonitorRecall, type WorkerObservation, type WorkerObservationQuery, type WorkerObservationReport, type WorkerObservationSource } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { contextDispatchAuthorization } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { inspectConfiguredResources } from '#composition/core/resource-observation/index.js';
const DENIED = ['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED', 'SCOPE_UNKNOWN'];
/** MON-CPU-FIX `walk` (the live monitor): `recall` keeps ledger/policy-derived reads of an unchanged source generation; one context and reader page a source up to `entries`. */
export async function inspectConfiguredWorkers(root: string, input: WorkerObservationQuery, options: ConfigLoadOptions = {}, walk?: { readonly recall: MonitorRecall; readonly entries: number }): Promise<WorkerObservationReport> {
  try {
    const query = workerObservationQuerySchema.parse(input), recall = walk?.recall ?? readThrough, clock = new SystemTrustedClock();
    const context = (path: string) => recall(`context\0${query.scopeId}\0${resolve(path)}`, () => loadConfiguredScopeContext(path, query.scopeId, options, 'read')), c = await context(root);
    await new DispatchInventoryPolicyAuthorization({ async load() { return c.document; } }).authorize(query.scopeId, c.principal);
    const limit = query.limit ?? c.config.inspection.maxPageSize;
    if (limit > c.config.inspection.maxPageSize || (query.after && !query.source)) throw new WorkerObservationError('WORKER_OBSERVATION_INVALID');
    const definitions = [{ id: 'current', kind: 'next-project', path: resolve(root), scopeId: query.scopeId }, ...c.config.inspection.workers.sources]
      .filter(source => source.scopeId === query.scopeId && (!query.source || source.id === query.source));
    if (!definitions.length) throw new WorkerObservationError('WORKER_OBSERVATION_INVALID');
    const sources: WorkerObservationSource[] = []; let remaining = walk?.entries ?? limit;
    for (const source of definitions) {
      if (!remaining) { sources.push({ ...source, status: 'not-sampled', workers: [], nextAfter: null, truncated: true }); continue; }
      try {
        if (source.kind === 'legacy-tasks') {
          const page = await inspectLegacyWorkers(source.path, c.config.inspection.workers, remaining, query.after);
          sources.push({ ...source, status: 'available', ...page }); remaining -= page.workers.length; continue;
        }
        // Ledger part (recalled while the generation holds): inventory pages, read-output decisions and dispatch records. A failed record read is not kept.
        const ledger = await recall(JSON.stringify(['workers', source.id, query, remaining]), async () => {
          // H34 S3: the target resolved the scope for its own company; this request's company must be that company.
          const target = await context(source.path); assertRequestCompany(target.config.company.id, c.config.company.id);
          const reader = await openSqliteInventoryReader(await inspectProductFile(target.layout, 'ledger', ['-wal', '-shm', '-journal']), { busyTimeoutMs: target.config.storage.sqlite.busyTimeoutMs });
          try {
            const inventory = new DispatchInventoryApplication(reader, { async verify() { return target.principal; } }, new DispatchInventoryPolicyAuthorization({ async load() { return target.document; } }), target.config.inspection.maxPageSize);
            const entries: DispatchInventoryEntry[] = [], authorization = contextDispatchAuthorization(target, target.document); let after = query.after, failed = false;
            do { const page = await inventory.inspect({ schemaVersion: 1, scopeId: query.scopeId, after, limit: Math.min(remaining - entries.length, target.config.inspection.maxPageSize) }); entries.push(...page.entries); after = page.nextAfter; }
            while (after && entries.length < remaining);
            return { target, nextAfter: after, entries: await mapBounded(entries, HOST_LIMITS_REGISTRY.observationConcurrency, async entry => {
              const refused = await authorization.authorizeIdentity('read-output', entry.identity, target.principal).then(() => null, (error: unknown) => DENIED.includes(queryFailure(error).code) ? 'output-denied' : 'observation-unavailable');
              return { entry, refused, record: refused || (query.open && entry.terminal) ? null : await reader.loadBoundDispatch(entry.identity).catch(() => { failed = true; return null; }) }; }), failed };
          } finally { reader.close(); }
        }, value => !value.failed);
        // Live part (every call): resource traces, process activity, sidecars; worker models are recalled per attempt and live usage summary.
        const { target, entries } = ledger, views = await inspectConfiguredResources(target.config, target.layout, entries.map(value => value.entry.identity)); let opened: ReturnType<typeof openSqliteInventoryReader> | undefined;
        const reader = () => opened ??= inspectProductFile(target.layout, 'ledger', ['-wal', '-shm', '-journal']).then(path => openSqliteInventoryReader(path, { busyTimeoutMs: target.config.storage.sqlite.busyTimeoutMs }));
        const workers = await mapBounded(entries, HOST_LIMITS_REGISTRY.observationConcurrency, async ({ entry, refused, record }, index): Promise<WorkerObservation> => {
          const basic: WorkerObservation = { taskId: entry.identity.taskId, identity: entry.identity, authority: 'next-ledger',
            provider: 'unknown', workspace: null, process: 'unknown', handle: entry.terminal?.handle ?? null,
            terminal: entry.terminal, outputRecorded: entry.outputRecorded, patchRecorded: false, files: null, diagnostics: [] };
          if (refused) return { ...basic, diagnostics: [...(query.open && entry.terminal ? ['info:ledger-only'] : []), refused] };
          const resources = views[index]!;
          if (query.open && entry.terminal) return { ...basic, resources, diagnostics: ['info:ledger-only'] };
          try {
            if (!record) throw new WorkerObservationError('WORKER_OBSERVATION_UNAVAILABLE');
            const activity = await DockerSupervisor.restoreProfile(record.profile).then(supervisor => supervisor.inspectActivity(record.request)).catch(() => ({ state: 'unknown' as const, handle: null }));
            let absent = false; const files = await readWorkerSidecars(dirname(record.request.workspace), 'worker', c.config.inspection.workers, clock.sample().wallMs, entry.identity)
              .catch((error: { code?: unknown }) => { absent = error?.code === 'ENOENT'; return null; }), released = absent && !!record.patch && activity.state === 'missing';
            const evidence = await recall(JSON.stringify(['models', entry.identity, files?.usage ?? null]), async () => observeAttemptWorkerModels(await reader(),
              FileArtifactStore.reader(() => inspectProductDirectory(target.layout, 'artifacts'), target.config.artifacts.maxBytes), entry.identity, files?.usage ?? null), value => value.usageEvidence !== 'unavailable'), model = evidence.model;
            return { ...basic, resources, ...(model ? { model } : {}), provider: files?.provider ?? 'unknown', workspace: record.request.workspace, process: activity.state, handle: activity.handle ?? basic.handle,
              patchRecorded: !!record.patch, dispatch: { containerId: record.containerId ?? null }, files, usageEvidence: evidence.usageEvidence, ...(evidence.usage ? { usage: evidence.usage } : {}), ...(released ? { custody: 'released' as const } : {}), diagnostics: [...(activity.state === 'unknown' ? ['process-unavailable'] : []),
                ...(evidence.usageEvidence === 'unavailable' ? ['model-unavailable'] : []), ...(files ? files.log.diagnostics : [released ? 'custody-released' : 'activity-unavailable'])] };
          } catch { return { ...basic, diagnostics: ['observation-unavailable'] }; }
        }).finally(() => opened?.then(value => value.close(), () => undefined));
        remaining -= workers.length;
        sources.push({ ...source, status: 'available', workers, nextAfter: ledger.nextAfter, truncated: ledger.nextAfter !== null });
      } catch (error) { sources.push({ ...source, status: DENIED.includes(queryFailure(error).code) ? 'denied' : 'unavailable', workers: [], nextAfter: null, truncated: false }); }
    }
    return Object.freeze({ schemaVersion: 1, observedAt: clock.sample().wallMs, scopeId: query.scopeId, sources, control: 'observe-only' });
  } catch (error) { throw queryFailure(error); }
}
