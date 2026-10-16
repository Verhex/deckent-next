import { bindRuntimeApplicationMethods, executeRuntimeApplicationOperation, type RuntimeServiceDelivery, type RuntimeServiceRequest } from '#engine/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
import { proposeConfiguredRun, inspectConfiguredRunProposal, createConfiguredRun, deliverConfiguredRunCancellation, evaluateConfiguredTask, inspectConfiguredRun,
  reconcileConfiguredAttempt, recoverConfiguredCancellations, requestConfiguredRunCancellation,
  reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
export function createConfiguredRuntimeOperations(projectRoot: string, options: ConfigLoadOptions = {}) {
  return Object.freeze({
    renewApproval(input: unknown, delivery?: RuntimeServiceDelivery) { return configuredApproval(projectRoot, 'renew', input, options, undefined, delivery?.maxResultBytes); },
    listApprovals(input: unknown, delivery?: RuntimeServiceDelivery) { return configuredApproval(projectRoot, 'list', input, options, undefined, delivery?.maxResultBytes); },
    inspectApproval(input: unknown, delivery?: RuntimeServiceDelivery) { return configuredApproval(projectRoot, 'inspect', input, options, undefined, delivery?.maxResultBytes); },
    decideApproval(input: unknown, delivery?: RuntimeServiceDelivery) { return configuredApproval(projectRoot, 'decide', input, options, undefined, delivery?.maxResultBytes); },
    ...bindRuntimeApplicationMethods(projectRoot, options, { proposeRun: proposeConfiguredRun, inspectRunProposal: inspectConfiguredRunProposal, createRun: createConfiguredRun,
      reserveRunTasks: reserveConfiguredRunTasks, executeTask: executeConfiguredTask, evaluateTask: evaluateConfiguredTask, inspectRun: inspectConfiguredRun,
      inspectInventory: inspectConfiguredInventory, requestRunCancellation: requestConfiguredRunCancellation, deliverRunCancellation: deliverConfiguredRunCancellation,
      reconcileAttempt: reconcileConfiguredAttempt, recoverCancellations: recoverConfiguredCancellations }),
  });
}
export type ConfiguredRuntimeOperations = ReturnType<typeof createConfiguredRuntimeOperations>;
export const executeConfiguredRuntimeOperation = (projectRoot: string, request: RuntimeServiceRequest, options: ConfigLoadOptions = {}) =>
  executeRuntimeApplicationOperation(createConfiguredRuntimeOperations(projectRoot, options), request);
