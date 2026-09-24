import { RUNTIME_SERVICE_LIFECYCLE_VERSIONS, RUNTIME_SERVICE_SCHEMA_VERSION, type RuntimeServiceLifecycleVersion, type RuntimeServiceRequest } from '#engine/index.js';
import { socketOptions } from './socket-options.js';
import { randomUUID } from 'node:crypto';
import { DeckentError, ErrorRegistry, loadConfig, prepareProductSocket, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, requestLocalRuntime, streamLocalRuntime } from '#adapters/index.js';
import { runtimeServiceOperationSchema, runtimeServiceDescriptorSchema, shutdownCommandSchema, shutdownAdmissionSchema, type RuntimeServiceOperation, type ShutdownCommand, type RuntimeServiceDescriptor, type ServiceShutdownAdmissionResult } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { modelInvocationCancellationCommandInputSchema, modelInvocationCommandInputSchema, modelInvocationQueryInputSchema, modelInvocationPurgeCommandInputSchema, ModelInvocationError,
  providerSpendAccountQueryInputSchema, providerSpendAuditCommandInputSchema, type ModelInvocationCancellationCommand, type ModelInvocationPurgeCommand, type ModelInvocationCommand,
  type ModelInvocationQuery, type ProviderSpendAccountQuery, type ProviderSpendAuditCommand, type ModelInvocationDeltaSink } from '#domain/index.js';
import { runtimeServiceResultCapacity, parseModelInvocationCancellationResultForCommand, parseModelInvocationPurgeResultForCommand, type ModelInvocationCancellationResult, type ModelInvocationPurgeResult, parseModelInvocationResultForCommand, parseModelInvocationInspectionForQuery,
  type ModelInvocationDelivery, type ModelInvocationResult, type ModelInvocationInspection, type RuntimeServiceDelivery } from '#engine/index.js';
import { parseProviderSpendAccountInspectionForQuery, parseProviderSpendAuditResultForCommand, ProviderSpendError,
  type ProviderSpendAccountInspection, type ProviderSpendAuditResult } from '#engine/index.js';
import type { ConfiguredRuntimeOperations } from './operations.js';

export type ConfiguredRuntimeClient = ConfiguredRuntimeOperations & Readonly<{
  cancelModelInvocation(command: ModelInvocationCancellationCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationCancellationResult>;
  purgeModelInvocationContent(command: ModelInvocationPurgeCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationPurgeResult>;
  describeService(): Promise<RuntimeServiceDescriptor>;
  shutdownService(command: ShutdownCommand): Promise<ServiceShutdownAdmissionResult>;
  invokeModel(command: ModelInvocationCommand, delivery?: ModelInvocationDelivery, signal?: AbortSignal): Promise<ModelInvocationResult>;
  /** v11 streamed invocation: the same governed result as invokeModel, preceded by presentation-only deltas. */
  invokeModelStream(command: ModelInvocationCommand, onDelta: ModelInvocationDeltaSink, delivery?: ModelInvocationDelivery,
    signal?: AbortSignal): Promise<ModelInvocationResult>;
  inspectModelInvocation(query: ModelInvocationQuery, delivery?: ModelInvocationDelivery): Promise<ModelInvocationInspection>;
  inspectProviderSpendAccount(query: ProviderSpendAccountQuery, delivery?: RuntimeServiceDelivery): Promise<ProviderSpendAccountInspection>;
  auditProviderSpendAccount(command: ProviderSpendAuditCommand, delivery?: RuntimeServiceDelivery): Promise<ProviderSpendAuditResult>;
}>;

/** No direct-execution fallback: a missing service is an explicit transport failure. */
export function createConfiguredRuntimeClient(projectRoot: string, options: ConfigLoadOptions = {}): ConfiguredRuntimeClient {
  const call = async (operation: RuntimeServiceOperation, input: unknown, delivery?: RuntimeServiceDelivery, signal?: AbortSignal,
    onDelta?: ModelInvocationDeltaSink, version: RuntimeServiceLifecycleVersion = RUNTIME_SERVICE_SCHEMA_VERSION): Promise<unknown> => {
    try {
      registerProviderConfig();
      const config = await loadConfig(projectRoot, { ...options, heal: false });
      const endpoint = await prepareProductSocket(config.productLayout, 'runtimeSocket', false);
      const requestId = randomUUID();
      const capacity = operation === 'renewApproval' || operation === 'listApprovals' || operation === 'inspectApproval' || operation === 'decideApproval' || operation === 'invokeModel' || operation === 'invokeModelStream' || operation === 'inspectModelInvocation' || operation === 'purgeModelInvocationContent'
        || operation === 'cancelModelInvocation' || operation === 'inspectProviderSpendAccount' || operation === 'auditProviderSpendAccount'
        ? { delivery: { maxResultBytes: runtimeServiceResultCapacity(requestId, config.service.responseMaxBytes, delivery?.maxResultBytes) } } : {};
      const request = { schemaVersion: version, requestId, operation, input, ...capacity } as RuntimeServiceRequest;
      const response = onDelta
        ? await streamLocalRuntime(socketOptions(config.service, endpoint), request, deltas => { for (const delta of deltas) onDelta(delta); }, signal)
        : await requestLocalRuntime(socketOptions(config.service, endpoint), request, signal);
      if (!response.ok) throw ErrorRegistry.has(response.error.code)
        ? ErrorRegistry.createError(response.error.code, response.error.params ? { params: response.error.params } : {})
        : ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return response.result;
    } catch (error) { throw queryFailure(error); }
  };
  /** Lifecycle operations retry once in each older protocol version of the window when the connection closed unanswered
   * (a service started from an older build drops current-version envelopes). describe is read-only; shutdown is durable. */
  const lifecycle = async (operation: 'describeService' | 'shutdownService', input: unknown): Promise<unknown> => {
    try { return await call(operation, input); }
    catch (error) {
      if (!(error instanceof DeckentError) || error.code !== 'LOCAL_RUNTIME_TRANSPORT') throw error;
      let last: unknown = error;
      for (const version of RUNTIME_SERVICE_LIFECYCLE_VERSIONS.slice(1)) {
        try { return await call(operation, input, undefined, undefined, undefined, version); }
        catch (retry) { last = retry; }
      }
      throw last;
    }
  };
  // The closed protocol vocabulary and the precisely typed server operation map describe the same methods.
  const operations = Object.fromEntries(runtimeServiceOperationSchema.options.filter(operation => operation !== 'describeService' && operation !== 'shutdownService'
    && operation !== 'invokeModel' && operation !== 'invokeModelStream' && operation !== 'inspectModelInvocation' && operation !== 'purgeModelInvocationContent'
    && operation !== 'cancelModelInvocation' && operation !== 'inspectProviderSpendAccount' && operation !== 'auditProviderSpendAccount').map(operation =>
    [operation, (input: unknown, delivery?: RuntimeServiceDelivery) => call(operation, input, delivery)])) as ConfiguredRuntimeOperations;
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
    async invokeModelStream(input: ModelInvocationCommand, onDelta: ModelInvocationDeltaSink, delivery?: ModelInvocationDelivery, signal?: AbortSignal) {
      try {
        const parsed = modelInvocationCommandInputSchema.safeParse(input);
        if (!parsed.success || typeof onDelta !== 'function') throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
        const command = parsed.data as ModelInvocationCommand;
        return parseModelInvocationResultForCommand(command, await call('invokeModelStream', command, delivery, signal, onDelta));
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
    async inspectProviderSpendAccount(input: ProviderSpendAccountQuery, delivery?: RuntimeServiceDelivery) {
      try {
        let query: ProviderSpendAccountQuery;
        try { query = providerSpendAccountQueryInputSchema.parse(input); }
        catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
        return parseProviderSpendAccountInspectionForQuery(query, await call('inspectProviderSpendAccount', query, delivery));
      } catch (error) { throw queryFailure(error); }
    },
    async auditProviderSpendAccount(input: ProviderSpendAuditCommand, delivery?: RuntimeServiceDelivery) {
      try {
        let command: ProviderSpendAuditCommand;
        try { command = providerSpendAuditCommandInputSchema.parse(input); }
        catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
        return parseProviderSpendAuditResultForCommand(command, await call('auditProviderSpendAccount', command, delivery));
      } catch (error) { throw queryFailure(error); }
    },
    async describeService() {
      const parsed = runtimeServiceDescriptorSchema.safeParse(await lifecycle('describeService', {}));
      if (!parsed.success) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return parsed.data;
    },
    async shutdownService(command: ShutdownCommand) {
      const expected = shutdownCommandSchema.parse(command);
      const value = await lifecycle('shutdownService', expected) as ServiceShutdownAdmissionResult;
      if (!value || typeof value.replayed !== 'boolean') throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      const parsed = shutdownAdmissionSchema.safeParse(value.admission);
      if (!parsed.success || JSON.stringify(parsed.data.command) !== JSON.stringify(expected)) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return Object.freeze({ replayed: value.replayed, admission: parsed.data });
    },
  });
}
