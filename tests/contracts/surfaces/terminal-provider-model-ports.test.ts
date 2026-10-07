import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { providerEndpoint } from '#adapters/core/provider-connect/index.js';
import { modelPanelSource, providerPanelPort, type ProviderConnectHost, type TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';

// T4-A ports over the host's handlers (no runtime, no network): `/provider` runs the free check and sends the key only to the secret store
// handler, and only when the check passes; `/model` lists declared models with the first missing precondition as the reason.
const CANARY = 'sk-canary-T4-6f1d2e9c0b7a';
// The provider sections are registered by the composition root in the product; here the test registers them once.
registerProviderConfig();
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(config: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-t4-ports-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify(config), { mode: 0o600 });
  return { root, options: { env: { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home') } } };
}
const reference = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 };
/** A valid invocation profile (the configured section is validated on load) whose definition names `credentialRef`. */
const profile = (ref: typeof reference, credentialRef: string | null) => ({ schemaVersion: 1, id: `p-${ref.modelId}`, version: 1, scopeId: 'scope', reference: ref,
  bindingDigest: 'b'.repeat(64), protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
    definition: { endpoint: 'http://127.0.0.1:9/v1/chat/completions', maxOutputTokens: 256, authentication: credentialRef ? { type: 'bearer', credentialRef } : { type: 'none' }, tariff } },
  allocation: { id: `a-${ref.modelId}`, maxCalls: null, maxInFlight: 1 }, limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } });
const errorText = (error: unknown) => `ERR:${String((error as { code?: unknown })?.code)}`;

function connectHost(outcome: string, httpStatus: number | null = 200): ProviderConnectHost & { probes: unknown[] } {
  const probes: unknown[] = [];
  return { probes, kinds: [
    { id: 'anthropic-api', labelKey: 'tui.provider.kind.anthropicApi', available: true, endpointDefault: 'https://api.anthropic.com', endpointEditable: false, keyRequired: true,
      secretName: 'DECKENT_ANTHROPIC_KEY', probePath: '/v1/models?limit=1', endpointChoices: [] },
    { id: 'local-openai', labelKey: 'tui.provider.kind.localOpenai', available: true, endpointDefault: null, endpointEditable: true, keyRequired: false,
      secretName: 'DECKENT_LOCAL_ENDPOINT_KEY', probePath: '/v1/models', endpointChoices: [{ id: 'vllm', labelKey: 'tui.provider.endpoint.choice.vllm', url: 'http://127.0.0.1:8000' },
        { id: 'ollama', labelKey: 'tui.provider.endpoint.choice.ollama', url: 'http://127.0.0.1:11434' }] },
    { id: 'chatgpt-login', labelKey: 'tui.provider.kind.chatgptLogin', available: false, endpointDefault: null, endpointEditable: false, keyRequired: false, secretName: null,
      probePath: null, endpointChoices: [] }],
  endpoint: providerEndpoint,
  probe: async input => { probes.push(input); return { outcome, httpStatus, key: outcome === 'ok' ? 'verified' : 'unverified' }; } };
}
function secrets(names: string[] = []) {
  const sets: unknown[] = [], deletes: unknown[] = [];
  return { sets, deletes, host: {
    listSecretNames: async () => ({ schemaVersion: 1 as const, backend: 'core.secret-store.file@1', names }),
    setSecret: async (_root: string, input: { schemaVersion: 1; scopeId: string; name: string; value: string }) => { sets.push(input); names.push(input.name);
      return { schemaVersion: 1 as const, scopeId: input.scopeId, name: input.name, action: 'set' as const, backend: 'core.secret-store.file@1', removed: null }; },
    deleteSecret: async (_root: string, input: { schemaVersion: 1; scopeId: string; name: string }) => { deletes.push(input);
      return { schemaVersion: 1 as const, scopeId: input.scopeId, name: input.name, action: 'delete' as const, backend: 'core.secret-store.file@1', removed: true }; },
  } satisfies Pick<TerminalLaunchContext, 'listSecretNames' | 'setSecret' | 'deleteSecret'> };
}

describe('/provider port', () => {
  it('a passing check stores the key under its name through the store handler; rows name the outcome, the key name and the next step, never the key', async () => {
    const { root, options } = await project({ provider_invocation_profiles: { schemaVersion: 1, profiles: [] } });
    const connect = connectHost('ok'), store = secrets();
    const port = providerPanelPort(root, 'scope', { ...store.host, providerConnect: connect }, options, 'en', errorText);
    const view = await port.inspect();
    expect(view.kinds.map(kind => [kind.label, kind.detail, kind.blocked])).toEqual([['Anthropic API', 'not connected', null],
      ['Local server (vLLM / OpenAI-compatible)', 'not connected', null], ['ChatGPT sign-in', '', 'Not available yet.']]);
    const outcome = await port.connect({ kind: 'anthropic-api', endpoint: null, key: CANARY });
    expect(connect.probes).toEqual([{ kind: 'anthropic-api', endpoint: null, key: CANARY }]);
    expect(store.sets).toEqual([{ schemaVersion: 1, scopeId: 'scope', name: 'DECKENT_ANTHROPIC_KEY', value: CANARY }]);
    expect(outcome.stored).toBe(true); expect(outcome.title).toBe('Connected: Anthropic API');
    expect(outcome.lines.map(line => line.tone ?? '')).toEqual(['success', 'success', 'muted']);
    expect(outcome.lines.map(line => `${line.label}|${line.text}`)).toEqual(['Check|The provider accepted the key.',
      'Key|stored as DECKENT_ANTHROPIC_KEY in the secret store (core.secret-store.file@1); the value is never shown',
      'Next|No model uses DECKENT_ANTHROPIC_KEY yet. Binding models to it is a governed catalog step; see: deckent models catalog list --scope scope']);
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
    // The custody words `doctor` uses for the backend the key went to (SECRET-AT-REST 1c).
    expect(port.transparency[0]!.text).toBe('Keys are plain text on disk (a 0600 file only you can read). The encrypted store is recommended: secrets.store = core.secret-store.encrypted-file@1.');
    expect((await port.inspect()).kinds[0]!.detail).toBe('key DECKENT_ANTHROPIC_KEY stored · 0 model profile(s) use it');
  });

  it('every refused check stores nothing and says why in the person\'s language', async () => {
    const { root, options } = await project({});
    for (const [outcome, status, text] of [['credential-rejected', 401, 'Anahtar reddedildi: geçersiz ya da süresi dolmuş.'], ['access-denied', 403, 'Anahtar geçerli ama bu API\'ye erişimi yok.'],
      ['spend-limit', 402, 'Hesabın harcama sınırına ulaşıldı.'], ['rate-limit', 429, 'Şu an istek sınırına takıldı; biraz sonra yeniden deneyin.'],
      ['limit-reached', 429, 'Bir sınıra ulaşıldı (sağlayıcı hangisi olduğunu söylemedi).'], ['unreachable', null, 'Sağlayıcıya ulaşılamadı.'],
      ['unexpected', 404, 'Beklenmeyen yanıt (HTTP 404).']] as const) {
      const store = secrets();
      const result = await providerPanelPort(root, 'scope', { ...store.host, providerConnect: connectHost(outcome, status) }, options, 'tr', errorText)
        .connect({ kind: 'anthropic-api', endpoint: null, key: CANARY });
      expect(store.sets).toEqual([]);
      expect(result).toMatchObject({ stored: false, title: 'Bağlanmadı: Anthropic API' });
      expect(result.lines[0]).toEqual({ label: 'Deneme', text, tone: 'warning' });
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
  });

  it('a store that cannot write is reported typed (nothing kept); disconnect removes by name and warns about profiles that still name the key', async () => {
    const { root, options } = await project({ provider_invocation_profiles: { schemaVersion: 1, profiles: [profile(reference, 'DECKENT_ANTHROPIC_KEY')] } });
    const store = secrets(['DECKENT_ANTHROPIC_KEY']);
    const readOnly = { ...store.host, setSecret: async () => { throw Object.assign(new Error('SECRET_STORE_READ_ONLY'), { code: 'SECRET_STORE_READ_ONLY' }); } };
    const refused = await providerPanelPort(root, 'scope', { ...readOnly, providerConnect: connectHost('ok') }, options, 'en', errorText)
      .connect({ kind: 'anthropic-api', endpoint: null, key: CANARY });
    expect(refused.stored).toBe(false);
    expect(refused.lines.find(line => line.label === 'Key')).toEqual({ label: 'Key', text: 'not stored. ERR:SECRET_STORE_READ_ONLY', tone: 'warning' });
    expect(JSON.stringify(refused)).not.toContain(CANARY);
    const port = providerPanelPort(root, 'scope', { ...store.host, providerConnect: connectHost('ok') }, options, 'en', errorText);
    expect((await port.inspect()).kinds[0]!.detail).toBe('key DECKENT_ANTHROPIC_KEY stored · 1 model profile(s) use it');
    expect(await port.disconnect('anthropic-api')).toEqual(['The stored key DECKENT_ANTHROPIC_KEY was removed.',
      '1 model profile(s) name DECKENT_ANTHROPIC_KEY; they are refused until a key is stored again.']);
    expect(store.deletes).toEqual([{ schemaVersion: 1, scopeId: 'scope', name: 'DECKENT_ANTHROPIC_KEY' }]);
  });
});

describe('/provider addresses (owner 2026-10-08, D3: chosen from a list; a typed address is the narrow exception)', () => {
  it('lists the configured inference server first, then the known local servers; a fixed-endpoint kind lists none; a typed address is checked and previewed', async () => {
    const serving = { schemaVersion: 1, activeProfileId: 'dev', profiles: [{ schemaVersion: 1, id: 'dev', scopeId: 'scope',
      hardware: { gpus: 1, vramGbPerGpu: 32, arch: 'blackwell_consumer', topology: 'single' },
      model: { modelId: 'local/chat', weightGb: 17.5, kvBytesPerTokenBf16: 65536, kvBytesPerTokenFp8: 32768, deltaNetStateGbPerSeq: 0.1 },
      serving: { backend: 'vllm', openaiBaseUrl: 'http://127.0.0.1:8000/v1', weightQuant: 'nvfp4', kvDtype: 'fp8', gpuMemUtil: 0.92, overheadGb: 3 },
      workload: { maxCtx: 163840, avgActiveCtx: 32768, roleMaxCtx: { brain: 163840, worker: 65536, auditor: 32768 } }, calibration: { computeCap: 8 } }] };
    const { root, options } = await project({ inference_serving: serving });
    const port = providerPanelPort(root, 'scope', { ...secrets().host, providerConnect: connectHost('ok') }, options, 'tr', errorText);
    const kinds = (await port.inspect()).kinds;
    // The configured server and the vLLM default are the same base: one row, the configured one.
    expect(kinds.find(kind => kind.id === 'local-openai')!.endpointChoices).toEqual([
      { id: 'configured', label: 'Bu kurulumun çıkarım sunucusu', url: 'http://127.0.0.1:8000' }, { id: 'ollama', label: 'Bu makinedeki Ollama', url: 'http://127.0.0.1:11434' }]);
    expect(kinds.find(kind => kind.id === 'anthropic-api')!.endpointChoices).toEqual([]);
    expect(port.endpoint('local-openai', 'http://localhost:9000/v1/')).toEqual({ ok: true, base: 'http://localhost:9000', check: 'http://localhost:9000/v1/models' });
    expect(port.endpoint('local-openai', 'http://10.0.0.2:8000')).toEqual({ ok: false, reason: 'Düz http yalnız bu makinede kullanılabilir; https kullanın.' });
  });
});

describe('/model source', () => {
  const catalog = { schemaVersion: 1, revision: 'catalog-1', providers: [{ id: 'local-openai', version: 1, models: ['chat', 'coder', 'fast', 'keyless'].map(id => ({ id, version: 1,
    nativeId: `native-${id}`, protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] })) }] };
  const ref = (modelId: string) => ({ ...reference, modelId });
  it('ready only when a profile, its key and an active activation exist; otherwise the first missing step with the exact command; never a fallback', async () => {
    const { root, options } = await project({ provider_invocation_profiles: { schemaVersion: 1, profiles: [profile(ref('chat'), 'DECKENT_LOCAL_ENDPOINT_KEY'),
      profile(ref('coder'), 'DECKENT_LOCAL_ENDPOINT_KEY'), profile(ref('keyless'), 'DECKENT_MISSING_KEY')] } });
    const active = new Set(['chat']);
    const host: Parameters<typeof modelPanelSource>[2] = {
      inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog }) as never,
      inspectModelActivation: async (_root, query) => ({ schemaVersion: 1, scopeId: 'scope', reference: query.reference, availability: 'not-observed',
        activation: active.has(query.reference.modelId) ? { state: 'active', revision: 1 } : query.reference.modelId === 'coder' ? { state: 'inactive', revision: 3 } : null }) as never,
      inspectModelBinding: async (_root, query) => ({ schemaVersion: 1, reference: query, availability: 'not-observed', status: 'declared', catalogRevision: 'catalog-1',
        definition: {}, binding: { encodingVersion: 1, algorithm: 'sha256', digest: 'd'.repeat(64) } }) as never,
      describeTerminalChatPlan: async () => ({ schemaVersion: 1, status: 'ready', reference: ref('chat'), catalogRevision: 'catalog-1', maxCompletionTokens: 1, historyMessages: 1 }),
      listSecretNames: async () => ({ schemaVersion: 1, backend: 'core.secret-store.file@1', names: ['DECKENT_LOCAL_ENDPOINT_KEY'] }),
    };
    const view = await modelPanelSource(root, 'scope', host, options, 'en').inspect();
    expect(view.choices.map(choice => [choice.reference.modelId, choice.configured, choice.blocked])).toEqual([
      ['chat', true, null],
      ['coder', false, 'Not activated in this scope.'],
      ['fast', false, 'Not connected in this scope: no invocation profile names this model. Connect the provider with /provider; binding a model to that connection is a governed configuration step.'],
      ['keyless', false, 'Its key DECKENT_MISSING_KEY is not in the secret store. Connect the provider with /provider.']]);
    // Human words in the row; the exact reference and the fixing command only as dimmed lines of the focused row.
    expect(view.choices.map(choice => choice.detail)).toEqual(['ready (connection not probed)', 'cannot be chosen now', 'cannot be chosen now', 'cannot be chosen now']);
    expect(view.choices[0]!.exact).toBe('local-openai@1/chat@1 · native native-chat');
    expect(view.choices[1]!.command).toBe('deckent models activate --scope scope --provider local-openai --provider-version 1 --model coder --model-version 1 --command-id <new id> '
      + `--expected-revision 3 --binding-digest ${'d'.repeat(64)} --catalog-revision catalog-1`);
    expect(view.choices[0]!.command).toBeNull();
    expect(view.defaultBlocked).toBe('Coming soon.');
  });
  it('an empty catalog says models are never added from here', async () => {
    const { root, options } = await project({});
    const view = await modelPanelSource(root, 'scope', { inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'not-configured', availability: 'not-observed', catalog: null }) }, options, 'tr')
      .inspect();
    expect(view.choices).toEqual([]); expect(view.notes[0]).toContain('buradan eklenmez');
  });
});
