import { configuredApproval } from '#composition/core/approvals/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { executeRuntimeOperation, type RuntimeServiceRequest, type RuntimeServiceDelivery } from '#engine/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
import { proposeConfiguredRun, inspectConfiguredRunProposal, createConfiguredRun, deliverConfiguredRunCancellation, evaluateConfiguredTask, inspectConfiguredRun,
  reconcileConfiguredAttempt, recoverConfiguredCancellations, requestConfiguredRunCancellation,
  reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
/** Closed local composition map. Each operation revalidates untrusted protocol input before any I/O. */
export function createConfiguredRuntimeOperations(projectRoot: string, options: ConfigLoadOptions = {}) {
  return Object.freeze({
    renewApproval(input: unknown, delivery?: RuntimeServiceDelivery) { return configuredApproval(projectRoot, 'renew', input, options, undefined, delivery?.maxResultBytes); },
    listApprovals(input: unknown, delivery?: RuntimeServiceDelivery) { return configuredApproval(projectRoot, 'list', input, options, undefined, delivery?.maxResultBytes); },
    inspectApproval(input: unknown, delivery?: RuntimeServiceDelivery) { return configuredApproval(projectRoot, 'inspect', input, options, undefined, delivery?.maxResultBytes); },
    decideApproval(input: unknown, delivery?: RuntimeServiceDelivery) { return configuredApproval(projectRoot, 'decide', input, options, undefined, delivery?.maxResultBytes); },
    proposeRun(input: Parameters<typeof proposeConfiguredRun>[1]) { return proposeConfiguredRun(projectRoot, input, options); },
    inspectRunProposal(input: Parameters<typeof inspectConfiguredRunProposal>[1]) { return inspectConfiguredRunProposal(projectRoot, input, options); },
    createRun(input: Parameters<typeof createConfiguredRun>[1]) { return createConfiguredRun(projectRoot, input, options); },
    reserveRunTasks(input: Parameters<typeof reserveConfiguredRunTasks>[1]) { return reserveConfiguredRunTasks(projectRoot, input, options); },
    executeTask(input: Parameters<typeof executeConfiguredTask>[1]) { return executeConfiguredTask(projectRoot, input, options); },
    evaluateTask(input: Parameters<typeof evaluateConfiguredTask>[1]) { return evaluateConfiguredTask(projectRoot, input, options); },
    inspectRun(input: Parameters<typeof inspectConfiguredRun>[1]) { return inspectConfiguredRun(projectRoot, input, options); },
    inspectInventory(input: Parameters<typeof inspectConfiguredInventory>[1]) { return inspectConfiguredInventory(projectRoot, input, options); },
    requestRunCancellation(input: Parameters<typeof requestConfiguredRunCancellation>[1]) { return requestConfiguredRunCancellation(projectRoot, input, options); },
    deliverRunCancellation(input: Parameters<typeof deliverConfiguredRunCancellation>[1]) { return deliverConfiguredRunCancellation(projectRoot, input, options); },
    reconcileAttempt(input: Parameters<typeof reconcileConfiguredAttempt>[1]) { return reconcileConfiguredAttempt(projectRoot, input, options); },
    recoverCancellations(input: Parameters<typeof recoverConfiguredCancellations>[1]) { return recoverConfiguredCancellations(projectRoot, input, options); },
  });
}
export type ConfiguredRuntimeOperations = ReturnType<typeof createConfiguredRuntimeOperations>;
/** Host wiring only; protocol validation precedes configured I/O. */
export async function executeConfiguredRuntimeOperation(projectRoot: string, request: RuntimeServiceRequest, options: ConfigLoadOptions = {}): Promise<unknown> {
  return executeRuntimeOperation(createConfiguredRuntimeOperations(projectRoot, options), request);
}
