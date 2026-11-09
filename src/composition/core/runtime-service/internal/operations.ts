import { mintAttendedWorkerDecision } from '#capabilities/index.js';
import { approvalCommandSchema, bindRuntimeApplicationMethods, executeRuntimeApplicationOperation, type RuntimeServiceDelivery, type RuntimeServiceRequest, type TurnDecisionCapabilities } from '#engine/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { attestLocalInteractiveTerminal, type LocalPeerIdentity } from '#adapters/index.js';
import { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { executeConfiguredTask, withNativeCliWorkerOptions } from '#composition/core/execution/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
import { proposeConfiguredRun, inspectConfiguredRunProposal, createConfiguredRun, deliverConfiguredRunCancellation, evaluateConfiguredTask, inspectConfiguredRun,
  reconcileConfiguredAttempt, recoverConfiguredCancellations, requestConfiguredRunCancellation,
  reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
export function createConfiguredRuntimeOperations(projectRoot: string, options: ConfigLoadOptions = {}) {
  const executionOptions = withNativeCliWorkerOptions(projectRoot, options);
  return Object.freeze({
    renewApproval(input: unknown, delivery?: RuntimeServiceDelivery) { return configuredApproval(projectRoot, 'renew', input, options, undefined, delivery?.maxResultBytes); },
    listApprovals(input: unknown, delivery?: RuntimeServiceDelivery) { return configuredApproval(projectRoot, 'list', input, options, undefined, delivery?.maxResultBytes); },
    inspectApproval(input: unknown, delivery?: RuntimeServiceDelivery) { return configuredApproval(projectRoot, 'inspect', input, options, undefined, delivery?.maxResultBytes); },
    decideApproval(input: unknown, delivery?: RuntimeServiceDelivery) { return configuredApproval(projectRoot, 'decide', input, options, undefined, delivery?.maxResultBytes); },
    ...bindRuntimeApplicationMethods(projectRoot, options, { proposeRun: proposeConfiguredRun, inspectRunProposal: inspectConfiguredRunProposal, createRun: createConfiguredRun,
      reserveRunTasks: reserveConfiguredRunTasks, executeTask: (root: string, input: Parameters<typeof executeConfiguredTask>[1]) => executeConfiguredTask(root, input, executionOptions), evaluateTask: evaluateConfiguredTask, inspectRun: inspectConfiguredRun,
      inspectInventory: inspectConfiguredInventory, requestRunCancellation: requestConfiguredRunCancellation, deliverRunCancellation: deliverConfiguredRunCancellation,
      reconcileAttempt: reconcileConfiguredAttempt, recoverCancellations: recoverConfiguredCancellations }),
  });
}
export type ConfiguredRuntimeOperations = ReturnType<typeof createConfiguredRuntimeOperations>;
export const executeConfiguredRuntimeOperation = (projectRoot: string, request: RuntimeServiceRequest, options: ConfigLoadOptions = {}) =>
  executeRuntimeApplicationOperation(createConfiguredRuntimeOperations(projectRoot, options), request);

/** Background cards have no initiating terminal. Bind the fresh witnessed deciding peer, then use the existing application unchanged. */
export async function attendedWorkerApprovalInput(root: string, input: unknown, peer: LocalPeerIdentity, options: ConfigLoadOptions,
  decisions?: TurnDecisionCapabilities): Promise<unknown> {
  if (!decisions) return input;
  const command = approvalCommandSchema.parse(input);
  if (command.decision !== 'allow' || command.decisionCapability) return input;
  const record = await configuredApproval(root, 'inspect', { schemaVersion: 1, scopeId: command.scopeId, approvalId: command.approvalId }, options, peer);
  const context = await loadPeerInvocationContext(root, command.scopeId, options, peer, 'write');
  const capability = mintAttendedWorkerDecision(record as import('#domain/index.js').ApprovalRecord | null, context.principal, peer.pid,
    await attestLocalInteractiveTerminal(peer.pid, peer.uid), decisions, Date.now());
  return capability ? { ...command, decisionCapability: capability } : input;
}
