import { socketOptions } from './socket-options.js';
import { randomUUID } from 'node:crypto';
import { ErrorRegistry, loadConfig, prepareProductSocket, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, requestLocalRuntime } from '#adapters/index.js';
import { runtimeServiceOperationSchema, runtimeServiceDescriptorSchema, shutdownCommandSchema, shutdownAdmissionSchema, type RuntimeServiceOperation, type ShutdownCommand, type RuntimeServiceDescriptor, type ServiceShutdownAdmissionResult } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import type { ConfiguredRuntimeOperations } from './operations.js';

export type ConfiguredRuntimeClient = ConfiguredRuntimeOperations & Readonly<{
  describeService(): Promise<RuntimeServiceDescriptor>;
  shutdownService(command: ShutdownCommand): Promise<ServiceShutdownAdmissionResult>;
}>;

/** No direct-execution fallback: a missing service is an explicit transport failure. */
export function createConfiguredRuntimeClient(projectRoot: string, options: ConfigLoadOptions = {}): ConfiguredRuntimeClient {
  const call = async (operation: RuntimeServiceOperation, input: unknown): Promise<unknown> => {
    try {
      registerProviderConfig();
      const config = await loadConfig(projectRoot, { ...options, heal: false });
      const endpoint = await prepareProductSocket(config.productLayout, 'runtimeSocket', false);
      const response = await requestLocalRuntime(socketOptions(config.service, endpoint),
        { schemaVersion: 2, requestId: randomUUID(), operation, input });
      if (!response.ok) throw ErrorRegistry.createError(ErrorRegistry.has(response.error.code) ? response.error.code : 'RUNTIME_SERVICE_TRANSPORT');
      return response.result;
    } catch (error) { throw queryFailure(error); }
  };
  // The closed protocol vocabulary and the precisely typed server operation map describe the same methods.
  const operations = Object.fromEntries(runtimeServiceOperationSchema.options.filter(operation => operation !== 'describeService' && operation !== 'shutdownService').map(operation =>
    [operation, (input: unknown) => call(operation, input)])) as ConfiguredRuntimeOperations;
  return Object.freeze({ ...operations,
    async describeService() {
      const parsed = runtimeServiceDescriptorSchema.safeParse(await call('describeService', {}));
      if (!parsed.success) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return parsed.data;
    },
    async shutdownService(command: ShutdownCommand) {
      const expected = shutdownCommandSchema.parse(command);
      const value = await call('shutdownService', expected) as ServiceShutdownAdmissionResult;
      if (!value || typeof value.replayed !== 'boolean') throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      const parsed = shutdownAdmissionSchema.safeParse(value.admission);
      if (!parsed.success || JSON.stringify(parsed.data.command) !== JSON.stringify(expected)) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return Object.freeze({ replayed: value.replayed, admission: parsed.data });
    },
  });
}
