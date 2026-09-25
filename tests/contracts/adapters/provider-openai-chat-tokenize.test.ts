import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createOpenAiChatNativePort, parseOpenAiChatHttpDefinition } from '#adapters/core/provider-openai-chat/index.js';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
const MODEL = 'configured-model';
const counted = [{ id: 'tool-calls', version: 1, state: 'supported' }, { id: 'token-count', version: 1, state: 'supported' }];
const binding = (capabilities: readonly unknown[] = counted) => ({ encodingVersion: 1, provider: { id: 'provider', version: 1 }, model: { id: 'model', version: 1,
  nativeId: MODEL, protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities }] } });
const profile = (endpoint: string, tokenizeEndpoint?: string) => ({ schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope',
  reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 }, bindingDigest: 'a'.repeat(64),
  protocol: { family: 'openai-chat-completions', version: 'v1' },
  adapter: { id: 'openai-chat-http', version: 4, definition: { endpoint, maxOutputTokens: 64, authentication: { type: 'none' }, tariff,
    ...(tokenizeEndpoint ? { tokenizeEndpoint } : {}) } },
  allocation: { id: 'allocation', maxCalls: null, maxInFlight: 1 }, limits: { requestMaxBytes: 65_536, responseMaxBytes: 65_536, timeoutMs: 5000 } });
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const native = { model: MODEL, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'read a.ts' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'export const a = 1;' }],
  max_completion_tokens: 48, stream: true, stream_options: { include_usage: true }, tools, tool_choice: 'auto' };

async function fixture(handler: (url: string, body: string, res: ServerResponse) => void) {
  const requests: { url: string; body: string }[] = [];
  const server = createServer((req: IncomingMessage, res) => { let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { requests.push({ url: req.url ?? '', body }); handler(req.url ?? '', body, res); }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}
const json = (value: unknown, status = 200) => (_url: string, _body: string, res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
};

it('accepts a tokenize endpoint only on the same origin as the completion endpoint', () => {
  const base = { endpoint: 'http://127.0.0.1:18080/v1/chat/completions', maxOutputTokens: 64, authentication: { type: 'none' }, tariff };
  expect(parseOpenAiChatHttpDefinition({ ...base, tokenizeEndpoint: 'http://127.0.0.1:18080/tokenize' })).toMatchObject({ tokenizeEndpoint: 'http://127.0.0.1:18080/tokenize' });
  for (const tokenizeEndpoint of ['http://127.0.0.1:18081/tokenize', 'http://[::1]:18080/tokenize', 'https://example.com/tokenize', 'http://127.0.0.1:18080/tokenize?x=1']) {
    expect(() => parseOpenAiChatHttpDefinition({ ...base, tokenizeEndpoint })).toThrow(expect.objectContaining({ code: 'OPENAI_CHAT_DEFINITION_INVALID' }));
  }
});

it('counts exactly the messages and tools the round sends, with the served window, and never fails a turn when the counter does', async () => {
  const server = await fixture(json({ count: 321, max_model_len: 131072, tokens: [1, 2, 3], token_strs: null }));
  const port = createOpenAiChatNativePort();
  const prepared = await port.prepare(profile(`${server.origin}/v1/chat/completions`, `${server.origin}/tokenize`), binding(), native);
  expect(await port.measure!(prepared)).toEqual({ promptTokens: 321, windowTokens: 131072 });
  expect(server.requests).toHaveLength(1); expect(server.requests[0]!.url).toBe('/tokenize');
  // The count is of the same prompt the round sends: identical model, messages and tools; no sampling fields.
  expect(JSON.parse(server.requests[0]!.body)).toEqual({ model: MODEL, messages: native.messages, tools });
  // A prepared request is single use for measure as for send.
  await expect(port.measure!(prepared)).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' });

  for (const handler of [json({ error: 'boom' }, 500), json({ count: -1 }), json({ unexpected: true })]) {
    const failing = await fixture(handler), again = createOpenAiChatNativePort();
    const request = await again.prepare(profile(`${failing.origin}/v1/chat/completions`, `${failing.origin}/tokenize`), binding(), native);
    expect(await again.measure!(request)).toBeNull();
  }
  // A transport failure (nothing listens on the counter's origin any more) is null too, never an exception into the turn.
  const gone = await fixture(json({ count: 1 })), closed = servers.pop()!;
  closed.closeAllConnections(); await new Promise<void>(resolve => closed.close(() => resolve()));
  const refused = createOpenAiChatNativePort();
  const request = await refused.prepare(profile(`${gone.origin}/v1/chat/completions`, `${gone.origin}/tokenize`), binding(), native);
  expect(await refused.measure!(request)).toBeNull();
});

it('sends no counter request when the binding does not declare token-count or the profile names no endpoint', async () => {
  const server = await fixture(json({ count: 1 }));
  for (const [capabilities, tokenize] of [[[counted[0]], true], [counted, false]] as const) {
    const port = createOpenAiChatNativePort();
    const prepared = await port.prepare(profile(`${server.origin}/v1/chat/completions`, tokenize ? `${server.origin}/tokenize` : undefined), binding(capabilities), native);
    expect(await port.measure!(prepared)).toBeNull();
  }
  expect(server.requests).toEqual([]);
});
