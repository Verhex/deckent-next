import type { ConfigCommandContext } from '#surfaces/core/config/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { WorkerObservationQuery, WorkerObservationReport } from '#engine/index.js';
import type { InventoryQueryHandler } from './inventory.js';
import type { MonitorHandler } from './command.js';

export type WorkerObservationHandler = (root: string, query: WorkerObservationQuery, options: ConfigLoadOptions) => Promise<WorkerObservationReport>;

/** The host operations the observation commands (monitor, workers, inventory) use; the CLI's full command context satisfies it. */
export interface MonitorCommandContext extends CliBaseContext, ConfigCommandContext {
  inspectWorkers?: WorkerObservationHandler;
  inspectInventory?: InventoryQueryHandler;
  /** MONITOR: the whole observe-only snapshot (data lane, composition); `deckent monitor` and `/monitor` fail typed without it. */
  inspectMonitor?: MonitorHandler;
}
