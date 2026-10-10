import { DeckentError, ErrorRegistry } from '#platform/index.js';
import type { AgentTurnStreamEvent, ModelInvocationDeltaSink } from '#domain/index.js';
import { runtimeWorkspaceFileMethods, runtimeEffectOperationMethods, type RuntimeFailureMapper } from './client-validation.js';
import { runtimeApprovalMethods, runtimeChatTurnMethods, runtimeModelInvocationMethods, runtimePermissionModeMethods,
  runtimeProviderSpendMethods, runtimeScratchMethods, runtimeSecretMethods, type RuntimeStreamingCall } from './client-methods.js';
import { RUNTIME_SERVICE_LIFECYCLE_VERSIONS, isRuntimeServiceBoundedResultOperation, runtimeServiceOperationSchema, runtimeServiceResultCapacity,
  type RuntimeServiceOperation, type RuntimeServiceDelivery, type RuntimeServiceLifecycleVersion, type RuntimeServiceRequest, type RuntimeServiceResponse } from './service-protocol.js';
import { runtimeServiceDescriptorSchema, shutdownAdmissionSchema, shutdownCommandSchema, type ShutdownCommand } from './shutdown-contract.js';
import type { ServiceShutdownAdmissionResult } from './shutdown-store.js';
/** Configuration and waiting are ports; the protocol client owns retries and result validation. */
export interface RuntimeClientPorts {
  readonly attempt: RuntimeStreamingCall;
  readonly readPolicy: () => Promise<{ readonly busyRetryLimit: number; readonly admissionWaitMs: number } | null>;
  readonly wait: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  readonly mapFailure: RuntimeFailureMapper;
}
type RuntimeCallRest = [onDelta?: ModelInvocationDeltaSink, version?: RuntimeServiceLifecycleVersion, onEvent?: (event: AgentTurnStreamEvent) => void];
/** BUSY is refused before anything was admitted, so a retry cannot repeat an effect. Bounded: at most `service.busyRetryLimit` more
 * attempts, each after the service's `retryAfterMs` (never beyond this installation's own `service.admissionWaitMs`), ended by the
 * caller's signal; then the typed BUSY stands. A zero wait means the installation chose immediate refusal, so nothing is retried. */
function busyRetrying(readPolicy: RuntimeClientPorts['readPolicy'], wait: RuntimeClientPorts['wait'],
  attempt: (operation: RuntimeServiceOperation, input: unknown, delivery?: RuntimeServiceDelivery, signal?: AbortSignal, ...rest: RuntimeCallRest) => Promise<unknown>) {
  return async (operation: RuntimeServiceOperation, input: unknown, delivery?: RuntimeServiceDelivery, signal?: AbortSignal, ...rest: RuntimeCallRest): Promise<unknown> => {
    for (let retry = 0; ; retry++) {
      try { return await attempt(operation, input, delivery, signal, ...rest); }
      catch (error) {
        if (!(error instanceof DeckentError) || error.code !== 'RUNTIME_SERVICE_BUSY' || signal?.aborted) throw error;
        const service = await readPolicy().catch(() => null);
        if (!service || retry >= service.busyRetryLimit || service.admissionWaitMs === 0) throw error;
        const hinted = Number(error.params?.retryAfterMs);
        try { await wait(Number.isFinite(hinted) && hinted > 0 ? Math.min(hinted, service.admissionWaitMs) : service.admissionWaitMs, signal); }
        catch { throw error; }
      }
    }
  };
}
export function createRuntimeServiceClient<Operations>(ports: RuntimeClientPorts) {
  const call = busyRetrying(ports.readPolicy, ports.wait, ports.attempt);
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
    [operation, (input: unknown, delivery?: RuntimeServiceDelivery) => call(operation, input, delivery)])) as Operations;
  return Object.freeze({ ...operations,
    ...runtimeApprovalMethods(call),
    ...runtimeChatTurnMethods(call, ports.mapFailure),
    ...runtimeWorkspaceFileMethods(call, ports.mapFailure),
    ...runtimeEffectOperationMethods(call, ports.mapFailure),
    ...runtimePermissionModeMethods(call, ports.mapFailure),
    ...runtimeScratchMethods(call, ports.mapFailure),
    ...runtimeSecretMethods(call, ports.mapFailure),
    ...runtimeModelInvocationMethods(call, ports.mapFailure),
    ...runtimeProviderSpendMethods(call, ports.mapFailure),
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

export function prepareRuntimeClientRequest(version: RuntimeServiceLifecycleVersion, requestId: string, operation: RuntimeServiceOperation, input: unknown,
  limits: { readonly responseMaxBytes: number; readonly maxResultBytes: number | undefined; readonly inputMaxBytes: number; readonly channel: string | undefined }) {
  const capacity = isRuntimeServiceBoundedResultOperation(operation)
    ? { delivery: { maxResultBytes: runtimeServiceResultCapacity(requestId, limits.responseMaxBytes, limits.maxResultBytes) } } : {};
  const request = { schemaVersion: version, requestId, operation, input, ...capacity, ...(limits.channel === 'mcp' ? { channel: 'mcp' as const } : {}) } as RuntimeServiceRequest;
  // A conversation too large for one request is refused before anything is sent, by name (Astra 2106 R2), never as a transport fault.
  if (operation === 'chatTurn') {
    const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    if (bytes > limits.inputMaxBytes) throw ErrorRegistry.createError('RUNTIME_CHAT_TURN_TOO_LARGE', { params: { bytes, limit: limits.inputMaxBytes } });
  }
  return request;
}
export function acceptRuntimeClientResponse(response: RuntimeServiceResponse): unknown {
  if (!response.ok) throw ErrorRegistry.has(response.error.code)
    ? ErrorRegistry.createError(response.error.code, response.error.params ? { params: response.error.params } : {})
    : ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
  return response.result;
}
