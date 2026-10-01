import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { WorkerObservationHandler } from './workers.js';
import type { InventoryQueryHandler } from './inventory.js';

/** The host operations the observation commands (workers, inventory) use; the CLI's full command context satisfies it. */
export interface MonitorCommandContext extends CliBaseContext {
  inspectWorkers?: WorkerObservationHandler;
  inspectInventory?: InventoryQueryHandler;
}
