import { RUNTIME_SERVICE_LIFECYCLE_VERSIONS, RUNTIME_SERVICE_SCHEMA_VERSION, isRuntimeServiceBoundedResultOperation, acceptSecretChangeResult, prepareSecretChange, type RuntimeServiceLifecycleVersion, type RuntimeServiceRequest,
  type SecretChangeResult, type SecretDeleteCommand, type SecretSetCommand } from '#engine/index.js';
import { socketOptions } from './socket-options.js';
import { randomUUID } from 'node:crypto';
import { DeckentError, ErrorRegistry, loadConfig, ManagedFileError, prepareProductSocket, type ConfigLoadOptions } from '#platform/index.js';
import { LocalRuntimeSocketError, registerProviderConfig, requestLocalRuntime, streamLocalRuntime, turnLocalRuntime } from '#adapters/index.js';
import { runtimeServiceOperationSchema, runtimeServiceDescriptorSchema, shutdownCommandSchema, shutdownAdmissionSchema, type RuntimeServiceOperation, type ShutdownCommand, type RuntimeServiceDescriptor, type ServiceShutdownAdmissionResult } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { modelInvocationCancellationCommandInputSchema, modelInvocationCommandInputSchema, modelInvocationQueryInputSchema, modelInvocationPurgeCommandInputSchema, ModelInvocationError,
  providerSpendAccountQueryInputSchema, providerSpendAuditCommandInputSchema, type ModelInvocationCancellationCommand, type ModelInvocationPurgeCommand, type ModelInvocationCommand,
  type ModelInvocationQuery, type ProviderSpendAccountQuery, type ProviderSpendAuditCommand, type ModelInvocationDeltaSink,
  chatTurnCancellationResultSchema, chatTurnCancellationSchema, chatTurnCommandSchema, chatTurnResultSchema, type AgentTurnStreamEvent,
  type ChatTurnCancellation, type ChatTurnCancellationResult, type ChatTurnCommand, type ChatTurnResult,
  workspaceAttachmentRequestSchema, workspaceAttachmentSchema, workspaceFileMatchesSchema, workspaceFileQuerySchema,
  type WorkspaceAttachment, type WorkspaceAttachmentRequest, type WorkspaceFileMatches, type WorkspaceFileQuery } from '#domain/index.js';
import { runtimeServiceResultCapacity, parseModelInvocationCancellationResultForCommand, parseModelInvocationPurgeResultForCommand, type ModelInvocationCancellationResult, type ModelInvocationPurgeResult, parseModelInvocationResultForCommand, parseModelInvocationInspectionForQuery,
  type ModelInvocationDelivery, type ModelInvocationResult, type ModelInvocationInspection, type RuntimeServiceDelivery } from '#engine/index.js';
import { PermissionModeError, runtimeOperationInspectionSchema, runtimeOperationOutcomeSchema, runtimeOperationQuerySchema, type RuntimeOperationQuery } from '#engine/index.js';
import { effectCommandSchema, EffectError, scratchClearanceSchema, scratchQuerySchema, scratchViewSchema, type EffectCommand, type EffectRecord, type ScratchClearance,
  type ScratchQuery, type ScratchView } from '#domain/index.js';
import { permissionModeChangeSchema, permissionModeCommandSchema, permissionModeQuerySchema, permissionModeViewSchema, type PermissionModeChange,
  type PermissionModeCommand, type PermissionModeQuery, type PermissionModeView } from '#domain/index.js';
import type { EffectOutcome } from '#engine/index.js';
import { AgentTurnStoreError, parseProviderSpendAccountInspectionForQuery, parseProviderSpendAuditResultForCommand, ProviderSpendError,
  type ProviderSpendAccountInspection, type ProviderSpendAuditResult } from '#engine/index.js';
import type { ConfiguredRuntimeOperations } from './operations.js';

export type ConfiguredRuntimeClient = ConfiguredRuntimeOperations & Readonly<{
  cancelModelInvocation(command: ModelInvocationCancellationCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationCancellationResult>;
  purgeModelInvocationContent(command: ModelInvocationPurgeCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationPurgeResult>;
  /** `signal` bounds the whole exchange, including a peer that accepts and never answers; `'current'` makes one attempt (no older-version retries). */
  describeService(signal?: AbortSignal, versions?: 'window' | 'current'): Promise<RuntimeServiceDescriptor>;
  shutdownService(command: ShutdownCommand, signal?: AbortSignal): Promise<ServiceShutdownAdmissionResult>;
  invokeModel(command: ModelInvocationCommand, delivery?: ModelInvocationDelivery, signal?: AbortSignal): Promise<ModelInvocationResult>;
  /** v11 streamed invocation: the same governed result as invokeModel, preceded by presentation-only deltas. */
  invokeModelStream(command: ModelInvocationCommand, onDelta: ModelInvocationDeltaSink, delivery?: ModelInvocationDelivery,
    signal?: AbortSignal): Promise<ModelInvocationResult>;
  inspectModelInvocation(query: ModelInvocationQuery, delivery?: ModelInvocationDelivery): Promise<ModelInvocationInspection>;
  inspectProviderSpendAccount(query: ProviderSpendAccountQuery, delivery?: RuntimeServiceDelivery): Promise<ProviderSpendAccountInspection>;
  auditProviderSpendAccount(command: ProviderSpendAuditCommand, delivery?: RuntimeServiceDelivery): Promise<ProviderSpendAuditResult>;
  /** v12 agent turn: required turn events (the history continues from its `message` events), then the bounded turn result.
   * Aborting disconnects, which cancels the turn at its next write; `cancelChatTurn` cancels at once. */
  chatTurn(command: ChatTurnCommand, onEvent: (event: AgentTurnStreamEvent) => void, signal?: AbortSignal): Promise<ChatTurnResult>;
  cancelChatTurn(command: ChatTurnCancellation): Promise<ChatTurnCancellationResult>;
  /** v15 composer `@file`: ranked candidate files of the project workspace (deny floor applied by the service). */
  findWorkspaceFiles(query: WorkspaceFileQuery, signal?: AbortSignal): Promise<WorkspaceFileMatches>;
  /** v15 composer `@file`: one file's bounded content, or a typed refusal. */
  attachWorkspaceFile(request: WorkspaceAttachmentRequest, signal?: AbortSignal): Promise<WorkspaceAttachment>;
  /** v15 catalog operations (C12 G4): settled, or approval-pending (nothing sent; resubmit the same command after a decision). */
  executeOperation(command: EffectCommand, delivery?: RuntimeServiceDelivery): Promise<EffectOutcome>;
  compensateOperation(command: EffectCommand, delivery?: RuntimeServiceDelivery): Promise<EffectOutcome>;
  inspectOperation(query: RuntimeOperationQuery, delivery?: RuntimeServiceDelivery): Promise<Readonly<{ schemaVersion: 1; record: EffectRecord | null }>>;
  /** v15 (T-L4 slice 4c): the caller's own permission mode in one scope, the effective revision and whether any rule is mode-eligible. */
  inspectPermissionMode(query: PermissionModeQuery, signal?: AbortSignal): Promise<PermissionModeView>;
  /** v15: sets the caller's own mode, conditional on `expectedRevision` (typed `PERMISSION_MODE_CONFLICT` when it moved). */
  setPermissionMode(command: PermissionModeCommand, signal?: AbortSignal): Promise<PermissionModeChange>;
  /** v16 (SCR-A `/scratch`): the caller's own scratch area of one conversation — its files, or emptied (the directory stays). */
  inspectScratch(query: ScratchQuery, signal?: AbortSignal): Promise<ScratchView>;
  clearScratch(query: ScratchQuery, signal?: AbortSignal): Promise<ScratchClearance>;
  /** v18 (SECRET-WRITE): one secret of the installation's store, set or deleted by the socket peer under the `secret` policy cell. */
  setSecret(command: SecretSetCommand, signal?: AbortSignal): Promise<SecretChangeResult>;
  deleteSecret(command: SecretDeleteCommand, signal?: AbortSignal): Promise<SecretChangeResult>;
}>;

type RuntimeCall = (operation: RuntimeServiceOperation, input: unknown, delivery?: RuntimeServiceDelivery, signal?: AbortSignal) => Promise<unknown>;
/** v15 composer `@file` methods: both ends validate; a service that answers more than was asked is not trusted with the turn's context. */
function workspaceFileMethods(call: RuntimeCall) {
  return {
    async findWorkspaceFiles(input: WorkspaceFileQuery, signal?: AbortSignal) {
      try {
        const parsed = workspaceFileQuerySchema.safeParse(input);
        if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
        const result = workspaceFileMatchesSchema.safeParse(await call('findWorkspaceFiles', parsed.data, undefined, signal));
        if (!result.success || result.data.paths.length > parsed.data.limit) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        return result.data;
      } catch (error) { throw queryFailure(error); }
    },
    async attachWorkspaceFile(input: WorkspaceAttachmentRequest, signal?: AbortSignal) {
      try {
        const parsed = workspaceAttachmentRequestSchema.safeParse(input);
        if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
        const result = workspaceAttachmentSchema.safeParse(await call('attachWorkspaceFile', parsed.data, undefined, signal));
        if (!result.success || (result.data.status === 'attached' && (result.data.bytes > parsed.data.maxBytes
          || Buffer.byteLength(result.data.content, 'utf8') !== result.data.bytes))) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        return result.data;
      } catch (error) { throw queryFailure(error); }
    },
  };
}

/** v15 catalog operation methods: both ends validate; an answer for another command, scope or operation is not trusted. */
function effectOperationMethods(call: RuntimeCall) {
  const submit = async (operation: 'executeOperation' | 'compensateOperation', input: EffectCommand, delivery?: RuntimeServiceDelivery) => {
    try {
      const parsed = effectCommandSchema.safeParse(input);
      if (!parsed.success) throw new EffectError('EFFECT_INVALID');
      const result = runtimeOperationOutcomeSchema.safeParse(await call(operation, parsed.data, delivery));
      if (!result.success || result.data.commandId !== parsed.data.commandId || result.data.scopeId !== parsed.data.scopeId
        || JSON.stringify(result.data.operation) !== JSON.stringify(parsed.data.operation)) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return result.data as EffectOutcome;
    } catch (error) { throw queryFailure(error); }
  };
  return {
    executeOperation: (input: EffectCommand, delivery?: RuntimeServiceDelivery) => submit('executeOperation', input, delivery),
    compensateOperation: (input: EffectCommand, delivery?: RuntimeServiceDelivery) => submit('compensateOperation', input, delivery),
    async inspectOperation(input: RuntimeOperationQuery, delivery?: RuntimeServiceDelivery) {
      try {
        const parsed = runtimeOperationQuerySchema.safeParse(input);
        if (!parsed.success) throw new EffectError('EFFECT_INVALID');
        const result = runtimeOperationInspectionSchema.safeParse(await call('inspectOperation', parsed.data, delivery));
        const command = result.success ? result.data.record?.intent.command : undefined;
        if (!result.success || (command && (command.scopeId !== parsed.data.scopeId || command.commandId !== parsed.data.commandId))) {
          throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        }
        return result.data;
      } catch (error) { throw queryFailure(error); }
    },
  };
}

/** v15 permission-mode methods: both ends validate; an answer for another scope, or a set answer for another mode, is not trusted. */
function permissionModeMethods(call: RuntimeCall) {
  return {
    async inspectPermissionMode(input: PermissionModeQuery, signal?: AbortSignal) {
      try {
        const parsed = permissionModeQuerySchema.safeParse(input);
        if (!parsed.success) throw new PermissionModeError('PERMISSION_MODE_INVALID');
        const result = permissionModeViewSchema.safeParse(await call('inspectPermissionMode', parsed.data, undefined, signal));
        if (!result.success || result.data.scopeId !== parsed.data.scopeId) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        return result.data;
      } catch (error) { throw error instanceof PermissionModeError ? ErrorRegistry.createError(error.code) : queryFailure(error); }
    },
    async setPermissionMode(input: PermissionModeCommand, signal?: AbortSignal) {
      try {
        const parsed = permissionModeCommandSchema.safeParse(input);
        if (!parsed.success) throw new PermissionModeError('PERMISSION_MODE_INVALID');
        const result = permissionModeChangeSchema.safeParse(await call('setPermissionMode', parsed.data, undefined, signal));
        if (!result.success || result.data.scopeId !== parsed.data.scopeId || result.data.mode !== parsed.data.mode) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        return result.data;
      } catch (error) { throw error instanceof PermissionModeError ? ErrorRegistry.createError(error.code) : queryFailure(error); }
    },
  };
}

/** v16 `/scratch` methods: both ends validate the shapes. */
function scratchMethods(call: RuntimeCall) {
  const scratch = async <T>(operation: 'inspectScratch' | 'clearScratch', schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    input: ScratchQuery, signal?: AbortSignal): Promise<T> => {
    try {
      const parsed = scratchQuerySchema.safeParse(input);
      if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
      const result = schema.safeParse(await call(operation, parsed.data, undefined, signal));
      if (!result.success) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return result.data;
    } catch (error) { throw queryFailure(error); }
  };
  return { inspectScratch: (input: ScratchQuery, signal?: AbortSignal) => scratch<ScratchView>('inspectScratch', scratchViewSchema, input, signal),
    clearScratch: (input: ScratchQuery, signal?: AbortSignal) => scratch<ScratchClearance>('clearScratch', scratchClearanceSchema, input, signal) };
}

/** v18 secret methods: name and value are checked before anything is sent (typed, never echoed); an answer for another change is not trusted. */
function secretMethods(call: RuntimeCall) {
  const change = async (operation: 'setSecret' | 'deleteSecret', input: SecretSetCommand | SecretDeleteCommand, signal?: AbortSignal) => {
    try {
      const command = prepareSecretChange(operation, input), result = acceptSecretChangeResult(operation, command, await call(operation, command, undefined, signal));
      if (!result) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return result;
    } catch (error) { throw queryFailure(error); }
  };
  return { setSecret: (input: SecretSetCommand, signal?: AbortSignal) => change('setSecret', input, signal),
    deleteSecret: (input: SecretDeleteCommand, signal?: AbortSignal) => change('deleteSecret', input, signal) };
}

/** No direct-execution fallback: a missing service is an explicit transport failure. */
export function createConfiguredRuntimeClient(projectRoot: string, options: ConfigLoadOptions = {}): ConfiguredRuntimeClient {
  const call = async (operation: RuntimeServiceOperation, input: unknown, delivery?: RuntimeServiceDelivery, signal?: AbortSignal,
    onDelta?: ModelInvocationDeltaSink, version: RuntimeServiceLifecycleVersion = RUNTIME_SERVICE_SCHEMA_VERSION,
    onEvent?: (event: AgentTurnStreamEvent) => void): Promise<unknown> => {
    try {
      registerProviderConfig();
      const config = await loadConfig(projectRoot, { ...options, heal: false });
      // The endpoint's never-created state directory is the same fact as a missing endpoint: no live service.
      const endpoint = await prepareProductSocket(config.productLayout, 'runtimeSocket', false).catch(error => {
        if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') throw new LocalRuntimeSocketError('LOCAL_RUNTIME_UNAVAILABLE', { cause: error });
        throw error;
      });
      const requestId = randomUUID();
      const capacity = isRuntimeServiceBoundedResultOperation(operation)
        ? { delivery: { maxResultBytes: runtimeServiceResultCapacity(requestId, config.service.responseMaxBytes, delivery?.maxResultBytes) } } : {};
      const request = { schemaVersion: version, requestId, operation, input, ...capacity } as RuntimeServiceRequest;
      // A conversation too large for one request is refused before anything is sent, by name (Astra 2106 R2), never as a transport fault.
      if (operation === 'chatTurn') {
        const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
        if (bytes > config.service.inputMaxBytes) throw ErrorRegistry.createError('RUNTIME_CHAT_TURN_TOO_LARGE', { params: { bytes, limit: config.service.inputMaxBytes } });
      }
      const response = onEvent
        ? await turnLocalRuntime(socketOptions(config.service, endpoint), request, events => { for (const event of events) onEvent(event); }, signal)
        : onDelta
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
  const lifecycle = async (operation: 'describeService' | 'shutdownService', input: unknown, signal?: AbortSignal, versions: 'window' | 'current' = 'window'): Promise<unknown> => {
    try { return await call(operation, input, undefined, signal); }
    catch (error) {
      if (versions === 'current' || !(error instanceof DeckentError) || error.code !== 'LOCAL_RUNTIME_TRANSPORT') throw error;
      let last: unknown = error;
      for (const version of RUNTIME_SERVICE_LIFECYCLE_VERSIONS.slice(1)) {
        if (signal?.aborted) break;
        try { return await call(operation, input, undefined, signal, undefined, version); }
        catch (retry) { last = retry; }
      }
      throw last;
    }
  };
  // The closed protocol vocabulary and the precisely typed server operation map describe the same methods: every operation without a typed
  // method below — the lifecycle pair and the bounded-result ones are typed, except the approval operations.
  const operations = Object.fromEntries(runtimeServiceOperationSchema.options.filter(operation => operation !== 'describeService' && operation !== 'shutdownService'
    && (!isRuntimeServiceBoundedResultOperation(operation) || operation === 'renewApproval' || operation === 'listApprovals' || operation === 'inspectApproval' || operation === 'decideApproval')).map(operation =>
    [operation, (input: unknown, delivery?: RuntimeServiceDelivery) => call(operation, input, delivery)])) as ConfiguredRuntimeOperations;
  return Object.freeze({ ...operations,
    async chatTurn(input: ChatTurnCommand, onEvent: (event: AgentTurnStreamEvent) => void, signal?: AbortSignal) {
      try {
        const parsed = chatTurnCommandSchema.safeParse(input);
        if (!parsed.success || typeof onEvent !== 'function') throw new AgentTurnStoreError('AGENT_TURN_INVALID');
        const result = chatTurnResultSchema.safeParse(await call('chatTurn', parsed.data, undefined, signal, undefined, RUNTIME_SERVICE_SCHEMA_VERSION, onEvent));
        if (!result.success || result.data.turnId !== parsed.data.turnId) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        return result.data;
      } catch (error) { throw queryFailure(error); }
    },
    async cancelChatTurn(input: ChatTurnCancellation) {
      try {
        const parsed = chatTurnCancellationSchema.safeParse(input);
        if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
        const result = chatTurnCancellationResultSchema.safeParse(await call('cancelChatTurn', parsed.data));
        if (!result.success || result.data.turnId !== parsed.data.turnId) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        return result.data;
      } catch (error) { throw queryFailure(error); }
    },
    ...workspaceFileMethods(call),
    ...effectOperationMethods(call),
    ...permissionModeMethods(call),
    ...scratchMethods(call),
    ...secretMethods(call),
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
    async describeService(signal?: AbortSignal, versions: 'window' | 'current' = 'window') {
      const parsed = runtimeServiceDescriptorSchema.safeParse(await lifecycle('describeService', {}, signal, versions));
      if (!parsed.success) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return parsed.data;
    },
    async shutdownService(command: ShutdownCommand, signal?: AbortSignal) {
      const expected = shutdownCommandSchema.parse(command);
      const value = await lifecycle('shutdownService', expected, signal) as ServiceShutdownAdmissionResult;
      if (!value || typeof value.replayed !== 'boolean') throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      const parsed = shutdownAdmissionSchema.safeParse(value.admission);
      if (!parsed.success || JSON.stringify(parsed.data.command) !== JSON.stringify(expected)) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return Object.freeze({ replayed: value.replayed, admission: parsed.data });
    },
  });
}
