import { chatTurnCancellationResultSchema, chatTurnCancellationSchema, chatTurnCommandSchema, chatTurnResultSchema, modelInvocationCancellationCommandInputSchema,
  modelInvocationCommandInputSchema, modelInvocationPurgeCommandInputSchema, modelInvocationQueryInputSchema, ModelInvocationError, permissionModeChangeSchema,
  permissionModeCommandSchema, permissionModeQuerySchema, permissionModeViewSchema, providerSpendAccountQueryInputSchema, providerSpendAuditCommandInputSchema,
  providerSpendManagementCommandInputSchema, scratchClearanceSchema, scratchQuerySchema, scratchViewSchema, type AgentTurnStreamEvent, type ChatTurnCancellation,
  type ChatTurnCommand, type ModelInvocationCancellationCommand, type ModelInvocationCommand, type ModelInvocationDeltaSink, type ModelInvocationPurgeCommand,
  type ModelInvocationQuery, type PermissionModeChange, type PermissionModeCommand, type PermissionModeQuery, type ProviderSpendAccountQuery,
  type ProviderSpendAuditCommand, type ProviderSpendManagementCommand, type ScratchClearance, type ScratchQuery, type ScratchView } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { AgentTurnStoreError } from '#engine/core/agent-turn/index.js';
import { PermissionModeError } from '#engine/core/policy/index.js';
import { acceptSecretChangeResult, acceptSecretStoreSwitchResult, prepareSecretChange, secretStoreSwitchCommandSchema, type SecretDeleteCommand, type SecretSetCommand,
  type SecretStoreSwitchCommand } from '#engine/core/secret-store/index.js';
import { approvalCommandSchema, parseApprovalAnswer, clearSessionStandingSchema, acceptSessionStandingClearance, type ClearSessionStanding } from '#engine/core/approval/index.js';
import { parseModelInvocationCancellationResultForCommand, parseModelInvocationInspectionForQuery, parseModelInvocationPurgeResultForCommand, parseModelInvocationResultForCommand,
  type ModelInvocationDelivery } from '#engine/core/model-invocation/index.js';
import { parseProviderSpendAccountInspectionForQuery, parseProviderSpendAuditResultForCommand, parseProviderSpendManagementResultForCommand, ProviderSpendError } from '#engine/core/provider-spend/index.js';
import { RUNTIME_SERVICE_SCHEMA_VERSION, type RuntimeServiceDelivery, type RuntimeServiceLifecycleVersion } from './service-protocol.js';
import type { RuntimeFailureMapper, RuntimeValidationCall } from './client-validation.js';
/** The validated call with the streamed forms: model deltas (v11) or agent turn events (v12) in a given protocol version. */
export type RuntimeStreamingCall = (operation: Parameters<RuntimeValidationCall>[0], input: unknown, delivery?: RuntimeServiceDelivery, signal?: AbortSignal,
  onDelta?: ModelInvocationDeltaSink, version?: RuntimeServiceLifecycleVersion, onEvent?: (event: AgentTurnStreamEvent) => void) => Promise<unknown>;
/** v15 permission-mode methods: both ends validate; an answer for another scope, or a set answer for another mode, is not trusted. */
export function runtimePermissionModeMethods(call: RuntimeValidationCall, mapFailure: RuntimeFailureMapper) {
  return {
    async inspectPermissionMode(input: PermissionModeQuery, signal?: AbortSignal) {
      try {
        const parsed = permissionModeQuerySchema.safeParse(input);
        if (!parsed.success) throw new PermissionModeError('PERMISSION_MODE_INVALID');
        const result = permissionModeViewSchema.safeParse(await call('inspectPermissionMode', parsed.data, undefined, signal));
        if (!result.success || result.data.scopeId !== parsed.data.scopeId) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        return result.data;
      } catch (error) { throw error instanceof PermissionModeError ? ErrorRegistry.createError(error.code) : mapFailure(error); }
    },
    async setPermissionMode(input: PermissionModeCommand, signal?: AbortSignal) {
      try {
        const parsed = permissionModeCommandSchema.safeParse(input);
        if (!parsed.success) throw new PermissionModeError('PERMISSION_MODE_INVALID');
        const result = permissionModeChangeSchema.safeParse(await call('setPermissionMode', parsed.data, undefined, signal));
        // FA-SESSION: a session full-access switch stores nothing, so the answer keeps the stored mode and says nothing changed.
        const answered = (change: PermissionModeChange) => parsed.data.session ? change.changed === false : change.mode === parsed.data.mode;
        if (!result.success || result.data.scopeId !== parsed.data.scopeId || !answered(result.data)) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        return result.data;
      } catch (error) { throw error instanceof PermissionModeError ? ErrorRegistry.createError(error.code) : mapFailure(error); }
    },
  };
}
/** v16 `/scratch` methods: both ends validate the shapes. */
export function runtimeScratchMethods(call: RuntimeValidationCall, mapFailure: RuntimeFailureMapper) {
  const scratch = async <T>(operation: 'inspectScratch' | 'clearScratch', schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    input: ScratchQuery, signal?: AbortSignal): Promise<T> => {
    try {
      const parsed = scratchQuerySchema.safeParse(input);
      if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
      const result = schema.safeParse(await call(operation, parsed.data, undefined, signal));
      if (!result.success) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return result.data;
    } catch (error) { throw mapFailure(error); }
  };
  return { inspectScratch: (input: ScratchQuery, signal?: AbortSignal) => scratch<ScratchView>('inspectScratch', scratchViewSchema, input, signal),
    clearScratch: (input: ScratchQuery, signal?: AbortSignal) => scratch<ScratchClearance>('clearScratch', scratchClearanceSchema, input, signal) };
}
/** v18 secret methods: name and value are checked before anything is sent (typed, never echoed); an answer for another change is not trusted. */
export function runtimeSecretMethods(call: RuntimeValidationCall, mapFailure: RuntimeFailureMapper) {
  const change = async (operation: 'setSecret' | 'deleteSecret', input: SecretSetCommand | SecretDeleteCommand, signal?: AbortSignal) => {
    try {
      const command = prepareSecretChange(operation, input), result = acceptSecretChangeResult(operation, command, await call(operation, command, undefined, signal));
      if (!result) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return result;
    } catch (error) { throw mapFailure(error); }
  };
  // v24 SECRET-STORE-SWITCH: the target is checked against the wire shape first; an answer for another switch is not trusted.
  const switchSecretStore = async (input: SecretStoreSwitchCommand, signal?: AbortSignal) => {
    try {
      const parsed = secretStoreSwitchCommandSchema.safeParse(input);
      if (!parsed.success) throw ErrorRegistry.createError('CLI_USAGE');
      const result = acceptSecretStoreSwitchResult(parsed.data, await call('switchSecretStore', parsed.data, undefined, signal));
      if (!result) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return result;
    } catch (error) { throw mapFailure(error); }
  };
  return { setSecret: (input: SecretSetCommand, signal?: AbortSignal) => change('setSecret', input, signal),
    deleteSecret: (input: SecretDeleteCommand, signal?: AbortSignal) => change('deleteSecret', input, signal), switchSecretStore };
}
/** Approval answers: a session-standing answer and a clearance are checked against the command that was sent. */
export function runtimeApprovalMethods(call: RuntimeValidationCall) {
  return {
    async decideApproval(input: unknown, delivery?: RuntimeServiceDelivery) {
      const command = approvalCommandSchema.parse(input);
      return parseApprovalAnswer('standing' in command, await call('decideApproval', command, delivery));
    },
    async clearSessionStanding(input: ClearSessionStanding, signal?: AbortSignal) {
      const command = clearSessionStandingSchema.parse(input);
      return acceptSessionStandingClearance(command, await call('clearSessionStanding', command, undefined, signal));
    },
  };
}
/** v12 agent turn methods: both ends validate; an answer for another turn is not trusted. */
export function runtimeChatTurnMethods(call: RuntimeStreamingCall, mapFailure: RuntimeFailureMapper) {
  return {
    async chatTurn(input: ChatTurnCommand, onEvent: (event: AgentTurnStreamEvent) => void, signal?: AbortSignal) {
      try {
        const parsed = chatTurnCommandSchema.safeParse(input);
        if (!parsed.success || typeof onEvent !== 'function') throw new AgentTurnStoreError('AGENT_TURN_INVALID');
        const result = chatTurnResultSchema.safeParse(await call('chatTurn', parsed.data, undefined, signal, undefined, RUNTIME_SERVICE_SCHEMA_VERSION, onEvent));
        if (!result.success || result.data.turnId !== parsed.data.turnId) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        return result.data;
      } catch (error) { throw mapFailure(error); }
    },
    async cancelChatTurn(input: ChatTurnCancellation) {
      try {
        const parsed = chatTurnCancellationSchema.safeParse(input);
        if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
        const result = chatTurnCancellationResultSchema.safeParse(await call('cancelChatTurn', parsed.data));
        if (!result.success || result.data.turnId !== parsed.data.turnId) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        return result.data;
      } catch (error) { throw mapFailure(error); }
    },
  };
}
/** Governed model invocation methods: both ends validate; a result for another command or query is not trusted. */
export function runtimeModelInvocationMethods(call: RuntimeStreamingCall, mapFailure: RuntimeFailureMapper) {
  return {
    async cancelModelInvocation(input: ModelInvocationCancellationCommand, delivery?: ModelInvocationDelivery) {
      try {
        const parsed = modelInvocationCancellationCommandInputSchema.safeParse(input);
        if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
        const command = parsed.data as ModelInvocationCancellationCommand;
        return parseModelInvocationCancellationResultForCommand(command, await call('cancelModelInvocation', command, delivery));
      } catch (error) { throw mapFailure(error); }
    },
    async purgeModelInvocationContent(input: ModelInvocationPurgeCommand, delivery?: ModelInvocationDelivery) {
      try {
        const parsed = modelInvocationPurgeCommandInputSchema.safeParse(input);
        if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
        const command = parsed.data as ModelInvocationPurgeCommand;
        return parseModelInvocationPurgeResultForCommand(command, await call('purgeModelInvocationContent', command, delivery));
      } catch (error) { throw mapFailure(error); }
    },
    async invokeModel(input: ModelInvocationCommand, delivery?: ModelInvocationDelivery, signal?: AbortSignal) {
      try {
        const parsed = modelInvocationCommandInputSchema.safeParse(input);
        if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
        const command = parsed.data as ModelInvocationCommand;
        return parseModelInvocationResultForCommand(command, await call('invokeModel', command, delivery, signal));
      } catch (error) { throw mapFailure(error); }
    },
    async invokeModelStream(input: ModelInvocationCommand, onDelta: ModelInvocationDeltaSink, delivery?: ModelInvocationDelivery, signal?: AbortSignal) {
      try {
        const parsed = modelInvocationCommandInputSchema.safeParse(input);
        if (!parsed.success || typeof onDelta !== 'function') throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
        const command = parsed.data as ModelInvocationCommand;
        return parseModelInvocationResultForCommand(command, await call('invokeModelStream', command, delivery, signal, onDelta));
      } catch (error) { throw mapFailure(error); }
    },
    async inspectModelInvocation(input: ModelInvocationQuery, delivery?: ModelInvocationDelivery) {
      try {
        const parsed = modelInvocationQueryInputSchema.safeParse(input);
        if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
        const query = parsed.data as ModelInvocationQuery;
        return parseModelInvocationInspectionForQuery(query, await call('inspectModelInvocation', query, delivery));
      } catch (error) { throw mapFailure(error); }
    },
  };
}
/** Provider spending methods: an invalid input is the typed PROVIDER_SPEND_INVALID; a result for another query or command is not trusted. */
export function runtimeProviderSpendMethods(call: RuntimeValidationCall, mapFailure: RuntimeFailureMapper) {
  return {
    async inspectProviderSpendAccount(input: ProviderSpendAccountQuery, delivery?: RuntimeServiceDelivery) {
      try {
        let query: ProviderSpendAccountQuery;
        try { query = providerSpendAccountQueryInputSchema.parse(input); }
        catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
        return parseProviderSpendAccountInspectionForQuery(query, await call('inspectProviderSpendAccount', query, delivery));
      } catch (error) { throw mapFailure(error); }
    },
    async manageProviderSpend(input: ProviderSpendManagementCommand, delivery?: RuntimeServiceDelivery) {
      try {
        const parsed = providerSpendManagementCommandInputSchema.safeParse(input);
        if (!parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
        return parseProviderSpendManagementResultForCommand(parsed.data, await call('manageProviderSpend', parsed.data, delivery));
      } catch (error) { throw mapFailure(error); }
    },
    async auditProviderSpendAccount(input: ProviderSpendAuditCommand, delivery?: RuntimeServiceDelivery) {
      try {
        let command: ProviderSpendAuditCommand;
        try { command = providerSpendAuditCommandInputSchema.parse(input); }
        catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
        return parseProviderSpendAuditResultForCommand(command, await call('auditProviderSpendAccount', command, delivery));
      } catch (error) { throw mapFailure(error); }
    },
  };
}
