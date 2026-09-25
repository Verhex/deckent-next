import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createOpenAiChatNativePort } from '#adapters/core/provider-openai-chat/index.js';
import type { ModelInvocationDelta } from '#domain/index.js';
import { openAiChatMessageFromInvocation } from '../../../src/composition/core/terminal-chat/index.js';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
const limits = { requestMaxBytes: 16_384, responseMaxBytes: 16_384, timeoutMs: 5000 };
const MODEL = 'configured-model';
const toolCapability = [{ id: 'tool-calls', version: 1, state: 'supported' }];
const binding = (capabilities: readonly unknown[] = toolCapability) => ({ encodingVersion: 1, provider: { id: 'provider', version: 1 }, model: { id: 'model', version: 1,
  nativeId: MODEL, protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities }] } });
const profile = (endpoint: string, timeoutMs = 5000) => ({ schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 },
  bindingDigest: 'a'.repeat(64), protocol: { family: 'openai-chat-completions', version: 'v1' },
  adapter: { id: 'openai-chat-http', version: 4, definition: { endpoint, maxOutputTokens: 64, authentication: { type: 'none' }, tariff } },
  allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 }, limits: { ...limits, timeoutMs } });
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'grep', parameters: { type: 'object', properties: {} } } }];
const request = (stream: boolean, extra: Record<string, unknown> = {}) => ({ model: MODEL, messages: [{ role: 'user', content: 'read a.ts' }], max_completion_tokens: 48,
  ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}), tools, tool_choice: 'auto', ...extra });

async function fixture(handler: (body: string, res: ServerResponse) => void) {
  const bodies: string[] = [];
  const server = createServer((req: IncomingMessage, res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { bodies.push(body); handler(body, res); }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  return { endpoint: `http://127.0.0.1:${address.port}/`, bodies };
}
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'chatcmpl-t', object: 'chat.completion.chunk', created: 1, model: MODEL,
  choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usage = `data: ${JSON.stringify({ id: 'chatcmpl-t', object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } })}\n\n`;
const DONE = 'data: [DONE]\n\n';
const sse = (parts: readonly string[], end = true) => (_body: string, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0; const next = () => { if (res.destroyed) return; if (i < parts.length) { res.write(parts[i++]); setTimeout(next, 3); } else if (end) res.end(); }; next();
};
async function send(endpoint: string, native: unknown, capabilities?: readonly unknown[], timeoutMs?: number) {
  const port = createOpenAiChatNativePort(), deltas: ModelInvocationDelta[] = [];
  const prepared = await port.prepare(profile(endpoint, timeoutMs), binding(capabilities), native);
  return { result: await port.send(prepared, undefined, delta => deltas.push(delta)), deltas };
}
const asInvocation = (result: unknown) => ({ receipt: { outcome: { state: 'responded' } }, response: result }) as never;

it('sends tools only to a model whose binding declares tool calling, and keeps the conversation shapes exact', async () => {
  const { endpoint } = await fixture((_b, res) => res.end());
  await expect(send(endpoint, request(false), [])).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' });
  await expect(send(endpoint, request(false), [{ id: 'tool-calls', version: 1, state: 'unknown' }])).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' });
  // Tool traffic without declared tools, a duplicate tool name, or tool_choice without tools are refused before any network use.
  const port = createOpenAiChatNativePort();
  for (const bad of [{ ...request(false), tools: undefined, tool_choice: undefined, messages: [{ role: 'tool', tool_call_id: 'c1', content: 'x' }] },
    { ...request(false), tools: [tools[0], tools[0]] }, { ...request(false), tools: undefined }]) {
    await expect(port.prepare(profile(endpoint), binding(), JSON.parse(JSON.stringify(bad)))).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' });
  }
  const conversation = request(false, { messages: [{ role: 'user', content: 'read a.ts' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '[deckent] read_file: mode=range …' }] });
  const server = await fixture((_b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: MODEL,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done', tool_calls: null, function_call: null } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); });
  await send(server.endpoint, conversation);
  expect(JSON.parse(server.bodies[0]!)).toMatchObject({ tools, tool_choice: 'auto', messages: conversation.messages });
});

it('accepts non-streamed calls to declared tools only, with unique ids and a matching finish reason', async () => {
  const reply = (message: Record<string, unknown>, finish = 'tool_calls') => (_b: string, res: ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: MODEL, choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: null, ...message } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); };
  const call = (name: string, id = 'c1', args = '{"path":"a.ts"}') => ({ id, type: 'function', function: { name, arguments: args } });
  const ok = await send((await fixture(reply({ tool_calls: [call('read_file'), call('grep', 'c2', 'not json')] }))).endpoint, request(false));
  expect(openAiChatMessageFromInvocation(asInvocation(ok.result))?.toolCalls).toEqual([{ id: 'c1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' },
    { id: 'c2', name: 'grep', argumentsJson: 'not json' }]);
  for (const bad of [reply({ tool_calls: [call('write_file')] }), reply({ tool_calls: [call('read_file'), call('grep', 'c1')] }), reply({ tool_calls: [call('read_file')] }, 'stop'),
    reply({ tool_calls: null }, 'tool_calls'), reply({ tool_calls: null, function_call: { name: 'read_file', arguments: '{}' } }, 'stop')]) {
    expect((await send((await fixture(bad)).endpoint, request(false))).result).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response' } });
  }
});

it('assembles streamed tool calls across chunks, presents no tool text, and never yields a call from a cut or invalid stream', async () => {
  const parts = [chunk({ role: 'assistant', content: 'Reading.' }), chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"pa' } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'c2', type: 'function', function: { name: 'grep', arguments: '{}' } }] }), chunk({}, 'tool_calls'), usage, DONE];
  const streamed = await send((await fixture(sse(parts))).endpoint, request(true));
  expect(streamed.deltas).toEqual([{ kind: 'text', text: 'Reading.' }]);
  expect(openAiChatMessageFromInvocation(asInvocation(streamed.result))).toMatchObject({ content: 'Reading.', finish: 'tool_calls',
    toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }, { id: 'c2', name: 'grep', argumentsJson: '{}' }] });
  // Cut in the middle of the arguments: interrupted (uncertain), no assembled call reaches the loop.
  const cut = await send((await fixture(sse(parts.slice(0, 3), false))).endpoint, { ...request(true) }, undefined, 400);
  expect(cut.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'interrupted' } });
  expect(openAiChatMessageFromInvocation(asInvocation(cut.result))).toBeNull();
  const invalid = [
    [chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] }), chunk({}, 'tool_calls'), usage, DONE],
    [chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'grep', arguments: '{}' } }] }), chunk({ tool_calls: [{ index: 0, id: 'c9', function: { arguments: '' } }] }), chunk({}, 'tool_calls'), usage, DONE],
    [chunk({ tool_calls: [{ index: 1, id: 'c1', function: { name: 'grep', arguments: '{}' } }] }), chunk({}, 'tool_calls'), usage, DONE],
    [chunk({ content: 'no tools' }), chunk({}, 'tool_calls'), usage, DONE],
    [chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'grep', arguments: '{}' } }] }), chunk({}, 'stop'), usage, DONE],
  ];
  for (const stream of invalid) {
    expect((await send((await fixture(sse(stream))).endpoint, request(true))).result, stream[0]).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response' } });
  }
  // Without declared tools a streamed tool call stays refused, exactly as before T-L2.
  const noTools = { ...request(true), tools: undefined, tool_choice: undefined };
  const refused = await send((await fixture(sse([parts[1]!, chunk({ content: 'after the call' }), chunk({}, 'tool_calls'), usage, DONE]))).endpoint, JSON.parse(JSON.stringify(noTools)), []);
  expect(refused.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response' } });
  // The undeclared call stops presentation at once: nothing after it reaches the screen.
  expect(refused.deltas).toEqual([]);
});

it('refuses calls under tool_choice none and stops a stream at the first undeclared tool name (Astra 2079)', async () => {
  const none = request(false, { tool_choice: 'none' });
  const reply = (_b: string, res: ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: MODEL, choices: [{ index: 0, finish_reason: 'tool_calls',
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); };
  expect((await send((await fixture(reply)).endpoint, none)).result).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response' } });
  const streamedNone = await send((await fixture(sse([chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{}' } }] }), chunk({}, 'tool_calls'), usage, DONE]))).endpoint,
    request(true, { tool_choice: 'none' }));
  expect(streamedNone.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response' } });
  const plain = await send((await fixture(sse([chunk({ content: 'just text' }), chunk({}, 'stop'), usage, DONE]))).endpoint, request(true, { tool_choice: 'none' }));
  expect(plain.result).toMatchObject({ native: { choices: [{ message: { content: 'just text' } }] } });
  // A declared prefix is still accepted while the name streams in; the first impossible prefix ends the read at once.
  let writesAfter = 0, providerClosed = false;
  const { endpoint } = await fixture((_b, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'rea', arguments: '' } }] }));
    res.write(chunk({ tool_calls: [{ index: 0, function: { name: 'd_x', arguments: '' } }] }));
    const timer = setInterval(() => { writesAfter++; res.write(chunk({ content: 'AFTER-INVALID' })); }, 10);
    res.on('close', () => { providerClosed = true; clearInterval(timer); });
  });
  const early = await send(endpoint, request(true), undefined, 4000);
  expect(early.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response' } });
  expect(early.deltas).toEqual([]);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(providerClosed).toBe(true); expect(writesAfter).toBeLessThan(20);
});
