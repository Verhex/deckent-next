import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ManagedFileError, type ConfigLoadOptions } from '#platform/index.js';
import { createRuntimeServiceClient, RUNTIME_SERVICE_SCHEMA_VERSION, prepareRuntimeClientRequest, acceptRuntimeClientResponse,
  type RuntimeServiceOperation, type RuntimeServiceDelivery, type RuntimeServiceLifecycleVersion, type EffectOutcome, type RuntimeOperationQuery } from '#engine/index.js';
import type { ModelInvocationDeltaSink, AgentTurnStreamEvent, EffectCommand, EffectRecord } from '#domain/index.js';
import { localPrincipalChannel, LocalRuntimeSocketError, prepareRuntimeSocket, requestLocalRuntime, streamLocalRuntime, turnLocalRuntime } from '#adapters/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { socketOptions } from './socket-options.js';
import type { ConfiguredRuntimeOperations } from './operations.js';
export type ConfiguredRuntimeClient = ReturnType<typeof createRuntimeServiceClient<ConfiguredRuntimeOperations>> & Readonly<{
  executeOperation(command: EffectCommand, delivery?: RuntimeServiceDelivery): Promise<EffectOutcome>;
  inspectOperation(query: RuntimeOperationQuery, delivery?: RuntimeServiceDelivery): Promise<Readonly<{ schemaVersion: 1; record: EffectRecord | null }>>;
}>;
/** No direct-execution fallback: a missing service is an explicit transport failure. */
export function createConfiguredRuntimeClient(projectRoot: string, options: ConfigLoadOptions = {}): ConfiguredRuntimeClient {
  const attempt = async (operation: RuntimeServiceOperation, input: unknown, delivery?: RuntimeServiceDelivery, signal?: AbortSignal,
    onDelta?: ModelInvocationDeltaSink, version: RuntimeServiceLifecycleVersion = RUNTIME_SERVICE_SCHEMA_VERSION,
    onEvent?: (event: AgentTurnStreamEvent) => void): Promise<unknown> => {
    try {
      const config = await loadComposedConfig(projectRoot, { ...options, heal: false });
      // The endpoint's never-created state directory is the same fact as a missing endpoint: no live service.
      const endpoint = await prepareRuntimeSocket(config.productLayout, false).catch(error => {
        if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') throw new LocalRuntimeSocketError('LOCAL_RUNTIME_UNAVAILABLE', { cause: error });
        throw error;
      });
      const requestId = randomUUID();
      const request = prepareRuntimeClientRequest(version, requestId, operation, input, { ...config.service, maxResultBytes: delivery?.maxResultBytes, channel: localPrincipalChannel() });
      const response = onEvent
        ? await turnLocalRuntime(socketOptions(config.service, endpoint), request, events => { for (const event of events) onEvent(event); }, signal)
        : onDelta
        ? await streamLocalRuntime(socketOptions(config.service, endpoint), request, deltas => { for (const delta of deltas) onDelta(delta); }, signal)
        : await requestLocalRuntime(socketOptions(config.service, endpoint), request, signal);
      return acceptRuntimeClientResponse(response);
    } catch (error) { throw queryFailure(error); }
  };
  return createRuntimeServiceClient<ConfiguredRuntimeOperations>({ attempt, mapFailure: queryFailure,
    readPolicy: async () => (await loadComposedConfig(projectRoot, { ...options, heal: false })).service,
    wait: (ms, signal) => sleep(ms, undefined, signal ? { signal } : {}),
  });
}
