import { randomUUID } from 'node:crypto';
import type { AgentTurnStreamEvent, ModelInvocationDeltaSink, ModelInvocationDelta } from '#domain/index.js';
import { prepareRuntimeClientRequest, acceptRuntimeClientResponse } from './client.js';
import { RUNTIME_SERVICE_SCHEMA_VERSION, type RuntimeServiceOperation, type RuntimeServiceDelivery, type RuntimeServiceLifecycleVersion, type RuntimeServiceRequest, type RuntimeServiceResponse } from './service-protocol.js';
/** Envelope, delivery bounds, event flattening and errors have one client owner; native transport remains a host port. */
export function createRuntimeRequestTransport<Context extends { service: { responseMaxBytes: number; inputMaxBytes: number } }>(ports: {
  prepare(): Promise<Context>; channel(): string | undefined; failure(error: unknown): unknown;
  request(context: Context, request: RuntimeServiceRequest, signal?: AbortSignal): Promise<RuntimeServiceResponse>;
  stream(context: Context, request: RuntimeServiceRequest, sink: (deltas: readonly ModelInvocationDelta[]) => void, signal?: AbortSignal): Promise<RuntimeServiceResponse>;
  turn(context: Context, request: RuntimeServiceRequest, sink: (events: readonly AgentTurnStreamEvent[]) => void, signal?: AbortSignal): Promise<RuntimeServiceResponse>;
}) {
  return async (operation: RuntimeServiceOperation, input: unknown, delivery?: RuntimeServiceDelivery, signal?: AbortSignal,
    onDelta?: ModelInvocationDeltaSink, version: RuntimeServiceLifecycleVersion = RUNTIME_SERVICE_SCHEMA_VERSION, onEvent?: (event: AgentTurnStreamEvent) => void): Promise<unknown> => {
    try {
      const context = await ports.prepare(), requestId = randomUUID();
      const request = prepareRuntimeClientRequest(version, requestId, operation, input, { ...context.service, maxResultBytes: delivery?.maxResultBytes, channel: ports.channel() });
      const response = onEvent ? await ports.turn(context, request, events => { for (const event of events) onEvent(event); }, signal)
        : onDelta ? await ports.stream(context, request, deltas => { for (const delta of deltas) onDelta(delta); }, signal) : await ports.request(context, request, signal);
      return acceptRuntimeClientResponse(response);
    } catch (error) { throw ports.failure(error); }
  };
}
