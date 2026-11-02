import type { JsonObject } from '#domain/index.js';

/** A text-only transport accepts one system prompt and one user transcript. Preserve every history entry and its role;
 * existing single-user role prompts keep their contents. Previous tool messages remain context, never native tool calls or authority. The native port still validates and bounds the request. */
export function textOnlyModelInvocationRequest(request: JsonObject): JsonObject {
  const messages = request['messages'] as readonly JsonObject[], history = messages.filter(message => message['role'] !== 'system');
  return { model: request['model']!, max_completion_tokens: request['max_completion_tokens']!, stream: false,
    messages: [{ role: 'system', content: messages.filter(message => message['role'] === 'system').map(message => message['content']).join('\n\n') },
      { role: 'user', content: history.length === 1 && history[0]!['role'] === 'user' ? history[0]!['content']! : JSON.stringify(history) }] };
}
