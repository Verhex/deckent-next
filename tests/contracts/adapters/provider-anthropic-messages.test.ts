import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpsServer, type ServerResponse } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { anthropicMaxChargeMinorUnits, anthropicMessagesBody, anthropicPublishedTariff, createAnthropicMessagesPricedNative, forgetAnthropicContentForTests,
  parseAnthropicMessagesDefinition, quoteAnthropicPublishedTariff, ANTHROPIC_PUBLISHED_TARIFFS } from '#adapters/core/provider-anthropic-messages/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';
import type { ModelInvocationDelta } from '#domain/index.js';
import { createLocalTls } from '../../fixtures/local-tls.js';

const servers: HttpsServer[] = [];
let directory = '', certificate = '', privateKey = '';
const SECRET = 'sk-ant-api03-test_secret-0123456789', MODEL = 'claude-sonnet-5-5';
const limits = { requestMaxBytes: 65_536, responseMaxBytes: 65_536, timeoutMs: 3000 };
beforeEach(async () => {
  forgetAnthropicContentForTests();
  directory = await mkdtemp(join(tmpdir(), 'deckent-anthropic-'));
  ({ key: privateKey, caPem: certificate } = await createLocalTls(directory));
});
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await rm(directory, { recursive: true, force: true });
});
async function fixture(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer({ key: privateKey, cert: certificate }, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', (part: Buffer) => chunks.push(part));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  return `https://127.0.0.1:${address.port}/v1/messages`;
}
const binding = (nativeId = MODEL, capabilities: readonly string[] = ['tool-calls', 'token-count', 'chat-template-enable-thinking']) => ({ encodingVersion: 1,
  provider: { id: 'anthropic', version: 1 }, model: { id: 'sonnet', version: 1, nativeId, protocols: [{ family: 'anthropic-messages', version: '2023-06-01',
    capabilities: capabilities.map(id => ({ id, version: 1, state: 'supported' })) }] } });
const reference = { providerId: 'anthropic', providerVersion: 1, modelId: 'sonnet', modelVersion: 1 };
function profile(endpoint: string, extra: Record<string, unknown> = {}, profileLimits = limits, tariff = anthropicPublishedTariff(MODEL)) {
  return { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: 'a'.repeat(64),
    protocol: { family: 'anthropic-messages', version: '2023-06-01' }, adapter: { id: 'anthropic-messages-http', version: 2,
      definition: { endpoint, maxOutputTokens: 256, authentication: { type: 'header', name: 'x-api-key', credentialRef: 'ANTHROPIC_API_KEY' },
        tls: { caPem: certificate }, tariff, ...extra } },
    allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 }, limits: profileLimits };
}
const tool = { type: 'function' as const, function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };
const streamed = (over: Record<string, unknown> = {}) => ({ model: MODEL, messages: [{ role: 'system' as const, content: 'be brief' }, { role: 'user' as const, content: 'hi' }],
  max_completion_tokens: 64, stream: true, stream_options: { include_usage: true }, ...over });
const sse = (type: string, payload: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
const startEvent = (usage: Record<string, unknown> = { input_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }, model = MODEL) =>
  sse('message_start', { message: { id: 'msg_01', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
const blockStart = (index: number, block: Record<string, unknown>) => sse('content_block_start', { index, content_block: block });
const blockDelta = (index: number, delta: Record<string, unknown>) => sse('content_block_delta', { index, delta });
const blockStop = (index: number) => sse('content_block_stop', { index });
const endEvents = (stop = 'end_turn', usage: Record<string, unknown> = { output_tokens: 15 }) => sse('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage }) + sse('message_stop');
const textStream = (text = 'Hello') => startEvent() + sse('ping') + blockStart(0, { type: 'text', text: '' }) + blockDelta(0, { type: 'text_delta', text }) + blockStop(0) + endEvents();
const okSse = (wire: string) => (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(wire); };
const credential = async (reference: string) => reference === 'ANTHROPIC_API_KEY' ? SECRET : undefined;
async function run(endpoint: string, request: Record<string, unknown> = streamed(), options: { signal?: AbortSignal; extra?: Record<string, unknown>; bind?: ReturnType<typeof binding> } = {}) {
  const priced = createAnthropicMessagesPricedNative({ resolveCredential: credential }), deltas: ModelInvocationDelta[] = [];
  const prepared = await priced.native.prepare(profile(endpoint, options.extra), options.bind ?? binding(), request);
  const result = await priced.native.send(prepared, options.signal, delta => deltas.push(delta));
  return { result, deltas, prepared };
}

it('maps the neutral request onto the Messages wire: system lifted, tool calls and folded results, thinking control, cache', () => {
  const definition = parseAnthropicMessagesDefinition(profile('https://api.anthropic.com/v1/messages').adapter.definition);
  const body = anthropicMessagesBody({ model: MODEL, max_completion_tokens: 64, messages: [
    { role: 'system', content: 'sys A' }, { role: 'developer', content: 'sys B' }, { role: 'user', content: 'go' },
    { role: 'assistant', content: 'looking', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
      { id: 'toolu_2', type: 'function', function: { name: 'read_file', arguments: 'not json' } }] },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'A' }, { role: 'tool', tool_call_id: 'toolu_2', content: '' }, { role: 'user', content: 'and then?' }],
  tools: [tool], tool_choice: 'auto' }, definition, 'scope', false);
  expect(body).toMatchObject({ model: MODEL, max_tokens: 64, stream: false, system: 'sys A\n\nsys B', tool_choice: { type: 'auto' } });
  expect(body.messages).toEqual([{ role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } },
      { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'A' }, { type: 'tool_result', tool_use_id: 'toolu_2' }, { type: 'text', text: 'and then?' }] }]);
  expect(body.tools).toEqual([{ name: 'read_file', description: 'read', input_schema: tool.function.parameters }]);
  expect('thinking' in body || 'cache_control' in body).toBe(false);
  const configured = parseAnthropicMessagesDefinition(profile('https://api.anthropic.com/v1/messages', { thinking: { mode: 'adaptive', display: 'summarized', off: 'between_tools' }, cache: '1h' }).adapter.definition);
  const plain = { model: MODEL, max_completion_tokens: 64, messages: [{ role: 'user' as const, content: 'x' }] };
  expect(anthropicMessagesBody(plain, configured, 'scope')).toMatchObject({ thinking: { type: 'adaptive', display: 'summarized' }, cache_control: { type: 'ephemeral', ttl: '1h' } });
  expect(anthropicMessagesBody({ ...plain, chat_template_kwargs: { enable_thinking: false } }, configured, 'scope')).toMatchObject({ thinking: { type: 'between_tools' } });
  // Reasoning off without a profile-declared off mode, forced tool use, prefill and a stray system message are refused before any call.
  expect(() => anthropicMessagesBody({ ...plain, chat_template_kwargs: { enable_thinking: false } }, definition, 'scope')).toThrow();
  expect(() => anthropicMessagesBody({ ...plain, tools: [tool], tool_choice: 'required' }, definition, 'scope')).toThrow();
  expect(() => anthropicMessagesBody({ ...plain, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'prefill' }] }, definition, 'scope')).toThrow();
  expect(() => anthropicMessagesBody({ ...plain, messages: [{ role: 'user', content: 'x' }, { role: 'system', content: 'late' }] }, definition, 'scope')).toThrow();
});

it('maps a compacted history (summary as the first user message, kept tail after it) without breaking alternation', () => {
  const definition = parseAnthropicMessagesDefinition(profile('https://api.anthropic.com/v1/messages').adapter.definition);
  const call = { id: 'toolu_9', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"x"}' } };
  // The loop's shape after compaction: system, one user summary, then a tail that may start with a user or an assistant message.
  for (const tail of [[{ role: 'user' as const, content: 'question' }], [{ role: 'assistant' as const, content: 'answer' }, { role: 'user' as const, content: 'next' }],
    [{ role: 'assistant' as const, content: null, tool_calls: [call] }, { role: 'tool' as const, tool_call_id: 'toolu_9', content: 'body' }]]) {
    const body = anthropicMessagesBody({ model: MODEL, max_completion_tokens: 64, tools: [tool], messages: [{ role: 'system', content: 'sys' },
      { role: 'user', content: '[Deckent context summary: replaces 4 earlier messages ...]' }, ...tail] }, definition, 'scope', true);
    expect(body.system).toBe('sys'); expect(body.messages[0]!.role).toBe('user'); expect(body.messages.at(-1)!.role).toBe('user');
    expect(body.messages.every((message, index, all) => index === 0 || message.role !== all[index - 1]!.role)).toBe(true);
  }
});

it('sends the key only in x-api-key with the pinned version, streams text and summarized thinking, and assembles bounded evidence', async () => {
  let headers: IncomingMessage['headers'] = {}, sent = '';
  const wire = startEvent({ input_tokens: 25, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 } })
    + sse('ping') + blockStart(0, { type: 'thinking', thinking: '' }) + blockDelta(0, { type: 'thinking_delta', thinking: 'let me ' }) + blockDelta(0, { type: 'thinking_delta', thinking: 'think' })
    + blockDelta(0, { type: 'signature_delta', signature: 'SIG' }) + blockStop(0)
    + blockStart(1, { type: 'text', text: '' }) + blockDelta(1, { type: 'text_delta', text: 'Hel' }) + blockDelta(1, { type: 'text_delta', text: 'lo' }) + blockStop(1)
    + endEvents('end_turn', { output_tokens: 15, output_tokens_details: { thinking_tokens: 6 } });
  const endpoint = await fixture((req, res, body) => { headers = req.headers; sent = body; okSse(wire)(req, res); });
  const { result, deltas, prepared } = await run(endpoint);
  expect(JSON.stringify(prepared)).not.toContain(SECRET);
  expect(headers['x-api-key']).toBe(SECRET); expect(headers['anthropic-version']).toBe('2023-06-01');
  expect(headers.authorization).toBeUndefined(); expect(headers.accept).toBe('text/event-stream');
  expect(JSON.parse(sent)).toEqual({ model: MODEL, max_tokens: 64, stream: true, system: 'be brief', messages: [{ role: 'user', content: 'hi' }] });
  expect(deltas).toEqual([{ kind: 'reasoning', text: 'let me ' }, { kind: 'reasoning', text: 'think' }, { kind: 'text', text: 'Hel' }, { kind: 'text', text: 'lo' }]);
  if ('kind' in result) throw new Error('rejected');
  const native = result.native as { choices: { finish_reason: string; message: Record<string, unknown> }[]; deckent_message: Record<string, unknown> };
  expect(native.choices[0]).toMatchObject({ finish_reason: 'stop', message: { role: 'assistant', content: 'Hello', reasoning: 'let me think' } });
  expect(result.usage).toMatchObject({ prompt_tokens: 135, completion_tokens: 15, total_tokens: 150, completion_tokens_details: { reasoning_tokens: 6 },
    anthropic: { input_tokens: 25, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 } } });
  expect(native.deckent_message).toMatchObject({ stopReason: 'end_turn', stream: { events: expect.any(Number), wireSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(JSON.stringify(result)).not.toContain('SIG');
});

it('assembles a tool turn from input_json_delta and replays the received thinking blocks verbatim inside the same turn', async () => {
  const calls: string[] = [];
  const first = startEvent() + blockStart(0, { type: 'thinking', thinking: '' }) + blockDelta(0, { type: 'thinking_delta', thinking: '' }) + blockDelta(0, { type: 'signature_delta', signature: 'SIG-A' }) + blockStop(0)
    + blockStart(1, { type: 'text', text: '' }) + blockDelta(1, { type: 'text_delta', text: 'Reading.' }) + blockStop(1)
    + blockStart(2, { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: {} }) + blockDelta(2, { type: 'input_json_delta', partial_json: '' })
    + blockDelta(2, { type: 'input_json_delta', partial_json: '{"path":' }) + blockDelta(2, { type: 'input_json_delta', partial_json: '"a.ts"}' }) + blockStop(2) + endEvents('tool_use');
  const endpoint = await fixture((req, res, body) => { calls.push(body); okSse(calls.length === 1 ? first : textStream('done'))(req, res); });
  const request = streamed({ tools: [tool], tool_choice: 'auto' });
  const { result } = await run(endpoint, request);
  if ('kind' in result) throw new Error('rejected');
  const message = (result.native as { choices: { finish_reason: string; message: { content: string; tool_calls: unknown[] } }[] }).choices[0]!;
  expect(message.finish_reason).toBe('tool_calls');
  expect(message.message.tool_calls).toEqual([{ id: 'toolu_01', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]);
  const followUp = (args: string, earlier = 'hi') => streamed({ tools: [tool], tool_choice: 'auto', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: earlier },
    { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'toolu_01', type: 'function', function: { name: 'read_file', arguments: args } }] },
    { role: 'tool', tool_call_id: 'toolu_01', content: 'file body' }] });
  await run(endpoint, followUp('{"path":"a.ts"}'));
  expect(JSON.parse(calls[1]!).messages[1]).toEqual({ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'SIG-A' }, { type: 'text', text: 'Reading.' },
    { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'a.ts' } }] });
  expect(JSON.parse(calls[1]!).messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'file body' }] });
  // History edited since the block was issued: it is never replayed against different content.
  await run(endpoint, followUp('{"path":"b.ts"}'));
  expect(JSON.stringify(JSON.parse(calls[2]!).messages[1])).not.toContain('SIG-A');
  // Nor when the history before it changed (a compaction, an edit): the API binds a replayed block to its prefix.
  await run(endpoint, followUp('{"path":"a.ts"}', 'hi, but rewritten by a compaction'));
  expect(JSON.stringify(JSON.parse(calls[3]!).messages[1])).not.toContain('SIG-A');
  expect(JSON.parse(calls[3]!).messages[1].content).toEqual([{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'a.ts' } }]);
});

it('rejects protocol defects without trusting usage: mid-stream error, missing stop, mismatch, bad order, tool defects', async () => {
  const cases: [string, string, string][] = [
    ['overloaded error after 200', startEvent() + blockStart(0, { type: 'text', text: '' }) + blockDelta(0, { type: 'text_delta', text: 'x' }) + sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }), 'interrupted'],
    ['a complete ending after a provider error event is not trusted', startEvent() + blockStart(0, { type: 'text', text: '' }) + blockStop(0)
      + sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }) + endEvents(), 'interrupted'],
    ['stream ends without message_stop', startEvent() + blockStart(0, { type: 'text', text: '' }) + blockStop(0) + sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }), 'interrupted'],
    ['alias id echoed differently', startEvent(undefined, 'claude-haiku-4-5-20251001'), 'model-mismatch'],
    ['delta before block start', startEvent() + blockDelta(0, { type: 'text_delta', text: 'x' }), 'invalid-response'],
    ['block index gap', startEvent() + blockStart(1, { type: 'text', text: '' }), 'invalid-response'],
    ['delta kind not matching block', startEvent() + blockStart(0, { type: 'text', text: '' }) + blockDelta(0, { type: 'thinking_delta', thinking: 'x' }), 'invalid-response'],
    ['server tool block', startEvent() + blockStart(0, { type: 'server_tool_use', id: 's', name: 'web_search', input: {} }), 'invalid-response'],
    ['undeclared tool', startEvent() + blockStart(0, { type: 'tool_use', id: 't', name: 'rm_rf', input: {} }), 'invalid-response'],
    ['event line disagrees with payload type', startEvent() + 'event: ping\ndata: {"type":"message_stop"}\n\n', 'invalid-response'],
    ['malformed tool input', startEvent() + blockStart(0, { type: 'tool_use', id: 't', name: 'read_file', input: {} }) + blockDelta(0, { type: 'input_json_delta', partial_json: '{"path"' }) + blockStop(0) + endEvents('tool_use'), 'invalid-response'],
    ['tool_use stop reason without a tool block', textStream().replace('end_turn', 'tool_use'), 'invalid-response'],
    ['pause_turn is not accepted', textStream().replace('end_turn', 'pause_turn'), 'invalid-response'],
    ['output beyond the requested budget', startEvent() + blockStart(0, { type: 'text', text: '' }) + blockStop(0) + endEvents('end_turn', { output_tokens: 999 }), 'invalid-response'],
    ['unknown event type', startEvent() + sse('mystery'), 'invalid-response'],
    // Astra 2462 R1: a complete stream whose final delta lacks its own output count never assembles message_start's output_tokens=1.
    ['final message_delta with empty usage', startEvent() + blockStart(0, { type: 'text', text: '' }) + blockStop(0) + endEvents('end_turn', {}), 'invalid-response'],
    ['final message_delta without output_tokens', startEvent() + blockStart(0, { type: 'text', text: '' }) + blockStop(0) + endEvents('end_turn', { input_tokens: 25 }), 'invalid-response'],
  ];
  for (const [label, wire, reason] of cases) {
    const endpoint = await fixture(okSse(wire));
    const { result } = await run(endpoint, streamed({ tools: [tool], tool_choice: 'auto' })).catch((error: unknown) => { throw new Error(`${label}: ${String(error)}`); });
    expect({ label, kind: 'kind' in result ? result.kind : 'responded', reason: 'kind' in result ? result.evidence.reason : null }).toEqual({ label, kind: 'rejected', reason });
  }
});

it('presents the valid text that precedes the first invalid event even when both arrive in one read (no dependence on TCP segmentation)', async () => {
  const wire = startEvent() + blockStart(0, { type: 'text', text: '' }) + blockDelta(0, { type: 'text_delta', text: 'ok' }) + sse('mystery');
  const { result, deltas } = await run(await fixture(okSse(wire)));
  expect(result).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response' } });
  expect(deltas).toEqual([{ kind: 'text', text: 'ok' }]);
});

it('maps HTTP failures to a bodiless rejection, and a credential echo, timeout and cancellation to typed errors', async () => {
  const denied = await fixture((_req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' }, request_id: 'req_1' })); });
  const rejected = (await run(denied)).result;
  expect(rejected).toMatchObject({ kind: 'rejected', evidence: { reason: 'http-status', httpStatus: 429 } });
  const echo = await fixture(okSse(textStream(`my key is ${SECRET}`)));
  await expect(run(echo)).rejects.toMatchObject({ code: 'OPENAI_CHAT_CREDENTIAL_ECHO' });
  const split = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(startEvent() + blockStart(0, { type: 'text', text: '' }) + blockDelta(0, { type: 'text_delta', text: SECRET.slice(0, 12) })); setTimeout(() => res.end(blockDelta(0, { type: 'text_delta', text: SECRET.slice(12) })), 20); });
  const seen: ModelInvocationDelta[] = [];
  const priced = createAnthropicMessagesPricedNative({ resolveCredential: credential });
  const token = await priced.native.prepare(profile(split), binding(), streamed());
  await expect(priced.native.send(token, undefined, delta => seen.push(delta))).rejects.toMatchObject({ code: 'OPENAI_CHAT_CREDENTIAL_ECHO' });
  expect(seen.map(delta => delta.text).join('')).not.toContain(SECRET.slice(0, 12));
  const silent = await fixture(() => undefined);
  const controller = new AbortController(); setTimeout(() => controller.abort(), 50);
  await expect(run(silent, streamed(), { signal: controller.signal })).rejects.toMatchObject({ code: 'OPENAI_CHAT_CANCELLED' });
  const noKey = createAnthropicMessagesPricedNative({ async resolveCredential() { return undefined; } });
  const unresolved = await noKey.native.prepare(profile(silent), binding(), streamed());
  await expect(noKey.native.send(unresolved)).rejects.toMatchObject({ code: 'OPENAI_CHAT_CREDENTIAL_UNAVAILABLE' });
});

it('parses a non-streamed message (compaction path) with the same checks', async () => {
  const message = { id: 'msg_2', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'summary' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 4, output_tokens: 3 } };
  let body = '';
  const endpoint = await fixture((_req, res, text) => { body = text; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); });
  const request = { model: MODEL, messages: [{ role: 'user' as const, content: 'summarise' }], max_completion_tokens: 32 };
  const { result } = await run(endpoint, request);
  expect(JSON.parse(body)).toMatchObject({ stream: false, max_tokens: 32 });
  expect(result).toMatchObject({ native: { choices: [{ finish_reason: 'stop', message: { content: 'summary' } }] }, usage: { prompt_tokens: 14, completion_tokens: 3 } });
  const wrongModel = await fixture((_req, res) => { res.writeHead(200); res.end(JSON.stringify({ ...message, model: 'claude-haiku-4-5-20251001' })); });
  expect((await run(wrongModel, request)).result).toMatchObject({ kind: 'rejected', evidence: { reason: 'model-mismatch' } });
});

it('binds the pinned model, the catalog and the tariff row together and refuses capabilities the catalog does not declare', async () => {
  const endpoint = 'https://127.0.0.1:9/v1/messages', priced = createAnthropicMessagesPricedNative({ resolveCredential: credential });
  await expect(priced.native.prepare(profile(endpoint), binding('claude-haiku-4-5'), streamed({ model: 'claude-haiku-4-5' }))).rejects.toMatchObject({ code: 'OPENAI_CHAT_MODEL_MISMATCH' });
  await expect(priced.native.prepare(profile(endpoint, {}, limits, anthropicPublishedTariff('claude-opus-5-5')), binding(), streamed())).rejects.toMatchObject({ code: 'OPENAI_CHAT_MODEL_MISMATCH' });
  await expect(priced.native.prepare(profile(endpoint), binding(MODEL, []), streamed({ tools: [tool] }))).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' });
  await expect(priced.native.prepare(profile(endpoint, { thinking: { mode: 'model-default', off: 'between_tools' } }), binding(MODEL, []), streamed({ chat_template_kwargs: { enable_thinking: false } }))).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' });
  await expect(priced.native.prepare(profile(endpoint), binding(), streamed({ messages: [{ role: 'user', content: 'x'.repeat(70_000) }] }))).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_TOO_LARGE' });
});

it('accepts only https canonical endpoints, one x-api-key credential reference, same-origin counter and safe thinking budgets', () => {
  const definition = (over: Record<string, unknown>) => () => parseAnthropicMessagesDefinition({ ...profile('https://api.anthropic.com/v1/messages').adapter.definition, ...over });
  expect(definition({})()).toMatchObject({ endpoint: 'https://api.anthropic.com/v1/messages' });
  for (const endpoint of ['http://127.0.0.1:1/v1/messages', 'https://api.anthropic.com/v1/messages?x=1', 'https://user:pw@api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages#f']) {
    expect(definition({ endpoint }), endpoint).toThrow();
  }
  expect(definition({ authentication: { type: 'bearer', credentialRef: 'ANTHROPIC_API_KEY' } })).toThrow();
  expect(definition({ authentication: { type: 'header', name: 'x-api-key', credentialRef: 'sk-ant-literal-key' } })).toThrow();
  expect(definition({ tokenCountEndpoint: 'https://other.example/v1/messages/count_tokens' })).toThrow();
  expect(definition({ tokenCountEndpoint: 'https://api.anthropic.com/v1/messages/count_tokens' })()).toBeTruthy();
  expect(definition({ thinking: { mode: 'enabled', budgetTokens: 1024 }, maxOutputTokens: 1024 })).toThrow();
  expect(definition({ thinking: { mode: 'enabled', budgetTokens: 512 } })).toThrow();
  expect(definition({ cache: 'forever' })).toThrow();
});

it('counts tokens through the same-origin counter for a declared model, without generation controls', async () => {
  let counted = '', path = '';
  const endpoint = await fixture((req, res, body) => { path = req.url ?? ''; counted = body; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 321 })); });
  const priced = createAnthropicMessagesPricedNative({ resolveCredential: credential });
  const extra = { tokenCountEndpoint: endpoint.replace('/v1/messages', '/v1/messages/count_tokens'), cache: '5m' };
  const token = await priced.native.prepare(profile(endpoint, extra), binding(), streamed({ tools: [tool], tool_choice: 'auto' }));
  await expect(priced.native.measure!(token)).resolves.toEqual({ promptTokens: 321, windowTokens: null });
  expect(path).toBe('/v1/messages/count_tokens');
  const body = JSON.parse(counted) as Record<string, unknown>;
  expect(body).toMatchObject({ model: MODEL, system: 'be brief', tools: [{ name: 'read_file' }] });
  expect(['max_tokens', 'stream', 'cache_control'].filter(key => key in body)).toEqual([]);
  const undeclared = await priced.native.prepare(profile(endpoint, extra), binding(MODEL, ['tool-calls']), streamed());
  await expect(priced.native.measure!(undeclared)).resolves.toBeNull();
});

it.each(['counted', 'http-error', 'malformed', 'aborted'] as const)('pins a %s input reservation with a safe fallback and sends the requested output bound', async mode => {
  let counters = 0, generated = '';
  const endpoint = await fixture((req, res, body) => {
    if (req.url?.endsWith('/count_tokens')) {
      counters++;
      if (mode === 'aborted') return;
      res.writeHead(mode === 'http-error' ? 503 : 200, { 'content-type': 'application/json' });
      res.end(mode === 'malformed' ? '{invalid' : JSON.stringify({ input_tokens: 5000 })); return;
    }
    generated = body; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(textStream());
  });
  const priced = createAnthropicMessagesPricedNative({ resolveCredential: credential });
  const stored = profile(endpoint, { maxOutputTokens: 128000, tokenCountEndpoint: endpoint.replace('/v1/messages', '/v1/messages/count_tokens') });
  const request = streamed({ max_completion_tokens: 16384, messages: [{ role: 'user', content: 'x'.repeat(20000) }] });
  const controller = new AbortController(), timer = mode === 'aborted' ? setTimeout(() => controller.abort(), 50) : null;
  const token = await priced.native.prepare(stored, binding(), request, controller.signal);
  if (timer) clearTimeout(timer);
  const command = { schemaVersion: 1 as const, commandId: 'counted-command', scopeId: 'scope', reference, catalogRevision: 'catalog',
    expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'a'.repeat(64) }, nativeRequest: request };
  const input = { command, requestDigest: modelInvocationRequestDigest(command), profile: stored, profileDigest: modelInvocationProfileDigest(stored), definition: binding(), prepared: token };
  const quote = priced.quote(input as never);
  expect(priced.quote(input as never)).toEqual(quote); expect(counters).toBe(1);
  const calculation = (quote.meter.evidence as { calculation: { inputBound: string; inputBoundTokens: number; outputBoundTokens: number } }).calculation;
  expect(calculation.outputBoundTokens).toBe(16384);
  if (mode === 'counted') {
    expect(calculation).toMatchObject({ inputBound: 'provider-count-plus-safety', inputBoundTokens: 8298 });
    expect(calculation.inputBoundTokens).toBeGreaterThan(5000);
    expect(quote.maxChargeMinorUnits).toBeLessThan(anthropicMaxChargeMinorUnits(anthropicPublishedTariff(MODEL)!, 'none', 20000, 16384));
  } else {
    expect(calculation.inputBound).toBe('body-bytes-as-tokens-plus-overhead'); expect(calculation.inputBoundTokens).toBeGreaterThan(20000);
  }
  if (mode !== 'aborted') {
    await priced.native.send(token);
    expect(JSON.parse(generated)).toMatchObject({ max_tokens: 16384 });
    expect(JSON.stringify(quote)).not.toContain(SECRET);
  }
});

it('quotes the exact worst case from the profile tariff and refuses a quote for a request that is not the prepared one', async () => {
  // 1000 body bytes + 2048 overhead at $2/MTok plus 64 output tokens at $10/MTok, ceil to cents once: 0.006096 + 0.00064 USD -> 1 cent.
  expect(anthropicMaxChargeMinorUnits(anthropicPublishedTariff(MODEL)!, 'none', 1000, 64)).toBe(1);
  // Opus 5.5, 1M prompt bytes, 128k output, 1h cache write ($8): 1_002_048 x 8 + 128_000 x 20 = $10.576384 -> 1058 cents.
  expect(anthropicMaxChargeMinorUnits(anthropicPublishedTariff('claude-opus-5-5')!, '1h', 1_000_000, 128_000)).toBe(1058);
  // The dearest input class governs: Fable 5.1 writes at $20 with the 1h cache, not the $10 input rate.
  expect(anthropicMaxChargeMinorUnits(anthropicPublishedTariff('claude-fable-5-1')!, '1h', 1_000_000, 0)).toBe(Math.ceil((1_002_048 * 20) / 10_000));
  expect(ANTHROPIC_PUBLISHED_TARIFFS.map(row => row.modelId)).toEqual(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5-20251001']);

  const priced = createAnthropicMessagesPricedNative({ resolveCredential: credential }), endpoint = 'https://127.0.0.1:9/v1/messages';
  const stored = profile(endpoint, { cache: '5m' }), request = streamed();
  const command = { schemaVersion: 1 as const, commandId: 'command', scopeId: 'scope', reference, catalogRevision: 'catalog',
    expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'a'.repeat(64) }, nativeRequest: request };
  const spending = { command, requestDigest: modelInvocationRequestDigest(command), profile: stored, profileDigest: modelInvocationProfileDigest(stored), definition: binding() };
  const token = await priced.native.prepare(stored, binding(), request);
  const quote = priced.quote({ ...spending, prepared: token } as never);
  expect(quote).toMatchObject({ scopeId: 'scope', currency: 'USD', pricing: { id: 'anthropic-published-tariff', version: 1, definition: { modelId: MODEL } },
    meter: { id: 'anthropic-messages-reservation', evidence: { calculation: { cache: '5m', outputBoundTokens: 64 } } } });
  expect(quote.maxChargeMinorUnits).toBeGreaterThan(0);
  // A flat tariff keeps the v1 evidence shape: no prompt-length tier field (HAIKU55-CATALOG).
  expect('promptTier' in (quote.meter.evidence as { calculation: object }).calculation).toBe(false);
  expect(priced.quote({ ...spending, prepared: token } as never)).toEqual(quote);
  expect(() => priced.quote({ ...spending, requestDigest: 'b'.repeat(64), prepared: token } as never)).toThrow();
  expect(() => priced.quote({ ...spending, prepared: {} } as never)).toThrow();
  expect(() => quoteAnthropicPublishedTariff({ ...spending, prepared: token } as never, { body: '{}', request: { model: 'other', max_completion_tokens: 64 }, scopeId: 'scope', definition: {}, limits: {} })).toThrow();
  // A prepared token of a sibling profile (same scope and model, other endpoint or cache choice) can never back this profile's quote.
  const sibling = await priced.native.prepare(profile(endpoint, { cache: '1h' }), binding(), request);
  expect(() => priced.quote({ ...spending, prepared: sibling } as never)).toThrow();
  expect(priced.native.responseBytesUpperBound!(token)).toBeGreaterThan(BigInt(limits.responseMaxBytes));
});

// Astra 2459 R1: the `message_start` usage (output_tokens=1) is interim and never a settlement basis; only the cumulative final
// `message_delta` usage backs a measurement of a cut stream. Partial counts stay in the evidence body, never in the money path.
it.each([
  ['before the final message_delta: interim message_start usage is never measured', '', null],
  ['after the final message_delta: its cumulative usage is measured', blockStop(0) + sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }), 7],
  // Astra 2462 R1: the final delta must carry its own output count; message_start's output_tokens=1 is never inherited as final.
  ['after a final message_delta with empty usage: nothing is measured', blockStop(0) + sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: {} }), null],
  ['after a final message_delta without output_tokens: nothing is measured', blockStop(0) + sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 25 } }), null],
] as const)('an interrupted stream cut %s', async (_name, tail, output) => {
  const endpoint = await fixture(okSse(startEvent() + blockStart(0, { type: 'text', text: '' }) + blockDelta(0, { type: 'text_delta', text: 'par' })
    + blockDelta(0, { type: 'text_delta', text: 'tial' }) + tail));
  const priced = createAnthropicMessagesPricedNative({ resolveCredential: credential }), stored = profile(endpoint), request = streamed();
  const prepared = await priced.native.prepare(stored, binding(), request);
  const command = { schemaVersion: 1 as const, commandId: 'cancel-usage', scopeId: 'scope', reference, catalogRevision: 'catalog',
    expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: stored.bindingDigest }, nativeRequest: request };
  const quote = priced.quote({ command, requestDigest: modelInvocationRequestDigest(command), profile: stored,
    profileDigest: modelInvocationProfileDigest(stored), definition: binding(), prepared } as never);
  const result = await priced.native.send(prepared);
  expect(result).toMatchObject({ kind: 'rejected', evidence: { reason: 'interrupted', body: { complete: false } } });
  if (!('kind' in result)) throw new Error('expected interrupted stream');
  const measured = priced.native.observePartialSpending!(prepared, result.evidence.body.digest);
  if (output === null) { expect(measured).toBeNull(); return; }
  expect(measured).toMatchObject({ basis: 'measured-tariff', source: { tariffDigest: quote.pricing.digest,
    dimensions: [{ field: 'input', tokens: 25 }, { field: 'cache-read', tokens: 0 }, { field: 'cache-write-5m', tokens: 0 },
      { field: 'cache-write-1h', tokens: 0 }, { field: 'output', tokens: output }] } });
  expect(JSON.stringify(measured)).not.toContain(SECRET);
  expect(priced.native.observePartialSpending!({}, result.evidence.body.digest)).toBeNull();
});
