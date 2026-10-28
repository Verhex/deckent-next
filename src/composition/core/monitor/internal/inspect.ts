import { loadComposedConfig } from '#composition/core/root/index.js';
import { resolve } from 'node:path';
import { SystemTrustedClock, inspectProductDirectory, ManagedFileError, type ConfigLoadOptions } from '#platform/index.js';
import { FileBrainQuotaWaitStore, indexMonitorInstall, listSurfaceRunIds, prepareMonitorInstall, stampMonitorInstall, followLedgerSurface as readLedgerSurface } from '#adapters/index.js';
import { MonitorApplication, monitorQuerySchema, authorizeApproval, runtimeConfigFreshness, PoolControlPolicyAuthorization, assertPoolControlAllowed, MonitorSourceMemo, monitorScopeDiagnosticsAllowed, type SurfaceNotInitialized, type MonitorQuery, type MonitorSnapshot, type MonitorRecall } from '#engine/index.js';
import { inspectConfiguredWorkers } from '#composition/core/worker-observation/index.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { contextDispatchAuthorization } from '#composition/core/policy/index.js';
import { inspectToolchainRefresh } from '#composition/core/toolchains/index.js';
import { inspectConfiguredDismissedDeliveries } from '#composition/core/workspace-patch/index.js';
import { inspectConfiguredInvocableModels } from '#composition/core/model-invocation/index.js';
import { inspectConfiguredModelRoles } from '#composition/core/model-activation/index.js';
import { inspectConfiguredCatalogMonitor } from '#composition/core/agent-catalog/index.js';
const DENIED = new Set(['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED', 'SCOPE_UNKNOWN', 'APPROVAL_DENIED']); const granted = (check: () => Promise<unknown>) => check().then(() => true, (error: unknown) => { if (DENIED.has(queryFailure(error).code)) return false; throw error; });
async function authorizeSurfaceRead(root: string, scopeId: string, options: ConfigLoadOptions) { try {
      const c = await loadConfiguredScopeContext(root, scopeId, { ...options, force: true }, 'read'), auth = contextDispatchAuthorization(c, c.document);
      const output = await granted(() => auth.authorizeScopeReadOutput(scopeId, c.principal)), approval = await granted(async () => { authorizeApproval(c.document, 'inspect', scopeId, scopeId, c.principal); });
      if (!output && !approval) return null; if (c.identity.installation.status === 'unavailable' && c.identity.installation.reason === 'not-created') return { access: 'not-initialized', scopeId, stopped: true } satisfies SurfaceNotInitialized;
      const ledger = await c.path(), binding = JSON.stringify([c.config.company.id, ledger, c.principal.issuer, c.principal.subject]);
      return { config: c.config, ledger, binding, scopeId, kinds: [...(output ? ['run', 'worker'] as const : []), ...(approval ? ['approval'] as const : [])] };
  } catch { return null; } }
export async function* followLedgerSurface(root: string, scopeId: string, options: ConfigLoadOptions, signal: AbortSignal, onReady?: () => void) {
  if (signal.aborted) return; const authorize = () => authorizeSurfaceRead(root, scopeId, options), initial = await authorize();
  if (!initial) { yield { access: 'denied' as const, scopeId, kinds: ['approval', 'run', 'worker'] as const, stopped: true }; return; } if ('access' in initial) { yield initial; return; }
  yield* readLedgerSurface(initial, async () => { const current = await authorize(); return current && !('access' in current) ? current : null; }, signal, onReady); }
type ResolvedInstall = { readonly config: Awaited<ReturnType<typeof loadComposedConfig>>; readonly home: readonly string[] };
/** `memo` (the live view's, MON-CPU-FIX): ledger/policy/config-derived reads are recalled while a target's generation holds; without it every read is fresh. */
export async function inspectMonitor(root: string, options: ConfigLoadOptions = {}, query: MonitorQuery = { schemaVersion: 1 }, memo?: MonitorSourceMemo): Promise<MonitorSnapshot> {
  const selection = monitorQuerySchema.parse(query);
  const config = await loadComposedConfig(root, { ...options, heal: false }).catch(error => { throw queryFailure(error); });
  const targets = [{ id: 'current', path: resolve(root) }, ...config.inspection.workers.sources.filter(source => source.kind === 'next-project')
    .map(source => ({ id: source.id, path: resolve(source.path) }))];
  const captures = new Map<string, Awaited<ReturnType<typeof prepareMonitorInstall>>>(), installs = new Map<string, Promise<ResolvedInstall>>();
  // One config load per target and inspection; its own configured scopes (service, terminal) are where `pool status` asks too.
  const installed = (path: string) => installs.get(path) ?? installs.set(path, loadComposedConfig(path, { ...options, heal: false }).then(value => ({ config: value, home: [
    ...(value.service.identity?.scopeId ? [value.service.identity.scopeId] : []), ...((value['terminal'] as { scopeId?: string } | undefined)?.scopeId ? [(value['terminal'] as { scopeId: string }).scopeId] : [])] }))).get(path)!;
  // MON-CPU-FIX: one recall per target and inspection; its generation is the viewer and the ledger/policy/bindings/config-file stamps. Sources changed within the last heartbeat (finer than any file timestamp granularity) read through.
  // Without a memo, reads (scope contexts, decisions) are still shared within this one inspection.
  const session = memo ?? new MonitorSourceMemo(), recalls = new Map<string, Promise<MonitorRecall>>(), recall = (path: string) => recalls.get(path) ?? recalls.set(path, !memo ? Promise.resolve(session.recall(path, null))
    : installed(path).then(async ({ config: c }) => { const stamp = await stampMonitorInstall(c, options).catch(() => null), settled = stamp && new SystemTrustedClock().sample().wallMs - stamp.changedAtMs >= c.inspection.workers.heartbeatMs;
      return memo.recall(path, settled ? stamp.stamp : null); })).get(path)!;
  const scope = async (path: string, scopeId: string) => (await recall(path))(`context\0${scopeId}\0${path}`, () => loadConfiguredScopeContext(path, scopeId, options, 'read'));
  return new MonitorApplication({ now: () => new SystemTrustedClock().sample().wallMs,
    readConfigFreshness: async (target, descriptor) => runtimeConfigFreshness(descriptor.configDigest, await loadComposedConfig(target.path, { ...options, heal: false }) as unknown as Record<string, unknown>),
    readImageRefresh: target => inspectToolchainRefresh(target.path, options), readDismissed: (target, scopeId, limit) => inspectConfiguredDismissedDeliveries(target.path, scopeId, limit, options),
    // f4: active Brain quota waits (state/brain-waits) of this install; the reader creates nothing, a missing store is no wait.
    readBrainWaits: async target => { const layout = (await installed(target.path)).config.productLayout;
      return new FileBrainQuotaWaitStore(async () => inspectProductDirectory(layout, 'brainWaits').catch((error: unknown) => {
        if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return null; throw error; }), () => new SystemTrustedClock().sample().wallMs).list(); },
    describeService: target => createConfiguredRuntimeClient(target.path, options).describeService(undefined, 'current'),
    indexLedger: async target => indexMonitorInstall((await installed(target.path)).config),
    // M-VIS: allowed when the viewer's `pool inspect` decision allows in any admitted or own configured scope (same decision as `pool status`).
    observePool: async (target, poolId, scopeIds) => { const { home } = await installed(target.path);
      return (await recall(target.path))(JSON.stringify(['pool', poolId, scopeIds]), async () => { for (const scopeId of new Set([...scopeIds, ...home])) if (await granted(async () => { const c = await scope(target.path, scopeId);
        assertPoolControlAllowed(await new PoolControlPolicyAuthorization({ async load() { return c.document; } }).decide('inspect', poolId, scopeId, c.principal)); })) return true;
      return false; }); },
    // MON-NAMES: the installation-wide decision needs the viewer's policy and principal only, the same from any scope's context (first that loads).
    observeScopeDiagnostics: async (target, scopeIds) => { const { home } = await installed(target.path); let failure: unknown = null;
      return (await recall(target.path))('scope-diagnostics', async () => { for (const scopeId of new Set([...scopeIds, ...home])) {
        const c = await scope(target.path, scopeId).catch((error: unknown) => { failure = error; return null; }); if (c) return monitorScopeDiagnosticsAllowed(c.document, c.principal); }
      if (failure) throw queryFailure(failure); return false; }); },
    readLedger: async (target, readScope) => { const { config: installedConfig, home } = await installed(target.path);
      // The ledger capture is recalled (a reading with an unavailable part is not kept); readShown below still reads open workers' live tails every call.
      const captured = await (await recall(target.path))(JSON.stringify(['ledger', readScope]), () => prepareMonitorInstall(installedConfig, options.env, identity => granted(async () => {
        const c = await scope(target.path, identity.scopeId); await contextDispatchAuthorization(c, c.document).authorizeIdentity('read-output', identity, c.principal); }), undefined, readScope),
      value => !value.reading.diagnostics.some(code => code.includes('unavailable')));
      const reading = captured.reading, ceiling = installedConfig.max_workers === 'auto' ? Infinity : installedConfig.max_workers;
      const modelScopes = [...new Set([...readScope.scopeIds, ...home])];
      const models: import('#engine/index.js').MonitorMap['models'][number][] = [];
      const modelDiagnostics: string[] = [];
      for (const scopeId of modelScopes) {
        try {
          const state = await inspectConfiguredInvocableModels(target.path, scopeId, options);
          for (const model of state.models) models.push({ ...reading.map?.models.find(row => row.channelId === model.reference.providerId && row.modelId === model.reference.modelId),
            channelId: model.reference.providerId, modelId: model.reference.modelId, reference: model.reference,
            scopeId, active: model.availability.invocable, availability: model.availability });
        } catch (error) { modelDiagnostics.push(`model-state-unavailable:${queryFailure(error).code}`); }
      }
      // M2 (f2): catalog models no tier/role row names, counted once across scopes (the same read as the doctor row), recalled per scope: the tier/role
      // rows are config, the catalog is config and registry data. A scope that cannot read it adds nothing (a failed read is not kept).
      const pendingRoles = new Set<string>();
      for (const scopeId of modelScopes) {
        try { for (const entry of await (await recall(target.path))(`roles\0${scopeId}`, async () => (await inspectConfiguredModelRoles(target.path, { schemaVersion: 1, scopeId }, { ...options, heal: false })).models
          .filter(row => row.state === 'pending').map(row => JSON.stringify([row.channelId, row.modelId])))) pendingRoles.add(entry); } catch { /* read-soft, as the doctor row */ }
      }
      if (pendingRoles.size) modelDiagnostics.push(`model-roles-pending:${pendingRoles.size}`);
      // S8-4: the catalog lines, summed across scopes ("öneri bekliyor (N)", "imzalayan iptal edildi", "imza anahtarı yok"); a scope that cannot read adds nothing.
      const catalog = new Map<string, number>();
      for (const scopeId of modelScopes) for (const line of await (await recall(target.path))(`catalog\0${scopeId}`, () => inspectConfiguredCatalogMonitor(target.path, scopeId, options)).catch(() => [] as readonly string[])) {
        if (line.startsWith('catalog-aggregator-unsigned:')) { modelDiagnostics.push(line); continue; }
        const [code, count] = line.split(':') as [string, string | undefined]; catalog.set(code, (catalog.get(code) ?? 0) + (count === undefined ? 0 : Number(count)));
      }
      for (const [code, count] of catalog) modelDiagnostics.push(count ? `${code}:${count}` : code);
      const effective = { ...reading, runs: reading.runs.map(run => ({ ...run, costComparison: { registry: installedConfig.admission?.registry, policy: installedConfig.resourceObservation.recommendation } })), pools: reading.pools.map(pool => ({ ...pool,
        capacity: { executionSlots: pool.executionSlots, inFlightSlots: pool.inFlightSlots }, executionSlots: Math.min(pool.executionSlots, ceiling), inFlightSlots: Math.min(pool.inFlightSlots, ceiling) })),
        ...(reading.map ? { map: { ...reading.map, models } } : {}), diagnostics: [...reading.diagnostics, ...modelDiagnostics] };
      captures.set(target.path, { ...captured, reading: effective }); return effective; },
    readShown: async (target, identities, failures) => { const captured = captures.get(target.path)!, hydrated = await captured.readShown(identities, failures);
      return { ...hydrated, pools: captured.reading.pools, map: captured.reading.map,
        diagnostics: [...new Set([...hydrated.diagnostics, ...captured.reading.diagnostics])] }; },
    async observeScope(target, scopeId) {
      // One walk per scope: one context and reader for all its pages up to `maxEntries` (was one inventory call per page).
      const recalled = await recall(target.path); let page;
      try { page = (await inspectConfiguredWorkers(target.path, { schemaVersion: 1, scopeId, source: 'current', after: null, open: true }, options, { recall: recalled, entries: config.inspection.workers.maxEntries })).sources[0]!; }
      catch (error) { const reason = queryFailure(error).code; if (DENIED.has(reason)) return { access: 'denied', reason, workers: [], workerStatus: 'denied', truncated: false }; throw error; }
      return { access: 'admitted', workers: page.workers, workerStatus: page.status, truncated: page.nextAfter !== null, approvals: await recalled(`approvals\0${scopeId}`, () => granted(async () => {
        const c = await scope(target.path, scopeId); authorizeApproval(c.document, 'inspect', scopeId, scopeId, c.principal); })) };
    } }).inspect(targets, selection);
}
/** Snapshot reads use the stream's fresh collection admission. */ export async function inspectSurfaceAccess(root: string, scopeId: string, options: ConfigLoadOptions) { const read = await authorizeSurfaceRead(root, scopeId, options); return read && !('access' in read) ? { binding: read.binding, kinds: read.kinds } : null; }
export async function inspectSurfaceRunIds(root: string, scopeId: string, options: ConfigLoadOptions) { const read = await authorizeSurfaceRead(root, scopeId, options); return read && !('access' in read) && read.kinds.includes('run') ? listSurfaceRunIds(read) : []; }
