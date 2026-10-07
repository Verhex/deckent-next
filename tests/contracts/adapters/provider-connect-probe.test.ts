import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { PROVIDER_CONNECT_KINDS, ProviderProbeError, probeProviderConnection, providerEndpoint, providerProbeRejection, type ProviderProbeFetch } from '#adapters/core/provider-connect/index.js';

// T4 PROVIDER-CONNECT: the connection check is one free request that needs the key, mapped to the secret lane's rejection kinds. The key is a
// canary: it may reach only the request header, never a result, an error or anything the caller could print.
const CANARY = 'sk-canary-T4-6f1d2e9c0b7a';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });

function fakeFetch(status: number, body = '', seen: { url: string; headers: Record<string, string>; redirect: string }[] = []): ProviderProbeFetch {
  return async (url, init) => { seen.push({ url, headers: init.headers, redirect: init.redirect }); return new Response(body || null, { status }); };
}

describe('provider connection check', () => {
  it('lists the four connect kinds and ChatGPT login as not available yet, each with a free probe and a store name', () => {
    expect(PROVIDER_CONNECT_KINDS.map(kind => [kind.id, kind.available])).toEqual([['anthropic-api', true], ['openai-compatible', true], ['openrouter', true],
      ['local-openai', true], ['chatgpt-login', false]]);
    for (const kind of PROVIDER_CONNECT_KINDS.filter(item => item.available)) {
      expect(kind.probe!.path).toMatch(/^\/(v1\/models|api\/v1\/key)/u);
      expect(kind.key!.secretName).toMatch(/^DECKENT_[A-Z_]+$/u);
    }
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
      [429, '{"error":{"type":"rate_limit_error","error_code":"enforced_spend_limit_reached"}}', 'spend-limit'],
      [429, '{"error":{"code":"insufficient_quota"}}', 'spend-limit'], [429, '{"error":{"type":"rate_limit_error"}}', 'rate-limit'], [429, '', 'limit-reached'],
      [400, '{"error":{"message":"You have reached your specified workspace API usage limits"}}', 'spend-limit'], [400, '{}', 'unexpected'],
      [302, '', 'unexpected'], [404, '', 'unexpected'], [503, '', 'unreachable']];
    for (const [status, body, outcome] of cases) {
      const result = await probeProviderConnection({ kind: 'openai-compatible', endpoint: null, key: CANARY }, { fetch: fakeFetch(status, `${body}${CANARY}`.slice(0, body ? undefined : 0)) });
      expect(result).toEqual({ outcome, httpStatus: status, key: 'unverified' });
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
    expect(providerProbeRejection(429, null)).toBe('limit-reached');
  });

  it('a network failure or a timeout is unreachable without any detail; a caller abort is the caller\'s', async () => {
    const failing: ProviderProbeFetch = async () => { throw new Error(`connect ECONNREFUSED with ${CANARY}`); };
    const result = await probeProviderConnection({ kind: 'openai-compatible', endpoint: null, key: CANARY }, { fetch: failing });
    expect(result).toEqual({ outcome: 'unreachable', httpStatus: null, key: 'unverified' }); expect(JSON.stringify(result)).not.toContain(CANARY);
    const abort = new AbortController(); abort.abort();
    await expect(probeProviderConnection({ kind: 'openai-compatible', endpoint: null, key: CANARY }, { fetch: failing, signal: abort.signal })).rejects.toThrow();
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
