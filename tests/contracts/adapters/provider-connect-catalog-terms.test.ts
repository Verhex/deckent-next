import * as http from '#adapters/core/provider-http-json/index.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_CONNECT_KINDS, connectionAdapter, providerConnectKind, providerEndpoint, readProviderConnectSeed } from '#adapters/core/provider-connect/index.js';
import { anthropicPublishedTariff, anthropicSettledCharge, createAnthropicMessagesPricedNative } from '#adapters/core/provider-anthropic-messages/index.js';
import { createOpenAiChatPricedNative, lookupOpenAiCompatibleTariff } from '#adapters/core/provider-openai-chat/index.js';
import { parseProviderCatalogDocument, type CatalogModel, type ProviderCatalogDocument } from '#domain/index.js';
import { createProviderSpendAccount, modelInvocationProfileDigest, modelInvocationRequestDigest, providerSpendQuoteDigest, reserveProviderSpend,
  settleProviderSpend } from '#engine/index.js';

// M4 (owner 2026-10-23: a new model works through a data update, never a code change). A registered catalog v3 row carries the invocation
// adapter's own terms for its exact model (`connect.tariff`, `connect.route`); `models connect` builds the profile from them when the shipped
// adapter tables have no row for that model. The shipped tables stay first for every model they list (existing profiles keep their bytes).
// The model ids below are synthetic test-only ids: no src table names them.
afterEach(() => { vi.restoreAllMocks(); });
const FABLE = 'claude-fable-6-test', SOL = 'gpt-sol-7-test', ROUTED = 'openai/gpt-sol-7-test';
const SOURCE = { url: 'https://platform.claude.com/docs/en/about-claude/pricing', retrievedAt: '2026-10-23' };
const fableTariff = { kind: 'anthropic-published', version: 1, currency: 'USD', modelId: FABLE,
  usdPerMTok: { input: '12', cacheWrite5m: '15', cacheWrite1h: '24', cacheRead: '0.3', output: '60' }, source: SOURCE };
const solTariff = (endpoint: string) => ({ kind: 'vendor-published', version: 1, vendor: 'openai', currency: 'USD', modelId: SOL, endpoint,
  usdPerMTok: { input: '3', cachedInput: '0.3', output: '15' }, source: { url: 'https://developers.openai.com/api/docs/pricing', retrievedAt: '2026-10-23' } });
const responsesRoute = { path: '/v1/responses', dialect: { tokenLimitField: 'max_completion_tokens', streamUsage: 'omit', toolChoice: ['auto', 'none', 'required'],
  protocol: 'responses', reasoningEfforts: ['low', 'medium', 'high'], reasoningEffort: 'medium' },
  source: { url: 'https://developers.openai.com/api/docs/models/gpt-sol-7-test', observedOn: '2026-10-23' } };
const routerRoute = { endpointTag: 'openai', tokenLimitField: 'max_tokens', sourceUrl: `https://openrouter.ai/api/v1/models/${ROUTED}/endpoints`, observedOn: '2026-10-23' };

/** A synthetic catalog v3 document: the seed's channel with one seed row copied under a new exact id, plus the given `connect` terms. */
async function synthetic(seed: string, nativeId: string, connect?: Record<string, unknown>, pricing?: Record<string, unknown>): Promise<ProviderCatalogDocument> {
  const document = structuredClone(await readProviderConnectSeed(seed)) as unknown as { providers: { models: Record<string, unknown>[] }[] } & Record<string, unknown>;
  const provider = document.providers[0]!, template = provider.models[0]!;
  const model = { ...template, id: nativeId.replace(/[^a-z0-9-]/gu, '-'), nativeId, channelModelId: nativeId, canonicalModelId: nativeId, displayName: nativeId,
    ...(pricing ? { pricing: { ...(template['pricing'] as object), ...pricing } } : {}), ...(connect ? { connect } : {}) };
  delete document['recommendedActivations'];
  return parseProviderCatalogDocument({ ...document, revision: `${seed}-synthetic-2026-10-23`, providers: [{ ...provider, models: [model] }] });
}
const rowOf = (document: ProviderCatalogDocument, nativeId: string) => ({ channelId: document.providers[0]!.id, modelRevision: 3,
  model: document.providers[0]!.models.find(model => model.nativeId === nativeId)! as CatalogModel });
const input = (endpoint: string, nativeId: string, credentialRef: string, catalog: ReturnType<typeof rowOf> | null = null) =>
  ({ endpoint, credentialRef, nativeId, maxOutputTokens: 64_000, currency: 'USD', catalog });
const profileOf = (built: ReturnType<typeof connectionAdapter>, providerId: string, modelId: string) => {
  const reference = { providerId, providerVersion: 1, modelId, modelVersion: 1 };
  return { reference, profile: { schemaVersion: 1 as const, id: 'p', version: 1, scopeId: 'scope', reference, bindingDigest: 'a'.repeat(64), protocol: built.protocol,
    adapter: built.adapter, allocation: { id: 'p', maxCalls: null, maxInFlight: 1 }, limits: { requestMaxBytes: 65_536, responseMaxBytes: 65_536, timeoutMs: 2_000 } } };
};
const commandOf = (reference: Record<string, unknown>, nativeRequest: Record<string, unknown>) => ({ schemaVersion: 1 as const, commandId: 'call', scopeId: 'scope', reference,
  catalogRevision: 'catalog', expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'a'.repeat(64) }, nativeRequest });

describe('catalog v3 connect terms', () => {
  it('the domain admits the terms only on an HTTP API channel', async () => {
    const document = await synthetic('anthropic-api', FABLE, { tariff: fableTariff });
    expect(rowOf(document, FABLE).model).toMatchObject({ connect: { tariff: fableTariff } });
    const cli = structuredClone(await readProviderConnectSeed('claude-cli-subscription')) as unknown as { providers: { models: Record<string, unknown>[] }[] };
    cli.providers[0]!.models[0]!['connect'] = { tariff: fableTariff };
    expect(() => parseProviderCatalogDocument(cli)).toThrow();
  });

  it('a synthetic Anthropic model connects from its catalog row with zero src edits, reserves and settles exactly; the seal names the row', async () => {
    const kind = providerConnectKind('anthropic-api')!, endpoint = 'https://api.anthropic.com/v1/messages';
    expect(anthropicPublishedTariff(FABLE)).toBeUndefined();
    const row = rowOf(await synthetic('anthropic-api', FABLE, { tariff: fableTariff }), FABLE);
    const built = connectionAdapter(kind, input(endpoint, FABLE, 'DECKENT_ANTHROPIC_KEY', row));
    expect(built.tariff).toBe('published');
    const tariff = { ...fableTariff, source: { ...SOURCE, catalog: { channelId: 'anthropic-api', modelRevision: 3 } } };
    expect(built.adapter.definition).toMatchObject({ endpoint, maxOutputTokens: 64_000, tariff, cache: '5m' });
    const { reference, profile } = profileOf(built, 'anthropic-api', FABLE);
    const binding = { encodingVersion: 1, provider: { id: 'anthropic-api', version: 1 }, model: { id: FABLE, version: 1, nativeId: FABLE,
      protocols: [{ family: 'anthropic-messages', version: '2023-06-01', capabilities: [] }] } };
    const request = { model: FABLE, messages: [{ role: 'user' as const, content: 'hello' }], max_completion_tokens: 100, stream: true, stream_options: { include_usage: true } };
    const command = commandOf(reference, request), priced = createAnthropicMessagesPricedNative({ resolveCredential: async () => 'sk-ant-test' });
    const prepared = await priced.native.prepare(profile as never, binding as never, request);
    const quote = priced.quote({ command, requestDigest: modelInvocationRequestDigest(command), profile, profileDigest: modelInvocationProfileDigest(profile as never),
      definition: binding, prepared } as never);
    expect(quote.pricing).toMatchObject({ id: 'anthropic-published-tariff', version: 1, definition: tariff });
    expect(quote.maxChargeMinorUnits).toBeGreaterThan(0);
    // 1,000 input x $12 + 2,000 cache read x $0.30 + 500 cache write (5m) x $15 + 100 output x $60 per MTok = $0.0261 = 2.61 cents.
    const usage = { prompt_tokens: 3_500, completion_tokens: 100, total_tokens: 3_600, anthropic: { input_tokens: 1_000, cache_read_input_tokens: 2_000,
      cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 } } };
    expect(anthropicSettledCharge(tariff as never, usage)).toMatchObject({ exactMinorUnits: '2.61' });
  });

  it('a synthetic OpenAI model connects from its catalog row; the spend authority prices and settles it exactly under a budget', async () => {
    const kind = providerConnectKind('openai-api')!, endpoint = 'https://api.openai.com/v1/chat/completions';
    expect(lookupOpenAiCompatibleTariff(endpoint, SOL)).toBeNull();
    const row = rowOf(await synthetic('openai-api', SOL, { tariff: solTariff(endpoint) }), SOL);
    const built = connectionAdapter(kind, input(endpoint, SOL, 'DECKENT_OPENAI_KEY', row));
    const tariff = { ...solTariff(endpoint), source: { ...solTariff(endpoint).source, catalog: { channelId: 'openai-api', modelRevision: 3 } } };
    expect(built).toMatchObject({ tariff: 'published', adapter: { version: 5, definition: { endpoint, tariff } } });
    const { reference, profile } = profileOf(built, 'openai-api', SOL);
    const binding = { encodingVersion: 1, provider: { id: 'openai-api', version: 1 }, model: { id: SOL, version: 1, nativeId: SOL,
      protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] } };
    const request = { model: SOL, messages: [{ role: 'user' as const, content: 'hello' }], max_completion_tokens: 10 };
    vi.spyOn(http, 'sendNativeJsonHttp').mockImplementation(async (_sent, options) => {
      const parsed = options!.parseResponse!(Buffer.from(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: SOL,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } } })));
      if (!('response' in parsed)) throw new Error('fixture'); return parsed.response;
    });
    const priced = createOpenAiChatPricedNative({ resolveCredential: async () => 'sk-test' } as never), command = commandOf(reference, request);
    const prepared = await priced.native.prepare(profile as never, binding as never, request);
    const quote = priced.quote({ profile, definition: binding, command, requestDigest: modelInvocationRequestDigest(command), profileDigest: modelInvocationProfileDigest(profile as never), prepared } as never);
    expect(quote.pricing).toMatchObject({ id: 'openai-compatible-published-tariff', definition: tariff }); expect(quote.maxChargeMinorUnits).toBeGreaterThan(0);
    const response = await priced.native.send(prepared); if ('kind' in response) throw new Error('fixture');
    const measurement = priced.native.observeSpending!(prepared, response)!;
    // 60 input x $3 + 40 cached x $0.30 + 10 output x $15 per MTok = 0.0342 cents.
    expect(measurement).toMatchObject({ basis: 'measured-tariff', exactMinorUnits: '0.0342' });
    const budget = { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 500 };
    const reserved = reserveProviderSpend(createProviderSpendAccount(budget), budget, { schemaVersion: 1, scopeId: 'scope', invocationId: 'call', budgetId: 'budget',
      budgetRevision: 1, currency: 'USD', quote, quoteDigest: providerSpendQuoteDigest(quote) });
    expect(settleProviderSpend(reserved.account, reserved.reservation, { kind: 'measured-tariff', measurement, evidenceDigest: 'b'.repeat(64) }).account)
      .toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: '0.0342', frozen: false });
  });

  it('a catalog route selects the Responses wire for a new OpenAI model; an OpenRouter row names its priced endpoint tag', async () => {
    const openai = providerConnectKind('openai-api')!, responses = 'https://api.openai.com/v1/responses';
    const row = rowOf(await synthetic('openai-api', SOL, { tariff: solTariff(responses), route: responsesRoute }), SOL);
    expect(connectionAdapter(openai, input('https://api.openai.com/v1/chat/completions', SOL, 'DECKENT_OPENAI_KEY', row)))
      .toMatchObject({ tariff: 'published', adapter: { version: 6, definition: { endpoint: responses, dialect: responsesRoute.dialect,
        tariff: { endpoint: responses, source: { catalog: { channelId: 'openai-api', modelRevision: 3 } } } } } });
    const router = providerConnectKind('openrouter')!, chat = 'https://openrouter.ai/api/v1/chat/completions';
    const routed = rowOf(await synthetic('openrouter-api', ROUTED, { route: routerRoute }), ROUTED);
    expect(connectionAdapter(router, input(chat, ROUTED, 'DECKENT_OPENROUTER_KEY', routed))).toMatchObject({ tariff: 'published', adapter: { definition: {
      dialect: { tokenLimitField: 'max_tokens' }, tariff: { kind: 'openrouter-endpoint', endpointTag: 'openai',
        metadataEndpoint: `https://openrouter.ai/api/v1/models/openai/gpt-sol-7-test/endpoints` } } } });
  });

  it('refuses a row without terms, terms for another model or endpoint, a catalog price that disagrees with the shipped one (negative)', async () => {
    const anthropic = providerConnectKind('anthropic-api')!, openai = providerConnectKind('openai-api')!, router = providerConnectKind('openrouter')!;
    const messages = 'https://api.anthropic.com/v1/messages', chat = 'https://api.openai.com/v1/chat/completions';
    // No terms: no guessed price, even though the row's display pricing names input and output rates.
    const bare = rowOf(await synthetic('anthropic-api', FABLE, undefined, { inputPerMTok: '12', outputPerMTok: '60' }), FABLE);
    expect(() => connectionAdapter(anthropic, input(messages, FABLE, 'DECKENT_ANTHROPIC_KEY', bare))).toThrow('MODEL_CONNECT_TARIFF_UNKNOWN');
    expect(() => connectionAdapter(anthropic, input(messages, FABLE, 'DECKENT_ANTHROPIC_KEY'))).toThrow('MODEL_CONNECT_TARIFF_UNKNOWN');
    const bareSol = rowOf(await synthetic('openai-api', SOL), SOL);
    expect(() => connectionAdapter(openai, input(chat, SOL, 'DECKENT_OPENAI_KEY', bareSol))).toThrow('MODEL_CONNECT_TARIFF_UNVERIFIED');
    const bareRouted = rowOf(await synthetic('openrouter-api', ROUTED), ROUTED);
    expect(() => connectionAdapter(router, input('https://openrouter.ai/api/v1/chat/completions', ROUTED, 'DECKENT_OPENROUTER_KEY', bareRouted))).toThrow('MODEL_CONNECT_TARIFF_UNVERIFIED');
    // Terms naming another model, another endpoint, or a malformed tariff are refused.
    const other = rowOf(await synthetic('anthropic-api', FABLE, { tariff: { ...fableTariff, modelId: 'claude-other' } }), FABLE);
    expect(() => connectionAdapter(anthropic, input(messages, FABLE, 'DECKENT_ANTHROPIC_KEY', other))).toThrow('MODEL_CONNECT_TARIFF_UNVERIFIED');
    const elsewhere = rowOf(await synthetic('openai-api', SOL, { tariff: solTariff('https://proxy.example.com/v1/chat/completions') }), SOL);
    expect(() => connectionAdapter(openai, input(chat, SOL, 'DECKENT_OPENAI_KEY', elsewhere))).toThrow('MODEL_CONNECT_TARIFF_UNVERIFIED');
    const malformed = rowOf(await synthetic('anthropic-api', FABLE, { tariff: { ...fableTariff, usdPerMTok: { input: '12', output: '60' } } }), FABLE);
    expect(() => connectionAdapter(anthropic, input(messages, FABLE, 'DECKENT_ANTHROPIC_KEY', malformed))).toThrow('MODEL_CONNECT_TARIFF_UNVERIFIED');
    // A shipped model keeps its shipped tariff; catalog terms that disagree with it are a typed conflict, never a silent choice.
    const shipped = anthropicPublishedTariff('claude-opus-5-5')!;
    const opus = async (tariff: unknown) => rowOf(await synthetic('anthropic-api', 'claude-opus-5-5', { tariff }), 'claude-opus-5-5');
    const cheaper = await opus({ ...shipped, usdPerMTok: { ...shipped.usdPerMTok, output: '1' } });
    expect(() => connectionAdapter(anthropic, input(messages, 'claude-opus-5-5', 'DECKENT_ANTHROPIC_KEY', cheaper))).toThrow('MODEL_CONNECT_TARIFF_UNVERIFIED');
    // Agreeing terms (another retrieval day) change nothing: the shipped row, its bytes and no catalog seal.
    const agreeing = await opus({ ...shipped, source: { ...shipped.source, retrievedAt: '2026-10-23' } });
    expect(JSON.stringify((connectionAdapter(anthropic, input(messages, 'claude-opus-5-5', 'DECKENT_ANTHROPIC_KEY', agreeing)).adapter.definition as { tariff: unknown }).tariff))
      .toBe(JSON.stringify(shipped));
  });

  it('a hand-written published tariff for an unlisted model without the catalog seal still refuses the paid call (negative)', async () => {
    const endpoint = 'https://api.openai.com/v1/chat/completions';
    const kind = providerConnectKind('openai-api')!, row = rowOf(await synthetic('openai-api', SOL, { tariff: solTariff(endpoint) }), SOL);
    const built = connectionAdapter(kind, input(endpoint, SOL, 'DECKENT_OPENAI_KEY', row));
    const definition = built.adapter.definition as { tariff: { source: Record<string, unknown> } };
    const unsealed = { ...built, adapter: { ...built.adapter, definition: { ...definition, tariff: { ...definition.tariff, source: solTariff(endpoint).source } } } };
    const { reference, profile } = profileOf(unsealed as never, 'openai-api', SOL);
    const binding = { encodingVersion: 1, provider: { id: 'openai-api', version: 1 }, model: { id: SOL, version: 1, nativeId: SOL,
      protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] } };
    const request = { model: SOL, messages: [{ role: 'user' as const, content: 'hello' }], max_completion_tokens: 10 };
    const priced = createOpenAiChatPricedNative({ resolveCredential: async () => 'sk-test' } as never), command = commandOf(reference, request);
    const prepared = await priced.native.prepare(profile as never, binding as never, request);
    expect(() => priced.quote({ profile, definition: binding, command, requestDigest: modelInvocationRequestDigest(command), profileDigest: modelInvocationProfileDigest(profile as never), prepared } as never))
      .toThrow('PROVIDER_SPEND_TARIFF_UNVERIFIED');
  });

  it('every shipped seed model connects byte-identically to the pre-M4 base, with and without its registered (term-less) row', async () => {
    const fixture = JSON.parse(await readFile(new URL('../../fixtures/provider-connect/connect-adapter-a55-base.json', import.meta.url), 'utf8')) as { outputs: Record<string, string> };
    const outputs: Record<string, string> = {};
    for (const kind of PROVIDER_CONNECT_KINDS) {
      if (!kind.connect?.seed || kind.endpoint.default === null) continue;
      const base = (providerEndpoint(kind.endpoint.default) as { base: string }).base, seed = await readProviderConnectSeed(kind.connect.seed);
      for (const provider of seed.providers) for (const model of provider.models) for (const existing of [null, {}]) for (const registered of [false, true]) {
        const catalog = registered ? { channelId: provider.id, modelRevision: 1, model } : null;
        let value: string;
        try { value = JSON.stringify(connectionAdapter(kind, { endpoint: `${base}${kind.connect.chatPath}`, credentialRef: 'DECKENT_KEY', nativeId: model.nativeId,
          maxOutputTokens: 32768, currency: 'USD', existing, catalog })); }
        catch (error) { value = `error:${(error as { code?: string }).code}`; }
        const key = `${kind.id}|${model.nativeId}|${existing ? 'existing' : 'new'}`, digest = value.startsWith('error:') ? value : createHash('sha256').update(value).digest('hex');
        if (registered) expect(digest, key).toBe(outputs[key]); else outputs[key] = digest;
      }
    }
    expect(outputs).toEqual(fixture.outputs);
  });
});
