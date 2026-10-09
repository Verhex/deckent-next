import { describe, expect, it } from 'vitest';
import { agentMessageContinuationSchema, agentTurnMessageSchema, type AgentTurnMessage, type ModelInvocationNativeResponse } from '#domain/index.js';
import { createOpenAiChatStream, openAiChatNativeMessages } from '#adapters/core/provider-openai-chat/index.js';
import { createAnthropicMessagesStream } from '#adapters/core/provider-anthropic-messages/index.js';
import type { NativeJsonHttpStream } from '#adapters/core/provider-http-json/index.js';

const limits = { requestMaxBytes: 65_536, responseMaxBytes: 65_536, timeoutMs: 1000 };
const request = { model: 'fixture', messages: [{ role: 'user' as const, content: 'hi' }], max_completion_tokens: 1000 };
const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
const chunk = (delta: object, finish: string | null = null, extra = {}, object: string | undefined = 'chat.completion.chunk') =>
  `data: ${JSON.stringify({ id: 'fixture', ...(object === undefined ? {} : { object }), created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
const done = 'data: [DONE]\n\n';
const parse = (stream: NativeJsonHttpStream, wire: string) => { stream.push(Buffer.from(wire)); return stream.finish(); };
const details = [{ type: 'reasoning.encrypted', data: 'opaque==', id: 'r1', format: 'anthropic-claude-v1', index: 0 },
  { type: 'reasoning.text', text: ' literal \n', signature: 'signature==', id: 'r2', index: 1 }];

describe('W8 scoped continuation', () => {
  const context = { scopeId: 'scope', reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 }, profileDigest: 'a'.repeat(64) };
  it('preserves DeepSeek native reasoning separately from preview and retains OpenRouter chunks in their original order', () => {
    const deepseek = parse(createOpenAiChatStream(request, limits), chunk({ reasoning_content: ' literal\n' }) + chunk({ reasoning_content: 'tail', content: 'answer' }, 'stop', { usage }) + done);
    expect(deepseek).toMatchObject({ response: { native: { choices: [{ message: { reasoning_content: ' literal\ntail' } }] } } });
    const openrouter = parse(createOpenAiChatStream(request, limits), chunk({ reasoning_details: [details[0]] })
      + chunk({ reasoning_details: [details[1]], content: 'answer' }, 'stop', { usage }) + done);
    expect(openrouter).toMatchObject({ response: { native: { choices: [{ message: { reasoning_details: details } }] } } });
  });
  it('round-trips a canonical message through JSON without modifying opaque fields, and excludes other scopes/models/profiles', () => {
    const assistant = agentTurnMessageSchema.parse(JSON.parse(JSON.stringify({ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', argumentsJson: '{}' }],
      continuation: { schemaVersion: 1, ...context, native: { reasoning_content: ' \nexact ', reasoning_details: details } } })));
    const messages: AgentTurnMessage[] = [{ role: 'user', content: 'hi' }, assistant, { role: 'tool', toolCallId: 'c', name: 'read', content: 'result' }];
    expect(openAiChatNativeMessages(messages, context)[1]).toMatchObject({ reasoning_content: ' \nexact ', reasoning_details: details });
    for (const changed of [{ ...context, scopeId: 'another' }, { ...context, profileDigest: 'b'.repeat(64) }, { ...context, reference: { ...context.reference, modelVersion: 2 } }]) {
      expect(openAiChatNativeMessages(messages, changed)[1]).not.toHaveProperty('reasoning_details');
      expect(openAiChatNativeMessages(messages, changed)[1]).not.toHaveProperty('reasoning_content');
    }
    expect(openAiChatNativeMessages(messages)[1]).not.toHaveProperty('reasoning_content');
    expect(agentMessageContinuationSchema.safeParse({ schemaVersion: 1, ...context, native: { tooLarge: 'x'.repeat(8 * 1024 * 1024 + 1) } }).success).toBe(false);
  });
  it('refuses malformed structured reasoning; text preview cannot repair it', () => {
    expect(parse(createOpenAiChatStream(request, limits), chunk({ reasoning: 'preview', reasoning_details: [{ type: 'reasoning.encrypted', data: 123 }] }, 'stop', { usage }) + done))
      .toEqual({ reason: 'invalid-response' });
  });
  it('omits empty/whitespace assistant turns while retaining tool-only turns', () => {
    const messages: AgentTurnMessage[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', toolCalls: [] },
      { role: 'assistant', content: ' \n', toolCalls: [] }, { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', argumentsJson: '{}' }] }];
    expect(openAiChatNativeMessages(messages)).toHaveLength(2);
    expect(openAiChatNativeMessages(messages)[1]).toHaveProperty('tool_calls');
  });
});

describe('W8 provider response grammar', () => {
  const dialect = { tokenLimitField: 'max_tokens' as const, streamUsage: 'omit' as const, toolChoice: ['auto' as const], responseObject: 'optional' as const,
    finishReasons: ['sensitive', 'model_context_window_exceeded', 'network_error', 'insufficient_system_resource', 'aborted'] as const };
  it.each(dialect.finishReasons)('accepts documented %s with its own final usage; ordinary OpenAI rejects it', finish => {
    const final: object[] = [], withdrawn: boolean[] = [];
    const wire = chunk({}, finish, { usage }, undefined) + done;
    const result = parse(createOpenAiChatStream(request, limits, value => final.push(value), () => withdrawn.push(true), dialect), wire);
    expect(result).toMatchObject({ response: { usage } }); expect(final).toEqual([usage]); expect(withdrawn).toEqual([]);
    expect(parse(createOpenAiChatStream(request, limits), wire)).toEqual({ reason: 'invalid-response' });
  });
  it('does not relax required identities or accept a wrong object, unknown finish or a missing final usage', () => {
    for (const wire of [chunk({}, 'future', { usage }, undefined), chunk({}, 'stop', { usage }, 'wrong'),
      chunk({}, 'stop', { usage, model: 'other' }, undefined), chunk({}, 'stop', { usage, id: '' }, undefined)]) {
      expect(parse(createOpenAiChatStream(request, limits, undefined, undefined, dialect), wire + done)).toHaveProperty('reason');
    }
    expect(parse(createOpenAiChatStream(request, limits, undefined, undefined, dialect), chunk({}, 'network_error', {}, undefined) + done)).toHaveProperty('reason');
  });
});

describe('W8 Anthropic final measurement withdrawal', () => {
  const sse = (type: string, extra: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
  const start = sse('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', model: 'fixture', usage: { input_tokens: 10, output_tokens: 1 } } });
  const final = sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } });
  it.each(['second-final', 'malformed', 'error', 'after-stop'] as const)('withdraws once on %s even after wire exceeds retention capacity', failure => {
    const measured: object[] = [], withdrawn: number[] = [];
    const cap = 1024, stream = createAnthropicMessagesStream(request, { ...limits, responseMaxBytes: cap }, { scopeId: 'scope', prefixDigest: 'prefix' },
      value => measured.push(value), () => withdrawn.push(1));
    const prefix = start + Array.from({ length: 100 }, () => sse('ping')).join('') + final;
    expect(Buffer.byteLength(prefix)).toBeGreaterThan(cap);
    expect(stream.push(Buffer.from(prefix))).not.toHaveProperty('rejected'); expect(measured).toHaveLength(1);
    const bad = failure === 'second-final' ? sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 900 } })
      : failure === 'malformed' ? 'data: {broken}\n\n' : failure === 'error' ? sse('error', { error: { type: 'overloaded_error' } }) : sse('message_stop') + sse('ping');
    stream.push(Buffer.from(bad)); expect(stream.finish()).toHaveProperty('reason'); stream.finish(); expect(withdrawn).toEqual([1]);
  });
  it('keeps a trustworthy measurement on a clean cut and on retention pressure alone', () => {
    const withdrawn: number[] = [];
    const stream = createAnthropicMessagesStream(request, limits, { scopeId: 'scope', prefixDigest: 'prefix' }, () => undefined, () => withdrawn.push(1));
    stream.push(Buffer.from(start + final)); expect(stream.finish()).toEqual({ reason: 'interrupted' }); expect(withdrawn).toEqual([]);
    const complete = parse(createAnthropicMessagesStream(request, limits, { scopeId: 'scope', prefixDigest: 'prefix' }), start + final + sse('message_stop'));
    expect((complete as { response: ModelInvocationNativeResponse }).response.usage).toMatchObject({ completion_tokens: 10 });
  });
});
