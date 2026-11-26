import type { ConfigLoadOptions } from '#platform/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import type { RunAdmissionHandler, RunDeliveryAdmissionHandler, RunReservationHandler } from './run.js';
import type { RunProposalHandler, RunProposalInspectHandler } from './run-proposal.js';

/** The host operations the `run`, `do`, `report` and `inventory` commands use; the CLI's full command context satisfies it. */
export interface RunCommandContext extends CliBaseContext, Pick<TerminalLaunchContext, 'applyRunLifecycle' | 'deliverRunCancellation' | 'inspectRun' | 'planRun'
  | 'inspectInventory' | 'inspectSurfaceRunIds' | 'configChoiceSources'> {
  /** BeUser D-08: the newest refused work requests of a scope (sealed audit records), newest first. */
  listRefusedRequests?: (root: string, scopeId: string, limit: number, options: ConfigLoadOptions) => Promise<readonly Readonly<{ atMs: number; code: string; title: string }>[]>;
  proposeRun?: RunProposalHandler;
  inspectRunProposal?: RunProposalInspectHandler;
  createRun?: RunAdmissionHandler;
  createDeliveryRun?: RunDeliveryAdmissionHandler;
  reserveRunTasks?: RunReservationHandler;
}
