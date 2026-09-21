import type { LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { RuntimeServiceProtocolError, runtimeServiceResultCapacity, type RuntimeServiceRequest } from '#engine/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
export async function executeRuntimeApproval(projectRoot: string, request: RuntimeServiceRequest,
  peer: LocalPeerIdentity, responseMaxBytes: number, options: ConfigLoadOptions) {
  const actions = { listApprovals: 'list', inspectApproval: 'inspect', decideApproval: 'decide', renewApproval: 'renew' } as const;
  if (!(request.operation in actions) || !request.delivery) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  const capacity = runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes);
  return configuredApproval(projectRoot, actions[request.operation as keyof typeof actions], request.input, options, peer, capacity);
}
