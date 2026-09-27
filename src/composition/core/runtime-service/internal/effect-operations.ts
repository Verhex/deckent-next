import { RuntimeServiceProtocolError, runtimeServiceResultCapacity, type RuntimeServiceRequest } from '#engine/index.js';
import type { LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { inspectPeerOperation, submitPeerOperation } from '#composition/core/operations/index.js';

/** v15 catalog operations (C12 G4): the socket peer is the principal of the one operation producer the CLI/SDK use. A result larger than
 * the delivery is a typed limit; an execute/compensate outcome is durable before it is answered, so the same command replays it. */
export async function executeConfiguredRuntimeEffectOperation(projectRoot: string, request: RuntimeServiceRequest, peer: LocalPeerIdentity,
  responseMaxBytes: number, options: ConfigLoadOptions): Promise<unknown> {
  if (!request.delivery) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  const capacity = runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes);
  const result = request.operation === 'executeOperation' ? await submitPeerOperation(projectRoot, 'execute', request.input, peer, options)
    : request.operation === 'compensateOperation' ? await submitPeerOperation(projectRoot, 'compensate', request.input, peer, options)
    : request.operation === 'inspectOperation' ? await inspectPeerOperation(projectRoot, request.input, peer, options) : null;
  if (result === null) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > capacity) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
  return result;
}
