import type { ConfigCommandContext } from '#surfaces/core/config/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { ConfigLoadOptions, ProductLayout } from '#platform/index.js';
import type { DispatchInventoryInput, DispatchInventoryPage, WorkerObservationQuery, WorkerObservationReport } from '#engine/index.js';
import type { MonitorHandler } from './command.js';

/** The dispatch inventory read (`deckent inventory` lives in cli-run since C-RUN; the terminal's ledger port still reads through this type). */
export type InventoryQueryHandler = (root: string, query: DispatchInventoryInput, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; page: DispatchInventoryPage }>>;
export type WorkerObservationHandler = (root: string, query: WorkerObservationQuery, options: ConfigLoadOptions) => Promise<WorkerObservationReport>;

/** The host operations the observation commands (monitor, workers, inventory) use; the CLI's full command context satisfies it. */
export interface MonitorCommandContext extends CliBaseContext, ConfigCommandContext {
  inspectWorkers?: WorkerObservationHandler;
  inspectInventory?: InventoryQueryHandler;
  /** MONITOR: the whole observe-only snapshot (data lane, composition); `deckent monitor` and `/monitor` fail typed without it. */
  inspectMonitor?: MonitorHandler;
}
