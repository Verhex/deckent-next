import { modelInvocationCommandInputSchema, modelInvocationQueryInputSchema,
  type ModelInvocationCommand, type ModelInvocationQuery } from '#domain/index.js';
import { runtimeServiceResultCapacity, RuntimeServiceProtocolError, type RuntimeServiceRequest } from '#engine/index.js';
import type { LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { invokePeerConfiguredModel, inspectPeerConfiguredModelInvocation } from '#composition/core/model-invocation/index.js';

/** Transport capacity narrows admission; native peer identity comes from the socket, never request input. */
export function executeConfiguredRuntimeModelOperation(projectRoot: string, request: RuntimeServiceRequest,
  peer: LocalPeerIdentity, responseMaxBytes: number, options: ConfigLoadOptions) {
  if (!request.delivery) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  const delivery = { maxResultBytes: runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes) };
  if (request.operation === 'invokeModel') {
    return invokePeerConfiguredModel(projectRoot, modelInvocationCommandInputSchema.parse(request.input) as ModelInvocationCommand, peer, options, delivery);
  }
  if (request.operation === 'inspectModelInvocation') {
    return inspectPeerConfiguredModelInvocation(projectRoot, modelInvocationQueryInputSchema.parse(request.input) as ModelInvocationQuery, peer, options, delivery);
  }
  throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
}
