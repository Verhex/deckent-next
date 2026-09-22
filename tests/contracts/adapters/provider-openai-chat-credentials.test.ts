import { createLocalTls } from '../../fixtures/local-tls.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createOpenAiChatNativePort, parseOpenAiChatHttpDefinition, type OpenAiChatHttpError } from '#adapters/core/provider-openai-chat/index.js';

const servers: HttpsServer[] = [];
let directory = '', certificate = '', privateKey = '';
const limits = { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 };
const request = { model: 'configured-model', messages: [{ role: 'user' as const, content: 'native text' }], max_completion_tokens: 12 };
const binding = { encodingVersion: 1, provider: { id: 'provider', version: 1 }, model: { id: 'model', version: 1,
  nativeId: 'configured-model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] } };
const response = (content = 'answer') => ({ id: 'chatcmpl-local', object: 'chat.completion', created: 1, model: 'configured-model',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'deckent-openai-credential-'));
  ({ key: privateKey, caPem: certificate } = await createLocalTls(directory));
});
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await rm(directory, { recursive: true, force: true });
});
async function fixture(handler: Parameters<typeof createServer>[1]) {
  const server = createServer({ key: privateKey, cert: certificate }, handler); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  return `https://127.0.0.1:${address.port}/`;
}
const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
function profile(endpoint: string, authentication: { type: 'none' } | { type: 'bearer'; credentialRef: string }, timeoutMs = 1000,
  responseMaxBytes = limits.responseMaxBytes) {
  return { schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope',
    reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 }, bindingDigest: 'a'.repeat(64),
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
      definition: { endpoint, maxOutputTokens: 32, authentication, tls: { caPem: certificate }, tariff } },
    allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 }, limits: { ...limits, timeoutMs, responseMaxBytes } };
}

it('resolves one exact bearer reference only during send and verifies the configured TLS authority', async () => {
  const secret = 'secret-token_123', references: string[] = []; let authorization: string | undefined;
  const endpoint = await fixture((req, res) => { authorization = req.headers.authorization; res.end(JSON.stringify(response())); });
  const port = createOpenAiChatNativePort({ async resolveCredential(reference) { references.push(reference); return secret; } });
  const prepared = await port.prepare(profile(endpoint, { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' }), binding, request);
  expect(JSON.stringify(prepared)).not.toContain(secret); expect(references).toEqual([]);
  await expect(port.send(prepared)).resolves.toMatchObject({ native: { model: 'configured-model' } });
  expect(references).toEqual(['PROVIDER_TOKEN']); expect(authorization).toBe(`Bearer ${secret}`);

  const untrusted = createOpenAiChatNativePort({ async resolveCredential() { return secret; } });
  const withoutAuthority = { ...profile(endpoint, { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' }),
    adapter: { id: 'openai-chat-http', version: 4, definition: { endpoint, maxOutputTokens: 32,
      authentication: { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' }, tariff } } };
  const token = await untrusted.prepare(withoutAuthority, binding, request);
  await expect(untrusted.send(token)).rejects.toMatchObject({ code: 'OPENAI_CHAT_TRANSPORT_UNKNOWN' } satisfies Partial<OpenAiChatHttpError>);

  const hostnamePort = createOpenAiChatNativePort({ async resolveCredential() { return secret; } });
  const hostnameProfile = profile(endpoint.replace('127.0.0.1', 'localhost'), { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' });
  const hostnameToken = await hostnamePort.prepare(hostnameProfile, binding, request);
  await expect(hostnamePort.send(hostnameToken)).rejects.toMatchObject({ code: 'OPENAI_CHAT_TRANSPORT_UNKNOWN' } satisfies Partial<OpenAiChatHttpError>);
});

it('accepts one valid public certificate and rejects private, multiple, or malformed TLS material', () => {
  const definition = { endpoint: 'https://provider.example/v1/chat', maxOutputTokens: 1,
    authentication: { type: 'none' as const }, tls: { caPem: certificate }, tariff };
  expect(parseOpenAiChatHttpDefinition(definition)).toMatchObject(definition);
  for (const caPem of [privateKey, `${certificate}${certificate}`, '-----BEGIN CERTIFICATE-----\nYWJjZA==\n-----END CERTIFICATE-----\n']) {
    expect(() => parseOpenAiChatHttpDefinition({ ...definition, tls: { caPem } })).toThrow('OPENAI_CHAT_DEFINITION_INVALID');
  }
});

it('rejects absent, invalid, or non-RFC6750 bearer credentials before a request', async () => {
  let requests = 0; const endpoint = await fixture((_req, res) => { requests++; res.end(JSON.stringify(response())); });
  for (const resolver of [undefined, async () => undefined, async () => '', async () => 'token with space', async () => 'token:colon']) {
    const port = createOpenAiChatNativePort(resolver ? { resolveCredential: resolver } : {});
    const prepared = await port.prepare(profile(endpoint, { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' }), binding, request);
    await expect(port.send(prepared)).rejects.toMatchObject({ code: 'OPENAI_CHAT_CREDENTIAL_UNAVAILABLE' } satisfies Partial<OpenAiChatHttpError>);
  }
  expect(requests).toBe(0);
});

it('never follows a redirect carrying bearer authorization', async () => {
  let targetRequests = 0;
  const target = await fixture((_req, res) => { targetRequests++; res.end(JSON.stringify(response())); });
  const endpoint = await fixture((_req, res) => { res.writeHead(307, { location: target }); res.end(); });
  const port = createOpenAiChatNativePort({ async resolveCredential() { return 'redirect-secret'; } });
  const prepared = await port.prepare(profile(endpoint, { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' }), binding, request);
  await expect(port.send(prepared)).resolves.toMatchObject({ kind: 'rejected', evidence: { reason: 'redirect' } });
  expect(targetRequests).toBe(0);
});

it('discards split raw or JSON-escaped credential echoes before evidence or parsing', async () => {
  const secret = 'known-secret'; let turn = 0;
  const endpoint = await fixture((_req, res) => {
    turn++;
    if (turn === 1) { res.write('{"echo":"known-'); setImmediate(() => res.end('secret"}')); return; }
    if (turn === 2) { res.writeHead(200); res.write('prefix known-sec'); setImmediate(() => res.socket?.destroy()); return; }
    res.end(JSON.stringify(response(`value:${secret}`)).replace(secret, 'known\\u002dsecret'));
  });
  for (let index = 0; index < 3; index++) {
    const port = createOpenAiChatNativePort({ async resolveCredential() { return secret; } });
    const prepared = await port.prepare(profile(endpoint, { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' }), binding, request);
    await expect(port.send(prepared)).rejects.toMatchObject({ code: 'OPENAI_CHAT_CREDENTIAL_ECHO' } satisfies Partial<OpenAiChatHttpError>);
  }
});

it('does not retain an escaped credential from a valid non-success JSON body', async () => {
  const secret = 'known-secret';
  const endpoint = await fixture((_req, res) => { res.writeHead(401); res.end('{"error":"known\\u002dsecret"}'); });
  const port = createOpenAiChatNativePort({ async resolveCredential() { return secret; } });
  const prepared = await port.prepare(profile(endpoint, { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' }), binding, request);
  await expect(port.send(prepared)).rejects.toMatchObject({ code: 'OPENAI_CHAT_CREDENTIAL_ECHO' } satisfies Partial<OpenAiChatHttpError>);
});

it('guards a retained cap ending inside a token and malformed split JSON escapes', async () => {
  const secret = 'known-secret'; let turn = 0;
  const endpoint = await fixture((_req, res) => {
    turn++;
    if (turn === 1) { res.end('padding:known\\u002dsecret:outside-cap'); return; }
    res.write('{"echo":"known\\u0'); setImmediate(() => { res.write('02dsec'); res.socket?.destroy(); });
  });
  const capped = createOpenAiChatNativePort({ async resolveCredential() { return secret; } });
  const cappedToken = await capped.prepare(profile(endpoint, { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' }, 1000,
    Buffer.byteLength('padding:known\\u002dsec')), binding, request);
  await expect(capped.send(cappedToken)).rejects.toMatchObject({ code: 'OPENAI_CHAT_CREDENTIAL_ECHO' } satisfies Partial<OpenAiChatHttpError>);
  const malformed = createOpenAiChatNativePort({ async resolveCredential() { return secret; } });
  const malformedToken = await malformed.prepare(profile(endpoint, { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' }), binding, request);
  await expect(malformed.send(malformedToken)).rejects.toMatchObject({ code: 'OPENAI_CHAT_CREDENTIAL_ECHO' } satisfies Partial<OpenAiChatHttpError>);
});

it('matches a self-overlapping credential across response chunks', async () => {
  const secret = 'ababaca';
  const endpoint = await fixture((_req, res) => { res.write('prefix-abab'); setImmediate(() => res.end('abaca-suffix')); });
  const port = createOpenAiChatNativePort({ async resolveCredential() { return secret; } });
  const prepared = await port.prepare(profile(endpoint, { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' }), binding, request);
  await expect(port.send(prepared)).rejects.toMatchObject({ code: 'OPENAI_CHAT_CREDENTIAL_ECHO' } satisfies Partial<OpenAiChatHttpError>);
});

it('bounds credential lookup by the whole deadline and ignores late resolution without a request', async () => {
  let requests = 0, release!: (value: string) => void;
  const endpoint = await fixture((_req, res) => { requests++; res.end(JSON.stringify(response())); });
  const pending = new Promise<string>(resolve => { release = resolve; });
  const port = createOpenAiChatNativePort({ async resolveCredential() { return pending; } });
  const prepared = await port.prepare(profile(endpoint, { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' }, 30), binding, request);
  await expect(port.send(prepared)).rejects.toMatchObject({ code: 'OPENAI_CHAT_TIMEOUT' } satisfies Partial<OpenAiChatHttpError>);
  release('late-secret'); await new Promise(resolve => setTimeout(resolve, 30)); expect(requests).toBe(0);
});

it('cancels credential lookup without allowing its late result to send', async () => {
  let requests = 0, release!: (value: string) => void, observedSignal: AbortSignal | undefined;
  const endpoint = await fixture((_req, res) => { requests++; res.end(JSON.stringify(response())); });
  const pending = new Promise<string>(resolve => { release = resolve; });
  const port = createOpenAiChatNativePort({ async resolveCredential(_reference, signal) { observedSignal = signal; return pending; } });
  const prepared = await port.prepare(profile(endpoint, { type: 'bearer', credentialRef: 'PROVIDER_TOKEN' }), binding, request);
  const controller = new AbortController(), sending = port.send(prepared, controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await expect(sending).rejects.toMatchObject({ code: 'OPENAI_CHAT_CANCELLED' } satisfies Partial<OpenAiChatHttpError>);
  expect(observedSignal?.aborted).toBe(true); release('late-secret'); await new Promise(resolve => setTimeout(resolve, 30)); expect(requests).toBe(0);
});
