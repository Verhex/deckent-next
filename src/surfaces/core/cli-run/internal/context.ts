import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import type { RunAdmissionHandler, RunDeliveryAdmissionHandler, RunReservationHandler } from './run.js';
import type { RunProposalHandler, RunProposalInspectHandler } from './run-proposal.js';

/** The host operations the `run`, `do` and `report` commands use; the CLI's full command context satisfies it. */
export interface RunCommandContext extends CliBaseContext, Pick<TerminalLaunchContext, 'applyRunLifecycle' | 'deliverRunCancellation' | 'inspectRun' | 'planRun'> {
  proposeRun?: RunProposalHandler;
  inspectRunProposal?: RunProposalInspectHandler;
  createRun?: RunAdmissionHandler;
  createDeliveryRun?: RunDeliveryAdmissionHandler;
  reserveRunTasks?: RunReservationHandler;
}
