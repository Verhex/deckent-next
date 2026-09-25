import { OPENAI_CHAT_MAX_TOOL_CALLS, type OpenAiChatTextRequest } from './contract.js';

/**
 * Tool calls of a response against the request: absent/null means none; otherwise every call must be a well-formed function call
 * to a declared tool, with a unique id. Arguments stay the provider's raw string: invalid JSON is the loop's typed tool error to the
 * model, never a reason to execute or to drop the call.
 */
export function checkedToolCalls(value: unknown, request: OpenAiChatTextRequest): readonly { id: string; name: string; arguments: string }[] | null | 'invalid' {
  if (value === null || value === undefined) return null;
  if (!request.tools || !Array.isArray(value) || value.length === 0 || value.length > OPENAI_CHAT_MAX_TOOL_CALLS) return 'invalid';
  const declared = new Set(request.tools.map(tool => tool.function.name)), ids = new Set<string>(), calls: { id: string; name: string; arguments: string }[] = [];
  for (const entry of value) {
    const call = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
    const fn = call && call['function'] && typeof call['function'] === 'object' ? call['function'] as Record<string, unknown> : null;
    if (!call || !fn || call['type'] !== 'function' || typeof call['id'] !== 'string' || call['id'].length === 0 || call['id'].length > 256 || ids.has(call['id'])
      || typeof fn['name'] !== 'string' || !declared.has(fn['name']) || typeof fn['arguments'] !== 'string') return 'invalid';
    ids.add(call['id']); calls.push({ id: call['id'], name: fn['name'], arguments: fn['arguments'] });
  }
  return calls;
}
