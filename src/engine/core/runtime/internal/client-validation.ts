import { EffectError, effectCommandSchema, workspaceAttachmentRequestSchema, workspaceAttachmentSchema,
  workspaceFileMatchesSchema, workspaceFileQuerySchema, type EffectCommand, type WorkspaceAttachmentRequest, type WorkspaceFileQuery } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { AgentTurnStoreError } from '#engine/core/agent-turn/index.js';
import type { EffectOutcome } from '#engine/core/effect/index.js';
import { runtimeOperationInspectionSchema, runtimeOperationOutcomeSchema, runtimeOperationQuerySchema,
  type RuntimeOperationQuery, type RuntimeServiceDelivery, type RuntimeServiceOperation } from './service-protocol.js';
/** Validated request/reply port; composition supplies transport and its existing public error mapping. */
export type RuntimeValidationCall = (operation: RuntimeServiceOperation, input: unknown, delivery?: RuntimeServiceDelivery, signal?: AbortSignal) => Promise<unknown>;
export type RuntimeFailureMapper = (error: unknown) => unknown;
/** v15 composer `@file` methods: both ends validate; a service that answers more than was asked is not trusted with the turn's context. */
export function runtimeWorkspaceFileMethods(call: RuntimeValidationCall, mapFailure: RuntimeFailureMapper) {
  return {
    async findWorkspaceFiles(input: WorkspaceFileQuery, signal?: AbortSignal) {
      try {
        const parsed = workspaceFileQuerySchema.safeParse(input);
        if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
        const result = workspaceFileMatchesSchema.safeParse(await call('findWorkspaceFiles', parsed.data, undefined, signal));
        if (!result.success || result.data.paths.length > parsed.data.limit) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        return result.data;
      } catch (error) { throw mapFailure(error); }
    },
    async attachWorkspaceFile(input: WorkspaceAttachmentRequest, signal?: AbortSignal) {
      try {
        const parsed = workspaceAttachmentRequestSchema.safeParse(input);
        if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
        const result = workspaceAttachmentSchema.safeParse(await call('attachWorkspaceFile', parsed.data, undefined, signal));
        if (!result.success || (result.data.status === 'attached' && (result.data.bytes > parsed.data.maxBytes
          || Buffer.byteLength(result.data.content, 'utf8') !== result.data.bytes))) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
        return result.data;
      } catch (error) { throw mapFailure(error); }
    },
  };
}
/** v15 catalog operation methods: both ends validate; an answer for another command, scope or operation is not trusted. */
export function runtimeEffectOperationMethods(call: RuntimeValidationCall, mapFailure: RuntimeFailureMapper) {
  const submit = async (operation: 'executeOperation' | 'compensateOperation', input: EffectCommand, delivery?: RuntimeServiceDelivery) => {
    try {
      const parsed = effectCommandSchema.safeParse(input);
      if (!parsed.success) throw new EffectError('EFFECT_INVALID');
      const result = runtimeOperationOutcomeSchema.safeParse(await call(operation, parsed.data, delivery));
      if (!result.success || result.data.commandId !== parsed.data.commandId || result.data.scopeId !== parsed.data.scopeId
        || JSON.stringify(result.data.operation) !== JSON.stringify(parsed.data.operation)) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      return result.data as EffectOutcome;
    } catch (error) { throw mapFailure(error); }
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
      } catch (error) { throw mapFailure(error); }
    },
  };
}
