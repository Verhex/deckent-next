import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { PROVIDER_CONNECT_KINDS, ProviderProbeError, probeProviderConnection, providerConnectKind, providerConnectSecretName, providerEndpoint, providerProbeRejection,
  connectionAdapter, readProviderConnectSeed, type ProviderProbeFetch } from '#adapters/core/provider-connect/index.js';

// T4 PROVIDER-CONNECT: the connection check is one free request that needs the key, mapped to the secret lane's rejection kinds. The key is a
// canary: it may reach only the request header, never a result, an error or anything the caller could print.
const CANARY = 'sk-canary-T4-6f1d2e9c0b7a';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });

function fakeFetch(status: number, body = '', seen: { url: string; headers: Record<string, string>; redirect: string }[] = []): ProviderProbeFetch {
  return async (url, init) => { seen.push({ url, headers: init.headers, redirect: init.redirect }); return new Response(body || null, { status }); };
}

describe('provider connection check', () => {
  it('lists the vendor rows, the generic and local rows and ChatGPT login as not available yet, each with its own store name (T4-B, Jev da5312fb)', () => {
    expect(PROVIDER_CONNECT_KINDS.map(kind => [kind.id, kind.available])).toEqual([['anthropic-api', true], ['openai-api', true], ['deepseek-api', true], ['zai-api', true],
      ['zai-cn-api', true], ['openrouter', true], ['openai-compatible', true], ['local-openai', true], ['chatgpt-login', false]]);
    const fixed = PROVIDER_CONNECT_KINDS.filter(item => item.available && item.key?.secretName).map(kind => kind.key!.secretName!);
    // Every vendor keeps its own key: connecting one never overwrites another's.
    expect(new Set(fixed).size).toBe(fixed.length);
    for (const name of fixed) expect(name).toMatch(/^DECKENT_[A-Z_]+$/u);
    // Z.ai documents no free read (no models list): its rows have no probe; every other available row has one.
    expect(PROVIDER_CONNECT_KINDS.filter(kind => kind.available && kind.probe === null).map(kind => kind.id)).toEqual(['zai-api', 'zai-cn-api']);
    for (const kind of PROVIDER_CONNECT_KINDS.filter(item => item.available && item.probe)) expect(kind.probe!.path).toMatch(/^\/(v1\/models|models|api\/v1\/key)/u);
    expect(PROVIDER_CONNECT_KINDS.filter(kind => kind.connect?.seed).map(kind => [kind.id, kind.connect!.seed]))
      .toEqual([['anthropic-api', 'anthropic-api'], ['openai-api', 'openai-api'], ['deepseek-api', 'deepseek-api'], ['zai-api', 'zai-api'], ['zai-cn-api', 'zai-cn-api']]);
  });

  it('the generic row derives one key name per endpoint host, shown before saving; vendor rows keep their fixed name', () => {
    const generic = providerConnectKind('openai-compatible')!;
    expect(providerConnectSecretName(generic, 'https://llm.example.com/v1')).toBe('DECKENT_OAICOMPAT_LLM_EXAMPLE_COM');
    expect(providerConnectSecretName(generic, 'https://llm.example.com:8443')).toBe('DECKENT_OAICOMPAT_LLM_EXAMPLE_COM_8443');
    expect(providerConnectSecretName(generic, 'https://gw-1.corp.example/openai/v1')).toBe('DECKENT_OAICOMPAT_GW_1_CORP_EXAMPLE');
    expect(providerConnectSecretName(generic, 'http://127.0.0.1:8000')).toBe('DECKENT_OAICOMPAT_127_0_0_1_8000');
    expect(providerConnectSecretName(generic, 'http://[::1]:9000')).toBe('DECKENT_OAICOMPAT_1_9000');
    // Not a valid address, or none yet: no name (nothing can be saved).
    expect(providerConnectSecretName(generic, 'http://10.0.0.2:8000')).toBeNull();
    expect(providerConnectSecretName(generic, null)).toBeNull();
    const long = providerConnectSecretName(generic, `https://${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example`)!;
    expect(long.length).toBeLessThanOrEqual(128); expect(long).toMatch(/^DECKENT_OAICOMPAT_A+_B+/u);
    expect(providerConnectSecretName(providerConnectKind('deepseek-api')!, 'https://anything.example')).toBe('DECKENT_DEEPSEEK_KEY');
  });

  it('every packaged seed parses, and each of its models builds a valid profile adapter for its row (published tariff for Anthropic, unmetered otherwise)', async () => {
    for (const kind of PROVIDER_CONNECT_KINDS.filter(item => item.connect?.seed)) {
      const seed = await readProviderConnectSeed(kind.connect!.seed!), checked = providerEndpoint(kind.endpoint.default!);
      if (!checked.ok) throw new Error(kind.id);
      for (const model of seed.providers.flatMap(provider => provider.models)) {
        const built = connectionAdapter(kind, { endpoint: `${checked.base}${kind.connect!.chatPath}`, credentialRef: kind.key!.secretName, nativeId: model.nativeId,
          maxOutputTokens: (model as { maxOutputTokens?: number | null }).maxOutputTokens ?? 32768, currency: 'USD' });
        expect(built.tariff).toBe(kind.id === 'anthropic-api' ? 'published' : 'unmetered');
        expect(JSON.stringify(built.adapter.definition)).toContain(kind.key!.secretName!);
      }
    }
    await expect(readProviderConnectSeed('../policy')).rejects.toMatchObject({ code: 'MODEL_CONNECT_SEED_UNAVAILABLE' });
    // K4: the OpenRouter seed (verified exact ids) parses as a catalog document; it is for catalog registration, no row connects it yet.
    const openrouter = await readProviderConnectSeed('openrouter-api');
    expect(openrouter.providers[0]!.models.map(model => model.nativeId)).toEqual(['anthropic/claude-fable-5.1', 'anthropic/claude-haiku-5.5', 'anthropic/claude-opus-5.5',
      'anthropic/claude-sonnet-5.5', 'deepseek/deepseek-v4.1-flash', 'openai/gpt-6-astra', 'openai/gpt-6-luna', 'openai/gpt-6.1-sol', 'z-ai/glm-5.3']);
  });

  it('a provider without a free read sends nothing: the key is kept unverified', async () => {
    const seen: Parameters<typeof fakeFetch>[2] = [];
    expect(await probeProviderConnection({ kind: 'zai-api', endpoint: null, key: CANARY }, { fetch: fakeFetch(200, '{}', seen) }))
      .toEqual({ outcome: 'ok', httpStatus: null, key: 'unverified' });
    expect(seen).toEqual([]);
  });

  it('sends the key only in the kind\'s own header, to its own endpoint, without following redirects', async () => {
    const seen: Parameters<typeof fakeFetch>[2] = [];
    expect(await probeProviderConnection({ kind: 'anthropic-api', endpoint: 'https://evil.example', key: CANARY }, { fetch: fakeFetch(200, '{}', seen) }))
      .toEqual({ outcome: 'ok', httpStatus: 200, key: 'verified' });
    expect(await probeProviderConnection({ kind: 'openrouter', endpoint: null, key: CANARY }, { fetch: fakeFetch(200, '{}', seen) })).toMatchObject({ outcome: 'ok' });
    expect(seen[0]).toEqual({ url: 'https://api.anthropic.com/v1/models?limit=1', redirect: 'manual',
      headers: { accept: 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': CANARY } });
    expect(seen[1]).toEqual({ url: 'https://openrouter.ai/api/v1/key', redirect: 'manual', headers: { accept: 'application/json', authorization: `Bearer ${CANARY}` } });
  });

  it('maps every refusal to its typed kind and never returns the key or the body', async () => {
    const cases: [number, string, string][] = [[401, '', 'credential-rejected'], [403, '', 'access-denied'], [402, '', 'spend-limit'],
      [429, '{"error":{"type":"rate_limit_error","details":{"error_code":"enforced_spend_limit_reached"}}}', 'spend-limit'],
      [429, '{"error":{"code":"insufficient_quota"}}', 'spend-limit'], [429, '{"error":{"type":"rate_limit_error"}}', 'rate-limit'], [429, '{"error":{"code":"rate_limit_exceeded"}}', 'rate-limit'], [429, '', 'limit-reached'],
      // Astra 2026-10-08: a 429 whose body is unreadable or names no known limit is an unknown limit, never guessed as a rate limit.
      [429, 'not json', 'limit-reached'], [429, '{"error":{"type":"overloaded"}}', 'limit-reached'],
      [400, '{"error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits until 2026-11-01"}}', 'spend-limit'], [400, '{}', 'unexpected'],
      [302, '', 'unexpected'], [404, '', 'unexpected'], [503, '', 'unreachable']];
    for (const [status, body, outcome] of cases) {
      const result = await probeProviderConnection({ kind: 'openai-api', endpoint: null, key: CANARY }, { fetch: fakeFetch(status, body) });
      expect(result).toEqual({ outcome, httpStatus: status, key: 'unverified' });
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
    expect(providerProbeRejection(429, null)).toBe('limit-reached');
    // A body that echoes the key is read for its error code only; nothing of it comes back.
    const echoed = await probeProviderConnection({ kind: 'openai-api', endpoint: null, key: CANARY },
      { fetch: fakeFetch(429, `{"error":{"type":"rate_limit_error","message":"key ${CANARY} is rate limited"}}`) });
    expect(echoed).toEqual({ outcome: 'rate-limit', httpStatus: 429, key: 'unverified' }); expect(JSON.stringify(echoed)).not.toContain(CANARY);
  });

  it('a network failure or a timeout is unreachable without any detail; a caller abort is the caller\'s', async () => {
    const failing: ProviderProbeFetch = async () => { throw new Error(`connect ECONNREFUSED with ${CANARY}`); };
    const result = await probeProviderConnection({ kind: 'openai-api', endpoint: null, key: CANARY }, { fetch: failing });
    expect(result).toEqual({ outcome: 'unreachable', httpStatus: null, key: 'unverified' }); expect(JSON.stringify(result)).not.toContain(CANARY);
    const abort = new AbortController(); abort.abort();
    await expect(probeProviderConnection({ kind: 'openai-api', endpoint: null, key: CANARY }, { fetch: failing, signal: abort.signal })).rejects.toThrow();
  });

  it('refuses before any request: an unavailable kind, a missing required key, an endpoint that would leak the key', async () => {
    const seen: Parameters<typeof fakeFetch>[2] = [];
    const refused = async (input: Parameters<typeof probeProviderConnection>[0]) => {
      const error = await probeProviderConnection(input, { fetch: fakeFetch(200, '', seen) }).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderProbeError); expect(String((error as Error).message) + JSON.stringify(error)).not.toContain(CANARY);
      return (error as ProviderProbeError).code;
    };
    expect(await refused({ kind: 'chatgpt-login', endpoint: null, key: CANARY })).toBe('PROVIDER_KIND_UNAVAILABLE');
    expect(await refused({ kind: 'nope', endpoint: null, key: CANARY })).toBe('PROVIDER_KIND_UNAVAILABLE');
    expect(await refused({ kind: 'anthropic-api', endpoint: null, key: '' })).toBe('PROVIDER_KEY_REQUIRED');
    expect(await refused({ kind: 'local-openai', endpoint: 'http://192.168.1.5:8000', key: CANARY })).toBe('PROVIDER_ENDPOINT_INVALID');
    expect(await refused({ kind: 'local-openai', endpoint: 'https://user:pw@host.example', key: CANARY })).toBe('PROVIDER_ENDPOINT_INVALID');
    expect(await refused({ kind: 'local-openai', endpoint: null, key: null })).toBe('PROVIDER_ENDPOINT_INVALID');
    expect(seen).toEqual([]);
    expect(providerEndpoint('http://127.0.0.1:8000/v1/')).toEqual({ ok: true, base: 'http://127.0.0.1:8000' });
    expect(providerEndpoint('https://gw.example/openai/v1')).toEqual({ ok: true, base: 'https://gw.example/openai' });
    expect(providerEndpoint('https://gw.example/v1?key=x')).toEqual({ ok: false, reason: 'url-query' });
  });

  it('checks a real local server over loopback: a key it rejects, the key it accepts, no key when it needs none', async () => {
    const server = createServer((req, res) => {
      const auth = req.headers['authorization'];
      if (req.url !== '/v1/models') { res.writeHead(404).end(); return; }
      if (auth === undefined) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}'); return; }
      res.writeHead(auth === `Bearer ${CANARY}` ? 200 : 401, { 'content-type': 'application/json' }).end('{"data":[]}');
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    expect(await probeProviderConnection({ kind: 'local-openai', endpoint, key: CANARY })).toEqual({ outcome: 'ok', httpStatus: 200, key: 'unverified' });
    expect(await probeProviderConnection({ kind: 'local-openai', endpoint, key: 'wrong' })).toEqual({ outcome: 'credential-rejected', httpStatus: 401, key: 'unverified' });
    expect(await probeProviderConnection({ kind: 'local-openai', endpoint, key: null })).toEqual({ outcome: 'ok', httpStatus: 200, key: 'none' });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); servers.splice(0);
    expect(await probeProviderConnection({ kind: 'local-openai', endpoint, key: null }, { timeoutMs: 2000 })).toMatchObject({ outcome: 'unreachable', httpStatus: null });
  });
});
