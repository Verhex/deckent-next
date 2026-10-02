import type { LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { RuntimeServiceProtocolError, approvalResultForProtocol, approvalSubjectsHiddenFromProtocol, runtimeServiceResultCapacity, type RuntimeServiceRequest,
  type TurnDecisionCapabilities } from '#engine/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';

/** Runtime approval operations, answered in the request's protocol shape (C12 G1/G2: a released client never receives a record it cannot parse). */
export async function executeRuntimeApproval(projectRoot: string, request: RuntimeServiceRequest,
  peer: LocalPeerIdentity, responseMaxBytes: number, options: ConfigLoadOptions, decisions?: TurnDecisionCapabilities) {
  const actions = { listApprovals: 'list', inspectApproval: 'inspect', decideApproval: 'decide', renewApproval: 'renew' } as const;
  if (!(request.operation in actions) || !request.delivery) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  const capacity = runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes);
  const action = actions[request.operation as keyof typeof actions];
  // Subjects the client cannot parse are excluded in the page selection (LIMIT counts visible records) and the capacity applies to that page.
  const view = { excludeSubjects: approvalSubjectsHiddenFromProtocol(request.schemaVersion) };
  return approvalResultForProtocol(request.schemaVersion, action, await configuredApproval(projectRoot, action, request.input, options, peer, capacity, view, decisions));
}
