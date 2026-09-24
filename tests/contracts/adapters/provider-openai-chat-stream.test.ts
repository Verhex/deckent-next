import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createOpenAiChatNativePort, OPENAI_CHAT_STREAM_TOKEN_WIRE_BYTES, OPENAI_CHAT_STREAM_WIRE_FACTOR } from '#adapters/core/provider-openai-chat/index.js';
import type { ModelInvocationDelta } from '#domain/index.js';
import { createLocalTls } from '../../fixtures/local-tls.js';

const servers: (Server | HttpsServer)[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
const vllmFixture = new URL('../../fixtures/vllm-chat-stream.sse', import.meta.url);
const VLLM_MODEL = 'Qwen3.8-27B-INT4-W4A16';
const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
const limits = { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 5000 };
const streamed = (model = 'configured-model', max = 48) => ({ model, messages: [{ role: 'user' as const, content: 'hi' }],
  max_completion_tokens: max, stream: true, stream_options: { include_usage: true } });
const binding = (model = 'configured-model') => ({ encodingVersion: 1, provider: { id: 'provider', version: 1 }, model: { id: 'model', version: 1,
  nativeId: model, protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] } });
function profile(endpoint: string, profileLimits = limits, extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope', reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 },
    bindingDigest: 'a'.repeat(64), protocol: { family: 'openai-chat-completions', version: 'v1' },
    adapter: { id: 'openai-chat-http', version: 4, definition: { endpoint, maxOutputTokens: 64, authentication: { type: 'none' }, tariff, ...extra } },
    allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 }, limits: profileLimits };
}
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  return `http://127.0.0.1:${address.port}/`;
}
const chunk = (delta: Record<string, unknown>, finish: string | null = null, model = 'configured-model') =>
  `data: ${JSON.stringify({ id: 'chatcmpl-s', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] })}\n\n`;
const usage = (completion = 3, model = 'configured-model') => `data: ${JSON.stringify({ id: 'chatcmpl-s', object: 'chat.completion.chunk', created: 1, model,
  choices: [], usage: { prompt_tokens: 5, completion_tokens: completion, total_tokens: 5 + completion } })}\n\n`;
const DONE = 'data: [DONE]\n\n';
async function send(endpoint: string, request = streamed(), profileLimits = limits, signal?: AbortSignal, model = 'configured-model') {
  const port = createOpenAiChatNativePort(), deltas: ModelInvocationDelta[] = [];
  const prepared = await port.prepare(profile(endpoint, profileLimits), binding(model), request);
  const result = await port.send(prepared, signal, delta => deltas.push(delta));
  return { result, deltas };
}
/** Writes each part as its own TCP write, with a small gap so the client really observes separate chunks. */
function drip(parts: readonly string[], gapMs = 5, end = true) {
  return (req: IncomingMessage, res: ServerResponse) => {
    req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' });
    let index = 0;
    const next = () => {
      if (res.destroyed) return;
      if (index < parts.length) { res.write(parts[index++]); setTimeout(next, gapMs); } else if (end) res.end();
    };
    next();
  };
}

it('parses a real vLLM reasoning stream split at arbitrary byte boundaries and assembles bounded native evidence', async () => {
  const wire = await readFile(vllmFixture);
  let body = '', accept: string | undefined;
  const pieces: string[] = [];
  for (let offset = 0; offset < wire.byteLength; offset += 97) pieces.push(wire.subarray(offset, offset + 97).toString('latin1'));
  const endpoint = await fixture((req, res) => {
    accept = req.headers.accept; const chunks: Buffer[] = [];
    req.on('data', (part: Buffer) => chunks.push(part));
    req.on('end', () => {
      body = Buffer.concat(chunks).toString('utf8'); res.writeHead(200, { 'content-type': 'text/event-stream' });
      let index = 0; const next = () => { if (index < pieces.length) { res.write(Buffer.from(pieces[index++]!, 'latin1')); setImmediate(next); } else res.end(); };
      next();
    });
  });
  const { result, deltas } = await send(endpoint, streamed(VLLM_MODEL, 48), { ...limits, responseMaxBytes: 8192 }, undefined, VLLM_MODEL);
  expect(accept).toBe('text/event-stream');
  expect(JSON.parse(body)).toEqual({ ...streamed(VLLM_MODEL, 48), stream: true, stream_options: { include_usage: true } });
  expect(deltas.length).toBeGreaterThan(10);
  expect(deltas.every(delta => delta.kind === 'reasoning')).toBe(true);
  const reasoning = deltas.map(delta => delta.text).join('');
  expect(reasoning.startsWith('The user wants me to say')).toBe(true);
  expect(result).toMatchObject({ schemaVersion: 1, native: { id: 'chatcmpl-fixture', object: 'chat.completion', model: VLLM_MODEL,
    system_fingerprint: 'vllm-0.30.0-01974291',
    choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: null, reasoning } }],
    usage: { prompt_tokens: 58, completion_tokens: 48, total_tokens: 106, completion_tokens_details: { reasoning_tokens: 48 } },
    deckent_stream: { schemaVersion: 1, chunks: 50, wireBytes: wire.byteLength, wireSha256: createHash('sha256').update(wire).digest('hex') } },
  usage: { completion_tokens: 48 } });
  // The retained evidence cap (8 KiB) is smaller than the wire (11 KiB); only the assembled result is bounded by it.
  expect(wire.byteLength).toBeGreaterThan(8192);
  expect(Buffer.byteLength(JSON.stringify((result as { native: unknown }).native))).toBeLessThanOrEqual(8192);
});

it('streams content and reasoning_content deltas in wire order across CRLF framing, comments and ignored fields', async () => {
  const parts = [': keep-alive\r\n\r\n', 'event: message\r\nid: 1\r\n', chunk({ role: 'assistant', content: '' }).replace(/\n/g, '\r\n'),
    chunk({ reasoning_content: 'think' }), chunk({ content: 'Mer' }), chunk({ content: 'haba' }), chunk({}, 'stop'), usage(3), DONE];
  const endpoint = await fixture(drip(parts));
  const { result, deltas } = await send(endpoint);
  expect(deltas).toEqual([{ kind: 'reasoning', text: 'think' }, { kind: 'text', text: 'Mer' }, { kind: 'text', text: 'haba' }]);
  expect(result).toMatchObject({ native: { choices: [{ finish_reason: 'stop', message: { content: 'Merhaba', reasoning: 'think' } }] },
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
});

it('rejects malformed chunks, tool calls and model changes at the first invalid chunk with its own reason and presents nothing after it', async () => {
  const malformedParts = [chunk({ content: 'ok' }), 'data: {not json\n\n', chunk({ content: 'hidden' }), chunk({}, 'stop'), usage(), DONE];
  const malformed = await send(await fixture(drip(malformedParts)));
  expect(malformed.deltas).toEqual([{ kind: 'text', text: 'ok' }]);
  // The read stops at the invalid chunk: every observed byte is retained (complete), and the rest of the stream is never read.
  expect(malformed.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response', httpStatus: 200, body: { complete: true } } });
  const evidence = Buffer.from((malformed.result as { evidence: { body: { data: string } } }).evidence.body.data, 'base64').toString();
  expect(evidence.startsWith(malformedParts[0]! + malformedParts[1]!)).toBe(true); expect(evidence).not.toContain('hidden');

  const tool = await send(await fixture(drip([chunk({ content: 'a' }), chunk({ tool_calls: [{ index: 0, id: 't', type: 'function', function: { name: 'x', arguments: '' } }] }),
    chunk({}, 'stop'), usage(), DONE])));
  expect(tool.deltas).toEqual([{ kind: 'text', text: 'a' }]);
  expect(tool.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response', body: { complete: true } } });
  const nullTools = await send(await fixture(drip([chunk({ content: 'a', tool_calls: null, function_call: null }), chunk({}, 'stop'), usage(), DONE])));
  expect(nullTools.result).toMatchObject({ native: { choices: [{ message: { content: 'a' } }] } });
  const toolFinish = await send(await fixture(drip([chunk({ content: 'a' }), chunk({}, 'tool_calls'), usage(), DONE])));
  expect(toolFinish.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response' } });

  const mismatch = await send(await fixture(drip([chunk({ content: 'a' }, null, 'other-model'), chunk({}, 'stop'), usage(), DONE])));
  expect(mismatch.deltas).toEqual([]);
  expect(mismatch.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'model-mismatch', body: { complete: true } } });
  const overBudget = await send(await fixture(drip([chunk({ content: 'a' }), chunk({}, 'stop'), usage(999), DONE])));
  expect(overBudget.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response' } });
  const afterDone = await send(await fixture(drip([chunk({ content: 'a' }), chunk({}, 'stop'), usage(), DONE, chunk({ content: 'late' })])));
  expect(afterDone.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response' } });
});

it('treats a stream that ends without [DONE], finish or usage as interrupted (uncertain), never as a response', async () => {
  for (const parts of [[chunk({ content: 'a' }), chunk({}, 'stop'), usage()], [chunk({ content: 'a' }), chunk({}, 'stop'), DONE],
    [chunk({ content: 'a' }), usage(), DONE], [chunk({ content: 'a' }), chunk({}, 'stop'), usage(), 'data: [DO']]) {
    const { result, deltas } = await send(await fixture(drip(parts)));
    expect(deltas).toEqual([{ kind: 'text', text: 'a' }]);
    expect(result).toMatchObject({ kind: 'rejected', evidence: { reason: 'interrupted', body: { complete: false } } });
  }
});

it('applies the total deadline to a slow drip and the wire bound to an endless stream', async () => {
  const endless = Array.from({ length: 1000 }, () => chunk({ content: 'x' }));
  const slow = await fixture(drip(endless, 100, false));
  const started = Date.now();
  const timed = await send(slow, streamed(), { ...limits, timeoutMs: 350 });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(timed.deltas.length).toBeGreaterThanOrEqual(2);
  expect(timed.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'interrupted', body: { complete: false } } });

  // The wire bound is the evidence multiple plus a per-token framing allowance for the request's completion budget.
  const wireBound = 1024 * OPENAI_CHAT_STREAM_WIRE_FACTOR + 48 * OPENAI_CHAT_STREAM_TOKEN_WIRE_BYTES;
  const comments = Array.from({ length: Math.ceil(wireBound / 204) + 20 }, () => `: ${'p'.repeat(200)}\n\n`);
  const noisy = await send(await fixture(drip(comments, 0)), streamed(), { ...limits, responseMaxBytes: 1024 });
  expect(wireBound).toBeLessThan(comments.length * 204);
  expect(noisy.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'response-limit', body: { complete: false, byteLength: 1024 } } });

  // Assembled text beyond responseMaxBytes stops the read before the wire bound.
  const long = await send(await fixture(drip(Array.from({ length: 12 }, () => chunk({ content: 'y'.repeat(100) })), 0)), streamed(),
    { ...limits, responseMaxBytes: 1024 });
  expect(long.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'response-limit', body: { complete: false } } });
});

it('aborts the provider request when the caller cancels mid-stream', async () => {
  let providerClosed = false;
  const endpoint = await fixture((req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(chunk({ content: 'first' }));
    const timer = setInterval(() => res.write(chunk({ content: '.' })), 20);
    res.on('close', () => { providerClosed = true; clearInterval(timer); });
  });
  const controller = new AbortController();
  const port = createOpenAiChatNativePort(), deltas: ModelInvocationDelta[] = [];
  const prepared = await port.prepare(profile(endpoint), binding(), streamed());
  const pending = port.send(prepared, controller.signal, delta => { deltas.push(delta); if (deltas.length === 3) controller.abort(); });
  const result = await pending;
  expect(result).toMatchObject({ kind: 'rejected', evidence: { reason: 'interrupted', body: { complete: false } } });
  await expect.poll(() => providerClosed).toBe(true);
  expect(deltas[0]).toEqual({ kind: 'text', text: 'first' });
});

it('keeps the non-streamed request exact and requires include_usage for a streamed request', async () => {
  const port = createOpenAiChatNativePort(), endpoint = 'http://127.0.0.1:9/';
  const plain = { model: 'configured-model', messages: [{ role: 'user' as const, content: 'hi' }], max_completion_tokens: 8 };
  await expect(port.prepare(profile(endpoint), binding(), { ...plain, stream: true })).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' });
  await expect(port.prepare(profile(endpoint), binding(), { ...plain, stream: false, stream_options: { include_usage: true } }))
    .rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' });
  await expect(port.prepare(profile(endpoint), binding(), { ...plain, stream: true, stream_options: { include_usage: false } }))
    .rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' });
  expect(await port.prepare(profile(endpoint), binding(), plain)).toMatchObject({ body: JSON.stringify({ ...plain, stream: false }) });
  expect(await port.prepare(profile(endpoint), binding(), streamed())).toMatchObject({ body: JSON.stringify(streamed()) });
});

it('never presents a streamed prefix of an echoed bearer credential and fails the call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deckent-openai-stream-'));
  try {
    const tls = await createLocalTls(directory), secret = 'sk-live-secret-42';
    const server = createHttpsServer({ key: tls.key, cert: tls.caPem }, drip([chunk({ content: 'the key is sk-li' }), chunk({ content: 've-sec' }),
      chunk({ content: 'ret-42 done' }), chunk({}, 'stop'), usage(), DONE]));
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
    const endpoint = `https://127.0.0.1:${address.port}/`;
    const port = createOpenAiChatNativePort({ async resolveCredential() { return secret; } }), deltas: ModelInvocationDelta[] = [];
    const prepared = await port.prepare(profile(endpoint, limits, { authentication: { type: 'bearer', credentialRef: 'TOKEN' }, tls: { caPem: tls.caPem } }),
      binding(), streamed());
    await expect(port.send(prepared, undefined, delta => deltas.push(delta))).rejects.toMatchObject({ code: 'OPENAI_CHAT_CREDENTIAL_ECHO' });
    const shown = deltas.map(delta => delta.text).join('');
    // Text that could still begin the credential is held back, so not even a prefix reaches the observer.
    expect(shown).toBe('');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('closes the provider connection at the first invalid chunk instead of draining the rest of the stream', async () => {
  let providerClosed = false, written = 0;
  const endpoint = await fixture((req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(chunk({ content: 'ok' }));
    res.write(chunk({ tool_calls: [{ index: 0, id: 't', type: 'function', function: { name: 'x', arguments: '' } }] }));
    // A provider that would keep generating: only the client closing the connection ends it.
    const timer = setInterval(() => { written++; res.write(chunk({ content: '.' })); }, 10);
    res.on('close', () => { providerClosed = true; clearInterval(timer); });
  });
  const started = Date.now();
  const { result, deltas } = await send(endpoint, streamed(), { ...limits, timeoutMs: 4000 });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(result).toMatchObject({ kind: 'rejected', evidence: { reason: 'invalid-response', body: { complete: true } } });
  expect(deltas).toEqual([{ kind: 'text', text: 'ok' }]);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(providerClosed).toBe(true); expect(written).toBeLessThan(20);
});

it('claims a stream\'s rejection cause only with complete evidence: within the cap it is kept, past the cap it is the limit', async () => {
  const mismatch = (padding: number) => [...Array.from({ length: padding }, () => `: ${'p'.repeat(200)}\n\n`),
    chunk({ content: 'a' }, null, 'other-model'), chunk({}, 'stop'), usage(), DONE];
  const within = await send(await fixture(drip(mismatch(2), 0)), streamed(), { ...limits, responseMaxBytes: 4096 });
  expect(within.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'model-mismatch', body: { complete: true } } });
  // Comments carry no text, so only the evidence cap is passed; the decisive chunk is then outside the retained bytes.
  const past = await send(await fixture(drip(mismatch(12), 0)), streamed(), { ...limits, responseMaxBytes: 1024 });
  expect(past.result).toMatchObject({ kind: 'rejected', evidence: { reason: 'response-limit', body: { complete: false, byteLength: 1024 } } });
});

it('accepts a long legitimate answer whose SSE framing exceeds the evidence multiple but fits its completion budget', async () => {
  const parts = Array.from({ length: 130 }, () => chunk({ content: 'x' }));
  const wire = parts.join('').length;
  expect(wire).toBeGreaterThan(1024 * OPENAI_CHAT_STREAM_WIRE_FACTOR);
  const port = createOpenAiChatNativePort();
  const endpoint = await fixture(drip([...parts, chunk({}, 'stop'), usage(130), DONE], 0));
  const prepared = await port.prepare(profile(endpoint, { ...limits, responseMaxBytes: 1024 }, { maxOutputTokens: 200 }), binding(), streamed('configured-model', 200));
  const result = await port.send(prepared);
  expect(result).toMatchObject({ native: { choices: [{ message: { content: 'x'.repeat(130) }, finish_reason: 'stop' }] } });
});
