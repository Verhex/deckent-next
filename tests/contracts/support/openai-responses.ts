/** Synthetic fixtures from the Responses reference, fetched 2026-10-09. No recorded credentials or paid calls. */
export const RESPONSES_MODEL = 'gpt-6.1-sol';
export const RESPONSES_DIALECT = { protocol: 'responses' as const, tokenLimitField: 'max_completion_tokens' as const, streamUsage: 'omit' as const,
  toolChoice: ['auto', 'none', 'required'] as const, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const, reasoningEffort: 'medium' as const };
export const RESPONSES_TOOLS = [{ type: 'function' as const, function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
export const responsesUsage = (cached = 40, reasoning = 6) => ({ input_tokens: 100, output_tokens: 10, total_tokens: 110,
  input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: reasoning } });
export const textItem = (text = 'ok') => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }] });
export const callItem = (name = 'read_file') => ({ type: 'function_call', id: 'fc_1', call_id: 'call_1', name, arguments: '{"path":"a.ts"}', status: 'completed' });
export const reasoningItem = () => ({ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan' }], encrypted_content: 'opaque-reasoning-canary' });
export const responsesFinal = (output: unknown[] = [textItem()], patch: Record<string, unknown> = {}) => ({
  id: 'resp_1', object: 'response', created_at: 1, model: RESPONSES_MODEL, status: 'completed', error: null,
  incomplete_details: null, output, usage: responsesUsage(), service_tier: 'default', ...patch,
});
export const event = (type: string, sequence_number: number, fields: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number, ...fields })}\n\n`;
export const responsesCreated = (patch: Record<string, unknown> = {}) => event('response.created', 0, {
  response: responsesFinal([], { status: 'in_progress', usage: null, ...patch }),
});
export function toolStream() {
  return [
    responsesCreated(),
    event('response.output_item.added', 1, { output_index: 0, item: { ...reasoningItem(), summary: [], encrypted_content: null } }),
    event('response.reasoning_summary_part.added', 2, { output_index: 0, item_id: 'rs_1', summary_index: 0, part: { type: 'summary_text', text: '' } }),
    event('response.reasoning_summary_text.delta', 3, { output_index: 0, item_id: 'rs_1', summary_index: 0, delta: 'Plan' }),
    event('response.reasoning_summary_text.done', 4, { output_index: 0, item_id: 'rs_1', summary_index: 0, text: 'Plan' }),
    event('response.output_item.done', 5, { output_index: 0, item: reasoningItem() }),
    event('response.output_item.added', 6, { output_index: 1, item: { ...callItem(), arguments: '', status: 'in_progress' } }),
    event('response.function_call_arguments.delta', 7, { output_index: 1, item_id: 'fc_1', delta: '{"path":' }),
    event('response.function_call_arguments.delta', 8, { output_index: 1, item_id: 'fc_1', delta: '"a.ts"}' }),
    event('response.function_call_arguments.done', 9, { output_index: 1, item_id: 'fc_1', arguments: '{"path":"a.ts"}' }),
    event('response.output_item.done', 10, { output_index: 1, item: callItem() }),
    event('response.completed', 11, { response: responsesFinal([reasoningItem(), callItem()]) }),
  ];
}
export function responsesFixture(endpoint: string, stream = true) {
  const reference = { providerId: 'openai-api', providerVersion: 1, modelId: RESPONSES_MODEL, modelVersion: 1 };
  const request = { model: RESPONSES_MODEL, messages: [{ role: 'user' as const, content: 'read a.ts' }], max_completion_tokens: 32,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}), tools: RESPONSES_TOOLS, tool_choice: 'auto' };
  const profile = { schemaVersion: 1, id: 'responses', version: 1, scopeId: 'scope', reference, bindingDigest: 'a'.repeat(64),
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 6, definition: {
      endpoint, maxOutputTokens: 32, dialect: RESPONSES_DIALECT, authentication: { type: 'none' }, tariff: { kind: 'operator-static', version: 2,
        currency: 'USD', inputMinorUnitsPerMillionTokens: 200, cachedInputMinorUnitsPerMillionTokens: 50, outputMinorUnitsPerMillionTokens: 1000 } } },
    allocation: { id: 'allocation', maxCalls: null, maxInFlight: 1 }, limits: { requestMaxBytes: 8192, responseMaxBytes: 8192, timeoutMs: 2000 } };
  const definition = { encodingVersion: 1, provider: { id: 'openai-api', version: 1 }, model: { id: RESPONSES_MODEL, version: 1, nativeId: RESPONSES_MODEL,
    protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }] }] } };
  const command = { schemaVersion: 1, commandId: 'call', scopeId: 'scope', reference, catalogRevision: 'catalog',
    expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) }, nativeRequest: request };
  return { profile, definition, request, command };
}
