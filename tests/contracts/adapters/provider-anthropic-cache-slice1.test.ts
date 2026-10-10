import { describe, expect, it } from 'vitest';
import { ANTHROPIC_PROMPT_OVERHEAD_TOKENS, anthropicMaxChargeMinorUnits, anthropicMessagesBody, anthropicPublishedTariff, createAnthropicMessagesPricedNative,
  parseAnthropicMessagesDefinition, type AnthropicPublishedTariff } from '#adapters/core/provider-anthropic-messages/index.js';
import { PROVIDER_CONNECT_REGISTRY, connectionAdapter, parseProviderConnectRegistry, providerConnectKind, providerEndpoint, providerProfileCacheOffer,
  readProviderConnectSeed } from '#adapters/core/provider-connect/index.js';
import { ModelConnectApplication, modelInvocationProfileDigest, modelInvocationRequestDigest, planProfileCache, settledProviderCacheUsage, type ModelConnectPorts } from '#engine/index.js';
import type { JsonObject } from '#domain/index.js';

// CACHE-SLICE1 (owner 2026-10-09, card cards/lanes/CACHE-SLICE1-2026-10-09.md): new interactive Anthropic profiles start with the 5-minute cache from
// the connect registry; an existing profile is never changed silently (absent stays absent, `none` stays `none`); every reservation assumes a miss
// plus the cache write plus the full output; the profile's own value — never the registry default — decides each call.
const anthropic = providerConnectKind('anthropic-api')!;
/** The adapter's registry safety margin on a provider count (`reservation-defaults.json`, package-private; pinned here as the reviewed value). */
const reservation = { countSafetyPercent: 25 };
const SONNET = 'claude-sonnet-5-5', ENDPOINT = 'https://api.anthropic.com/v1/messages';
const adapterInput = (existing?: JsonObject | null) => ({ endpoint: ENDPOINT, credentialRef: 'DECKENT_ANTHROPIC_KEY', nativeId: SONNET, maxOutputTokens: 4096, currency: 'USD',
  ...(existing === undefined ? {} : { existing }) });
const definitionOf = (built: ReturnType<typeof connectionAdapter>) => built.adapter.definition as Record<string, unknown>;

describe('connect registry data: the cache default of new profiles', () => {
  it('the shipped anthropic-api row defaults new profiles to 5m; the adapter writes it, and keeps an existing profile as it is', () => {
    expect(anthropic.connect?.cacheDefault).toBe('5m');
    expect(definitionOf(connectionAdapter(anthropic, adapterInput()))).toMatchObject({ cache: '5m' });
    expect(definitionOf(connectionAdapter(anthropic, adapterInput(null)))).toMatchObject({ cache: '5m' });
    // An existing profile written before the default: the field stays absent (no silent paid change on a re-run).
    expect('cache' in definitionOf(connectionAdapter(anthropic, adapterInput({ endpoint: ENDPOINT })))).toBe(false);
    for (const kept of ['none', '5m', '1h']) expect(definitionOf(connectionAdapter(anthropic, adapterInput({ cache: kept })))['cache']).toBe(kept);
  });

  it('the registry refuses a 1h default and a cache default on a non-Anthropic row (negative)', () => {
    const row = (connect: Record<string, unknown>) => ({ ...PROVIDER_CONNECT_REGISTRY, kinds: [{ ...anthropic, connect: { ...anthropic.connect, ...connect } }] });
    expect(() => parseProviderConnectRegistry(row({ cacheDefault: '1h' }))).toThrow();
    const openai = providerConnectKind('openai-api')!;
    expect(() => parseProviderConnectRegistry({ ...PROVIDER_CONNECT_REGISTRY, kinds: [{ ...openai, connect: { ...openai.connect, cacheDefault: '5m' } }] })).toThrow();
    expect(parseProviderConnectRegistry(row({ cacheDefault: 'none' })).kinds[0]!.connect?.cacheDefault).toBe('none');
  });
});

/** `models.connect` over in-memory governed ports: the config writes are recorded, everything else is already in place. */
function connectHarness(project: Record<string, unknown>, global: Record<string, unknown> = {}) {
  const writes: { keyPath: string; value: unknown; layer: string }[] = [], state = { project: structuredClone(project), global: structuredClone(global) };
  const digest = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'd'.repeat(64) };
  const ports: ModelConnectPorts = {
    kind: id => { const kind = providerConnectKind(id); return kind && { id: kind.id, available: kind.available, endpoint: kind.endpoint, keyRequired: true, connect: kind.connect }; },
    defaults: PROVIDER_CONNECT_REGISTRY.profileDefaults,
    endpoint: text => { const checked = providerEndpoint(text); return checked.ok ? checked.base : null; },
    secretName: () => 'DECKENT_ANTHROPIC_KEY', seed: readProviderConnectSeed,
    adapter: (id, value) => connectionAdapter(providerConnectKind(id)!, value),
    principal: async () => ({ issuer: 'local', subject: 'me' }) as never,
    layers: async () => ({ global: state.global, project: state.project, effective: { ...state.global, ...state.project } }),
    write: async change => { writes.push({ keyPath: change.keyPath, value: change.value, layer: change.layer });
      state[change.layer] = { ...state[change.layer], [change.keyPath]: change.value }; return null; },
    catalogHas: async () => true, register: async () => undefined,
    binding: async () => ({ status: 'declared', catalogRevision: 'catalog', definition: {} as never, binding: digest }),
    activation: async () => ({ state: 'active', catalogRevision: 'catalog', binding: digest, revision: 1 }) as never,
    activate: async () => undefined, delivers: () => true, audit: async () => undefined, policyRevision: async () => 'policy', keyStored: async () => true,
    service: async () => 'current',
  };
  return { app: new ModelConnectApplication(ports, () => 1), writes, state };
}
const connectCommand = { schemaVersion: 1, commandId: 'connect-cache', scopeId: 'scope', connection: 'anthropic-api', endpoint: null, model: { nativeId: SONNET } };
const profileWrites = (writes: readonly { keyPath: string; value: unknown }[]) => writes.filter(write => write.keyPath === 'provider_invocation_profiles')
  .map(write => (write.value as { profiles: { adapter: { definition: Record<string, unknown> }; version: number }[] }).profiles);

describe('models.connect writes the cache default only for a new profile', () => {
  it('keeps each authored layer context window and copies it from the sibling when a profile is missing', async () => {
    const first = connectHarness({}); await first.app.connect(connectCommand);
    const written = (first.state.project['provider_invocation_profiles'] as { profiles: Record<string, unknown>[] }).profiles[0]!;
    const globalProfile = { ...written, contextWindowTokens: 800_000 }, projectProfile = { ...written, contextWindowTokens: 600_000 };
    const foreignScope = { ...written, scopeId: 'another', contextWindowTokens: 400_000 };
    for (const profiles of [[projectProfile, foreignScope], [foreignScope]]) {
      const run = connectHarness({ ...first.state.project, provider_invocation_profiles: { schemaVersion: 1, profiles } },
        { provider_invocation_profiles: { schemaVersion: 1, profiles: [globalProfile] } });
      await run.app.connect({ ...connectCommand, commandId: `context-layers-${profiles.length}` });
      expect(run.state.global['provider_invocation_profiles']).toEqual({ schemaVersion: 1, profiles: [globalProfile] });
      const result = (run.state.project['provider_invocation_profiles'] as { profiles: Record<string, unknown>[] }).profiles;
      expect(result.find(profile => profile['scopeId'] === 'scope')!['contextWindowTokens']).toBe(profiles.length === 2 ? 600_000 : 800_000);
      expect(result.find(profile => profile['scopeId'] === 'another')).toEqual(foreignScope);
      run.writes.length = 0;
      expect((await run.app.connect({ ...connectCommand, commandId: `context-repeat-${profiles.length}` })).steps.profile).toBe('present');
      expect(profileWrites(run.writes)).toEqual([]);
    }
  });

  it('both layers author profiles and only the user layer has this one (no cache field): the project copy is written equal to it, without a cache field', async () => {
    const first = connectHarness({});
    await first.app.connect(connectCommand);
    const written = (first.state.project['provider_invocation_profiles'] as { profiles: { adapter: { definition: Record<string, unknown> } }[] }).profiles[0]!;
    const definition = { ...written.adapter.definition }; delete definition['cache'];
    const legacy = { ...written, adapter: { ...written.adapter, definition } };
    const run = connectHarness({ provider_catalog: first.state.project['provider_catalog'], provider_invocation_profiles: { schemaVersion: 1, profiles: [] } },
      { provider_invocation_profiles: { schemaVersion: 1, profiles: [legacy] } });
    await run.app.connect({ ...connectCommand, commandId: 'both-layers' });
    const project = run.writes.filter(write => write.keyPath === 'provider_invocation_profiles');
    expect(project.map(write => write.layer)).toEqual(['project']);
    expect((project[0]!.value as { profiles: unknown[] }).profiles).toEqual([legacy]);
  });

  it('a new Anthropic profile is written with cache 5m; the same command again changes nothing', async () => {
    const run = connectHarness({});
    expect((await run.app.connect(connectCommand)).steps.profile).toBe('written');
    const [profiles] = profileWrites(run.writes);
    expect(profiles).toHaveLength(1);
    expect(profiles![0]!.adapter.definition).toMatchObject({ cache: '5m', tariff: { modelId: SONNET } });
    run.writes.length = 0;
    expect((await run.app.connect({ ...connectCommand, commandId: 'connect-cache-2' })).steps.profile).toBe('present');
    expect(profileWrites(run.writes)).toEqual([]);
  });

  it('an existing profile without a cache field, or with an explicit none, is left exactly as it is (negative: no silent migration)', async () => {
    const first = connectHarness({});
    await first.app.connect(connectCommand);
    const written = (first.state.project['provider_invocation_profiles'] as { profiles: { adapter: { definition: Record<string, unknown> } }[] }).profiles[0]!;
    for (const variant of ['absent', 'none'] as const) {
      const definition = { ...written.adapter.definition };
      if (variant === 'absent') delete definition['cache']; else definition['cache'] = 'none';
      const profile = { ...written, adapter: { ...written.adapter, definition } };
      const run = connectHarness({ ...first.state.project, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] } });
      expect((await run.app.connect({ ...connectCommand, commandId: `again-${variant}` })).steps.profile).toBe('present');
      expect(profileWrites(run.writes)).toEqual([]);
      expect((run.state.project['provider_invocation_profiles'] as { profiles: unknown[] }).profiles).toEqual([profile]);
    }
  });
});

const sonnet = anthropicPublishedTariff(SONNET) as AnthropicPublishedTariff;
/** Rate in units of 0.0001 USD per MTok; minor units = ceil(sum(tokens x units) / 1e8). */
const u = (rate: string) => Math.round(Number(rate) * 10_000);
const expected = (inputTokens: number, inputRate: string, maxTokens: number) => Math.ceil((inputTokens * u(inputRate) + maxTokens * u(sonnet.usdPerMTok.output)) / 1e8);

describe('reservation always assumes a miss plus the cache write plus the full output', () => {
  it.each([['none', 'input'], ['5m', 'cacheWrite5m'], ['1h', 'cacheWrite1h']] as const)('cache %s: every input token at the %s rate, every output token reserved', (cache, rate) => {
    const bytes = 400_000, maxTokens = 16_384, inputTokens = bytes + ANTHROPIC_PROMPT_OVERHEAD_TOKENS;
    expect(anthropicMaxChargeMinorUnits(sonnet, cache, bytes, maxTokens)).toBe(expected(inputTokens, sonnet.usdPerMTok[rate], maxTokens));
    // The provider count path: count + safety percentage + overhead, the same rate rule.
    const counted = 120_000, bound = counted + Math.ceil(counted * reservation.countSafetyPercent / 100) + ANTHROPIC_PROMPT_OVERHEAD_TOKENS;
    expect(anthropicMaxChargeMinorUnits(sonnet, cache, bytes, maxTokens, counted)).toBe(expected(bound, sonnet.usdPerMTok[rate], maxTokens));
  });

  it('never prices a cache read in advance: a cached reservation is at least the uncached one, never below it', () => {
    for (const [bytes, maxTokens] of [[1, 1], [10_000, 1_024], [900_000, 64_000]] as const) {
      const none = anthropicMaxChargeMinorUnits(sonnet, 'none', bytes, maxTokens), five = anthropicMaxChargeMinorUnits(sonnet, '5m', bytes, maxTokens);
      expect(five).toBeGreaterThanOrEqual(none);
      expect(anthropicMaxChargeMinorUnits(sonnet, '1h', bytes, maxTokens)).toBeGreaterThanOrEqual(five);
      // The read rate would undercut the miss: the reservation is strictly above that figure for any real prompt.
      expect(none).toBeGreaterThanOrEqual(expected(bytes + ANTHROPIC_PROMPT_OVERHEAD_TOKENS, sonnet.usdPerMTok.cacheRead, maxTokens));
    }
  });
});

describe('each call honours its own profile, not the registry default (model switch, fallback and worker calls read the same profile)', () => {
  const reference = { providerId: 'anthropic-api', providerVersion: 1, modelId: SONNET, modelVersion: 1 };
  const binding = { encodingVersion: 1, provider: { id: 'anthropic-api', version: 1 }, model: { id: SONNET, version: 1, nativeId: SONNET,
    protocols: [{ family: 'anthropic-messages', version: '2023-06-01', capabilities: [] }] } };
  const stored = (cache?: 'none' | '5m') => ({ schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: 'a'.repeat(64),
    protocol: { family: 'anthropic-messages', version: '2023-06-01' }, adapter: { id: 'anthropic-messages-http', version: 2,
      definition: { endpoint: 'https://127.0.0.1:9/v1/messages', maxOutputTokens: 256, authentication: { type: 'header', name: 'x-api-key', credentialRef: 'K' },
        tariff: sonnet, ...(cache ? { cache } : {}) } },
    allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 }, limits: { requestMaxBytes: 1_048_576, responseMaxBytes: 65_536, timeoutMs: 3000 } });
  async function prepared(cache?: 'none' | '5m') {
    const priced = createAnthropicMessagesPricedNative({ resolveCredential: async () => 'sk-ant-test' }), profile = stored(cache);
    const request = { model: SONNET, messages: [{ role: 'user' as const, content: 'hello' }], max_completion_tokens: 256, stream: true, stream_options: { include_usage: true } };
    const command = { schemaVersion: 1 as const, commandId: 'command', scopeId: 'scope', reference, catalogRevision: 'catalog',
      expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'a'.repeat(64) }, nativeRequest: request };
    const token = await priced.native.prepare(profile, binding, request);
    const quote = priced.quote({ command, requestDigest: modelInvocationRequestDigest(command), profile, profileDigest: modelInvocationProfileDigest(profile),
      definition: binding, prepared: token } as never);
    // The wire body the prepared call sends is built from this same profile definition (the prepared token is opaque here).
    const wire = anthropicMessagesBody({ model: SONNET, messages: request.messages, max_completion_tokens: 256 }, parseAnthropicMessagesDefinition(profile.adapter.definition), 'scope') as Record<string, unknown>;
    return { wire, cache: (quote.meter.evidence as { calculation: { cache: string } }).calculation.cache };
  }
  it('explicit none: no cache_control on the wire and a none quote, although new profiles default to 5m', async () => {
    expect(anthropic.connect?.cacheDefault).toBe('5m');
    for (const cache of ['none', undefined] as const) {
      const call = await prepared(cache);
      expect('cache_control' in call.wire).toBe(false); expect(call.cache).toBe('none');
    }
    const cached = await prepared('5m');
    expect(cached.wire['cache_control']).toEqual({ type: 'ephemeral' }); expect(cached.cache).toBe('5m');
  });
});

describe('the governed migration of existing profiles', () => {
  const base = (definition: Record<string, unknown>, scopeId = 'scope', id = 'anthropic') => ({ schemaVersion: 1, id, version: 3, scopeId,
    reference: { providerId: 'anthropic-api', providerVersion: 1, modelId: id, modelVersion: 1 }, adapter: { id: 'anthropic-messages-http', version: 2,
      definition: { endpoint: ENDPOINT, maxOutputTokens: 4096, authentication: { type: 'header', name: 'x-api-key', credentialRef: 'K' }, tariff: sonnet, ...definition } } });
  it('offers 5m only for an Anthropic profile without a cache field, with its own tariff ratios and the next version', () => {
    const offer = providerProfileCacheOffer(base({}));
    expect(offer).toMatchObject({ ttl: '5m', modelId: SONNET, writeRatio: 1.25, readRatio: 0.05, next: { version: 4, adapter: { definition: { cache: '5m' } } } });
    for (const cache of ['none', '5m', '1h']) expect(providerProfileCacheOffer(base({ cache }))).toBeNull();
    expect(providerProfileCacheOffer({ ...base({}), adapter: { id: 'openai-chat-http', version: 5, definition: {} } })).toBeNull();
  });

  it('plans the governed writes for this scope only; other profiles and scopes stay byte-identical; a copy in both layers is named, not changed', () => {
    const offered = base({}, 'scope', 'sonnet'), none = base({ cache: 'none' }, 'scope', 'kept'), other = base({}, 'other-scope', 'theirs');
    const plan = planProfileCache({ global: { provider_invocation_profiles: { schemaVersion: 1, profiles: [offered, other, none] } },
      project: { provider_invocation_profiles: { schemaVersion: 1, profiles: [none] } } }, 'scope', providerProfileCacheOffer);
    expect(plan.models).toEqual([{ reference: offered.reference, ttl: '5m', modelId: SONNET, writeRatio: 1.25, readRatio: 0.05 }]);
    expect(plan.writes.map(write => write.layer)).toEqual(['global']); expect(plan.shared).toEqual([]);
    const [global] = plan.writes.map(write => (write.value as { profiles: Record<string, unknown>[] }).profiles);
    expect(global![1]).toEqual(other); expect(global![2]).toEqual(none);
    expect(global![0]).toMatchObject({ version: 4, adapter: { definition: { cache: '5m' } } });
    // Project-only authoring: the project layer is the one written.
    expect(planProfileCache({ global: {}, project: { provider_invocation_profiles: { schemaVersion: 1, profiles: [none, offered] } } }, 'scope', providerProfileCacheOffer)
      .writes.map(write => write.layer)).toEqual(['project']);
    // The same profile in both layers: the layer rule (project = a copy of a user-layer profile) admits no single-layer write; named, not written.
    expect(planProfileCache({ global: { provider_invocation_profiles: { schemaVersion: 1, profiles: [offered] } }, project: { provider_invocation_profiles: { schemaVersion: 1,
      profiles: [offered] } } }, 'scope', providerProfileCacheOffer)).toEqual({ models: [], writes: [], shared: [offered.reference] });
    expect(planProfileCache({ global: {}, project: { provider_invocation_profiles: { schemaVersion: 1, profiles: [none] } } }, 'scope', providerProfileCacheOffer))
      .toEqual({ models: [], writes: [], shared: [] });
  });
});

describe('settled cache usage for /usage', () => {
  const settled = (dimensions: { field: string; tokens: number; usdPerMillionTokens: string }[], id = 'anthropic-usage-tariff') => ({
    disposition: { state: 'settled-measured-tariff' }, measurement: { basis: 'measured-tariff', source: { id, version: 1, dimensions } } }) as never;
  it('keeps the raw read, 5m and 1h classes and the same-request net benefit (read savings minus write premium)', () => {
    const usage = settledProviderCacheUsage(settled([{ field: 'input', tokens: 1_000, usdPerMillionTokens: '2' }, { field: 'cache-read', tokens: 100_000, usdPerMillionTokens: '0.1' },
      { field: 'cache-write-5m', tokens: 20_000, usdPerMillionTokens: '2.5' }, { field: 'cache-write-1h', tokens: 5_000, usdPerMillionTokens: '4' },
      { field: 'output', tokens: 500, usdPerMillionTokens: '10' }]));
    // Savings 100,000 x (2 - 0.1) = 190,000; premium 20,000 x 0.5 + 5,000 x 2 = 20,000; net 170,000 token-USD/MTok = $0.17.
    expect(usage).toEqual({ readTokens: 100_000, writeTokens: 25_000, promptTokens: 126_000, write5mTokens: 20_000, write1hTokens: 5_000, netBenefitUsdE10: 170_000 * 10_000 });
    // Only writes, no read: a negative benefit is reported as it is.
    expect(settledProviderCacheUsage(settled([{ field: 'input', tokens: 10, usdPerMillionTokens: '2' }, { field: 'cache-read', tokens: 0, usdPerMillionTokens: '0.1' },
      { field: 'cache-write-5m', tokens: 1_000_000, usdPerMillionTokens: '2.5' }]))?.netBenefitUsdE10).toBe(-0.5 * 1e10);
    // OpenAI-compatible classes map to the same benefit rule.
    expect(settledProviderCacheUsage(settled([{ field: 'input', tokens: 10, usdPerMillionTokens: '5' }, { field: 'cached-input', tokens: 1_000_000, usdPerMillionTokens: '0.5' }],
      'openai-compatible-usage-tariff'))).toMatchObject({ readTokens: 1_000_000, write5mTokens: 0, write1hTokens: 0, netBenefitUsdE10: 4.5 * 1e10 });
  });
});
