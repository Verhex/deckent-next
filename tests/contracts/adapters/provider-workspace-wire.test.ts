import { afterEach, expect, it, vi } from 'vitest';
import * as http from '#adapters/core/provider-http-json/index.js';
import { connectionAdapter, providerConnectKind } from '#adapters/core/provider-connect/index.js';
import { createAnthropicMessagesPricedNative } from '#adapters/core/provider-anthropic-messages/index.js';
afterEach(() => vi.restoreAllMocks());

it.each([undefined, 'wrkspc_Selected'])('passes selected workspace %s to the real transport port for count and generation', async workspaceId => {
  const kind = providerConnectKind('anthropic-api')!, model = 'claude-sonnet-5-5';
  const connected = connectionAdapter(kind, { endpoint: 'https://api.anthropic.com/v1/messages', credentialRef: 'FIXTURE_KEY', nativeId: model,
    maxOutputTokens: 256, currency: 'USD', ...(workspaceId ? { existing: { workspaceId } } : {}) });
  const seen: Array<{ endpoint: string; headers: unknown }> = [];
  vi.spyOn(http, 'sendNativeJsonHttp').mockImplementation(async request => {
    seen.push({ endpoint: request.definition.endpoint, headers: request.headers });
    return { schemaVersion: 1, native: { count: 25 }, usage: null };
  });
  const definition = { encodingVersion: 1, provider: { id: 'provider', version: 1 }, model: { id: 'model', version: 1, nativeId: model,
    protocols: [{ family: connected.protocol.family, version: connected.protocol.version, capabilities: [{ id: 'token-count', version: 1, state: 'supported' }] }] } };
  const profile = { schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope', reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 },
    bindingDigest: 'a'.repeat(64), adapter: connected.adapter, protocol: connected.protocol, allocation: { id: 'allocation', maxCalls: 10, maxInFlight: 1 },
    limits: { requestMaxBytes: 65536, responseMaxBytes: 65536, timeoutMs: 1000 } };
  const priced = createAnthropicMessagesPricedNative(), prepared = await priced.native.prepare(profile as never, definition as never,
    { model, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 64 });
  await priced.native.send(prepared);
  expect(seen.map(row => row.endpoint)).toEqual(['https://api.anthropic.com/v1/messages/count_tokens', 'https://api.anthropic.com/v1/messages']);
  for (const row of seen) {
    expect(row.headers).toMatchObject({ 'anthropic-version': '2023-06-01' });
    if (workspaceId) expect(row.headers).toHaveProperty('anthropic-workspace-id', workspaceId);
    else expect(row.headers).not.toHaveProperty('anthropic-workspace-id');
  }
});
