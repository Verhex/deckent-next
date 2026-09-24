import { modelInvocationCancellationCommandInputSchema, modelInvocationCommandInputSchema, modelInvocationQueryInputSchema, modelInvocationPurgeCommandInputSchema,
  type ModelInvocationPurgeCommand, type ModelInvocationCommand, type ModelInvocationQuery } from '#domain/index.js';
import { runtimeServiceResultCapacity, RuntimeServiceProtocolError, type RuntimeServiceRequest } from '#engine/index.js';
import type { LocalPeerIdentity, RuntimeServiceStreamChannel } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { cancelPeerConfiguredModelInvocation, type RuntimeModelInvocationHost, invokePeerConfiguredModel, inspectPeerConfiguredModelInvocation, purgePeerConfiguredModelInvocationContent } from '#composition/core/model-invocation/index.js';

/** Transport capacity narrows admission; native peer identity comes from the socket, never request input. */
export function executeConfiguredRuntimeModelOperation(projectRoot: string, request: RuntimeServiceRequest,
  peer: LocalPeerIdentity, responseMaxBytes: number, options: ConfigLoadOptions, host: RuntimeModelInvocationHost,
  stream?: RuntimeServiceStreamChannel) {
  if (!request.delivery) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  const delivery = { maxResultBytes: runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes) };
  if (request.operation === 'cancelModelInvocation') {
    return cancelPeerConfiguredModelInvocation(projectRoot, modelInvocationCancellationCommandInputSchema.parse(request.input), peer, options, delivery, host.controllers);
  }
  if (request.operation === 'purgeModelInvocationContent') {
    return purgePeerConfiguredModelInvocationContent(projectRoot, modelInvocationPurgeCommandInputSchema.parse(request.input) as ModelInvocationPurgeCommand, peer, options, delivery);
  }
  if (request.operation === 'invokeModel') {
    return invokePeerConfiguredModel(projectRoot, modelInvocationCommandInputSchema.parse(request.input) as ModelInvocationCommand, peer, options, delivery, host);
  }
  if (request.operation === 'invokeModelStream') {
    // Same governed invocation as invokeModel; deltas of a fresh send go to the connection's presentation channel.
    if (!stream) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
    return invokePeerConfiguredModel(projectRoot, modelInvocationCommandInputSchema.parse(request.input) as ModelInvocationCommand, peer, options, delivery, host,
      delta => stream.emit(delta));
  }
  if (request.operation === 'inspectModelInvocation') {
    return inspectPeerConfiguredModelInvocation(projectRoot, modelInvocationQueryInputSchema.parse(request.input) as ModelInvocationQuery, peer, options, delivery);
  }
  throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
}
