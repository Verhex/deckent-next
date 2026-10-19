import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import type { TaskEvaluationHandler, TaskExecutionHandler, TaskIntegrationAdoptHandler, TaskIntegrationCheckHandler, TaskIntegrationDeliverHandler, TaskIntegrationInspectHandler,
  TaskIntegrationPrepareHandler, TaskIntegrationRollbackHandler, TaskPatchHandler } from './task.js';

/** The host operations the `task` command uses; the CLI's full command context satisfies it. */
export interface TaskCommandContext extends CliBaseContext, Pick<TerminalLaunchContext, 'applyRunLifecycle' | 'inspectInventory' | 'inspectRun' | 'inspectWorkerTranscript'
  | 'deliveryQueue' | 'confirmDeliveryQueue' | 'inspectSurfaceRunIds' | 'interactiveDelivery' | 'configChoiceSources'> {
  deliverWorkspaceIntegration?: TaskIntegrationDeliverHandler;
  adoptWorkspaceIntegration?: TaskIntegrationAdoptHandler;
  rollbackWorkspaceIntegration?: TaskIntegrationRollbackHandler;
  inspectWorkspaceIntegration?: TaskIntegrationInspectHandler;
  checkWorkspaceIntegration?: TaskIntegrationCheckHandler;
  prepareWorkspaceIntegration?: TaskIntegrationPrepareHandler;
  prepareWorkspacePatch?: TaskPatchHandler;
  previewWorkspacePatch?: TaskPatchHandler;
  renderUnifiedDiff?: (path: string, before: string | null, after: string | null) => string;
  executeTask?: TaskExecutionHandler;
  evaluateTask?: TaskEvaluationHandler;
}
