import type { ConfigCommandContext } from '#surfaces/core/config/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { WorkerObservationHandler } from './workers.js';
import type { InventoryQueryHandler } from './inventory.js';
import type { MonitorHandler } from './command.js';

/** The host operations the observation commands (monitor, workers, inventory) use; the CLI's full command context satisfies it. */
export interface MonitorCommandContext extends CliBaseContext, ConfigCommandContext {
  inspectWorkers?: WorkerObservationHandler;
  inspectInventory?: InventoryQueryHandler;
  /** MONITOR: the whole observe-only snapshot (data lane, composition); `deckent monitor` and `/monitor` fail typed without it. */
  inspectMonitor?: MonitorHandler;
}
