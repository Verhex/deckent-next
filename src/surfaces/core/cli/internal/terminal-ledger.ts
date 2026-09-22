import type { ConfigLoadOptions } from '#platform/index.js';
import type { RunQueryHandler } from './run.js';
import type { WorkerObservationHandler } from './workers.js';
import type { InventoryQueryHandler } from './inventory.js';
import type { WorklineLedgerPorts } from '#surfaces/core/terminal/index.js';

export function createWorklineLedgerPorts(input: {
  readonly root: string;
  readonly scopeId: string;
  readonly options: ConfigLoadOptions;
  readonly workerHeartbeatMs?: number;
  readonly inspectWorkers?: WorkerObservationHandler;
  readonly inspectRun?: RunQueryHandler;
  readonly inspectInventory?: InventoryQueryHandler;
}): WorklineLedgerPorts | undefined {
  if (!input.inspectWorkers || !input.inspectRun) return undefined;
  const { root, scopeId, options, inspectWorkers, inspectRun, inspectInventory, workerHeartbeatMs } = input;
  return {
    scopeId,
    ...(workerHeartbeatMs === undefined ? {} : { workerHeartbeatMs }),
    async listWorkers() {
      return inspectWorkers(root, { schemaVersion: 1, scopeId, after: null, limit: 20 }, options);
    },
    async inspectRun(runId: string) {
      const view = await inspectRun(root, { schemaVersion: 1, scopeId, runId }, options);
      return view.run;
    },
    ...(inspectInventory ? {
      async listRunIds() {
        const page = await inspectInventory(root, { schemaVersion: 1, scopeId, after: null, limit: 50 }, options);
        const ids = new Set<string>();
        for (const entry of page.page.entries) ids.add(entry.identity.runId);
        return Object.freeze([...ids]);
      },
    } : {}),
  };
}
