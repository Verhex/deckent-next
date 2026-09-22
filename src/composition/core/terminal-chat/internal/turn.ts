import { randomUUID } from 'node:crypto';
import type { JsonObject, ModelInvocationCancellationCommand, ModelInvocationCommand, ModelReference } from '#domain/index.js';
import { modelInvocationRequestDigest, type ModelInvocationResult } from '#engine/index.js';
import { ErrorRegistry, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { readTerminalChatConfig, registerProviderConfig } from '#adapters/index.js';
import { inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { extractOpenAiChatTextFromInvocation, openAiChatStoppedAtLength } from './extract-text.js';

export type TerminalChatMessage = Readonly<{ role: 'system' | 'user' | 'assistant'; content: string }>;

export type TerminalChatPlan = Readonly<{
  schemaVersion: 1;
  status: 'ready' | 'not-configured' | 'model-not-declared';
  reference: ModelReference | null;
  catalogRevision: string | null;
  maxCompletionTokens: number | null;
  historyMessages: number | null;
}>;

/** Governed model invocation service; the shipped executable wires the local runtime client. */
export interface TerminalChatInvocationPorts {
  invoke(projectRoot: string, command: ModelInvocationCommand, options: ConfigLoadOptions, signal?: AbortSignal): Promise<ModelInvocationResult>;
  cancel(projectRoot: string, command: ModelInvocationCancellationCommand, options: ConfigLoadOptions): Promise<unknown>;
}

export interface TerminalChatTurnInput {
  readonly projectRoot: string;
  readonly scopeId: string;
  readonly messages: readonly TerminalChatMessage[];
  readonly options: ConfigLoadOptions;
  readonly signal?: AbortSignal;
}

export async function describeTerminalChat(projectRoot: string, options: ConfigLoadOptions = {}): Promise<TerminalChatPlan> {
  registerProviderConfig();
  const chat = readTerminalChatConfig(await loadConfig(projectRoot, options) as Record<string, unknown>);
  if (!chat) return Object.freeze({ schemaVersion: 1, status: 'not-configured', reference: null, catalogRevision: null, maxCompletionTokens: null, historyMessages: null });
  const binding = await inspectModelBinding(projectRoot, chat.reference, options);
  return Object.freeze({ schemaVersion: 1, status: binding.status === 'declared' ? 'ready' : 'model-not-declared', reference: chat.reference,
    catalogRevision: binding.catalogRevision, maxCompletionTokens: chat.maxCompletionTokens, historyMessages: chat.historyMessages });
}

/**
 * One chat turn is one governed model invocation: principal, policy, activation and spending are enforced by the
 * invocation service for the caller's scope. Abort stops the wait and requests cancellation of that invocation.
 */
export async function completeTerminalChatTurn(input: TerminalChatTurnInput, ports: TerminalChatInvocationPorts): Promise<string> {
  registerProviderConfig();
  const chat = readTerminalChatConfig(await loadConfig(input.projectRoot, input.options) as Record<string, unknown>);
  if (!chat) throw ErrorRegistry.createError('TERMINAL_CHAT_NOT_CONFIGURED');
  const binding = await inspectModelBinding(input.projectRoot, chat.reference, input.options);
  if (binding.status !== 'declared') throw ErrorRegistry.createError('TERMINAL_CHAT_MODEL_NOT_DECLARED');
  const nativeRequest = {
    model: binding.definition.model.nativeId,
    messages: input.messages.map(message => ({ role: message.role, content: message.content })),
    max_completion_tokens: chat.maxCompletionTokens,
    stream: false,
  } as unknown as JsonObject;
  const command: ModelInvocationCommand = { schemaVersion: 1, commandId: randomUUID(), scopeId: input.scopeId,
    reference: chat.reference, catalogRevision: binding.catalogRevision, expectedBinding: binding.binding, nativeRequest };
  let outcome: ModelInvocationResult;
  try {
    outcome = await ports.invoke(input.projectRoot, command, input.options, input.signal);
  } catch (error) {
    if (!input.signal?.aborted) throw error;
    await ports.cancel(input.projectRoot, { schemaVersion: 1, commandId: randomUUID(), scopeId: input.scopeId,
      targetCommandId: command.commandId, reference: command.reference, expectedRequestDigest: modelInvocationRequestDigest(command) },
    input.options).catch(() => undefined);
    throw ErrorRegistry.createError('TERMINAL_CHAT_CANCELLED');
  }
  const text = extractOpenAiChatTextFromInvocation(outcome);
  if (!text) {
    throw openAiChatStoppedAtLength(outcome)
      ? ErrorRegistry.createError('TERMINAL_CHAT_TRUNCATED', { params: { maxCompletionTokens: chat.maxCompletionTokens } })
      : ErrorRegistry.createError('TERMINAL_CHAT_EMPTY');
  }
  return text;
}
