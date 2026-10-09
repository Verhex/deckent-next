import { createHash } from 'node:crypto';
import { OpenAiChatHttpError, type OpenAiChatHttpDefinition, type OpenAiChatTextRequest } from './contract.js';
import { RESPONSES_CONTROLS as CONTROLS } from './responses-controls.js';

type Item = Readonly<Record<string, unknown>>;
const continuations = new Map<string, { at: number; items: readonly Item[]; message: string; reasoningInputTokensUpperBound: number }>();
const canonical = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v)
  ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
export const responsesValueDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const digest = responsesValueDigest;
const key = (scope: string, definition: OpenAiChatHttpDefinition, request: OpenAiChatTextRequest, index: number, callId: string) =>
  digest([scope, definition, request.model, request.tools ?? null, request.messages.slice(0, index), callId]);

/** Opaque reasoning never crosses the agent contract. Bounded, scope/profile/prefix-bound replay, like Anthropic's continuation port. */
export function rememberResponsesOutput(scope: string, definition: OpenAiChatHttpDefinition, request: OpenAiChatTextRequest,
  items: readonly Item[], message: unknown, now = Date.now()): void {
  const first = items.find(item => item['type'] === 'function_call');
  if (typeof first?.['call_id'] !== 'string' || !items.some(item => item['type'] === 'reasoning' && typeof item['encrypted_content'] === 'string')) return;
  if (Buffer.byteLength(JSON.stringify(items), 'utf8') > CONTROLS.continuationMaxBytes) return;
  for (const [id, entry] of continuations) if (now - entry.at > CONTROLS.continuationTtlMs) continuations.delete(id);
  while (continuations.size >= CONTROLS.continuationMaxEntries) continuations.delete(continuations.keys().next().value!);
  const projected = message as { content?: unknown; tool_calls?: unknown };
  const neutral = { role: 'assistant', content: projected.content ?? '', ...(projected.tool_calls ? { tool_calls: projected.tool_calls } : {}) };
  continuations.set(key(scope, definition, request, request.messages.length, first['call_id']),
    { at: now, items, message: digest(neutral), reasoningInputTokensUpperBound: request.max_completion_tokens });
}

/** Pure encoding of the same typed request. No server conversation, hidden retention or built-in tools. */
export function responsesBody(definition: OpenAiChatHttpDefinition, request: OpenAiChatTextRequest, scope = '', now = Date.now()) {
  const dialect = definition.dialect;
  const effort = request.reasoning_effort ?? dialect?.reasoningEffort;
  if (dialect?.protocol !== 'responses' || !effort || !dialect.reasoningEfforts?.includes(effort)
    || request.chat_template_kwargs !== undefined) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  const input: Item[] = [];
  let reasoningInputTokensUpperBound = 0;
  for (const [index, message] of request.messages.entries()) {
    if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
    else if (message.role === 'assistant') {
      const found = scope && message.tool_calls?.[0] ? continuations.get(key(scope, definition, request, index, message.tool_calls[0].id)) : undefined;
      // Compare the exact neutral projection too: changed text/calls never replays an opaque provider block.
      if (found && now - found.at <= CONTROLS.continuationTtlMs && found.message === digest(message)) {
        input.push(...found.items.map(item => Object.fromEntries(Object.entries(item).filter(([name]) => name !== 'status'))));
        // Ciphertext bytes are not a token count. A validated prior response's reasoning is bounded by its complete output limit.
        reasoningInputTokensUpperBound += found.reasoningInputTokensUpperBound;
        continue;
      }
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    } else input.push({ role: message.role, content: message.content });
  }
  return { reasoningInputTokensUpperBound, body: { model: request.model, input, max_output_tokens: request.max_completion_tokens, stream: request.stream === true,
    store: false, include: ['reasoning.encrypted_content'], reasoning: { effort },
    ...(request.service_tier ? { service_tier: request.service_tier } : {}),
    ...(request.tools ? { tools: request.tools.map(tool => ({ type: 'function', ...tool.function, strict: false })) } : {}),
    ...(request.tool_choice ? { tool_choice: request.tool_choice } : {}) } };
}
