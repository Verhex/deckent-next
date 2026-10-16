import { RuntimeServiceProtocolError, runtimeServiceResultCapacity, type RuntimeServiceRequest } from './service-protocol.js';
import { approvalResultForProtocol, approvalSubjectsHiddenFromProtocol } from '#engine/core/approval/index.js';
/** Delivery capacity and version projection are protocol semantics; approval authority stays in the supplied command. */
export async function executeRuntimeApprovalOperation(request: RuntimeServiceRequest, responseMaxBytes: number, execute: (action: 'list' | 'inspect' | 'decide' | 'renew', input: unknown, capacity: number, view: { excludeSubjects: ReturnType<typeof approvalSubjectsHiddenFromProtocol> }) => Promise<unknown>) {
  const actions = { listApprovals: 'list', inspectApproval: 'inspect', decideApproval: 'decide', renewApproval: 'renew' } as const;
  if (!(request.operation in actions) || !request.delivery) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  const capacity = runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes);
  const action = actions[request.operation as keyof typeof actions];
  // Subjects the client cannot parse are excluded in the page selection (LIMIT counts visible records) and the capacity applies to that page.
  const view = { excludeSubjects: approvalSubjectsHiddenFromProtocol(request.schemaVersion) };
  return approvalResultForProtocol(request.schemaVersion, action, await execute(action, request.input, capacity, view));
}
