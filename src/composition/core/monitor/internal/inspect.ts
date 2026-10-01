import { resolve } from 'node:path';
import { loadConfig, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { readMonitorInstall, registerProviderConfig } from '#adapters/index.js';
import { MonitorApplication, type MonitorSnapshot, type WorkerObservation, type WorkerObservationSource } from '#engine/index.js';
import { inspectConfiguredWorkers } from '#composition/core/worker-observation/index.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

const DENIED = new Set(['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED', 'SCOPE_UNKNOWN']);
/** MONITOR (owner 2026-10-02): the current project plus each configured `next-project` source (deduplicated by path), each through its own
 * config, layout, ledger (read-only), runtime describe and scope policy (its `inspect` decision admits the scope's Runs and workers). */
export async function inspectMonitor(root: string, options: ConfigLoadOptions = {}): Promise<MonitorSnapshot> {
  registerProviderConfig(); const config = await loadConfig(root, { ...options, heal: false }).catch(error => { throw queryFailure(error); });
  const targets = [{ id: 'current', path: resolve(root) }, ...config.inspection.workers.sources.filter(source => source.kind === 'next-project')
    .map(source => ({ id: source.id, path: resolve(source.path) }))].filter((target, index, all) => all.findIndex(other => other.path === target.path) === index);
  return new MonitorApplication({ now: () => new SystemTrustedClock().sample().wallMs,
    describeService: target => createConfiguredRuntimeClient(target.path, options).describeService(undefined, 'current'),
    readLedger: async target => readMonitorInstall(await loadConfig(target.path, { ...options, heal: false }), options.env),
    async observeScope(target, scopeId) {
      const workers: WorkerObservation[] = []; let page: WorkerObservationSource | undefined; let after: string | null = null;
      try {
        do { page = (await inspectConfiguredWorkers(target.path, { schemaVersion: 1, scopeId, source: 'current', after, open: true }, options)).sources[0]!; workers.push(...page.workers); after = page.nextAfter; }
        while (after && workers.length < config.inspection.workers.maxEntries);
      } catch (error) { if (DENIED.has(queryFailure(error).code)) return { access: 'denied', workers: [], workerStatus: 'denied', truncated: false }; throw error; }
      return { access: 'admitted', workers, workerStatus: page.status, truncated: after !== null };
    } }).inspect(targets);
}
