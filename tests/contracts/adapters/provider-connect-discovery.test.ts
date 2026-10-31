import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverProviderModels, discoveredProviderCatalog, providerConnectKind, providerDiscoveryChannel, PROVIDER_CONNECT_LIMITS,
  ProviderModelListError, listKindProviderWorkspaces, probeLocalToolCalls, type ProviderProbeFetch } from '#adapters/core/provider-connect/index.js';

const local = providerConnectKind('local-openai')!, generic = providerConnectKind('openai-compatible')!;
const key = 'sk-discovery-canary-41db79';
const body = (ids: string[]) => JSON.stringify({ object: 'list', data: ids.map(id => ({ id, object: 'model', owned_by: 'fixture' })) });
const reply = (text: string, status = 200): ProviderProbeFetch => async () => new Response(text, { status });
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

describe('seedless provider model discovery', () => {
  it('preserves exact slash/case/tag IDs, deduplicates, and scopes declarations to the canonical address', async () => {
    const nativeId = 'Org/Model:Q4_K_M';
    const ids = await discoverProviderModels(local, 'http://127.0.0.1:8000/v1/', null, { fetch: reply(body([nativeId, nativeId, 'other'])) });
    expect(ids).toEqual([nativeId, 'other']);
    const catalog = discoveredProviderCatalog(local, 'http://127.0.0.1:8000', nativeId);
    expect(catalog.providers[0]!.models[0]).toMatchObject({ nativeId, protocols: [{ capabilities: [] }], efforts: [], aliases: [] });
    expect(providerDiscoveryChannel(local, 'http://127.0.0.1:8000/v1')).toBe(catalog.providers[0]!.id);
    expect(providerDiscoveryChannel(local, 'http://127.0.0.1:8001')).not.toBe(catalog.providers[0]!.id);
    expect(providerDiscoveryChannel(generic, 'http://127.0.0.1:8000')).not.toBe(catalog.providers[0]!.id);
    // CONNECT-LOCALITY: a 'localhost' name is not literal loopback; plain http to it is refused before any request.
    let sent = 0;
    await expect(discoverProviderModels(local, 'http://localhost:8000/v1/', null, { fetch: async () => { sent += 1; return new Response(body(['x'])); } }))
      .rejects.toMatchObject({ code: 'PROVIDER_ENDPOINT_INVALID' });
    expect(sent).toBe(0);
  });

  it('uses only GET and the chosen origin, with manual redirects; never sends a key to plain-http loopback', async () => {
    const seen: unknown[] = [];
    const fetch: ProviderProbeFetch = async (url, init) => { seen.push({ url, ...init, signal: undefined }); return new Response(body(['x'])); };
    await discoverProviderModels(local, 'http://127.0.0.1:8000/v1', key, { fetch });
    await discoverProviderModels(generic, 'https://llm.example/prefix/v1', key, { fetch });
    expect(seen).toEqual([
      { url: 'http://127.0.0.1:8000/v1/models', method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: undefined },
      { url: 'https://llm.example/prefix/v1/models', method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${key}` }, redirect: 'manual', signal: undefined },
    ]);
  });

  it.each(['http://remote.example', 'https://user:password@llm.example', 'https://llm.example?query=x'])('refuses disallowed endpoint %s before network', async endpoint => {
    let called = false;
    await expect(discoverProviderModels(local, endpoint, key, { fetch: async () => { called = true; return new Response(body(['x'])); } }))
      .rejects.toMatchObject({ code: 'PROVIDER_ENDPOINT_INVALID' });
    expect(called).toBe(false);
  });

  it.each([302, 401, 403, 429, 500])('refuses HTTP %i without exposing the response/key or following a redirect', async status => {
    const result = discoverProviderModels(generic, 'https://llm.example', key, { fetch: reply(key, status) });
    await expect(result).rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_UNAVAILABLE' });
    await expect(result).rejects.not.toThrow(key);
  });

  it.each(['not JSON', '{"data":null}', '{"data":[{}]}', '{"data":[{"id":" trimmed "}]}', '{"data":[{"id":"-option"}]}',
    '{"data":[{"id":"line\\nfeed"}]}'])('refuses a malformed list or ID: %s', async text => {
    await expect(discoverProviderModels(local, 'http://127.0.0.1', null, { fetch: reply(text) })).rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_INVALID' });
  });

  it('refuses a credential echoed as a model ID and keeps an empty list empty', async () => {
    await expect(discoverProviderModels(generic, 'https://llm.example', key, { fetch: reply(body([`echo-${key}`])) }))
      .rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_INVALID' });
    expect(await discoverProviderModels(local, 'http://127.0.0.1', null, { fetch: reply(body([])) })).toEqual([]);
  });

  it('refuses oversized bytes and entry counts without returning a partial list', async () => {
    await expect(discoverProviderModels(local, 'http://127.0.0.1', null, { fetch: reply(' '.repeat(PROVIDER_CONNECT_LIMITS.modelListBytes + 1)) }))
      .rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_LIMIT' });
    await expect(discoverProviderModels(local, 'http://127.0.0.1', null, { fetch: reply(body(Array.from({ length: PROVIDER_CONNECT_LIMITS.modelListCount + 1 }, (_, i) => `m${i}`))) }))
      .rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_LIMIT' });
  });

  it('times out a stalled injected body, cancels the reader and exposes no partial model list', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); },
      cancel() { cancelled = true; } });
    await expect(discoverProviderModels(local, 'http://127.0.0.1', null, { timeoutMs: 30, fetch: async () => new Response(stream) }))
      .rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_UNAVAILABLE', cause: 'timeout' });
    expect(cancelled).toBe(true);
  });

  it('caller cancellation ends a stalled body and a pre-cancelled discovery never calls the transport', async () => {
    const controller = new AbortController(), reason = new Error('cancelled');
    const stream = new ReadableStream<Uint8Array>({ start(streamController) {
      streamController.enqueue(new TextEncoder().encode('{"data":['));
    } });
    const pending = discoverProviderModels(local, 'http://127.0.0.1', null, { signal: controller.signal, fetch: async () => new Response(stream) });
    controller.abort(reason); await expect(pending).rejects.toBe(reason);
    let called = false;
    await expect(discoverProviderModels(local, 'http://127.0.0.1', null, { signal: controller.signal, fetch: async () => {
      called = true; return new Response(body(['x']));
    } })).rejects.toBe(reason);
    expect(called).toBe(false);
  });

  it('bounds a real response stalled after headers and honors cancellation', async () => {
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"data":['); }); servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    await expect(discoverProviderModels(local, endpoint, null, { timeoutMs: 50 })).rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_UNAVAILABLE' });
    const controller = new AbortController(), reason = new Error('cancelled');
    const pending = discoverProviderModels(local, endpoint, null, { signal: controller.signal });
    controller.abort(reason); await expect(pending).rejects.toBe(reason);
  });
});

it('retains closed discovery causes without leaking response or transport text', async () => {
  const endpoint = 'https://llm.example';
  for (const [status, text, cause] of [[401, key, 'credential-rejected'], [403, key, 'access-denied'],
    [429, '{"error":{"code":"insufficient_quota"}}', 'spend-limit'], [429, '{"error":{"type":"rate_limit_error"}}', 'rate-limit'],
    [429, key, 'limit-reached'], [503, key, 'http-status'], [302, key, 'redirect']] as const) {
    await expect(discoverProviderModels(generic, endpoint, key, { fetch: reply(text, status) })).rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_UNAVAILABLE', cause, status });
  }
  await expect(discoverProviderModels(generic, endpoint, null)).rejects.toMatchObject({ cause: 'no-credential' });
  await expect(discoverProviderModels(generic, endpoint, key, { fetch: async () => { throw new Error(key); } })).rejects.toMatchObject({ cause: 'network' });
  const failure = new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'credential-rejected', 401);
  expect(JSON.stringify(failure)).not.toContain(key);
});

it('seeded model discovery completes registry-paged lists with one bound, a selected workspace, and rejects repeated cursors', async () => {
  const kind = providerConnectKind('anthropic-api')!, urls: string[] = [];
  const fetch: ProviderProbeFetch = async (url, init) => {
    urls.push(String(url)); expect(init?.headers).toMatchObject({ 'anthropic-workspace-id': 'wrkspc_fixture' });
    return new Response(JSON.stringify(urls.length === 1 ? { data: [{ id: 'a' }], has_more: true, last_id: 'a' } : { data: [{ id: 'b' }], has_more: false, last_id: 'b' }));
  };
  expect(await discoverProviderModels(kind, null, key, { fetch, workspaceId: 'wrkspc_fixture' })).toEqual(['a', 'b']);
  expect(urls).toEqual(['https://api.anthropic.com/v1/models?limit=128', 'https://api.anthropic.com/v1/models?limit=128&after_id=a']);
  let calls = 0;
  await expect(discoverProviderModels(kind, null, key, { fetch: async () => { calls++; return new Response(JSON.stringify({ data: [{ id: 'a' }], has_more: true, last_id: 'a' })); } }))
    .rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_INVALID' });
  expect(calls).toBe(2);
  let echoed = 0;
  await expect(discoverProviderModels(kind, null, key, { fetch: async () => { echoed++; return new Response(JSON.stringify({ data: [{ id: 'a' }], has_more: true, last_id: key })); } }))
    .rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_INVALID' });
  expect(echoed).toBe(1);
});

it('Astra R2 (alpha.56.1): a network failure keeps one display address (scheme, host, port, path) and never a query, userinfo or fragment', async () => {
  const canary = 'reviewOpaqueCredential7fd91', down: ProviderProbeFetch = async () => { throw new TypeError('fetch failed'); };
  const failure = async (work: Promise<unknown>) => { const error = await work.catch((caught: unknown) => caught) as ProviderModelListError;
    expect(error).toBeInstanceOf(ProviderModelListError); expect(JSON.stringify({ ...error, address: error.address })).not.toContain(canary); return error.address; };
  // A registry row whose list path carries a query secret (a test/Enterprise overlay); the shipped Anthropic row's `?limit=1` still gives a usable address.
  expect(await failure(discoverProviderModels({ ...local, probe: { ...local.probe!, path: `/v1/models?k=${canary}#${canary}` } }, 'http://127.0.0.1:18080', null, { fetch: down })))
    .toBe('http://127.0.0.1:18080/v1/models');
  const anthropic = providerConnectKind('anthropic-api')!;
  expect(await failure(discoverProviderModels(anthropic, null, key, { fetch: down }))).toBe('https://api.anthropic.com/v1/models');
  // The workspace list: a path with userinfo never shows it.
  const workspaces = { ...anthropic, connect: { ...anthropic.connect!, workspaceList: { ...anthropic.connect!.workspaceList!, path: `//review-user:${canary}@api.anthropic.com/v1/organizations/workspaces` } } };
  expect(await failure(listKindProviderWorkspaces(workspaces, 'https://api.anthropic.com', key, { fetch: down }))).toBe('https://api.anthropic.com/v1/organizations/workspaces');
});
it('BeUser AYSE-16/M-04 (alpha.56.1): a keyless loopback server that accepts one tool call declares tool-calls; a refusal declares none and uncertainty stays unknown', async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const probe = (status: number): ProviderProbeFetch => async (url, init) => { sent.push({ url: String(url), init: init! }); return new Response(status === 400 ? '{"error":{"message":"auto tool choice requires a tool parser"}}' : '{}', { status }); };
  expect(await probeLocalToolCalls(local, 'http://127.0.0.1:8000/v1', 'm', { fetch: probe(200) })).toBe(true);
  expect(sent[0]).toMatchObject({ url: 'http://127.0.0.1:8000/v1/chat/completions', init: { method: 'POST', redirect: 'manual' } });
  expect(JSON.parse(String(sent[0]!.init.body))).toMatchObject({ model: 'm', max_tokens: 1, tool_choice: 'auto', tools: [{ type: 'function' }] });
  expect(new Headers(sent[0]!.init.headers).get('authorization')).toBeNull();
  expect(await probeLocalToolCalls(local, 'http://127.0.0.1:8000/v1', 'm', { fetch: probe(400) })).toBe(false);
  expect(await probeLocalToolCalls(local, 'http://127.0.0.1:8000/v1', 'm', { fetch: async () => { throw new Error('down'); } })).toBeNull();
  expect(await probeLocalToolCalls(generic, 'https://llm.example/v1', 'm', { fetch: probe(200) })).toBeNull(); expect(sent).toHaveLength(2);
  expect(await probeLocalToolCalls(local, 'http://127.0.0.1:8000/v1', 'm', { fetch: probe(503) })).toBeNull();
  for (const status of [400, 422]) {
    for (const error of [{ param: 'tools' }, { code: 'tool_choice' }, { param: 'tool_choice' }, { code: 'tools' },
      { message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set' },
      { message: 'This model does not support tools.' }, { message: 'Tool calling is not supported' }]) {
      expect(await probeLocalToolCalls(local, 'http://127.0.0.1:8000/v1', 'm', { fetch: reply(JSON.stringify({ error }), status) })).toBe(false);
    }
    for (const text of ['{"error":"bad max_tokens"}', '{"error":{"param":"max_tokens","message":"bad max_tokens"},"request":{"tools":[]}}',
      '{"error":{"message":"bad max_tokens; request includes tools"}}', '{"error":{"message":"tool_calls must be an array"}}',
      '{"request":{"param":"tools","message":"Tools are not supported"}}', '{"error":{"param":"max_tokens","message":"bad max_tokens"},"tools":"not supported"}',
      '{"error":{"param":["tools"],"code":{"tools":true},"message":["Tools are not supported"]}}',
      'Tools are not supported', '{"error":{"param":"tools"}', 'null']) {
      const result = await probeLocalToolCalls(local, 'http://127.0.0.1:8000/v1', 'm', { fetch: reply(text, status) });
      expect(result).toBeNull();
      expect(discoveredProviderCatalog(local, 'http://127.0.0.1:8000', 'm', result).providers[0]!.models[0]!.protocols[0]!.capabilities).toEqual([]);
    }
  }
  for (const status of [401, 403, 404, 409, 429, 503]) {
    expect(await probeLocalToolCalls(local, 'http://127.0.0.1:8000/v1', 'm', { fetch: reply('{"error":{"param":"tools"}}', status) })).toBeNull();
  }
  const fragmented = new ReadableStream<Uint8Array>({ start(controller) {
    for (const part of ['{"error":', '{"param":', '"tools"', '}}']) controller.enqueue(new TextEncoder().encode(part)); controller.close();
  } });
  expect(await probeLocalToolCalls(local, 'http://127.0.0.1:8000/v1', 'm', { fetch: async () => new Response(fragmented, { status: 422 }) })).toBe(false);
  let oversizedCancelled = false;
  expect(await probeLocalToolCalls(local, 'http://127.0.0.1:8000/v1', 'm', { fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"error":{"param":"tools"}}' + ' '.repeat(PROVIDER_CONNECT_LIMITS.bodyPrefixBytes))); },
    cancel() { oversizedCancelled = true; },
  }), { status: 400 }) })).toBeNull();
  expect(oversizedCancelled).toBe(true);
  const timeout: ProviderProbeFetch = async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  expect(await probeLocalToolCalls(local, 'http://127.0.0.1:8000/v1', 'm', { fetch: timeout, timeoutMs: 20 })).toBeNull();
  let bodyCancelled = false;
  expect(await probeLocalToolCalls(local, 'http://127.0.0.1:8000/v1', 'm', { timeoutMs: 20,
    fetch: async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }), { status: 400 }) })).toBeNull();
  expect(bodyCancelled).toBe(true);
  const cancelled = AbortSignal.abort(new Error('caller-cancelled'));
  await expect(probeLocalToolCalls(local, 'http://127.0.0.1:8000/v1', 'm', { signal: cancelled, fetch: probe(200) })).rejects.toThrow('caller-cancelled');
  for (const [support, expected] of [[false, 'unsupported'], [null, null]] as const) {
    const capabilities = discoveredProviderCatalog(local, 'http://127.0.0.1:8000', 'm', support).providers[0]!.models[0]!.protocols[0]!.capabilities;
    expect(capabilities).toEqual(expected ? [{ id: 'tool-calls', version: 1, state: expected }] : []);
  }
  expect(discoveredProviderCatalog(local, 'http://127.0.0.1:8000', 'm', true).providers[0]!.models[0]!.protocols[0]!.capabilities).toEqual([{ id: 'tool-calls', version: 1, state: 'supported' }]);
});
