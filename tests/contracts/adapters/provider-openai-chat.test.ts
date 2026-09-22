import http, { Agent, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { OPENAI_CHAT_COMPLETIONS_FAMILY, OPENAI_CHAT_COMPLETIONS_VERSION, OPENAI_CHAT_HTTP_ADAPTER_ID,
  OPENAI_CHAT_HTTP_ADAPTER_VERSION, OpenAiChatHttpError, createOpenAiChatNativePort, parseOpenAiChatHttpDefinition, prepareOpenAiChatHttpRequest } from '#adapters/core/provider-openai-chat/index.js';

const servers: Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map(close)));
const limits = { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 5000 };
const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
const request = { model: 'configured-model', messages: [{ role: 'user' as const, content: 'native text' }], max_completion_tokens: 12 };
const binding = { encodingVersion: 1, provider: { id: 'provider', version: 1 }, model: { id: 'model', version: 1,
  nativeId: 'configured-model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] } };

async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  return `http://127.0.0.1:${address.port}/`;
}
function profile(endpoint: string, profileLimits = limits, definition: Record<string, unknown> = { endpoint, maxOutputTokens: 32, authentication: { type: 'none' }, tariff }) {
  return { schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope', reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 },
    bindingDigest: 'a'.repeat(64), protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4, definition },
    allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 }, limits: profileLimits };
}
async function token(origin: string, input: unknown = request, profileLimits = limits, definition?: Record<string, unknown>) {
  const port = createOpenAiChatNativePort(); const prepared = await port.prepare(profile(origin, profileLimits, definition), binding, input);
  return { port, prepared };
}
function response(model = 'configured-model', overrides: Record<string, unknown> = {}) {
  return { id: 'chatcmpl-local', object: 'chat.completion', created: 1, model, choices: [{ index: 0, finish_reason: 'stop',
    message: { role: 'assistant', content: 'native answer' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, ...overrides };
}
function expectRejected(result: unknown, reason: string, body: Buffer, complete: boolean, httpStatus: number | null, observedBytes = body.byteLength) {
  expect(result).toMatchObject({ kind: 'rejected', evidence: { schemaVersion: 1, adapter: { id: 'openai-chat-http', version: 4 },
    reason, httpStatus, body: { complete, byteLength: body.byteLength, observedBytes } } });
  const evidence = (result as { evidence: { body: { data: string } } }).evidence;
  expect(Buffer.from(evidence.body.data, 'base64')).toEqual(body);
}

it('uses exact native nonstream bytes and preserves full native completion evidence without credentials', async () => {
  let seen: { method?: string; url?: string; headers?: IncomingMessage['headers']; body?: string } = {};
  const origin = await fixture((req, res) => { const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.on('end', () => {
    seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }; res.end(JSON.stringify(response()));
  }); });
  const { port, prepared } = await token(origin), result = await port.send(prepared);
  expect({ id: OPENAI_CHAT_HTTP_ADAPTER_ID, version: OPENAI_CHAT_HTTP_ADAPTER_VERSION,
    family: OPENAI_CHAT_COMPLETIONS_FAMILY, protocol: OPENAI_CHAT_COMPLETIONS_VERSION }).toEqual({
    id: 'openai-chat-http', version: 4, family: 'openai-chat-completions', protocol: 'v1' });
  expect(seen.method).toBe('POST'); expect(seen.url).toBe('/'); expect(JSON.parse(seen.body ?? '')).toEqual({ ...request, stream: false });
  expect(seen.headers?.authorization).toBeUndefined(); expect(seen.headers?.['proxy-authorization']).toBeUndefined();
  expect(result).toEqual({ schemaVersion: 1, native: response(), usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  expect(Object.isFrozen(result.native)).toBe(true); expect(Object.isFrozen(result.usage)).toBe(true);
});

it('uses the explicit endpoint pathname without adding a default route, and freezes it during preparation', async () => {
  let seen: { method?: string; url?: string } = {}; let redirected = 0;
  const origin = await fixture((req, res) => { seen = { method: req.method, url: req.url }; res.end(JSON.stringify(response())); });
  const endpoint = `${origin}custom/v2/chat`; const definition = { endpoint, maxOutputTokens: 32, authentication: { type: 'none' as const }, tariff };
  const { port, prepared } = await token(origin, request, limits, definition);
  definition.endpoint = `${origin}redirected`; redirected++;
  await expect(port.send(prepared)).resolves.toMatchObject({ native: { model: 'configured-model' } });
  expect(seen).toEqual({ method: 'POST', url: '/custom/v2/chat' }); expect(redirected).toBe(1);
});

it('bounds the complete serialized native and duplicated usage, including escaped and multibyte text', async () => {
  const native = response('configured-model', { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5,
    details: { text: '\u0000\n\t"\\İ😀'.repeat(40) } } });
  const cap = Buffer.byteLength(JSON.stringify(native), 'utf8'); let requests = 0;
  const origin = await fixture((_req, res) => { requests++; res.end(JSON.stringify(native)); });
  const { port, prepared } = await token(origin, request, { ...limits, responseMaxBytes: cap });
  const bound = port.responseBytesUpperBound!(prepared);
  expect(port.responseBytesUpperBound!(prepared)).toBe(bound); expect(requests).toBe(0);
  const result = await port.send(prepared);
  expect(result.native).toEqual(native); expect(result.usage).toEqual(native.usage);
  expect(BigInt(Buffer.byteLength(JSON.stringify(result), 'utf8')) <= bound).toBe(true);
  expect(() => port.responseBytesUpperBound!(prepared)).toThrow('OPENAI_CHAT_REQUEST_INVALID');
  expect(requests).toBe(1);
});

it('rejects wire numbers whose serialized form grows beyond the declared native capacity', async () => {
  const raw = JSON.stringify(response('configured-model', { extra: 1_000_000_000_000_000_000_000 })).replace('1e+21', '1e21');
  // Both representations parse identically; the wire is one byte shorter than its canonical JSON form.
  const canonical = JSON.stringify(JSON.parse(raw)); expect(canonical.length).toBeGreaterThan(raw.length);
  const origin = await fixture((_req, res) => res.end(raw));
  const { port, prepared } = await token(origin, request, { ...limits, responseMaxBytes: Buffer.byteLength(raw, 'utf8') });
  expectRejected(await port.send(prepared), 'response-limit', Buffer.from(raw), true, 200);
});

it('bypasses inherited proxy selectors and rejects non-canonical endpoints or transport selectors before transport', async () => {
  let proxyRequests = 0; const trap = await fixture((_req, res) => { proxyRequests++; res.end('trap'); });
  const original = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].map(name => [name, process.env[name]]));
  const originalAgent = http.globalAgent, proxyAgent = new Agent({ proxyEnv: { HTTP_PROXY: trap, NO_PROXY: '' } });
  http.globalAgent = proxyAgent;
  try {
    process.env.HTTP_PROXY = trap; process.env.HTTPS_PROXY = trap; process.env.NO_PROXY = '';
    const origin = await fixture((_req, res) => res.end(JSON.stringify(response()))), { port, prepared } = await token(origin);
    await expect(port.send(prepared)).resolves.toMatchObject({ native: { model: 'configured-model' } }); expect(proxyRequests).toBe(0);
    for (const definition of [
      { endpoint: 'http://8.8.8.8:80/', maxOutputTokens: 2, authentication: { type: 'none' }, tariff }, { endpoint: 'http://user:pass@127.0.0.1:80/', maxOutputTokens: 2, authentication: { type: 'none' }, tariff },
      { endpoint: '//127.0.0.1:18080/', maxOutputTokens: 2, authentication: { type: 'none' }, tariff }, { endpoint: 'http://127.0.0.1:18080/a/../b', maxOutputTokens: 2, authentication: { type: 'none' }, tariff },
      { endpoint: 'http://127.0.0.1:18080/a\\b', maxOutputTokens: 2, authentication: { type: 'none' }, tariff }, { endpoint: 'http://127.0.0.1:18080/?query=x', maxOutputTokens: 2, authentication: { type: 'none' }, tariff },
      { endpoint: 'http://127.0.0.1:18080/#fragment', maxOutputTokens: 2, authentication: { type: 'none' }, tariff }, { endpoint: 'http://127.0.0.1:0/', maxOutputTokens: 2, authentication: { type: 'none' }, tariff },
      { origin, maxOutputTokens: 2, authentication: { type: 'none' }, tariff }, { endpoint: 'http://localhost:18080/', maxOutputTokens: 2, authentication: { type: 'none' }, tariff },
      { endpoint: origin, maxOutputTokens: 2, authentication: { type: 'none' }, tariff, proxy: trap }, { endpoint: origin, maxOutputTokens: 2, authentication: { type: 'none' }, tariff, headers: { authorization: 'x' } },
    ]) expect(() => parseOpenAiChatHttpDefinition(definition)).toThrow('OPENAI_CHAT_DEFINITION_INVALID');
    expect(proxyRequests).toBe(0);
  } finally {
    http.globalAgent = originalAgent; proxyAgent.destroy();
    for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

it('accepts only an explicit canonical endpoint and rejects earlier adapter versions before network activity', async () => {
  let requests = 0; const origin = await fixture((_req, res) => { requests++; res.end(JSON.stringify(response())); });
  expect(parseOpenAiChatHttpDefinition({ endpoint: origin, maxOutputTokens: 2, authentication: { type: 'none' }, tariff }))
    .toEqual({ endpoint: origin, maxOutputTokens: 2, authentication: { type: 'none' }, tariff });
  expect(parseOpenAiChatHttpDefinition({ endpoint: `${origin}custom/route`, maxOutputTokens: 2, authentication: { type: 'none' }, tariff }))
    .toEqual({ endpoint: `${origin}custom/route`, maxOutputTokens: 2, authentication: { type: 'none' }, tariff });
  const port = createOpenAiChatNativePort(); const legacy = profile(origin) as { adapter: { version: number } };
  for (const version of [2, 3]) {
    legacy.adapter.version = version;
    await expect(port.prepare(legacy, binding, request)).rejects.toMatchObject({ code: 'OPENAI_CHAT_DEFINITION_INVALID' } satisfies Partial<OpenAiChatHttpError>);
  }
  expect(() => parseOpenAiChatHttpDefinition({ endpoint: origin, maxOutputTokens: 2, authentication: { type: 'none' } })).toThrow('OPENAI_CHAT_DEFINITION_INVALID');
  expect(() => parseOpenAiChatHttpDefinition({ endpoint: origin, maxOutputTokens: 2, authentication: { type: 'none' }, tariff: { ...tariff, outputMinorUnitsPerMillionTokens: 1 } })).toThrow('OPENAI_CHAT_DEFINITION_INVALID');
  expect(requests).toBe(0);
});

it('keeps preparation pure, rejects unsupported/getter input, binding mismatch, and reusing a sent token without a second request', async () => {
  let requests = 0; const origin = await fixture((_req, res) => { requests++; const value = response(); delete value.usage; res.end(JSON.stringify(value)); });
  const port = createOpenAiChatNativePort(); let getterCalls = 0; const getter = { ...request };
  Object.defineProperty(getter, 'stream', { get() { getterCalls++; return false; } });
  await expect(port.prepare(profile(origin), binding, getter)).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' } satisfies Partial<OpenAiChatHttpError>);
  expect(getterCalls).toBe(0); await expect(port.prepare(profile(origin), binding, { ...request, tools: [] })).rejects.toThrow('OPENAI_CHAT_REQUEST_INVALID');
  await expect(port.prepare(profile(origin), { ...binding, model: { ...binding.model, nativeId: 'other-model' } }, request))
    .rejects.toMatchObject({ code: 'OPENAI_CHAT_MODEL_MISMATCH' } satisfies Partial<OpenAiChatHttpError>); expect(requests).toBe(0);
  const prepared = await port.prepare(profile(origin), binding, request); await expect(port.send(prepared)).resolves.toMatchObject({ usage: null });
  await expect(port.send(prepared)).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' } satisfies Partial<OpenAiChatHttpError>); expect(requests).toBe(1);
  expect(() => prepareOpenAiChatHttpRequest({ endpoint: 'http://localhost:1/', maxOutputTokens: 1, authentication: { type: 'none' }, tariff }, limits, request)).toThrow('OPENAI_CHAT_DEFINITION_INVALID');
});

it('reports cancellation and timeout after the owned fixture has observed the request', async () => {
  let seen!: () => void; const observed = new Promise<void>(resolve => { seen = resolve; });
  const origin = await fixture(() => seen()); const { port, prepared } = await token(origin); const controller = new AbortController(); const cancelling = port.send(prepared, controller.signal);
  await observed; controller.abort(); await expect(cancelling).rejects.toMatchObject({ code: 'OPENAI_CHAT_CANCELLED' } satisfies Partial<OpenAiChatHttpError>);
  const slowOrigin = await fixture(() => undefined), slow = await token(slowOrigin, request, { ...limits, timeoutMs: 40 });
  await expect(slow.port.send(slow.prepared)).rejects.toMatchObject({ code: 'OPENAI_CHAT_TIMEOUT' } satisfies Partial<OpenAiChatHttpError>);
});

it('retains partial response bytes for reset, cancellation, and deadline interruption without putting bytes in thrown errors', async () => {
  const prefix = Buffer.from('private response prefix'); let turn = 0; let observed!: () => void;
  const seen = new Promise<void>(resolve => { observed = resolve; });
  const origin = await fixture((_req, res) => {
    turn++;
    if (turn === 1) { res.writeHead(200); res.write(prefix); setImmediate(() => res.socket?.destroy()); return; }
    res.writeHead(200); res.write(prefix); observed();
  });
  const reset = await token(origin); expectRejected(await reset.port.send(reset.prepared), 'interrupted', prefix, false, 200);
  const cancelling = await token(origin); const controller = new AbortController(); const cancelled = cancelling.port.send(cancelling.prepared, controller.signal);
  await seen; await new Promise(resolve => setTimeout(resolve, 10)); controller.abort(); expectRejected(await cancelled, 'interrupted', prefix, false, 200);
  const timeout = await token(origin, request, { ...limits, timeoutMs: 40 });
  expectRejected(await timeout.port.send(timeout.prepared), 'interrupted', prefix, false, 200);
  const noResponse = await fixture((_req, res) => { res.socket?.destroy(); }); const unknown = await token(noResponse);
  try { await unknown.port.send(unknown.prepared); throw new Error('EXPECTED_TRANSPORT_FAILURE'); }
  catch (error) { expect(error).toMatchObject({ code: 'OPENAI_CHAT_TRANSPORT_UNKNOWN' }); expect(String(error)).not.toContain(prefix.toString('utf8')); }
});

it('retains exact complete non-success response bodies', async () => {
  const body = Buffer.from('{"private":"status body"}');
  const origin = await fixture((_req, res) => { res.writeHead(429); res.end(body); });
  const result = await token(origin);
  expectRejected(await result.port.send(result.prepared), 'http-status', body, true, 429);
});

it('fails a direct oversized evidence construction as a typed body-free error', async () => {
  const privatePrefix = 'private-evidence-boundary-';
  const body = Buffer.from(`"${privatePrefix}${'x'.repeat(8 * 1024 * 1024)}"`);
  const origin = await fixture((_req, res) => { res.end(body); });
  const result = await token(origin, request, { ...limits, responseMaxBytes: 9 * 1024 * 1024 });
  try { await result.port.send(result.prepared); throw new Error('EXPECTED_EVIDENCE_BOUNDARY'); }
  catch (error) {
    expect(error).toMatchObject({ code: 'OPENAI_CHAT_RESPONSE_TOO_LARGE' });
    expect(String(error)).not.toContain(privatePrefix);
  }
});

it('retains bounded rejection evidence for complete malformed/status/model replies and interrupted response prefixes', async () => {
  const tool = response(); tool.choices[0].message.tool_calls = [];
  const empty = response('configured-model', { choices: [] });
  const multiple = response(); multiple.choices.push(multiple.choices[0]);
  const invalidUsage = response('configured-model', { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 1 } });
  const toolBody = JSON.stringify(tool), emptyBody = JSON.stringify(empty), multipleBody = JSON.stringify(multiple), invalidUsageBody = JSON.stringify(invalidUsage);
  let turn = 0; const origin = await fixture((_req, res) => {
    turn++; if (turn === 1) { res.writeHead(307, { location: 'http://127.0.0.1:9/other' }); res.end('redirect-body'); return; }
    if (turn === 2) { res.destroy(); return; } if (turn === 3) { res.end('x'.repeat(5000)); return; } if (turn === 4) { res.end('{'); return; }
    if (turn === 5) { res.end(toolBody); return; }
    if (turn === 6) { res.end(emptyBody); return; }
    if (turn === 7) { res.end(multipleBody); return; }
    if (turn === 8) { res.end(invalidUsageBody); return; }
    if (turn === 9) { res.end(JSON.stringify(response('different-model'))); return; }
    res.writeHead(200); res.write('partial-response');
  });
  const redirect = await token(origin); expectRejected(await redirect.port.send(redirect.prepared), 'redirect', Buffer.from('redirect-body'), true, 307);
  const reset = await token(origin); await expect(reset.port.send(reset.prepared)).rejects.toMatchObject({ code: 'OPENAI_CHAT_TRANSPORT_UNKNOWN' });
  const oversize = await token(origin); const oversizeResult = await oversize.port.send(oversize.prepared);
  expectRejected(oversizeResult, 'response-limit', Buffer.alloc(4096, 'x'), false, 200, 5000);
  const malformed = await token(origin); expectRejected(await malformed.port.send(malformed.prepared), 'invalid-response', Buffer.from('{'), true, 200);
  const toolResult = await token(origin); expectRejected(await toolResult.port.send(toolResult.prepared), 'invalid-response', Buffer.from(toolBody), true, 200);
  const emptyResult = await token(origin); expectRejected(await emptyResult.port.send(emptyResult.prepared), 'invalid-response', Buffer.from(emptyBody), true, 200);
  const multipleResult = await token(origin); expectRejected(await multipleResult.port.send(multipleResult.prepared), 'invalid-response', Buffer.from(multipleBody), true, 200);
  const invalidUsageResult = await token(origin); expectRejected(await invalidUsageResult.port.send(invalidUsageResult.prepared), 'invalid-response', Buffer.from(invalidUsageBody), true, 200);
  const mismatch = await token(origin); const mismatchResult = await mismatch.port.send(mismatch.prepared);
  expectRejected(mismatchResult, 'model-mismatch', Buffer.from(JSON.stringify(response('different-model'))), true, 200);
  const partial = await token(origin, request, { ...limits, timeoutMs: 40 }); const partialResult = await partial.port.send(partial.prepared);
  expectRejected(partialResult, 'interrupted', Buffer.from('partial-response'), false, 200);
});
