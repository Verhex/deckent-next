import { openConfiguredLedger } from '#composition/core/scoped-request/index.js';
import { randomUUID } from 'node:crypto';
import { sha256, ErrorRegistry, loadConfig, inspectProductFile, type ConfigLoadOptions, type DeckentError } from '#platform/index.js';
import { withLocalPrincipalChannel, openLocalIntegrityAuthority, readLocalOsIdentity } from '#adapters/index.js';
import { selectRunProgression, mergeProgressionPages, RunSessionRegistry, verifyApproval, RunLifecycleRuntimeLoop, RunProgressionFailure, type ProgressionCursor } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { advanceConfiguredRunLifecycle, parkConfiguredRunProgression } from '#composition/core/runs/index.js';
import { advanceConfiguredRun, type RunExecutionAdmission } from './advance.js';
export interface RunProgressionObserver {
  onRun?(query: ProgressionCursor, result: Awaited<ReturnType<typeof advanceConfiguredRun>>): void | Promise<void>;
  onError?(query: ProgressionCursor | null, error: DeckentError): void | Promise<void>;
  onScopeSkipped?(note: DeckentError): void | Promise<void>;
}
export async function prepareConfiguredRunRuntime(projectRoot: string, observer: RunProgressionObserver,
  admitExecution: RunExecutionAdmission, options: ConfigLoadOptions = {}, session?: RunSessionRegistry) {
  const config = await loadConfig(projectRoot, { ...options, heal: false }), settings = config.runRuntime;
  const identity = (channel: 'mcp' | undefined) => withLocalPrincipalChannel(channel, readLocalOsIdentity);
  const actors = [undefined, 'mcp'] as const;
  let surveyed = false;
  const storeFor = async () => {
    const current = await loadConfig(projectRoot, { ...options, heal: false });
    const ledger = await inspectProductFile(current.productLayout, 'ledger', ['-wal', '-shm', '-journal']);
    return { current, ledger, store: await openConfiguredLedger({ config: current, path: async () => ledger }, { migration: 'forbid' }) };
  };
  async function asActor<T>(query: ProgressionCursor, work: (maintenance: boolean) => Promise<T>, checkStart = true): Promise<T> {
    const { current, ledger, store } = await storeFor();
    let selected: Awaited<ReturnType<typeof selectRunProgression>>;
    try {
      selected = await selectRunProgression(query, sha256(ledger), current.company.id, store, identity, session, checkStart);
    } finally { store.close(); }
    return withLocalPrincipalChannel(selected.channel, () => work(selected.maintenance));
  }
  return new RunLifecycleRuntimeLoop({
    async discover(after, dueAfter, now) {
      await session?.sweep(settings.pageSize);
      const { current, store } = await storeFor();
      try {
        const pages = [], due = [], skipped = [];
        for (const channel of actors) {
          const actor = identity(channel), query = { actor: { id: actor.id, issuer: actor.issuer, subject: actor.subject }, limit: settings.pageSize, companyId: current.company.id };
          const result = await withLocalPrincipalChannel(channel, async () => ({
            page: await store.listRunProgression({ ...query, after }),
            due: await store.listRunLifecycleDue({ ...query, after: dueAfter, now }),
            skipped: surveyed ? [] : await store.listForeignProgressionScopes(query),
          }));
          pages.push(result.page); due.push(result.due); skipped.push(...result.skipped);
        }
        surveyed = true;
        return { page: mergeProgressionPages(pages, settings.pageSize), due: mergeProgressionPages(due, settings.pageSize), skipped };
      } finally { store.close(); }
    },
    park: (query, error) => asActor(query, async () => {
      if (!(error instanceof RunProgressionFailure) || error.revision === null) throw ErrorRegistry.createError('RUN_PROGRESSION_PARK_UNAVAILABLE');
      try { await parkConfiguredRunProgression(projectRoot, { schemaVersion: 1, ...query, commandId: randomUUID(), expectedRevision: error.revision, failureCode: queryFailure(error.cause).code }, options); return 'parked' as const; }
      catch (failure) { if (queryFailure(failure).code === 'RUN_STORE_CONFLICT') return 'changed' as const; throw failure; }
    }, false),
    expire: query => asActor(query, async () => { await advanceConfiguredRunLifecycle(projectRoot, { schemaVersion: 1, ...query }, options); }, false),
    advance: (query, signal) => asActor(query, maintenance => advanceConfiguredRun(projectRoot, { schemaVersion: 1, ...query }, signal, options, admitExecution, settings.maxReservationsPerTurn, maintenance)),
  }, { ...(observer.onRun ? { onRun: observer.onRun } : {}),
    onScopeSkipped: note => observer.onScopeSkipped?.(ErrorRegistry.createError('RUN_PROGRESSION_SCOPE_SKIPPED', { params: { scopeId: note.scopeId, reason: note.reason } })),
    onError: (query, error) => observer.onError?.(query, queryFailure(error)) }, { ...settings, maxConcurrentRuns: settings.maxConcurrentRuns ?? config.service.maxConcurrentExecutions });
}
/** Service-lifetime registry, created under custody before any admission listener. */
export function createConfiguredRunSession(projectRoot: string, options: ConfigLoadOptions = {}) {
  return new RunSessionRegistry(async identity => {
    const config = await loadConfig(projectRoot, { ...options, heal: false });
    const store = await openConfiguredLedger({ config, path: () => inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']) }, { migration: 'forbid' });
    try {
      const state = store.readRunSession(identity);
      const approval = state.approval ? verifyApproval(state.approval, await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile)) : null;
      return { ...state, approval, now: Date.now(), admissionWindowMs: config.approvals.requestTtlMs };
    } finally { store.close(); }
  });
}
