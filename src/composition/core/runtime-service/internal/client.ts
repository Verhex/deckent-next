import { socketOptions } from './socket-options.js';
import { randomUUID } from 'node:crypto';
import { ErrorRegistry, loadConfig, prepareProductSocket, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, requestLocalRuntime } from '#adapters/index.js';
import { runtimeServiceOperationSchema, runtimeServiceDescriptorSchema, shutdownCommandSchema, shutdownAdmissionSchema, type RuntimeServiceOperation, type ShutdownCommand, type RuntimeServiceDescriptor, type ServiceShutdownAdmissionResult } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { modelInvocationCancellationCommandInputSchema, modelInvocationCommandInputSchema, modelInvocationQueryInputSchema, modelInvocationPurgeCommandInputSchema, ModelInvocationError,
  type ModelInvocationCancellationCommand, type ModelInvocationPurgeCommand, type ModelInvocationCommand, type ModelInvocationQuery } from '#domain/index.js';
import { runtimeServiceResultCapacity, parseModelInvocationCancellationResultForCommand, parseModelInvocationPurgeResultForCommand, type ModelInvocationCancellationResult, type ModelInvocationPurgeResult, parseModelInvocationResultForCommand, parseModelInvocationInspectionForQuery,
  type ModelInvocationDelivery, type ModelInvocationResult, type ModelInvocationInspection } from '#engine/index.js';
import type { ConfiguredRuntimeOperations } from './operations.js';

export type ConfiguredRuntimeClient = ConfiguredRuntimeOperations & Readonly<{
  cancelModelInvocation(command: ModelInvocationCancellationCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationCancellationResult>;
  purgeModelInvocationContent(command: ModelInvocationPurgeCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationPurgeResult>;
  describeService(): Promise<RuntimeServiceDescriptor>;
  shutdownService(command: ShutdownCommand): Promise<ServiceShutdownAdmissionResult>;
  invokeModel(command: ModelInvocationCommand, delivery?: ModelInvocationDelivery, signal?: AbortSignal): Promise<ModelInvocationResult>;
  inspectModelInvocation(query: ModelInvocationQuery, delivery?: ModelInvocationDelivery): Promise<ModelInvocationInspection>;
}>;

/** No direct-execution fallback: a missing service is an explicit transport failure. */
export function createConfiguredRuntimeClient(projectRoot: string, options: ConfigLoadOptions = {}): ConfiguredRuntimeClient {
  const call = async (operation: RuntimeServiceOperation, input: unknown, delivery?: ModelInvocationDelivery, signal?: AbortSignal): Promise<unknown> => {
    try {
      registerProviderConfig();
      const config = await loadConfig(projectRoot, { ...options, heal: false });
      const endpoint = await prepareProductSocket(config.productLayout, 'runtimeSocket', false);
      const requestId = randomUUID();
      const capacity = operation === 'invokeModel' || operation === 'inspectModelInvocation' || operation === 'purgeModelInvocationContent' || operation === 'cancelModelInvocation'
        ? { delivery: { maxResultBytes: runtimeServiceResultCapacity(requestId, config.service.responseMaxBytes, delivery?.maxResultBytes) } } : {};
      const response = await requestLocalRuntime(socketOptions(config.service, endpoint),
        { schemaVersion: 7, requestId, operation, input, ...capacity }, signal);
      if (!response.ok) throw ErrorRegistry.createError(ErrorRegistry.has(response.error.code) ? response.error.code : 'RUNTIME_SERVICE_TRANSPORT');
      return response.result;
    } catch (error) { throw queryFailure(error); }
  };
  // The closed protocol vocabulary and the precisely typed server operation map describe the same methods.
  const operations = Object.fromEntries(runtimeServiceOperationSchema.options.filter(operation => operation !== 'describeService' && operation !== 'shutdownService'
    && operation !== 'invokeModel' && operation !== 'inspectModelInvocation' && operation !== 'purgeModelInvocationContent' && operation !== 'cancelModelInvocation').map(operation =>
    [operation, (input: unknown) => call(operation, input)])) as ConfiguredRuntimeOperations;
  return Object.freeze({ ...operations,
    async cancelModelInvocation(input: ModelInvocationCancellationCommand, delivery?: ModelInvocationDelivery) {
      try {
        const parsed = modelInvocationCancellationCommandInputSchema.safeParse(input);
        if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
        const command = parsed.data as ModelInvocationCancellationCommand;
        return parseModelInvocationCancellationResultForCommand(command, await call('cancelModelInvocation', command, delivery));
      } catch (error) { throw queryFailure(error); }
    },
    async purgeModelInvocationContent(input: ModelInvocationPurgeCommand, delivery?: ModelInvocationDelivery) {
      try {
        const parsed = modelInvocationPurgeCommandInputSchema.safeParse(input);
        if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
        const command = parsed.data as ModelInvocationPurgeCommand;
        return parseModelInvocationPurgeResultForCommand(command, await call('purgeModelInvocationContent', command, delivery));
      } catch (error) { throw queryFailure(error); }
    },
    async invokeModel(input: ModelInvocationCommand, delivery?: ModelInvocationDelivery, signal?: AbortSignal) {
      try {
        const parsed = modelInvocationCommandInputSchema.safeParse(input);
        if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
        const command = parsed.data as ModelInvocationCommand;
        return parseModelInvocationResultForCommand(command, await call('invokeModel', command, delivery, signal));
      } catch (error) { throw queryFailure(error); }
    },
    async inspectModelInvocation(input: ModelInvocationQuery, delivery?: ModelInvocationDelivery) {
      try {
        const parsed = modelInvocationQueryInputSchema.safeParse(input);
        if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
        const query = parsed.data as ModelInvocationQuery;
        return parseModelInvocationInspectionForQuery(query, await call('inspectModelInvocation', query, delivery));
      } catch (error) { throw queryFailure(error); }
    },
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
