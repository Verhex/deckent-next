import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverProviderModels, discoveredProviderCatalog, providerConnectKind, providerDiscoveryChannel, PROVIDER_CONNECT_LIMITS,
  type ProviderProbeFetch } from '#adapters/core/provider-connect/index.js';

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
      .rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_UNAVAILABLE' });
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
