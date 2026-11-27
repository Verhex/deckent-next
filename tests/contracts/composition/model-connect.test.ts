import * as witnessAdapters from '#adapters/index.js';
import { personMarkersUnset } from '../support/person-env.js';
import { DatabaseSync } from 'node:sqlite';
import { terminalApproval } from '../support/terminal-runtime-client.js';
import { describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PROVIDER_CONNECT_REGISTRY, lookupOpenAiCompatibleTariff, readProviderConnectSeed, parseProviderConnectRegistry } from '#adapters/index.js';
import { inspectConfiguredModelCatalog, inspectConfiguredModelActivation, admitConfiguredModelActivation as admit, applyConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import { inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { connectConfiguredModel as connect } from '#composition/core/model-connect/index.js';
import { clearConfigCache, resolveGlobalConfigPaths } from '#platform/index.js';
import { modelActivationTargetId, modelCatalogTargetId } from '#engine/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';

// T4-B models.connect (owner 2026-10-08 D2) through the real configured paths: the governed config writer (policy, approval, audit), the ledger
// catalog register, the chat activation and the real runtime service with a scripted OpenAI-compatible server. No real provider is called.
const CANARY = 'sk-canary-T4B-5c1e9a7d3f20';
const ask = (turnId: string, reference?: Record<string, unknown>) => ({ schemaVersion: 1 as const, scopeId: 'scope', turnId, messages: [{ role: 'user' as const, content: 'hi' }],
  ...(reference ? { reference } : {}) });
const grants = (extra: Record<string, unknown>[] = []) => [
  { id: 'config', effect: 'allow', actions: ['write'], scopes: 'all', principals: me, resource: { kind: 'config', ids: 'all' } },
  { id: 'activation', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: 'all', principals: me, resource: { kind: 'model-activation', ids: 'all' } },
  { id: 'invoke-all', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: ['scope'], principals: me, resource: { kind: 'model-invocation', ids: 'all' } },
  { id: 'approvals', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } },
  // İ-12 budget step reads the scope's spend account, as the first-run founder can (template spending rule).
  { id: 'spend-inspect', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: me, resource: { kind: 'provider-spend-account', ids: 'all' } }, ...extra];
/** A registry like the shipped one whose two seeded rows take a typed (local) address: the scripted server stands in for both vendors. */
const localRegistry = parseProviderConnectRegistry({ ...PROVIDER_CONNECT_REGISTRY, kinds: [
  { id: 'vendor-one', labelKey: 'tui.provider.kind.openaiApi', available: true, endpoint: { default: null, editable: true }, probe: null,
    key: { required: true, secretName: 'DECKENT_OPENAI_KEY' }, connect: { adapter: 'openai-chat-http', chatPath: '/v1/chat/completions', seed: 'openai-api',
      dialect: { tokenLimitField: 'max_completion_tokens', streamUsage: 'include', toolChoice: ['auto', 'none', 'required'] } } },
  { id: 'vendor-two', labelKey: 'tui.provider.kind.deepseekApi', available: true, endpoint: { default: null, editable: true }, probe: null,
    key: { required: true, secretName: 'DECKENT_DEEPSEEK_KEY' }, connect: { adapter: 'openai-chat-http', chatPath: '/v1/chat/completions', seed: 'deepseek-api',
      dialect: { tokenLimitField: 'max_tokens', streamUsage: 'include', toolChoice: ['auto', 'none', 'required'] } } }] });
type Config = Record<string, unknown> & { service: Record<string, unknown>; provider_catalog: { providers: { id: string }[] } & Record<string, unknown>;
  provider_invocation_profiles: { profiles: (Record<string, unknown> & { reference: unknown; adapter: { definition: { endpoint: string } } })[] } };
async function harness(extra: Record<string, unknown>[] = [], noServer = false) {
  const f = await runtime({ extraGrants: grants(extra), noServer });
  const path = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8')) as Config;
  const base = String(config['provider_invocation_profiles'].profiles[0].adapter.definition.endpoint).replace(/\/v1\/chat\/completions$/u, '');
  // The product's default service frame (1 MiB): activation checks that a connected profile's worst-case answer fits it (the harness keeps 64 KiB).
  config['service'] = { ...config['service'], responseMaxBytes: 1_048_576 };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 }); clearConfigCache();
  // The canary stands in for a stored key: it must never reach a result, a config file, the ledger (audit) or a model request.
  const options = { env: { ...f.env, DECKENT_OPENAI_KEY: CANARY, DECKENT_DEEPSEEK_KEY: CANARY } };
  return { ...f, path, base, options, config: async () => JSON.parse(await readFile(path, 'utf8')) as Config };
}
const allText = async (dir: string): Promise<string> => {
  let text = '';
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) text += (await readFile(join(entry.parentPath, entry.name))).toString('latin1');
  }
  return text;
};

describe.skipIf(process.platform !== 'linux')('models.connect', () => {
  it('connects a seeded model end to end: ledger catalog, declaration, profile, activation, audit; the terminal pins it; a re-run changes nothing', async () => {
    const f = await harness(); await f.start();
    const command = { schemaVersion: 1, commandId: 'connect-1', scopeId: 'scope', connection: 'vendor-one', endpoint: f.base, model: { nativeId: 'gpt-6-luna' } };
    const result = await connectConfiguredModel(f.project, command, f.options, { registry: localRegistry, listSecretNames: async () => ({ names: ['DECKENT_OPENAI_KEY'] }) });
    const reference = { providerId: 'openai-api', providerVersion: 1, modelId: 'gpt-6-luna', modelVersion: 1 };
    expect(result).toMatchObject({ schemaVersion: 1, operation: 'models.connect', status: 'connected', reference, tariff: 'unmetered', approval: null,
      // Plain http to this machine: the key is never named in the profile (the adapter refuses a cleartext credential).
      credentialRef: null, steps: { catalog: 'written', declaration: 'written', profile: 'written', activation: 'written', carried: 1 } });
    const config = await f.config();
    expect(config['provider_catalog'].providers.map((provider: { id: string }) => provider.id)).toEqual(['local-openai', 'openai-api']);
    const profile = config['provider_invocation_profiles'].profiles.find((item: { reference: unknown }) => JSON.stringify(item.reference) === JSON.stringify(reference));
    expect(profile).toMatchObject({ schemaVersion: 2, billingAxis: 'local', id: 'vendor-one.openai-api.gpt-6-luna.1', scopeId: 'scope', protocol: { family: 'openai-chat-completions', version: 'v1' },
      adapter: { id: 'openai-chat-http', version: 5, definition: { endpoint: `${f.base}/v1/chat/completions`, maxOutputTokens: 128000, authentication: { type: 'none' } } },
      contextWindowTokens: 1050000 });
    // The ledger has the seed's channel; every step wrote its own record and the connection one more.
    expect(f.rows("SELECT channel_id FROM model_catalog_channels").map(row => row['channel_id'])).toContain('openai-api');
    const subjects = f.rows('SELECT record FROM audit_events ORDER BY rowid').map(row => (JSON.parse(String(row['record'])) as { event: { subject: Record<string, unknown> } }).event.subject);
    expect(subjects.filter(subject => subject['kind'] === 'config-change').map(subject => subject['keyPath'])).toEqual(['provider_catalog', 'provider_invocation_profiles']);
    expect(subjects.filter(subject => subject['kind'] === 'model-connect')).toEqual([{ kind: 'model-connect', commandId: 'connect-1', connection: 'vendor-one', reference,
      credentialRef: null, steps: { catalog: 'written', declaration: 'written', profile: 'written', activation: 'written', carried: 1 }, notCarried: [] }]);
    // The terminal can pick and pin it: the next turn carries the reference and the scripted server receives the exact model id.
    f.state.script = [{ content: 'Luna here.' }, { content: 'Still local.' }];
    const luna = await f.client().chatTurn(ask('turn-luna', reference), () => undefined);
    expect(luna).toMatchObject({ finish: 'stop', answer: 'Luna here.' });
    // The model active before the catalog changed was carried to the new revision (its binding is unchanged): the unpinned turn still runs.
    expect(await f.client().chatTurn(ask('turn-configured'), () => undefined)).toMatchObject({ finish: 'stop', answer: 'Still local.' });
    expect((f.state.requests as { model: string }[]).map(request => request.model)).toEqual(['gpt-6-luna', 'native-chat']);
    // The same command again: everything is in place, nothing is written.
    const beforeReplay = f.rows("SELECT * FROM audit_events");
    const again = await connect(f.project, command, f.options, { registry: localRegistry });
    expect(again.steps).toEqual({ catalog: 'present', declaration: 'present', profile: 'present', activation: 'present', carried: 0 });
    expect(f.rows("SELECT * FROM audit_events")).toEqual(beforeReplay);
    // A reconnect that switches nothing on does not ask for the permission to switch the chat model on.
    const policyPath = join(f.data, 'policy.json'), policy = await readFile(policyPath, 'utf8');
    await f.writePolicy([...f.grants, { id: 'deny-current-chat', effect: 'deny', actions: ['activate'], scopes: 'all', principals: me,
      resource: { kind: 'model-activation', ids: [modelActivationTargetId(reference)] } }]);
    await expect.soft(connect(f.project, { ...command, commandId: 'connect-current' }, f.options, { registry: localRegistry }))
      .resolves.toMatchObject({ status: 'connected', steps: { profile: 'present', activation: 'present' } });
    await writeFile(policyPath, policy); clearConfigCache();
    expect(f.rows("SELECT * FROM audit_events")).toEqual(beforeReplay);
      const db = new DatabaseSync(f.ledger);
    try { db.prepare('DELETE FROM model_catalog_activations WHERE channel_id=? AND model_id=?').run('openai-api', 'gpt-6-luna'); }
    finally { db.close(); }
    const missing = f.rows('SELECT * FROM model_catalog_activations');
    await expect(connect(f.project, command, f.options, { registry: localRegistry })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(f.rows('SELECT * FROM model_catalog_activations')).toEqual(missing);
    expect(f.rows('SELECT * FROM audit_events')).toEqual(beforeReplay);
    // The wide check runs before each worker write: a settings change after the channel write stops the model write.
    const unset = new DatabaseSync(f.ledger);
    try { unset.prepare("DELETE FROM model_catalog_activations WHERE channel_id='openai-api'").run(); } finally { unset.close(); }
    const openCatalog = witnessAdapters.openSqliteModelCatalogStore;
    const drifted = vi.spyOn(witnessAdapters, 'openSqliteModelCatalogStore').mockImplementation(async (...args) => {
      const store = await openCatalog(...args), write = store.apply.bind(store);
      store.apply = async admission => {
        const written = await write(admission);
        if (admission.command.commandId.endsWith('.worker.0.0')) await writeFile(f.path, JSON.stringify({ ...await f.config(), language: 'tr' }), { mode: 0o600 });
        return written;
      };
      return store;
    });
    try {
      await expect.soft(connectConfiguredModel(f.project, { ...command, commandId: 'connect-worker-drift' }, f.options, { registry: localRegistry }))
        .rejects.toMatchObject({ code: 'CONFIG_CONCURRENT_REVISION_HOLD' });
    } finally { drifted.mockRestore(); }
    expect.soft(f.rows("SELECT model_id FROM model_catalog_activations WHERE channel_id='openai-api'").map(row => row['model_id'])).not.toContain('gpt-6-luna');
  // Canary: no result, configuration file, ledger row or model request carries the key.
    expect(JSON.stringify([result, again])).not.toContain(CANARY);
    expect(await allText(f.project)).not.toContain(CANARY);
    expect(await allText(f.data)).not.toContain(CANARY);
    expect(f.state.raw.join('')).not.toContain(CANARY);
  }, 60_000);

  it('reconnecting an exact reference keeps its context window; seeded reconnects keep an authored value and fill an absent one', async () => {
    const f = await harness([], true);
    const reference = { providerId: 'anthropic-api', providerVersion: 1, modelId: 'claude-opus-5-5', modelVersion: 1 };
    const command = { schemaVersion: 1, commandId: 'context-seed', scopeId: 'scope', connection: 'anthropic-api', endpoint: null,
      model: { nativeId: reference.modelId } };
    expect(await connectConfiguredModel(f.project, command, f.options)).toMatchObject({ status: 'connected' });
    const find = (config: Config) => config.provider_invocation_profiles.profiles.find(profile => JSON.stringify(profile.reference) === JSON.stringify(reference))!;
    expect(find(await f.config())['contextWindowTokens']).toBe(1_000_000);
    const reconnect = { ...command, commandId: 'context-reference', model: { reference } };
    expect(await connectConfiguredModel(f.project, reconnect, f.options)).toMatchObject({ status: 'connected' });
    expect(find(await f.config())['contextWindowTokens']).toBe(1_000_000);
    const custom = await f.config(); find(custom)['contextWindowTokens'] = 800_000;
    await writeFile(f.path, JSON.stringify(custom)); clearConfigCache();
    expect(await connectConfiguredModel(f.project, { ...command, commandId: 'context-authored' }, f.options)).toMatchObject({ status: 'connected' });
    expect(find(await f.config())['contextWindowTokens']).toBe(800_000);
    const absent = await f.config(); delete find(absent)['contextWindowTokens'];
    await writeFile(f.path, JSON.stringify(absent)); clearConfigCache();
    expect(await connectConfiguredModel(f.project, { ...command, commandId: 'context-fill' }, f.options)).toMatchObject({ status: 'connected', steps: { profile: 'written' } });
    expect(find(await f.config())['contextWindowTokens']).toBe(1_000_000);
    expect(await connectConfiguredModel(f.project, { ...command, commandId: 'context-idempotent' }, f.options)).toMatchObject({ steps: { profile: 'present' } });
  }, 60_000);

  it('a model that cannot be carried to the new catalog revision does not stop the connection: the result and the audit name it', async () => {
    const local = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
    const f = await harness([{ id: 'deny-local-activation', effect: 'deny', actions: ['activate'], scopes: ['scope'], principals: me,
      resource: { kind: 'model-activation', ids: [modelActivationTargetId(local)] } }]);
    await f.start();
    const result = await connectConfiguredModel(f.project, { schemaVersion: 1, commandId: 'c-deny', scopeId: 'scope', connection: 'vendor-one', endpoint: f.base,
      model: { nativeId: 'gpt-6-luna' } }, f.options, { registry: localRegistry });
    expect(result).toMatchObject({ status: 'connected', steps: { declaration: 'written', profile: 'written', activation: 'written', carried: 0 },
      notCarried: [{ reference: local, code: 'POLICY_DENIED' }], carriedModels: [] });
    const subject = f.rows('SELECT record FROM audit_events ORDER BY rowid').map(row => (JSON.parse(String(row['record'])) as { event: { subject: Record<string, unknown> } }).event.subject)
      .find(item => item['kind'] === 'model-connect');
    expect(subject?.['notCarried']).toEqual([local]);
    f.state.script = [{ content: 'Luna.' }];
    expect(await f.client().chatTurn(ask('t-luna', { providerId: 'openai-api', providerVersion: 1, modelId: 'gpt-6-luna', modelVersion: 1 }), () => undefined)).toMatchObject({ answer: 'Luna.' });
  }, 60_000);

  it('a second vendor changes the catalog revision; the first one keeps working (carried) and both answer pinned', async () => {
    const f = await harness(); await f.start();
    const one = { providerId: 'openai-api', providerVersion: 1, modelId: 'gpt-6-luna', modelVersion: 1 };
    const two = { providerId: 'deepseek-api', providerVersion: 1, modelId: 'deepseek-flash', modelVersion: 1 };
    await connectConfiguredModel(f.project, { schemaVersion: 1, commandId: 'c-one', scopeId: 'scope', connection: 'vendor-one', endpoint: f.base, model: { nativeId: 'gpt-6-luna' } },
      f.options, { registry: localRegistry });
    const second = await connectConfiguredModel(f.project, { schemaVersion: 1, commandId: 'c-two', scopeId: 'scope', connection: 'vendor-two', endpoint: f.base,
      model: { nativeId: 'deepseek-flash' } }, f.options, { registry: localRegistry });
    // Both the configured model and the first vendor's model were active under the old revision.
    expect(second.steps).toMatchObject({ declaration: 'written', carried: 2 });
    // K5: the carried models are named (the result window lists them).
    expect(second.carriedModels.map(reference => reference.modelId).sort()).toEqual(['chat', 'gpt-6-luna']); expect(second.notCarried).toEqual([]);
    f.state.script = [{ content: 'one' }, { content: 'two' }];
    expect(await f.client().chatTurn(ask('t-one', one), () => undefined)).toMatchObject({ answer: 'one' });
    expect(await f.client().chatTurn(ask('t-two', two), () => undefined)).toMatchObject({ answer: 'two' });
    expect((f.state.requests as { model: string }[]).map(request => request.model)).toEqual(['gpt-6-luna', 'deepseek-flash']);
    // K1: each vendor gets its documented dialect on the wire (OpenAI max_completion_tokens, DeepSeek max_tokens).
    expect(f.state.requests[0]).toHaveProperty('max_completion_tokens'); expect(f.state.requests[0]).not.toHaveProperty('max_tokens');
    expect(f.state.requests[1]).toHaveProperty('max_tokens'); expect(f.state.requests[1]).not.toHaveProperty('max_completion_tokens');
  }, 60_000);

  it('a priced vendor model connects with its verified published row; an unpriced one is refused before any write; a remote generic address waits for a declared price', async () => {
    const f = await harness();
    const connect = (commandId: string, connection: string, nativeId: string) => connectConfiguredModel(f.project, { schemaVersion: 1, commandId, scopeId: 'scope',
      connection, endpoint: null, model: { nativeId } }, f.options, { listSecretNames: async () => ({ names: ['DECKENT_OPENAI_KEY'] }) });
    // PRICING: every verified USD seed connects through the governed producer.
    const untouched = await readFile(f.path, 'utf8');
    await expect(connect('c-cn', 'zai-cn-api', 'glm-5.3')).rejects.toMatchObject({ code: 'MODEL_CONNECT_TARIFF_UNVERIFIED' });
    expect(await readFile(f.path, 'utf8')).toBe(untouched);
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']) {
      expect(await connect(`c-${model}`, 'openai-api', model)).toMatchObject({ status: 'connected', tariff: 'published' });
    }
    for (const model of ['glm-5.3', 'glm-4.7-flash']) {
      expect(await connect(`c-${model}`, 'zai-api', model)).toMatchObject({ status: 'connected', tariff: 'published' });
    }
    // İ-12: a priced model's result carries the budget step — the harness configures a scope budget, so it is present.
    expect((await connect('c-sol-again', 'openai-api', 'gpt-6.1-sol')).budget).toEqual({ state: 'present' });
    // Budget 0 USD (no account, no configured budget): the connection still completes and says priced turns need a budget first.
    const unbudgeted = await f.config(); delete unbudgeted['provider_spending']; await writeFile(f.path, JSON.stringify(unbudgeted), { mode: 0o600 }); clearConfigCache();
    const b = await connect('c-b', 'deepseek-api', 'deepseek-flash');
    // The DeepSeek key is not stored yet: the result says so (the profile names it; turns are refused until it is stored).
    expect([b.credentialRef, b.keyStored, b.status, b.tariff, b.budget]).toEqual(['DECKENT_DEEPSEEK_KEY', false, 'connected', 'published', { state: 'missing' }]);
    const profiles = (await f.config())['provider_invocation_profiles'].profiles as { reference: { providerId: string }; adapter: { definition: { endpoint: string;
      authentication: unknown; tariff: unknown } } }[];
    const byVendor = Object.fromEntries(profiles.map(profile => [profile.reference.providerId, profile.adapter.definition]));
    expect(byVendor['deepseek-api']).toMatchObject({ endpoint: 'https://api.deepseek.com/chat/completions', authentication: { type: 'bearer', credentialRef: 'DECKENT_DEEPSEEK_KEY' } });
    expect(byVendor['deepseek-api']!.tariff).toEqual(lookupOpenAiCompatibleTariff('https://api.deepseek.com/chat/completions', 'deepseek-flash'));
    expect(profiles.map(profile => profile.reference.providerId).sort()).toEqual(['deepseek-api', 'local-openai', 'openai-api', 'openai-api', 'openai-api', 'zai-api', 'zai-api']);
    // Owner 2026-10-08: the generic row's remote address needs a declared price (SPEND-SETTLEMENT) before any paid call; nothing is written.
    const before = await readFile(f.path, 'utf8');
    await expect(connectConfiguredModel(f.project, { schemaVersion: 1, commandId: 'c-g', scopeId: 'scope', connection: 'openai-compatible', endpoint: 'https://llm.example.com/v1',
      model: { reference: { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 } } }, f.options)).rejects.toMatchObject({ code: 'MODEL_CONNECT_PRICE_REQUIRED' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
  }, 60_000);

  it('OpenRouter connects both approved seed models through governed config, catalog and activation with v5 metadata pricing', async () => {
    const f = await harness();
    for (const nativeId of ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol']) {
      const result = await connectConfiguredModel(f.project, { schemaVersion: 1, commandId: `or-${nativeId.replaceAll('/', '-')}`, scopeId: 'scope',
        connection: 'openrouter', endpoint: null, model: { nativeId } }, f.options, { listSecretNames: async () => ({ names: ['DECKENT_OPENROUTER_KEY'] }) });
      expect(result).toMatchObject({ status: 'connected', tariff: 'published', keyStored: true, credentialRef: 'DECKENT_OPENROUTER_KEY',
        reference: { providerId: 'openrouter-api', modelId: nativeId } });
    }
    const profiles = (await f.config()).provider_invocation_profiles.profiles.filter(p => JSON.stringify(p.reference).includes('openrouter-api'));
    expect(profiles).toHaveLength(2);
    for (const profile of profiles) expect(profile.adapter).toMatchObject({ id: 'openai-chat-http', version: 5, definition: {
      endpoint: 'https://openrouter.ai/api/v1/chat/completions', dialect: { tokenLimitField: 'max_tokens', streamUsage: 'omit', finalUsageChoice: 'repeat-finish' },
      tariff: { kind: 'openrouter-endpoint', currency: 'USD' } } });
  }, 60_000);

  it('connects without write access to an untouched global layer', async () => {
    const f = await harness([], true), nativeId = 'local-untouched-global', requests: string[] = [];
    const host = { discoveryOptions: { async fetch(_url: string, init: RequestInit) {
      requests.push(String(init.method));
      return Response.json(init.method === 'GET' ? { data: [{ id: nativeId }] } : { choices: [] });
    } } };
    const command = { schemaVersion: 1, commandId: 'connect-global-layer', scopeId: 'scope',
      connection: 'local-openai', endpoint: f.base, model: { nativeId } };
    const initial = await connectConfiguredModel(f.project, command, f.options, host);
    const global = resolveGlobalConfigPaths(f.env).platformPath;
    const config = await f.config(), contents = JSON.stringify({ provider_invocation_profiles: config.provider_invocation_profiles });
    await mkdir(dirname(global), { recursive: true, mode: 0o700 });
    await writeFile(global, contents, { mode: 0o600 });
    await f.writePolicy([...f.grants, { id: 'deny-global-profile', effect: 'deny', actions: ['write'], scopes: 'all', principals: me,
      resource: { kind: 'config', ids: ['global:provider_invocation_profiles'] } }]);
    clearConfigCache();
    const before = await readFile(f.ledger);
    expect(await connectConfiguredModel(f.project, { ...command, commandId: 'connect-global-repeat' }, f.options, host))
      .toMatchObject({ status: 'connected', steps: { profile: 'present', activation: 'present' } });
    expect(requests).toEqual(['GET', 'POST', 'GET', 'POST']);
    expect(await readFile(global, 'utf8')).toBe(contents);
    expect(await readFile(f.ledger)).toEqual(before);
    config.provider_invocation_profiles.profiles = config.provider_invocation_profiles.profiles
      .filter(profile => JSON.stringify(profile.reference) !== JSON.stringify(initial.reference));
    await writeFile(f.path, JSON.stringify(config)); clearConfigCache();
    const activation = f.rows('SELECT * FROM model_activation_receipts');
    expect(await connectConfiguredModel(f.project, { ...command, commandId: 'connect-project-profile' }, f.options, host))
      .toMatchObject({ status: 'connected', steps: { profile: 'written', activation: 'present' } });
    expect(requests).toEqual(['GET', 'POST', 'GET', 'POST', 'GET', 'POST']);
    expect(await readFile(global, 'utf8')).toBe(contents);
    expect(f.rows('SELECT * FROM model_activation_receipts')).toEqual(activation);
  });

  it('a require-approval config rule stops explicit and pulled connections; after allow the same command finishes', async () => {
    for (const model of [{ nativeId: 'gpt-6.1-sol' }, { pull: 'available' }]) {
      const f = await harness([{ id: 'ask-profiles', effect: 'require-approval', actions: ['write'], scopes: 'all', principals: me,
        resource: { kind: 'config', ids: ['project:provider_invocation_profiles'] } }], true);
      const command = { schemaVersion: 1, commandId: 'connect-ask', scopeId: 'scope', connection: 'vendor-one', endpoint: f.base, model: { nativeId: 'gpt-6-sol' } };
      // An id the seed does not list is refused typed before anything is written.
      await expect(connectConfiguredModel(f.project, command, f.options, { registry: localRegistry })).rejects.toMatchObject({ code: 'MODEL_CONNECT_MODEL_UNKNOWN' });
      const asked = { ...command, model };
      const pending = await connectConfiguredModel(f.project, asked, f.options, { registry: localRegistry });
      expect(pending).toMatchObject({ status: 'approval-pending', approval: { keyPath: 'provider_invocation_profiles', layer: 'project' },
        steps: { declaration: 'written', profile: 'present', activation: 'present' } });
      expect((await f.config()).provider_invocation_profiles.profiles.filter(profile => (profile.reference as { providerId: string }).providerId === 'openai-api')).toEqual([]);
      expect((await inspectConfiguredModelActivation(f.project, { schemaVersion: 1, scopeId: 'scope', reference: pending.reference }, f.options)).activation).toBeNull();
      await terminalApproval(f.project, 'decide', { schemaVersion: 1, scopeId: 'scope', approvalId: pending.approval!.approvalId, commandId: 'decide-connect', expectedRevision: 0,
        decision: 'allow', reason: 'Allowed in the terminal', channel: 'local-terminal-card' }, f.options);
      const done = await connectConfiguredModel(f.project, asked, f.options, { registry: localRegistry });
      expect(done).toMatchObject({ status: 'connected', steps: { declaration: 'present', profile: 'written', activation: 'written' } });
      if ('pull' in model) expect(done.models).toEqual(expect.arrayContaining([expect.objectContaining({ nativeId: 'gpt-6.1-sol', state: 'connected' })]));
    }
  }, 60_000);
});

it.skipIf(process.platform === 'win32')('[unsupported on Windows: managed private ledger files] preserves an authored v1 invocation profile on reconnect instead of silently rewriting its billing path', async () => {
  const f = await harness([], true);
  const command = { schemaVersion: 1, commandId: 'billing-v1', scopeId: 'scope', connection: 'vendor-one', endpoint: f.base, model: { nativeId: 'gpt-6-luna' } };
  await connectConfiguredModel(f.project, command, f.options, { registry: localRegistry });
  const config = await f.config(), current = config.provider_invocation_profiles.profiles.find(row => String(row['id']).startsWith('vendor-one.'))!;
  const { billingAxis: axis, ...legacy } = current;
  expect(axis).toBe('local');
  const v1 = { ...legacy, schemaVersion: 1 };
  config.provider_invocation_profiles.profiles = config.provider_invocation_profiles.profiles.map(row => row === current ? v1 : row);
  await writeFile(f.path, JSON.stringify(config), { mode: 0o600 }); clearConfigCache();
  await connectConfiguredModel(f.project, { ...command, commandId: 'billing-reconnect' }, f.options, { registry: localRegistry });
  const kept = (await f.config()).provider_invocation_profiles.profiles.find(row => row['id'] === current['id'])!;
  expect(kept['schemaVersion']).toBe(1); expect(kept).not.toHaveProperty('billingAxis'); expect(kept.adapter).toEqual(v1.adapter);
  // The v1 frame may resize after converting this synthetic v2 fixture; the next exact reconnect is stable.
  await connectConfiguredModel(f.project, { ...command, commandId: 'billing-stable' }, f.options, { registry: localRegistry });
  expect((await f.config()).provider_invocation_profiles.profiles.find(row => row['id'] === current['id'])).toEqual(kept);
});

it.skipIf(process.platform !== 'linux')('explicit model state writes both owners; conflicting legacy rows remain byte-identical through read-only inspection', async () => {
  const f = await harness([], true);
  const command = { schemaVersion: 1, commandId: 'both-connect', scopeId: 'scope', connection: 'vendor-one', endpoint: f.base, model: { nativeId: 'gpt-6-luna' } };
  const connected = await connectConfiguredModel(f.project, command, f.options, { registry: localRegistry });
  const binding = await inspectModelBinding(f.project, connected.reference, f.options);
  if (binding.status !== 'declared') throw Error('binding');
  let chat = await inspectConfiguredModelActivation(f.project, { schemaVersion: 1, scopeId: 'scope', reference: connected.reference }, f.options);
  await admitConfiguredModelActivation(f.project, { schemaVersion: 1, commandId: 'both-off', scopeId: 'scope', reference: connected.reference, action: 'deactivate', expectedRevision: chat.activation!.revision, expectedBinding: binding.binding }, f.options);
  chat = await inspectConfiguredModelActivation(f.project, { schemaVersion: 1, scopeId: 'scope', reference: connected.reference }, f.options);
  expect(chat.activation?.state).toBe('inactive');
  const catalog = await inspectConfiguredModelCatalog(f.project, { schemaVersion: 1, scopeId: 'scope', channelId: connected.reference.providerId }, f.options);
  expect(catalog.channels[0]).toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ modelId: 'gpt-6-luna', activation: { state: 'inactive', revision: 2 } })]) });
  await admitConfiguredModelActivation(f.project, { schemaVersion: 1, commandId: 'both-on', scopeId: 'scope', reference: connected.reference, action: 'activate', catalogRevision: binding.catalogRevision, expectedRevision: chat.activation!.revision, expectedBinding: binding.binding }, f.options);
  // A retained pre-upgrade worker-off row is a fixture, not an implicit migration or a person command.
  const fixtureDb = new DatabaseSync(f.ledger);
  try {
    const row = fixtureDb.prepare("SELECT record FROM model_catalog_activations WHERE model_id='gpt-6-luna'").get()!;
    const record = { ...JSON.parse(String(row['record'])), state: 'inactive' };
    fixtureDb.prepare("UPDATE model_catalog_activations SET state='inactive',record=? WHERE model_id='gpt-6-luna'").run(JSON.stringify(record));
  } finally { fixtureDb.close(); }
  const before = JSON.stringify(f.rows('SELECT * FROM model_catalog_activations'));
  const listed = await inspectConfiguredModelCatalog(f.project, { schemaVersion: 1, scopeId: 'scope', channelId: connected.reference.providerId }, f.options);
  expect(listed.channels[0]).toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ modelId: 'gpt-6-luna', chatState: 'active', activationConflict: true })]) });
  expect(JSON.stringify(f.rows('SELECT * FROM model_catalog_activations'))).toBe(before);
  // Chat on with no worker activation at all (a new project whose worker registry is not set up yet) is setup to do, not a conflict.
  const unset = new DatabaseSync(f.ledger);
  try { unset.prepare("DELETE FROM model_catalog_activations WHERE model_id='gpt-6-luna'").run(); } finally { unset.close(); }
  const missing = await inspectConfiguredModelCatalog(f.project, { schemaVersion: 1, scopeId: 'scope', channelId: connected.reference.providerId }, f.options);
  expect(missing.channels[0]).toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ modelId: 'gpt-6-luna', chatState: 'active', activation: null, activationConflict: false })]) });

  const sibling = 'gpt-6.1-sol', channelId = connected.reference.providerId;
  await connectConfiguredModel(f.project, { ...command, commandId: 'sibling-on', model: { nativeId: sibling } }, f.options, { registry: localRegistry });
  const seed = await readProviderConnectSeed(channelId), authored = structuredClone(seed);
  const retired = authored.providers[0]!.models.find(row => row.nativeId === sibling)!;
  Object.assign(retired.lifecycle, { state: 'retired', retiredOn: '2026-01-01', retireNotBefore: '2026-01-01' });
  await applyConfiguredModelCatalog(f.project, { schemaVersion: 1, commandId: 'retire-sibling', scopeId: 'scope', action: 'register', catalog: authored }, f.options);
  await applyConfiguredModelCatalog(f.project, { schemaVersion: 1, commandId: 'close-channel', scopeId: 'scope', action: 'deactivate',
    channelId, modelId: null, expectedRevision: 1 }, f.options);
  const policyPath = join(f.data, 'policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  await writeFile(policyPath, JSON.stringify({ ...policy, revision: 'retired-sibling-denied', grants: [...policy.grants,
    { id: 'deny-retired-sibling', effect: 'deny', scopes: ['scope'], principals: me, actions: ['activate'],
      resource: { kind: 'model-activation', ids: [modelCatalogTargetId({ channelId, modelId: sibling })] } }] }));
  await expect(connectConfiguredModel(f.project, { ...command, commandId: 'reopen-channel' }, f.options, { registry: localRegistry }))
    .resolves.toMatchObject({ status: 'connected' });
}, 40_000);

it.skipIf(process.platform !== 'linux')('refuses unwitnessed seedless connect before the capability POST or any durable change', async () => {
  const f = await harness([], true);
  const methodLog: string[] = [];
  const nativeId = 'witness-loopback-fixture';
  const snapshot = async () => ({ config: await f.config(), ledger: await readFile(f.ledger),
    dataFiles: (await readdir(f.data)).filter(file => file !== 'policy.json').sort(), channels: f.rows('SELECT * FROM model_catalog_channels'),
    catalog: f.rows('SELECT * FROM model_catalog_activations'), chat: f.rows('SELECT * FROM model_activations'),
    audit: f.rows('SELECT * FROM audit_events'), receipts: f.rows('SELECT * FROM model_activation_receipts') });
  const before = await snapshot();
  const command = { schemaVersion: 1, commandId: 'witness-loopback', scopeId: 'scope',
    connection: 'local-openai', endpoint: f.base, model: { nativeId } };
  const host = { discoveryOptions: { async fetch(_url: string, init: RequestInit) {
    methodLog.push(String(init.method));
    return Response.json(init.method === 'GET' ? { data: [{ id: nativeId }] } : { choices: [] });
  } } };
  const raw = () => connect(f.project, command, f.options, host);
  const result = await raw().then(value => value.status, (error: { code?: string }) => error.code);
  const after = await snapshot();
  expect({ result, posts: methodLog.filter(method => method === 'POST').length,
    configUnchanged: JSON.stringify(after.config) === JSON.stringify(before.config),
    catalogUnchanged: JSON.stringify([after.channels, after.catalog]) === JSON.stringify([before.channels, before.catalog]),
    chatUnchanged: JSON.stringify(after.chat) === JSON.stringify(before.chat),
    auditUnchanged: JSON.stringify(after.audit) === JSON.stringify(before.audit) })
    .toEqual({ result: 'AUTHORITY_WITNESS_REQUIRED', posts: 0, configUnchanged: true, catalogUnchanged: true, chatUnchanged: true, auditUnchanged: true });
  await expect(asPerson(async () => {
    process.env['CI'] = 'true';
    try { return await raw(); } finally { delete process.env['CI']; }
  })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(after).toEqual(before);
  expect(methodLog).toEqual([]);

  const policyPath = join(f.data, 'policy.json'), policy = await readFile(policyPath, 'utf8');
  const denied = JSON.parse(policy);
  denied.grants = denied.grants.filter((rule: { id: string }) => rule.id !== 'config');
  await writeFile(policyPath, JSON.stringify({ ...denied, revision: 'connect-known-deny' }));
  await expect(asPerson(raw)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(methodLog).toEqual([]);
  expect(await snapshot()).toEqual(before);
  await writeFile(policyPath, policy);

  const drift = () => connect(f.project, command, f.options, { discoveryOptions: { async fetch(url, init) {
    const response = await host.discoveryOptions.fetch(String(url), init);
    if (init.method === 'POST') await writeFile(policyPath, JSON.stringify({ ...JSON.parse(policy), revision: 'connect-drift' }));
    return response;
  } } });
  await expect(asPerson(drift)).rejects.toMatchObject({ code: 'CONFIG_CONCURRENT_REVISION_HOLD' });
  expect(methodLog).toEqual(['GET', 'POST']);
  expect(await snapshot()).toEqual(before);
  await writeFile(policyPath, policy);

  const losesTerminal = () => connect(f.project, command, f.options, { discoveryOptions: { async fetch(url, init) {
    const response = await host.discoveryOptions.fetch(String(url), init);
    if (init.method === 'POST') vi.mocked(witnessAdapters.attestLocalInteractiveTerminal).mockResolvedValue(false);
    return response;
  } } });
  await expect(asPerson(losesTerminal)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(methodLog).toEqual(['GET', 'POST', 'GET', 'POST']);
  expect(await snapshot()).toEqual(before);

  expect(await asPerson(raw)).toMatchObject({ status: 'connected', steps: { catalog: 'written', declaration: 'written', profile: 'written', activation: 'written' } });
  expect(methodLog).toEqual(['GET', 'POST', 'GET', 'POST', 'GET', 'POST']);

  // A profile another writer adds after this connect's declaration write is never overwritten: the connect stops instead.
  const secondId = 'witness-loopback-second', foreign = structuredClone((await f.config()).provider_invocation_profiles.profiles[0]!);
  Object.assign(foreign, { id: 'concurrent-writer', scopeId: 'scope-concurrent' });
  const documents = witnessAdapters.createConfigFileDocuments;
  const concurrent = vi.spyOn(witnessAdapters, 'createConfigFileDocuments').mockImplementation((...args) => {
    const port = documents(...args);
    return { ...port, async publish(input, planner) {
      const written = await port.publish(input, planner);
      if (input.keyPath === 'provider_catalog') {
        const config = await f.config(); config.provider_invocation_profiles.profiles.push(foreign);
        await writeFile(f.path, JSON.stringify(config), { mode: 0o600 });
      }
      return written;
    } };
  });
  try {
    await expect.soft(asPerson(() => connect(f.project, { ...command, commandId: 'witness-concurrent', model: { nativeId: secondId } }, f.options,
      { discoveryOptions: { async fetch(_url: string, init: RequestInit) {
        return Response.json(init.method === 'GET' ? { data: [{ id: secondId }] } : { choices: [] });
      } } }))).rejects.toMatchObject({ code: 'CONFIG_CONCURRENT_REVISION_HOLD' });
  } finally { concurrent.mockRestore(); }
  expect.soft((await f.config()).provider_invocation_profiles.profiles).toContainEqual(foreign);
  // One file serving as both the project and the installation settings: the connect's own write is not taken for a foreign one.
  const sharedId = 'witness-loopback-shared', shared = { env: { ...f.options.env, DECKENT_GLOBAL_HOME: join(f.project, '.deckent') } };
  await expect.soft(asPerson(() => connect(f.project, { ...command, commandId: 'witness-shared', model: { nativeId: sharedId } }, shared,
    { discoveryOptions: { async fetch(_url: string, init: RequestInit) {
      return Response.json(init.method === 'GET' ? { data: [{ id: sharedId }] } : { choices: [] });
    } } }))).resolves.toMatchObject({ status: 'connected', steps: { declaration: 'written', profile: 'written' } });
  // The same file read only as the installation layer (`globalOnly`): the published global write is checked against its own read.
  const globalId = 'witness-loopback-global-only';
  await expect.soft(asPerson(() => connect(f.project, { ...command, commandId: 'witness-global-only', model: { nativeId: globalId } }, { ...shared, globalOnly: true },
    { discoveryOptions: { async fetch(_url: string, init: RequestInit) {
      return Response.json(init.method === 'GET' ? { data: [{ id: globalId }] } : { choices: [] });
    } } }))).resolves.toMatchObject({ status: 'connected', steps: { declaration: 'written', profile: 'written' } });
  // `globalOnly` with its own installation file, no profile section and no project file yet: the first profile is written to the project
  // file, and the connect checks that write against the file it published.
  const ownHome = join(f.data, 'own-global'), installation: Record<string, unknown> = { ...await f.config() };
  delete installation['provider_invocation_profiles'];
  await mkdir(ownHome, { recursive: true, mode: 0o700 });
  await writeFile(join(ownHome, 'config.json'), JSON.stringify(installation), { mode: 0o600 });
  await rm(f.path); clearConfigCache();
  const projectId = 'witness-loopback-project-profile';
  await expect.soft(asPerson(() => connect(f.project, { ...command, commandId: 'witness-project-profile', model: { nativeId: projectId } },
    { env: { ...f.options.env, DECKENT_GLOBAL_HOME: ownHome }, globalOnly: true }, { discoveryOptions: { async fetch(_url: string, init: RequestInit) {
      return Response.json(init.method === 'GET' ? { data: [{ id: projectId }] } : { choices: [] });
    } } }))).resolves.toMatchObject({ status: 'connected', steps: { declaration: 'written', profile: 'written' } });

});

const admitConfiguredModelActivation: typeof admit = (...args) => asPerson(() => admit(...args));

const connectConfiguredModel: typeof connect = (...args) => asPerson(() => connect(...args));

async function asPerson<T>(operation: () => Promise<T>): Promise<T> {
  const witness = vi.spyOn(witnessAdapters, 'attestLocalInteractiveTerminal').mockResolvedValue(true);
  const markers = Object.keys(personMarkersUnset()).filter(key => process.env[key] !== undefined);
  const values = markers.map(key => process.env[key]!);
  for (const key of markers) delete process.env[key];
  try { return await operation(); }
  finally {
    witness.mockRestore();
    for (const [index, key] of markers.entries()) process.env[key] = values[index]!;
  }
}
