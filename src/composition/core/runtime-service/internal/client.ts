import { attestLocalInteractiveTerminal, localPrincipalChannel, LocalRuntimeSocketError, prepareRuntimeSocket, requestLocalRuntime, streamLocalRuntime, turnLocalRuntime } from '#adapters/index.js';
import { ErrorRegistry, ManagedFileError, type ConfigLoadOptions } from '#platform/index.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { runtimeTargetQueueTerminal, createRuntimeQueueSubmission, createRuntimeRequestTransport, createRuntimeServiceClient,
  type RuntimeServiceDelivery, type EffectOutcome, type RuntimeOperationQuery } from '#engine/index.js';
import type { EffectCommand, EffectRecord } from '#domain/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { socketOptions } from './socket-options.js';
import type { ConfiguredRuntimeOperations } from './operations.js';
export type ConfiguredRuntimeClient = ReturnType<typeof createRuntimeServiceClient<ConfiguredRuntimeOperations>> & Readonly<{
  executeOperation(command: EffectCommand, delivery?: RuntimeServiceDelivery): Promise<EffectOutcome>;
  inspectOperation(query: RuntimeOperationQuery, delivery?: RuntimeServiceDelivery): Promise<Readonly<{ schemaVersion: 1; record: EffectRecord | null }>>;
}>;
function configuredRuntimeTransport(projectRoot: string, options: ConfigLoadOptions) {
  return createRuntimeRequestTransport({ channel: localPrincipalChannel, failure: queryFailure,
    async prepare() {
      const config = await loadComposedConfig(projectRoot, { ...options, heal: false });
      const endpoint = await prepareRuntimeSocket(config.productLayout, false).catch(error => {
        if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') throw new LocalRuntimeSocketError('LOCAL_RUNTIME_UNAVAILABLE', { cause: error }); throw error;
      });
      return { ...config, endpoint };
    },
    request: (config, request, signal) => requestLocalRuntime(socketOptions(config.service, config.endpoint), request, signal),
    stream: (config, request, sink, signal) => streamLocalRuntime(socketOptions(config.service, config.endpoint), request, sink, signal),
    turn: (config, request, sink, signal) => turnLocalRuntime(socketOptions(config.service, config.endpoint), request, sink, signal),
  });
}
const clientPorts = (projectRoot: string, options: ConfigLoadOptions) => ({ attempt: configuredRuntimeTransport(projectRoot, options), mapFailure: queryFailure,
  readPolicy: async () => (await loadComposedConfig(projectRoot, { ...options, heal: false })).service, wait: (ms: number, signal?: AbortSignal) => sleep(ms, undefined, signal ? { signal } : {}) });
export function createConfiguredRuntimeClient(projectRoot: string, options: ConfigLoadOptions = {}): ConfiguredRuntimeClient {
  return createRuntimeServiceClient<ConfiguredRuntimeOperations>(clientPorts(projectRoot, options));
}
/** CLI/Terminal only (DESIGN §6): submission and the TTY-bound confirmation. The SDK client above stays inspect/list; the service refuses MCP submission. */
export function configuredTargetQueueTerminal(projectRoot: string, options: ConfigLoadOptions = {}) {
  const ports = clientPorts(projectRoot, options), interactive = async () => { if (localPrincipalChannel() === 'mcp' || !await attestLocalInteractiveTerminal()) throw ErrorRegistry.createError('DELIVERY_INTERACTIVE_REQUIRED'); };
  return { deliveryQueue: createRuntimeQueueSubmission(ports), confirmDeliveryQueue: runtimeTargetQueueTerminal(ports.attempt, interactive) };
}
