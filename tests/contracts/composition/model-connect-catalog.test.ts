import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PROVIDER_CONNECT_REGISTRY, parseProviderConnectRegistry, readProviderConnectSeed } from '#adapters/index.js';
import { connectConfiguredModel } from '#composition/core/model-connect/index.js';
import { applyConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import { clearConfigCache } from '#platform/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';

// M4 (owner 2026-10-23): a model the release does not know connects and answers after ONE data step, a `models catalog register --file`
// document, with zero src edits. Synthetic test-only ids; no real provider is called (the Anthropic connect writes config and ledger rows only;
// the OpenAI-compatible model answers from the scripted local server).
const FABLE = 'claude-fable-6-test', UNPRICED = 'claude-fable-6-unpriced-test', SOL = 'gpt-sol-7-test';
const grants = [
  { id: 'config', effect: 'allow', actions: ['write'], scopes: 'all', principals: me, resource: { kind: 'config', ids: 'all' } },
  { id: 'activation', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: 'all', principals: me, resource: { kind: 'model-activation', ids: 'all' } },
  { id: 'invoke-all', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: ['scope'], principals: me, resource: { kind: 'model-invocation', ids: 'all' } }];
const fableTariff = { kind: 'anthropic-published', version: 1, currency: 'USD', modelId: FABLE,
  usdPerMTok: { input: '12', cacheWrite5m: '15', cacheWrite1h: '24', cacheRead: '0.3', output: '60' },
  source: { url: 'https://platform.claude.com/docs/en/about-claude/pricing', retrievedAt: '2026-10-23' } };
/** A local registry row on the openai-api seed (the scripted server stands in for the vendor, as in model-connect.test.ts). */
const localRegistry = parseProviderConnectRegistry({ ...PROVIDER_CONNECT_REGISTRY, kinds: [...PROVIDER_CONNECT_REGISTRY.kinds,
  { id: 'vendor-one', labelKey: 'tui.provider.kind.openaiApi', available: true, endpoint: { default: null, editable: true }, probe: null,
    key: { required: true, secretName: 'DECKENT_OPENAI_KEY' }, connect: { adapter: 'openai-chat-http', chatPath: '/v1/chat/completions', seed: 'openai-api',
      dialect: { tokenLimitField: 'max_completion_tokens', streamUsage: 'include', toolChoice: ['auto', 'none', 'required'] } } }] });
/** The seed's channel with its first row copied under each new exact id (and its `connect` terms): the document a person registers with `--file`. */
async function document(seed: string, rows: readonly [string, Record<string, unknown> | undefined][]) {
  const value = structuredClone(await readProviderConnectSeed(seed)) as unknown as { providers: { models: Record<string, unknown>[] }[] } & Record<string, unknown>;
  const provider = value.providers[0]!, template = provider.models[0]!;
  delete value['recommendedActivations'];
  return { ...value, revision: `${seed}-synthetic-2026-10-23`, providers: [{ ...provider, models: rows.map(([nativeId, connect]) => ({ ...template, id: nativeId, nativeId,
    channelModelId: nativeId, canonicalModelId: nativeId, displayName: nativeId, ...(connect ? { connect } : {}) })) }] };
}
async function harness(noServer: boolean) {
  const f = await runtime({ extraGrants: grants, noServer });
  const path = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8')) as Record<string, Record<string, unknown>>;
  config['service'] = { ...config['service'], responseMaxBytes: 1_048_576 };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 }); clearConfigCache();
  const base = String((config['provider_invocation_profiles'] as { profiles: { adapter: { definition: { endpoint: string } } }[] }).profiles[0]!.adapter.definition.endpoint)
    .replace(/\/v1\/chat\/completions$/u, '');
  const options = { env: { ...f.env, DECKENT_OPENAI_KEY: 'sk-test-m4', DECKENT_ANTHROPIC_KEY: 'sk-ant-test-m4' } };
  return { ...f, base, options, config: async () => JSON.parse(await readFile(path, 'utf8')) as Record<string, { profiles?: Record<string, unknown>[] } & Record<string, unknown>>,
    register: async (catalog: unknown, commandId: string) => applyConfiguredModelCatalog(f.project, { schemaVersion: 1, commandId, scopeId: 'scope', action: 'register', catalog }, options) };
}
const connect = (nativeId: string, commandId: string, connection = 'anthropic-api', endpoint: string | null = null) =>
  ({ schemaVersion: 1, commandId, scopeId: 'scope', connection, endpoint, model: { nativeId } });

describe.skipIf(process.platform !== 'linux')('models.connect from a registered catalog row', () => {
  it('a new Anthropic model connects with the price its row states (sealed to the row); a row without terms is refused before any write', async () => {
    const f = await harness(true);
    // The person's path, through the built `deckent` binary: `models catalog register --file`, then `models connect --model`.
    await writeFile(join(f.project, 'synthetic.json'), JSON.stringify(await document('anthropic-api', [[FABLE, { tariff: fableTariff }], [UNPRICED, undefined]])));
    const deckent = (...args: string[]) => promisify(execFile)(process.execPath, [resolve('dist/composition/core/cli/internal/entry.js'), ...args],
      { cwd: f.project, env: f.options.env as NodeJS.ProcessEnv });
    await deckent('models', 'catalog', 'register', '--scope', 'scope', '--file', 'synthetic.json', '--command-id', 'register-fable', '--json');
    clearConfigCache();
    const out = [(await deckent('models', 'connect', '--scope', 'scope', '--connection', 'anthropic-api', '--model', FABLE, '--command-id', 'connect-fable', '--json')).stdout];
    clearConfigCache();
    const result = JSON.parse(out.join('')) as Record<string, unknown>;
    const reference = { providerId: 'anthropic-api', providerVersion: 1, modelId: FABLE, modelVersion: 1 };
    expect(result).toMatchObject({ status: 'connected', reference, tariff: 'published', credentialRef: 'DECKENT_ANTHROPIC_KEY',
      steps: { catalog: 'skipped', declaration: 'written', profile: 'written', activation: 'written' } });
    const config = await f.config();
    const profile = config['provider_invocation_profiles']!.profiles!.find(item => JSON.stringify(item['reference']) === JSON.stringify(reference));
    expect(profile).toMatchObject({ adapter: { id: 'anthropic-messages-http', definition: { endpoint: 'https://api.anthropic.com/v1/messages', maxOutputTokens: 128000,
      tariff: { ...fableTariff, source: { ...fableTariff.source, catalog: { channelId: 'anthropic-api', modelRevision: 1 } } } } } });
    const before = JSON.stringify(await f.config());
    await expect(connectConfiguredModel(f.project, connect(UNPRICED, 'connect-unpriced'), f.options)).rejects.toMatchObject({ code: 'MODEL_CONNECT_TARIFF_UNKNOWN' });
    expect(JSON.stringify(await f.config())).toBe(before);
    // An id neither the seed nor the registered catalog names stays unknown.
    await expect(connectConfiguredModel(f.project, connect('claude-not-registered-test', 'connect-none'), f.options)).rejects.toMatchObject({ code: 'MODEL_CONNECT_MODEL_UNKNOWN' });
  }, 60_000);

  it('a new OpenAI-compatible model registered by file connects and answers a pinned turn', async () => {
    const f = await harness(false); await f.start();
    await f.register(await document('openai-api', [[SOL, undefined]]), 'register-sol');
    const result = await connectConfiguredModel(f.project, connect(SOL, 'connect-sol', 'vendor-one', f.base), f.options, { registry: localRegistry });
    const reference = { providerId: 'openai-api', providerVersion: 1, modelId: SOL, modelVersion: 1 };
    // Plain http to this machine: the zero operator tariff, exactly like a seeded model at this address.
    expect(result).toMatchObject({ status: 'connected', reference, tariff: 'unmetered', steps: { catalog: 'skipped', declaration: 'written', activation: 'written' } });
    f.state.script = [{ content: 'Sol 7 here.' }];
    const turn = await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-sol', messages: [{ role: 'user', content: 'hi' }], reference }, () => undefined);
    expect(turn).toMatchObject({ finish: 'stop', answer: 'Sol 7 here.' });
    expect((f.state.requests as { model: string }[]).map(request => request.model)).toEqual([SOL]);
  }, 60_000);
});
