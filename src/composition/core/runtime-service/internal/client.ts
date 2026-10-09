import { localPrincipalChannel } from '#adapters/index.js';
import type { ProviderSpendManagementCommand } from '#domain/index.js';
import type { ProviderSpendManagementResult } from '#engine/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { runtimeWorkspaceFileMethods, runtimeEffectOperationMethods, runtimeApprovalMethods, runtimeChatTurnMethods, runtimeModelInvocationMethods, runtimePermissionModeMethods,
  runtimeProviderSpendMethods, runtimeScratchMethods, runtimeSecretMethods, type ClearSessionStanding, type SessionStandingClearance, RUNTIME_SERVICE_LIFECYCLE_VERSIONS,
  RUNTIME_SERVICE_SCHEMA_VERSION, isRuntimeServiceBoundedResultOperation, type RuntimeServiceLifecycleVersion, type RuntimeServiceRequest,
  type SecretChangeResult, type SecretDeleteCommand, type SecretSetCommand, type SecretStoreSwitchCommand } from '#engine/index.js';
import { socketOptions } from './socket-options.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DeckentError, ErrorRegistry, ManagedFileError,  type ConfigLoadOptions } from '#platform/index.js';
import { LocalRuntimeSocketError, prepareRuntimeSocket, requestLocalRuntime, streamLocalRuntime, turnLocalRuntime } from '#adapters/index.js';
import { runtimeServiceOperationSchema, runtimeServiceDescriptorSchema, shutdownCommandSchema, shutdownAdmissionSchema, type RuntimeServiceOperation, type ShutdownCommand, type RuntimeServiceDescriptor, type ServiceShutdownAdmissionResult } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import type { ModelInvocationCancellationCommand, ModelInvocationPurgeCommand, ModelInvocationCommand, ModelInvocationQuery, ProviderSpendAccountQuery, ProviderSpendAuditCommand,
  ModelInvocationDeltaSink, AgentTurnStreamEvent, ChatTurnCancellation, ChatTurnCancellationResult, ChatTurnCommand, ChatTurnResult,
  WorkspaceAttachment, WorkspaceAttachmentRequest, WorkspaceFileMatches, WorkspaceFileQuery, EffectCommand, EffectRecord, ScratchClearance, ScratchQuery, ScratchView,
  PermissionModeChange, PermissionModeCommand, PermissionModeQuery, PermissionModeView } from '#domain/index.js';
import { runtimeServiceResultCapacity, type ModelInvocationCancellationResult, type ModelInvocationPurgeResult, type ModelInvocationDelivery, type ModelInvocationResult,
  type ModelInvocationInspection, type RuntimeServiceDelivery, type RuntimeOperationQuery, type EffectOutcome, type ProviderSpendAccountInspection, type ProviderSpendAuditResult } from '#engine/index.js';
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
  manageProviderSpend(command: ProviderSpendManagementCommand, delivery?: RuntimeServiceDelivery): Promise<ProviderSpendManagementResult>;
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
  clearSessionStanding(query: ClearSessionStanding, signal?: AbortSignal): Promise<SessionStandingClearance>;
  clearScratch(query: ScratchQuery, signal?: AbortSignal): Promise<ScratchClearance>;
  /** v18 (SECRET-WRITE): one secret of the installation's store, set or deleted by the socket peer under the `secret` policy cell. */
  setSecret(command: SecretSetCommand, signal?: AbortSignal): Promise<SecretChangeResult>;
  deleteSecret(command: SecretDeleteCommand, signal?: AbortSignal): Promise<SecretChangeResult>;
  /** v24 (SECRET-STORE-SWITCH): every secret moved into another registered store and selected, under the `secret`/`switch` cell. */
  switchSecretStore(command: SecretStoreSwitchCommand, signal?: AbortSignal): Promise<import('#engine/index.js').SecretStoreSwitchResult>;
}>;
type RuntimeCallRest = [onDelta?: ModelInvocationDeltaSink, version?: RuntimeServiceLifecycleVersion, onEvent?: (event: AgentTurnStreamEvent) => void];
/** BUSY is refused before anything was admitted, so a retry cannot repeat an effect. Bounded: at most `service.busyRetryLimit` more
 * attempts, each after the service's `retryAfterMs` (never beyond this installation's own `service.admissionWaitMs`), ended by the
 * caller's signal; then the typed BUSY stands. A zero wait means the installation chose immediate refusal, so nothing is retried. */
function busyRetrying(projectRoot: string, options: ConfigLoadOptions,
  attempt: (operation: RuntimeServiceOperation, input: unknown, delivery?: RuntimeServiceDelivery, signal?: AbortSignal, ...rest: RuntimeCallRest) => Promise<unknown>) {
  return async (operation: RuntimeServiceOperation, input: unknown, delivery?: RuntimeServiceDelivery, signal?: AbortSignal, ...rest: RuntimeCallRest): Promise<unknown> => {
    for (let retry = 0; ; retry++) {
      try { return await attempt(operation, input, delivery, signal, ...rest); }
      catch (error) {
        if (!(error instanceof DeckentError) || error.code !== 'RUNTIME_SERVICE_BUSY' || signal?.aborted) throw error;
        const service = (await loadComposedConfig(projectRoot, { ...options, heal: false }).catch(() => null))?.service;
        if (!service || retry >= service.busyRetryLimit || service.admissionWaitMs === 0) throw error;
        const hinted = Number(error.params?.retryAfterMs);
        try { await sleep(Number.isFinite(hinted) && hinted > 0 ? Math.min(hinted, service.admissionWaitMs) : service.admissionWaitMs, undefined, signal ? { signal } : {}); }
        catch { throw error; }
      }
    }
  };
}
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
      const capacity = isRuntimeServiceBoundedResultOperation(operation)
        ? { delivery: { maxResultBytes: runtimeServiceResultCapacity(requestId, config.service.responseMaxBytes, delivery?.maxResultBytes) } } : {};
      const request = { schemaVersion: version, requestId, operation, input, ...capacity, ...(localPrincipalChannel() === 'mcp' ? { channel: 'mcp' as const } : {}) } as RuntimeServiceRequest;
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
  const call = busyRetrying(projectRoot, options, attempt);
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
    ...runtimeApprovalMethods(call),
    ...runtimeChatTurnMethods(call, queryFailure),
    ...runtimeWorkspaceFileMethods(call, queryFailure),
    ...runtimeEffectOperationMethods(call, queryFailure),
    ...runtimePermissionModeMethods(call, queryFailure),
    ...runtimeScratchMethods(call, queryFailure),
    ...runtimeSecretMethods(call, queryFailure),
    ...runtimeModelInvocationMethods(call, queryFailure),
    ...runtimeProviderSpendMethods(call, queryFailure),
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
