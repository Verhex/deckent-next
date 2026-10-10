import { expect, it } from 'vitest';
import { connectionAdapter, providerEndpoint, providerConnectKind, readProviderConnectSeed, providerRequestDiagnosis,
  listProviderWorkspaces, providerProfileWorkspaceOffer, probeProviderConnection, providerProbeRejection } from '#adapters/core/provider-connect/index.js';
import { prepareOpenAiChatHttpRequest } from '#adapters/core/provider-openai-chat/index.js';
import { classifyProviderRejection, planProfileChanges } from '#engine/index.js';

async function profile(kindId: string, existing?: Record<string, unknown>) {
  const kind = providerConnectKind(kindId)!, seed = await readProviderConnectSeed(kind.connect!.seed!);
  const model = kindId === 'zai-cn-api' ? (await readProviderConnectSeed('zai-api')).providers[0]!.models[0]! : seed.providers[0]!.models[0]!;
  const buildKind = kindId === 'zai-cn-api' ? providerConnectKind('zai-api')! : kind;
  const built = connectionAdapter(buildKind, { endpoint: `${(providerEndpoint(buildKind.endpoint.default!) as { base: string }).base}${buildKind.connect!.chatPath}`,
    credentialRef: kind.key!.secretName, nativeId: model.nativeId, maxOutputTokens: 256, currency: 'USD', ...(existing ? { existing } : {}) });
  const adapter = kindId === 'zai-cn-api' ? { ...built.adapter, definition: { ...built.adapter.definition, endpoint: `${kind.endpoint.default}${kind.connect!.chatPath}` } } : built.adapter;
  return { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference: { providerId: seed.providers[0]!.id, providerVersion: 1, modelId: model.id, modelVersion: 1 },
    bindingDigest: 'a'.repeat(64), protocol: built.protocol, adapter,
    allocation: { id: 'allocation', maxCalls: 10, maxInFlight: 1 }, limits: { requestMaxBytes: 65536, responseMaxBytes: 65536, timeoutMs: 1000 } };
}

it.each(['openai-api', 'deepseek-api', 'zai-api', 'zai-cn-api', 'openrouter'])(
  'identifies the exact %s registry endpoint without a provider-id branch', async id => {
    const value = await profile(id, {}), kind = providerConnectKind(id)!;
    expect(providerRequestDiagnosis(value).labelKey).toBe(kind.labelKey);
    expect(providerRequestDiagnosis(value).migration).toBe(id === 'openai-api');
    const unknown = { ...value, adapter: { ...value.adapter, definition: { ...value.adapter.definition, endpoint: 'https://unknown.example/v1/chat/completions' } } };
    expect(providerRequestDiagnosis(unknown)).toMatchObject({ labelKey: null, migration: false, rejectionCodes: {} });
  });

it.each([['1113', 'spend-limit'], ['1302', 'rate-limit'], ['1305', 'limit-reached']])('classifies Z.ai business code %s only with its registry context', async (code, expected) => {
  const value = await profile('zai-api'), rules = providerRequestDiagnosis(value).rejectionCodes;
  const evidence = { reason: 'http-status' as const, httpStatus: 429, body: { data: Buffer.from(JSON.stringify({ error: { code } })).toString('base64') } };
  expect(classifyProviderRejection(evidence, rules)).toBe(expected);
  expect(classifyProviderRejection(evidence)).toBe('limit-reached');
  expect(classifyProviderRejection({ ...evidence, httpStatus: 400 }, rules)).toBeNull();
  expect(classifyProviderRejection({ ...evidence, body: {} }, rules)).toBe('limit-reached');
});

it('narrows DeepSeek tool choice even for a legacy profile that still advertises required', async () => {
  const value = await profile('deepseek-api'), definition = { ...value.adapter.definition,
    dialect: { tokenLimitField: 'max_tokens', streamUsage: 'include', toolChoice: ['auto', 'none', 'required'] } };
  const model = (definition['tariff'] as { modelId: string }).modelId;
  const request = { model, messages: [{ role: 'user', content: 'use tool' }], max_completion_tokens: 64,
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] };
  expect(() => prepareOpenAiChatHttpRequest(definition, value.limits, { ...request, tool_choice: 'required' })).toThrow('OPENAI_CHAT_REQUEST_INVALID');
  for (const tool_choice of ['auto', 'none']) expect(prepareOpenAiChatHttpRequest(definition, value.limits, { ...request, tool_choice }).body).toContain(`"tool_choice":"${tool_choice}"`);
});

it.each(['zai-api', 'zai-cn-api'])('seeds a conservative Flash window in %s without changing other unknown windows', async name => {
  const seed = await readProviderConnectSeed(name), flash = seed.providers[0]!.models.find(row => row.id === 'glm-4.7-flash');
  expect(flash).toMatchObject({ contextWindow: 200000 });
});

it('discovers paginated workspaces on the pinned free route and preserves the chosen header on reconnect', async () => {
  const value = await profile('anthropic-api'), seen: string[] = [];
  const choices = await listProviderWorkspaces(value, 'fixture-key', { fetch: async (url, init) => {
    seen.push(url); expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { authorization: 'Bearer fixture-key' } });
    expect(new URL(url).origin).toBe('https://api.anthropic.com');
    return new Response(JSON.stringify({ data: [{ id: seen.length === 1 ? 'wrkspc_First' : 'wrkspc_Second', name: 'Team', archived_at: null }], has_more: seen.length === 1, last_id: 'wrkspc_First' }), { status: 200 });
  } });
  expect(choices.map(row => row.id)).toEqual(['wrkspc_First', 'wrkspc_Second']);
  expect(seen[0]).toContain('include_default=true'); expect(seen[1]).toContain('after_id=wrkspc_First');
  expect(providerProfileWorkspaceOffer(value, { id: 'wrkspc_Forged', name: 'Team' }, choices)).toBeNull();
  const offered = providerProfileWorkspaceOffer(value, choices[1]!, choices)!;
  expect(offered.next).toMatchObject({ version: 2, adapter: { definition: { workspaceId: 'wrkspc_Second' } } });
  const kind = providerConnectKind('anthropic-api')!;
  const rebuilt = connectionAdapter(kind, { endpoint: value.adapter.definition['endpoint'] as string,
    credentialRef: kind.key!.secretName, nativeId: (value.adapter.definition['tariff'] as { modelId: string }).modelId,
    maxOutputTokens: 256, currency: 'USD', existing: offered.next.adapter.definition });
  expect(rebuilt.adapter.definition['workspaceId']).toBe('wrkspc_Second');
  const document = { provider_invocation_profiles: { schemaVersion: 1, profiles: [value, { ...value, id: 'foreign', scopeId: 'other' }] } };
  const plan = planProfileChanges({ global: {}, project: document }, 'scope', item => providerProfileWorkspaceOffer(item, choices[1]!, choices));
  expect((plan.writes[0]!.value['profiles'] as typeof value[])[1]).toEqual(document.provider_invocation_profiles.profiles[1]);
});

it.each(['redirect', 'oversize', 'loop', 'bad-id', 'invalid-json'] as const)('refuses %s workspace discovery without returning a partial choice', async mode => {
  const value = await profile('anthropic-api'); let calls = 0;
  await expect(listProviderWorkspaces(value, 'fixture-key', { fetch: async () => {
    calls++;
    if (mode === 'redirect') return new Response('', { status: 307, headers: { location: 'https://foreign.example' } });
    if (mode === 'oversize') return new Response(' '.repeat(262145));
    if (mode === 'invalid-json') return new Response('{');
    return new Response(JSON.stringify({ data: [{ id: mode === 'bad-id' ? 'bad\r\nheader' : 'wrkspc_First', name: 'Team', archived_at: null }], has_more: mode === 'loop', last_id: 'wrkspc_First' }));
  } })).rejects.toThrow();
  expect(calls).toBe(mode === 'loop' ? 2 : 1);
});

it('allows storing a multi-workspace key only after its documented missing-header error and a successful free workspace list', async () => {
  const urls: string[] = [];
  const probe = await probeProviderConnection({ kind: 'anthropic-api', endpoint: null, key: 'fixture-key' }, { fetch: async url => {
    urls.push(url);
    return urls.length === 1 ? new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'anthropic-workspace-id is required when authenticating with an identity-linked API key; send the id of the workspace this request acts in.' } }), { status: 400 })
      : new Response(JSON.stringify({ data: [{ id: 'wrkspc_First', name: 'Team', archived_at: null }], has_more: false, last_id: 'wrkspc_First' }));
  } });
  expect(probe).toEqual({ outcome: 'ok', httpStatus: 200, key: 'unverified', workspaceRequired: true }); expect(urls).toHaveLength(2);
  expect(urls[1]).toContain('/v1/organizations/workspaces');
});

it.each([['1113', 'spend-limit'], ['1302', 'rate-limit']])('maps connection rejection code %s only with Z.ai registry context', (code, outcome) => {
  const body = JSON.stringify({ error: { code } });
  expect(providerProbeRejection(429, body, providerConnectKind('zai-api')!.connect!.rejectionCodes)).toBe(outcome);
  expect(providerProbeRejection(429, body)).toBe('limit-reached');
});
