import { OpenAiChatHttpError, type OpenAiChatTextMessage, type OpenAiChatTextRequest } from '#adapters/core/provider-openai-chat/index.js';
import type { AnthropicMessagesDefinition } from './contract.js';
import { recallAnthropicContent, type AnthropicContentBlock } from './continuation.js';

type Block = Record<string, unknown> & { type: string };
type Wire = { role: 'user' | 'assistant'; content: string | Block[] };
const invalid = (): never => { throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID'); };
const blocksOf = (message: Wire): Block[] => typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;

/** A tool call's arguments are the model's raw JSON text; the API wants an object. Anything else is sent as `{}` (the loop already answered it with a typed tool error). */
function toolInput(argumentsJson: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(argumentsJson);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

/** True when the recalled provider content still says exactly what the neutral assistant message says (text and tool calls). */
function sameAssistant(blocks: readonly AnthropicContentBlock[], content: string | null, calls: readonly ToolCall[]): boolean {
  const text = blocks.filter(block => block.type === 'text').map(block => String(block['text'])).join('');
  const uses = blocks.filter(block => block.type === 'tool_use');
  return text === (content ?? '') && uses.length === calls.length && uses.every((use, index) => use['id'] === calls[index]!.id
    && use['name'] === calls[index]!.function.name && JSON.stringify(use['input']) === JSON.stringify(toolInput(calls[index]!.function.arguments)));
}

function assistantBlocks(message: Extract<OpenAiChatTextMessage, { role: 'assistant' }>, scopeId: string): string | Block[] {
  const calls = (message.tool_calls ?? []) as readonly ToolCall[];
  if (calls.length === 0) return (message.content ?? '').trim() === '' ? invalid() : message.content!;
  const recalled = recallAnthropicContent(scopeId, calls[0]!.id);
  if (recalled && sameAssistant(recalled, message.content, calls)) return structuredClone(recalled) as Block[];
  return [...(message.content !== null && message.content.trim() !== '' ? [{ type: 'text', text: message.content }] : []),
    ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: toolInput(call.function.arguments) }))];
}

/** Sampling and thinking controls from profile data and the typed request; never inferred from the model name. */
function thinkingOf(request: OpenAiChatTextRequest, definition: AnthropicMessagesDefinition): Record<string, unknown> | undefined {
  const config = definition.thinking;
  if (request.chat_template_kwargs?.enable_thinking === false) {
    if (!config?.off) return invalid();
    return { type: config.off };
  }
  if (!config || config.mode === 'model-default') return undefined;
  return config.mode === 'adaptive' ? { type: 'adaptive', display: config.display } : { type: 'enabled', budget_tokens: config.budgetTokens };
}

/**
 * Pure mapping of the provider-neutral request to a Messages API body: leading system/developer text to the top-level `system`,
 * assistant tool calls to `tool_use`, consecutive tool results folded into one user message of `tool_result` blocks, strict
 * user-first/user-last alternation (a trailing assistant message is a prefill, refused by current models). `required` tool choice
 * is refused: forced tool use is a 400 on Opus 5.5 / Sonnet 5.5 / Fable 5.1.
 */
export function anthropicMessagesBody(request: OpenAiChatTextRequest, definition: AnthropicMessagesDefinition, scopeId: string, stream = request.stream === true) {
  const system: string[] = [], wire: Wire[] = [];
  const push = (role: Wire['role'], content: string | Block[]) => {
    const last = wire.at(-1);
    if (last && last.role === role) last.content = [...blocksOf(last), ...(typeof content === 'string' ? [{ type: 'text', text: content }] : content)];
    else wire.push({ role, content });
  };
  request.messages.forEach((message, index) => {
    if (message.role === 'system' || message.role === 'developer') { if (wire.length > 0 || index > system.length) invalid(); system.push(message.content); return; }
    if (message.role === 'user') return push('user', message.content);
    if (message.role === 'assistant') return push('assistant', assistantBlocks(message, scopeId));
    if (message.role !== 'tool') return invalid();
    push('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, ...(message.content === '' ? {} : { content: message.content }) }]);
  });
  if (wire.length === 0 || wire[0]!.role !== 'user' || wire.at(-1)!.role !== 'user') invalid();
  if (request.tool_choice === 'required') invalid();
  const thinking = thinkingOf(request, definition);
  const maxTokens = request.max_completion_tokens;
  if (thinking?.['type'] === 'enabled' && Number(thinking['budget_tokens']) >= maxTokens) invalid();
  return { model: request.model, max_tokens: maxTokens, stream, ...(system.length ? { system: system.join('\n\n') } : {}), messages: wire,
    ...(request.tools ? { tools: request.tools.map(tool => ({ name: tool.function.name,
      ...(tool.function.description === undefined ? {} : { description: tool.function.description }), input_schema: tool.function.parameters })) } : {}),
    ...(request.tool_choice ? { tool_choice: { type: request.tool_choice } } : {}),
    ...(thinking ? { thinking } : {}),
    ...(definition.cache && definition.cache !== 'none' ? { cache_control: definition.cache === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' } } : {}) };
}
