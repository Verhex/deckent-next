import type { ModelInvocationResult } from '#engine/index.js';
import { agentToolCallSchema, type AgentToolCall, type AgentTurnMessage, type JsonObject, agentMessageContinuationSchema, type AgentMessageContinuation, type AgentProviderStop } from '#domain/index.js';
import { OPENAI_CHAT_METERING } from './metering.js';

function firstChoice(result: ModelInvocationResult): Record<string, unknown> | null {
  const native = result.response?.native;
  if (!native || typeof native !== 'object') return null;
  const choices = (native as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  return choice && typeof choice === 'object' ? choice as Record<string, unknown> : null;
}

/** Assistant text from an OpenAI-shaped native response; reasoning fields are never treated as the answer. */
export function extractOpenAiChatTextFromInvocation(result: ModelInvocationResult): string | null {
  const message = firstChoice(result)?.['message'];
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.trim()) return null;
  return content.trim();
}

/** True when the completion budget ended the turn (e.g. a reasoning model spent it before answering). */
export function openAiChatStoppedAtLength(result: ModelInvocationResult): boolean {
  return firstChoice(result)?.['finish_reason'] === 'length';
}

/**
 * Untrimmed answer, reasoning text and tool calls of the assembled result (already validated by the adapter against the declared
 * tools), mapped onto the provider-neutral agent tool call. `null` when the result has no readable message.
 */
export function openAiChatMessageFromInvocation(result: ModelInvocationResult):
  { content: string; reasoning: string; finish: unknown; toolCalls: readonly AgentToolCall[]; continuation?: AgentMessageContinuation; providerStop?: AgentProviderStop } | null {
  const choice = firstChoice(result), message = choice?.['message'];
  if (!choice || !message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const reasoning = typeof record['reasoning'] === 'string' ? record['reasoning']
    : typeof record['reasoning_content'] === 'string' ? record['reasoning_content'] : '';
  const toolCalls: AgentToolCall[] = [];
  for (const entry of Array.isArray(record['tool_calls']) ? record['tool_calls'] : []) {
    const call = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const parsed = agentToolCallSchema.safeParse({ id: call.id, name: call.function?.name, argumentsJson: call.function?.arguments });
    if (!parsed.success) return null;
    toolCalls.push(parsed.data);
  }
  const native: Record<string, unknown> = {};
  if (typeof record['reasoning_content'] === 'string' || record['reasoning_content'] === null) native['reasoning_content'] = record['reasoning_content'];
  if (Array.isArray(record['reasoning_details'])) native['reasoning_details'] = record['reasoning_details'];
  const continuation = Object.keys(native).length ? agentMessageContinuationSchema.parse({ schemaVersion: 1, scopeId: result.receipt.request.scopeId,
    reference: result.receipt.request.reference, profileDigest: result.receipt.profileDigest, native }) : undefined;
  const providerStop = providerStopOf(choice['finish_reason']);
  return { ...(continuation ? { continuation } : {}), ...(providerStop ? { providerStop } : {}), content: typeof record['content'] === 'string' ? record['content'] : '', reasoning, finish: choice['finish_reason'], toolCalls: Object.freeze(toolCalls) };
}

/** Settled token usage of the result; reasoning tokens when the server reports them. */
export function openAiChatUsageFromInvocation(result: ModelInvocationResult):
  { promptTokens: number; completionTokens: number; reasoningTokens: number | null } | null {
  const usage = result.response?.usage as Record<string, unknown> | null | undefined;
  if (!usage || typeof usage['prompt_tokens'] !== 'number' || typeof usage['completion_tokens'] !== 'number') return null;
  const details = usage['completion_tokens_details'] as Record<string, unknown> | null | undefined;
  const reasoning = details && typeof details['reasoning_tokens'] === 'number' ? details['reasoning_tokens'] : null;
  return { promptTokens: usage['prompt_tokens'], completionTokens: usage['completion_tokens'], reasoningTokens: reasoning };
}

/** Provider-neutral agent turn messages in the OpenAI chat request shape (assistant tool calls as `function` calls, tool results by call id). */
export function openAiChatNativeMessages(messages: readonly AgentTurnMessage[], context?: Omit<AgentMessageContinuation, 'schemaVersion' | 'native'>) {
  return messages.filter(message => message.role !== 'assistant' || message.content.trim() || message.toolCalls.length).map(message => message.role === 'assistant'
    ? { role: 'assistant', content: message.content, ...continuationFields(message.continuation, context), ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map(call =>
      ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.argumentsJson } })) } : {}) }
    : message.role === 'tool' ? { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
      : { role: message.role, content: message.content });
}

/**
 * Conservative prompt bound when the provider has no counter (legacy formula): every UTF-8 byte of messages and tools counts as a
 * token, plus fixed overheads per request, message and tool. It never under-counts; it is always labelled `upper-bound`.
 */
export function openAiChatPromptUpperBound(nativeRequest: JsonObject): number {
  const request = nativeRequest as { messages?: unknown[]; tools?: unknown[] };
  const messages = request.messages ?? [], tools = request.tools ?? [];
  const estimate = OPENAI_CHAT_METERING.tokenEstimate;
  return Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') + estimate.requestOverheadTokens
    + estimate.messageOverheadTokens * messages.length + estimate.toolOverheadTokens * tools.length;
}

function continuationFields(value: AgentMessageContinuation | undefined, context: Omit<AgentMessageContinuation, 'schemaVersion' | 'native'> | undefined) {
  if (!value || !context || value.scopeId !== context.scopeId || value.profileDigest !== context.profileDigest
    || Object.entries(context.reference).some(([key, field]) => value.reference[key as keyof typeof value.reference] !== field)) return {};
  return { ...((typeof value.native['reasoning_content'] === 'string' || value.native['reasoning_content'] === null) ? { reasoning_content: value.native['reasoning_content'] } : {}),
    ...(Array.isArray(value.native['reasoning_details']) ? { reasoning_details: value.native['reasoning_details'] } : {}) };
}
function providerStopOf(finish: unknown): AgentProviderStop | undefined {
  switch (finish) {
    case 'content_filter': case 'sensitive': return 'content-filter';
    case 'model_context_window_exceeded': return 'context-window';
    case 'network_error': return 'network-error';
    case 'insufficient_system_resource': return 'resource-exhausted';
    case 'aborted': return 'aborted';
    default: return undefined;
  }
}
