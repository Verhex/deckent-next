import { describe, expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROVIDER_CONNECT_REGISTRY, lookupOpenAiCompatibleTariff, parseProviderConnectRegistry } from '#adapters/index.js';
import { connectConfiguredModel } from '#composition/core/model-connect/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { clearConfigCache } from '#platform/index.js';
import { modelActivationTargetId } from '#engine/index.js';
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
  { id: 'approvals', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }, ...extra];
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
async function harness(extra: Record<string, unknown>[] = []) {
  const f = await runtime({ extraGrants: grants(extra) });
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
    expect(profile).toMatchObject({ id: 'vendor-one.openai-api.gpt-6-luna.1', scopeId: 'scope', protocol: { family: 'openai-chat-completions', version: 'v1' },
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
    const again = await connectConfiguredModel(f.project, command, f.options, { registry: localRegistry });
    expect(again.steps).toEqual({ catalog: 'present', declaration: 'present', profile: 'present', activation: 'present', carried: 0 });
    // Canary: no result, configuration file, ledger row or model request carries the key.
    expect(JSON.stringify([result, again])).not.toContain(CANARY);
    expect(await allText(f.project)).not.toContain(CANARY);
    expect(await allText(f.data)).not.toContain(CANARY);
    expect(f.state.raw.join('')).not.toContain(CANARY);
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
    const b = await connect('c-b', 'deepseek-api', 'deepseek-flash');
    // The DeepSeek key is not stored yet: the result says so (the profile names it; turns are refused until it is stored).
    expect([b.credentialRef, b.keyStored, b.status, b.tariff]).toEqual(['DECKENT_DEEPSEEK_KEY', false, 'connected', 'published']);
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

  it('a require-approval config rule stops the run with the pending card; after allow the same command finishes', async () => {
    const f = await harness([{ id: 'ask-profiles', effect: 'require-approval', actions: ['write'], scopes: 'all', principals: me,
      resource: { kind: 'config', ids: ['project:provider_invocation_profiles'] } }]);
    const command = { schemaVersion: 1, commandId: 'connect-ask', scopeId: 'scope', connection: 'vendor-one', endpoint: f.base, model: { nativeId: 'gpt-6-sol' } };
    // An id the seed does not list is refused typed before anything is written.
    await expect(connectConfiguredModel(f.project, command, f.options, { registry: localRegistry })).rejects.toMatchObject({ code: 'MODEL_CONNECT_MODEL_UNKNOWN' });
    const asked = { ...command, model: { nativeId: 'gpt-6.1-sol' } };
    const pending = await connectConfiguredModel(f.project, asked, f.options, { registry: localRegistry });
    expect(pending).toMatchObject({ status: 'approval-pending', approval: { keyPath: 'provider_invocation_profiles', layer: 'project' },
      steps: { declaration: 'written', profile: 'present', activation: 'present' } });
    await configuredApproval(f.project, 'decide', { schemaVersion: 1, scopeId: 'scope', approvalId: pending.approval!.approvalId, commandId: 'decide-connect', expectedRevision: 0,
      decision: 'allow', reason: 'Allowed in the terminal', channel: 'local-terminal-card' }, f.options);
    const done = await connectConfiguredModel(f.project, asked, f.options, { registry: localRegistry });
    expect(done).toMatchObject({ status: 'connected', steps: { declaration: 'present', profile: 'written', activation: 'written' } });
  }, 60_000);
});
