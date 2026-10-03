import { resolve } from 'node:path';
import { loadConfig, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { readMonitorInstall, registerProviderConfig } from '#adapters/index.js';
import { MonitorApplication, authorizeApproval, type MonitorSnapshot, type WorkerObservation, type WorkerObservationSource } from '#engine/index.js';
import { inspectConfiguredWorkers } from '#composition/core/worker-observation/index.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { contextDispatchAuthorization } from '#composition/core/policy/index.js';
const DENIED = new Set(['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED', 'SCOPE_UNKNOWN', 'APPROVAL_DENIED']);
const granted = (check: () => Promise<unknown>) => check().then(() => true, (error: unknown) => { if (DENIED.has(queryFailure(error).code)) return false; throw error; });
export async function inspectMonitor(root: string, options: ConfigLoadOptions = {}): Promise<MonitorSnapshot> {
  registerProviderConfig(); const config = await loadConfig(root, { ...options, heal: false }).catch(error => { throw queryFailure(error); });
  const targets = [{ id: 'current', path: resolve(root) }, ...config.inspection.workers.sources.filter(source => source.kind === 'next-project')
    .map(source => ({ id: source.id, path: resolve(source.path) }))].filter((target, index, all) => all.findIndex(other => other.path === target.path) === index);
  const contexts = new Map<string, ReturnType<typeof loadConfiguredScopeContext>>(), scope = (path: string, scopeId: string) => contexts.get(`${path}\0${scopeId}`)
    ?? contexts.set(`${path}\0${scopeId}`, loadConfiguredScopeContext(path, scopeId, options, 'read')).get(`${path}\0${scopeId}`)!;
  return new MonitorApplication({ now: () => new SystemTrustedClock().sample().wallMs,
    describeService: target => createConfiguredRuntimeClient(target.path, options).describeService(undefined, 'current'),
    readLedger: async target => {
      const installed = await loadConfig(target.path, { ...options, heal: false });
      const reading = await readMonitorInstall(installed, options.env, identity => granted(async () => {
        const c = await scope(target.path, identity.scopeId); await contextDispatchAuthorization(c).authorizeIdentity('read-output', identity, c.principal); }));
      const ceiling = installed.max_workers === 'auto' ? Infinity : installed.max_workers;
      return { ...reading, pools: reading.pools.map(pool => ({ ...pool,
        capacity: { executionSlots: pool.executionSlots, inFlightSlots: pool.inFlightSlots }, executionSlots: Math.min(pool.executionSlots, ceiling), inFlightSlots: Math.min(pool.inFlightSlots, ceiling) })) };
    },
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
