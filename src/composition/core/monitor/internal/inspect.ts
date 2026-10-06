import { resolve } from 'node:path';
import { loadConfig, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { listSurfaceRunIds, prepareMonitorInstall, registerProviderConfig, followLedgerSurface as readLedgerSurface } from '#adapters/index.js';
import { MonitorApplication, authorizeApproval, runtimeConfigFreshness, type SurfaceNotInitialized, type MonitorSnapshot, type WorkerObservation, type WorkerObservationSource } from '#engine/index.js';
import { inspectConfiguredWorkers } from '#composition/core/worker-observation/index.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { contextDispatchAuthorization } from '#composition/core/policy/index.js';
import { inspectToolchainRefresh } from '#composition/core/toolchains/index.js';
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
export async function inspectMonitor(root: string, options: ConfigLoadOptions = {}): Promise<MonitorSnapshot> {
  registerProviderConfig(); const config = await loadConfig(root, { ...options, heal: false }).catch(error => { throw queryFailure(error); });
  const targets = [{ id: 'current', path: resolve(root) }, ...config.inspection.workers.sources.filter(source => source.kind === 'next-project')
    .map(source => ({ id: source.id, path: resolve(source.path) }))].filter((target, index, all) => all.findIndex(other => other.path === target.path) === index);
  const contexts = new Map<string, ReturnType<typeof loadConfiguredScopeContext>>(), scope = (path: string, scopeId: string) => contexts.get(`${path}\0${scopeId}`)
    ?? contexts.set(`${path}\0${scopeId}`, loadConfiguredScopeContext(path, scopeId, options, 'read')).get(`${path}\0${scopeId}`)!;
  const captures = new Map<string, Awaited<ReturnType<typeof prepareMonitorInstall>>>(); return new MonitorApplication({ now: () => new SystemTrustedClock().sample().wallMs,
    readConfigFreshness: async (target, descriptor) => runtimeConfigFreshness(descriptor.configDigest, await loadConfig(target.path, { ...options, heal: false }) as unknown as Record<string, unknown>),
    readImageRefresh: target => inspectToolchainRefresh(target.path, options),
    describeService: target => createConfiguredRuntimeClient(target.path, options).describeService(undefined, 'current'),
    readLedger: async target => { const installed = await loadConfig(target.path, { ...options, heal: false });
      const captured = await prepareMonitorInstall(installed, options.env, identity => granted(async () => {
        const c = await scope(target.path, identity.scopeId); await contextDispatchAuthorization(c).authorizeIdentity('read-output', identity, c.principal); }));
      const reading = captured.reading; const ceiling = installed.max_workers === 'auto' ? Infinity : installed.max_workers;
      const effective = { ...reading, pools: reading.pools.map(pool => ({ ...pool,
        capacity: { executionSlots: pool.executionSlots, inFlightSlots: pool.inFlightSlots }, executionSlots: Math.min(pool.executionSlots, ceiling), inFlightSlots: Math.min(pool.inFlightSlots, ceiling) })) };
      captures.set(target.path, { ...captured, reading: effective }); return effective; },
    readShown: async (target, identities) => { const captured = captures.get(target.path)!, hydrated = await captured.readShown(identities);
      return { ...hydrated, pools: captured.reading.pools }; },
    async observeScope(target, scopeId) {
      const workers: WorkerObservation[] = []; let page: WorkerObservationSource | undefined; let after: string | null = null;
      try {
        do { page = (await inspectConfiguredWorkers(target.path, { schemaVersion: 1, scopeId, source: 'current', after, open: true }, options)).sources[0]!; workers.push(...page.workers); after = page.nextAfter; }
        while (after && workers.length < config.inspection.workers.maxEntries);
      } catch (error) { if (DENIED.has(queryFailure(error).code)) return { access: 'denied', workers: [], workerStatus: 'denied', truncated: false }; throw error; }
      return { access: 'admitted', workers, workerStatus: page.status, truncated: after !== null, approvals: await granted(async () => {
        const c = await scope(target.path, scopeId); authorizeApproval(c.document, 'inspect', scopeId, scopeId, c.principal); }) };
    } }).inspect(targets);
}
/** Snapshot reads use the stream's fresh collection admission. */ export async function inspectSurfaceAccess(root: string, scopeId: string, options: ConfigLoadOptions) { const read = await authorizeSurfaceRead(root, scopeId, options); return read && !('access' in read) ? { binding: read.binding, kinds: read.kinds } : null; }
export async function inspectSurfaceRunIds(root: string, scopeId: string, options: ConfigLoadOptions) { const read = await authorizeSurfaceRead(root, scopeId, options); return read && !('access' in read) && read.kinds.includes('run') ? listSurfaceRunIds(read) : []; }
