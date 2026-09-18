import { socketOptions } from './socket-options.js';
import { randomUUID } from 'node:crypto';
import { ErrorRegistry, loadConfig, prepareProductSocket, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, requestLocalRuntime } from '#adapters/index.js';
import { runtimeServiceOperationSchema, type RuntimeServiceOperation } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import type { ConfiguredRuntimeOperations } from './operations.js';

/** No direct-execution fallback: a missing service is an explicit transport failure. */
export function createConfiguredRuntimeClient(projectRoot: string, options: ConfigLoadOptions = {}): ConfiguredRuntimeOperations {
  const call = async (operation: RuntimeServiceOperation, input: unknown): Promise<unknown> => {
    try {
      registerProviderConfig();
      const config = await loadConfig(projectRoot, { ...options, heal: false });
      const endpoint = await prepareProductSocket(config.productLayout, 'runtimeSocket', false);
      const response = await requestLocalRuntime(socketOptions(config.service, endpoint),
        { schemaVersion: 1, requestId: randomUUID(), operation, input });
      if (!response.ok) throw ErrorRegistry.createError(ErrorRegistry.has(response.error.code) ? response.error.code : 'RUNTIME_SERVICE_TRANSPORT');
      return response.result;
    } catch (error) { throw queryFailure(error); }
  };
  // The closed protocol vocabulary and the precisely typed server operation map describe the same methods.
  return Object.freeze(Object.fromEntries(runtimeServiceOperationSchema.options.map(operation =>
    [operation, (input: unknown) => call(operation, input)]))) as ConfiguredRuntimeOperations;
}
