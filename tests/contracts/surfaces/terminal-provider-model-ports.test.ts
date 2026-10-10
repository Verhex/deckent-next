import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { providerEndpoint } from '#adapters/core/provider-connect/index.js';
import { modelPanelSource, providerOutcomeWord, providerPanelPort, type ProviderConnectHost, type TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import type { ModelConnectCommand, ModelConnectResult } from '#domain/index.js';
import { providerModelTree, providerPanelTree } from '#surfaces/core/terminal-panels/index.js';
import { modelInvocabilityText } from '#surfaces/core/model-invocability/index.js';
import { ModelInvocableNowApplication, type ModelInvocability, type InvocableModels } from '#engine/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';

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
  // Scope 'scope' has a spending budget unless the test removes it; typed readiness decides each model's money requirement.
  const budget = { provider_spending: { schemaVersion: 1, budgets: [{ schemaVersion: 1, scopeId: 'scope', budgetId: 'b', revision: 1, currency: 'USD', limitMinorUnits: 100 }] } };
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify(config['provider_spending'] === null ? Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'provider_spending'))
    : { ...budget, ...config }), { mode: 0o600 });
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

it.each(['en', 'tr'] as const)('a multi-workspace key result gives the selection step in %s without printing its key', async locale => {
  const { root, options } = await project({}), store = secrets();
  const host = { ...connectHost('ok'), probe: async () => ({ outcome: 'ok', httpStatus: 200, key: 'unverified' as const, workspaceRequired: true as const }) };
  const result = await providerPanelPort(root, 'scope', { ...store.host, providerConnect: host }, options, locale, errorText)
    .connect({ kind: 'anthropic-api', endpoint: null, key: CANARY });
  expect(result.stored).toBe(true); expect(result.lines.at(-1)!.text).toContain('/model');
  expect(result.lines.at(-1)!.text).toContain(locale === 'en' ? 'Select provider workspace' : 'Sağlayıcı workspace seç');
  expect(JSON.stringify(result)).not.toContain(CANARY);
});

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
      'Next|No model uses DECKENT_ANTHROPIC_KEY yet: choose "Connect a model" on this provider.']);
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
    // The custody words `doctor` uses for the backend the key went to (SECRET-AT-REST 1c).
    expect(port.transparency[0]!.text).toBe('Keys are plain text on disk (a 0600 file only you can read). The encrypted store is recommended: deckent secret store moves the keys and removes the plain text.');
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
    expect(port.endpoint('local-openai', 'http://127.0.0.1:9000/v1/')).toEqual({ ok: true, base: 'http://127.0.0.1:9000', check: 'http://127.0.0.1:9000/v1/models' });
    // CONNECT-LOCALITY: only literal loopback is local; a 'localhost' name is refused like any other plain-http host.
    expect(port.endpoint('local-openai', 'http://localhost:9000/v1/')).toEqual({ ok: false, reason: 'Düz http yalnız bu makinede kullanılabilir; https kullanın.' });
    expect(port.endpoint('local-openai', 'http://10.0.0.2:8000')).toEqual({ ok: false, reason: 'Düz http yalnız bu makinede kullanılabilir; https kullanın.' });
  });
});

describe('/provider port: connect a model (T4-B)', () => {
  const generic = { id: 'openai-compatible', labelKey: 'tui.provider.kind.openaiCompatible', available: true, endpointDefault: null, endpointEditable: true, keyRequired: true,
    secretName: null, probePath: '/v1/models', endpointChoices: [], connectFamily: 'openai-chat-completions', seeded: false, priceRequired: true };
  const openai = { id: 'openai-api', labelKey: 'tui.provider.kind.openaiApi', available: true, endpointDefault: 'https://api.openai.com/v1', endpointEditable: false, keyRequired: true,
    secretName: 'DECKENT_OPENAI_KEY', probePath: '/v1/models', endpointChoices: [], connectFamily: 'openai-chat-completions', seeded: true };
  const host = (results: ModelConnectResult[]) => {
    const commands: ModelConnectCommand[] = [];
    const connect: ProviderConnectHost = { kinds: [openai, generic], endpoint: providerEndpoint, probe: async () => ({ outcome: 'ok', httpStatus: 200, key: 'verified' }),
      secretName: (kind, endpoint) => kind === 'openai-compatible' ? (endpoint ? `DECKENT_OAICOMPAT_${new URL(endpoint).hostname.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}` : null)
        : kind === 'openai-api' ? 'DECKENT_OPENAI_KEY' : null,
      // Stage 1: the host says which seed models carry a verified price; an unpriced one is listed but locked.
      seedModels: async kind => kind === 'openai-api' ? [{ nativeId: 'gpt-6-luna', displayName: 'GPT-6 Luna' }, { nativeId: 'gpt-6-astra', displayName: 'GPT-6 Astra', priced: false }] : [] };
    return { commands, connect, extra: {
      connectModel: async (_root: string, command: ModelConnectCommand) => { commands.push(command); return results.shift()!; },
      inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog: { schemaVersion: 1, revision: 'c', providers: [
        { id: 'vendor-a', version: 1, models: [{ id: 'a', version: 1, nativeId: 'native-a', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] },
        { id: 'claude', version: 1, models: [{ id: 'c', version: 1, nativeId: 'native-c', protocols: [{ family: 'anthropic-messages', version: '2023-06-01', capabilities: [] }] }] }] } }) as never } };
  };
  const result = (status: 'connected' | 'approval-pending'): ModelConnectResult => ({ schemaVersion: 1, operation: 'models.connect', commandId: 'x', scopeId: 'scope',
    connection: 'openai-api', status, reference: { providerId: 'openai-api', providerVersion: 1, modelId: 'gpt-6-luna', modelVersion: 1 }, credentialRef: 'DECKENT_OPENAI_KEY',
    keyStored: true, steps: { catalog: 'written', declaration: 'written', profile: status === 'connected' ? 'written' : 'present', activation: status === 'connected' ? 'written' : 'present', carried: 0 },
    notCarried: [], carriedModels: [], tariff: 'unmetered', approval: status === 'connected' ? null : { approvalId: 'appr-1', keyPath: 'provider_invocation_profiles', layer: 'project' }, service: 'stale' });

  it('shows the CNY/USD reason on locked China seed models in the provider port', async () => {
    const { root, options } = await project({});
    const { connect, extra } = host([]);
    const china = { ...connect.kinds[0]!, id: 'zai-cn-api', labelKey: 'tui.provider.kind.zaiCnApi', secretName: 'DECKENT_ZAI_CN_KEY' };
    connect.kinds = [china];
    connect.seedModels = async () => [{ nativeId: 'glm-5.3', displayName: 'GLM-5.3', priced: false }];
    for (const locale of ['en', 'tr'] as const) {
      const kinds = (await providerPanelPort(root, 'scope', { ...secrets(['DECKENT_ZAI_CN_KEY']).host, ...extra, providerConnect: connect }, options, locale, errorText).inspect()).kinds;
      expect(kinds[0]!.models[0]!.blocked).toContain('CNY');
      expect(kinds[0]!.models[0]!.blocked).toContain('USD');
    }
  });

  it('a provider without a free read says nothing was sent', () => {
    expect(providerOutcomeWord({ outcome: 'ok', httpStatus: null, key: 'unverified' }, 'en'))
      .toBe('No free check exists for this provider: nothing was sent and the key is kept unverified; the first turn shows any rejection.');
  });

  it('lists each kind\'s models (seed or declared in its protocol family), locks the action until the vendor key is stored, and names the derived key before saving', async () => {
    const { root, options } = await project({});
    const { connect, extra } = host([]);
    let port = providerPanelPort(root, 'scope', { ...secrets([]).host, ...extra, providerConnect: connect }, options, 'en', errorText);
    let kinds = (await port.inspect()).kinds;
    expect(kinds.map(kind => [kind.id, kind.models, kind.modelBlocked])).toEqual([
      ['openai-api', [{ id: 'seed:gpt-6-luna', label: 'GPT-6 Luna', detail: 'gpt-6-luna' },
        { id: 'seed:gpt-6-astra', label: 'GPT-6 Astra', detail: 'gpt-6-astra', blocked: 'Price not verified — paid calls are refused.' }], 'Store its key first (Connect).'],
      // Without a discovery host this fixture uses declared models in the same protocol family; the adapter gates pricing after address selection.
      ['openai-compatible', [{ id: 'ref:vendor-a@1/a@1', label: 'a', detail: 'vendor-a@1/a@1' }],
        null]]);
    // The model list locks the unpriced row with the same words (picker `blocked`).
    expect(providerModelTree(kinds[0]!, { modelTitle: '{kind}' } as never).items.map(item => [item.id, 'blocked' in item ? item.blocked : null])).toEqual([
      ['seed:gpt-6-luna', null], ['seed:gpt-6-astra', { reason: 'Price not verified — paid calls are refused.' }]]);
    expect(port.keyName!('openai-compatible', 'https://llm.example.com')).toBe('DECKENT_OAICOMPAT_LLM_EXAMPLE_COM');
    port = providerPanelPort(root, 'scope', { ...secrets(['DECKENT_OPENAI_KEY']).host, ...extra, providerConnect: connect }, options, 'en', errorText);
    kinds = (await port.inspect()).kinds;
    expect(kinds[0]!.modelBlocked).toBeNull();
    // A generic connect stores the key under the derived name of the chosen address.
    const store = secrets([]);
    port = providerPanelPort(root, 'scope', { ...store.host, ...extra, providerConnect: connect }, options, 'en', errorText);
    await port.connect({ kind: 'openai-compatible', endpoint: 'https://llm.example.com', key: CANARY });
    expect(store.sets).toEqual([{ schemaVersion: 1, scopeId: 'scope', name: 'DECKENT_OAICOMPAT_LLM_EXAMPLE_COM', value: CANARY }]);
  });

  it('offers seedless discovery after the chosen address, preserves exact ids and locks only unpriced models in EN/TR', async () => {
    const { root, options } = await project({});
    const { connect, extra } = host([]), seen: unknown[] = [];
    connect.discoverModels = async (_root, scope, kind, endpoint) => {
      seen.push({ scope, kind, endpoint });
      return [{ nativeId: 'Org/Model:Q4_K_M', displayName: 'Org/Model:Q4_K_M', priced: true }, { nativeId: 'unpriced', displayName: 'unpriced', priced: false }];
    };
    for (const locale of ['en', 'tr'] as const) {
      const port = providerPanelPort(root, 'scope', { ...secrets([]).host, ...extra, providerConnect: connect }, options, locale, errorText);
      const kind = (await port.inspect()).kinds.find(kind => kind.id === 'openai-compatible')!;
      expect(kind.discoversModels).toBe(true); expect(kind.modelBlocked).toBeNull();
      const rows = await port.listModels!('openai-compatible', 'http://localhost:9000/v1');
      expect(rows[0]).toEqual({ id: 'seed:Org/Model:Q4_K_M', label: 'Org/Model:Q4_K_M', detail: 'Org/Model:Q4_K_M' });
      expect(rows[1]!.blocked).toContain(locale === 'en' ? 'verified published price' : 'doğrulanmış yayımlanmış fiyat');
      expect(rows[1]!.blocked).toContain(locale === 'en' ? 'loopback' : 'yerel sunucu');
    }
    expect(seen).toEqual(Array(2).fill({ scope: 'scope', kind: 'openai-compatible', endpoint: 'http://localhost:9000/v1' }));
  });

  it('connects through models.connect: rows and one summary; a pending approval keeps its command id for the retry; never a key value', async () => {
    const { root, options } = await project({});
    const { connect, extra, commands } = host([result('approval-pending'), result('connected')]);
    const port = providerPanelPort(root, 'scope', { ...secrets(['DECKENT_OPENAI_KEY']).host, ...extra, providerConnect: connect }, options, 'en', errorText);
    const pending = await port.connectModel!({ kind: 'openai-api', endpoint: null, model: 'seed:gpt-6-luna' });
    expect(pending).toMatchObject({ connected: false, title: 'Waiting for approval: gpt-6-luna', approvalId: 'appr-1',
      summary: 'gpt-6-luna waits for your approval; answer the card, then connect it again.' });
    const done = await port.connectModel!({ kind: 'openai-api', endpoint: null, model: 'seed:gpt-6-luna' });
    expect(commands.map(command => command.commandId)).toEqual([commands[0]!.commandId, commands[0]!.commandId]);
    expect(commands[0]).toMatchObject({ schemaVersion: 1, scopeId: 'scope', connection: 'openai-api', endpoint: null, model: { nativeId: 'gpt-6-luna' } });
    expect(done.title).toBe('Model connected: gpt-6-luna'); expect(done.summary).toBe('gpt-6-luna is connected; choose it with /model.');
    expect(done.lines.map(line => line.label)).toEqual(['Model', 'Steps', 'Key', 'Spending', 'Service', 'Next']);
    expect(done.lines.find(line => line.label === 'Spending')!.tone).toBe('warning');
    expect(JSON.stringify([pending, done, commands])).not.toContain(CANARY);
    // K5: carried and not-carried models are rows of the window; the summary line only counts them.
    const local = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 }, coder = { ...local, modelId: 'coder' };
    const { connect: c2, extra: e2 } = host([{ ...result('connected'), carriedModels: [local], notCarried: [{ reference: coder, code: 'POLICY_DENIED' }] }]);
    const mixed = await providerPanelPort(root, 'scope', { ...secrets(['DECKENT_OPENAI_KEY']).host, ...e2, providerConnect: c2 }, options, 'en', errorText)
      .connectModel!({ kind: 'openai-api', endpoint: null, model: 'seed:gpt-6-luna' });
    expect(mixed.lines.filter(line => ['Kept active', 'Needs activation'].includes(line.label)).map(line => `${line.label}|${line.text}`)).toEqual(['Kept active|chat',
      'Needs activation|Lost its activation with the catalog change (activate it again with deckent models activate): coder (POLICY_DENIED)']);
    expect(mixed.summary).toBe('gpt-6-luna is connected; 1 other model(s) need activation again (see the window).');
    // A typed refusal stays in the window as its reason.
    const refused = await providerPanelPort(root, 'scope', { ...secrets([]).host, connectModel: async () => { throw Object.assign(new Error('x'), { code: 'MODEL_CONNECT_MODEL_UNKNOWN' }); },
      providerConnect: connect }, options, 'en', errorText).connectModel!({ kind: 'openai-api', endpoint: null, model: 'seed:nope' });
    expect(refused).toMatchObject({ connected: false, title: 'Model not connected: nope', approvalId: null });
    expect(refused.lines.at(-1)!.text).toBe('ERR:MODEL_CONNECT_MODEL_UNKNOWN');
  });
});

describe('/model source', () => {
  const catalog = { schemaVersion: 1, revision: 'catalog-1', providers: [{ id: 'local-openai', version: 1, models: ['chat', 'coder', 'fast', 'keyless'].map(id => ({ id, version: 1,
    nativeId: `native-${id}`, protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] })) }] };
  const ref = (modelId: string) => ({ ...reference, modelId });
  const reading = (state: (id: string) => ModelInvocability): InvocableModels => ({ schemaVersion: 1, scopeId: 'scope', models: catalog.providers.flatMap(provider => provider.models.map(model => ({
    reference: ref(model.id), label: model.id, nativeId: model.nativeId, catalogRevision: 'catalog-1', bindingDigest: 'd'.repeat(64), availability: state(model.id),
  }))) });

  it('ready only when a profile, its key and an active activation exist; otherwise the first missing step with the exact command; never a fallback', async () => {
    const { root, options } = await project({ provider_invocation_profiles: { schemaVersion: 1, profiles: [profile(ref('chat'), 'DECKENT_LOCAL_ENDPOINT_KEY'),
      profile(ref('coder'), 'DECKENT_LOCAL_ENDPOINT_KEY'), profile(ref('keyless'), 'DECKENT_MISSING_KEY')] } });
    const states = reading(id => id === 'chat' ? { invocable: true, reason: null } : { invocable: false, reason: { kind: id === 'coder' ? 'not-carried' : id === 'fast' ? 'profile' : 'no-credential', code: 'MODEL_INVOCATION_UNAVAILABLE', ...(id === 'coder' ? { activationRevision: 3 } : {}) } });
    let inspected = 0;
    const active = new Set(['chat']);
    const host: Parameters<typeof modelPanelSource>[2] = {
      inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog }) as never,
      inspectModelActivation: async (_root, query) => ({ schemaVersion: 1, scopeId: 'scope', reference: query.reference, availability: 'not-observed',
        activation: active.has(query.reference.modelId) ? { state: 'active', revision: 1, catalogRevision: 'catalog-1', binding: { digest: 'd'.repeat(64) } } : query.reference.modelId === 'coder' ? { state: 'inactive', revision: 3 } : null }) as never,
      inspectModelBinding: async (_root, query) => ({ schemaVersion: 1, reference: query, availability: 'not-observed', status: 'declared', catalogRevision: 'catalog-1',
        definition: {}, binding: { encodingVersion: 1, algorithm: 'sha256', digest: 'd'.repeat(64) } }) as never,
      describeTerminalChatPlan: async () => ({ schemaVersion: 1, status: 'ready', reference: ref('chat'), catalogRevision: 'catalog-1', maxCompletionTokens: 1, historyMessages: 1 }),
      inspectInvocableModels: async () => { inspected++; return states; },
      listSecretNames: async () => ({ schemaVersion: 1, backend: 'core.secret-store.file@1', names: ['DECKENT_LOCAL_ENDPOINT_KEY'] }),
    };
    const view = await modelPanelSource(root, 'scope', host, options, 'en').inspect();
    expect(inspected).toBe(1);
    expect(view.choices.map(choice => [choice.reference.modelId, choice.configured, choice.blocked])).toEqual(states.models.map(entry => [entry.reference.modelId,
      entry.reference.modelId === 'chat', entry.availability.invocable ? null : modelInvocabilityText(entry.availability, 'en')]));
    expect(view.choices.map(choice => choice.detail)).toEqual(states.models.map(entry => modelInvocabilityText(entry.availability, 'en')));
    expect(view.choices[0]!.exact).toBe('local-openai@1/chat@1 · native native-chat');
    expect(view.choices[1]!.command).toBe('deckent models activate --scope scope --provider local-openai --provider-version 1 --model coder --model-version 1 --command-id <new id> '
      + `--expected-revision 3 --binding-digest ${'d'.repeat(64)} --catalog-revision catalog-1`);
    expect(view.choices[0]!.command).toBeNull();
    expect(view.defaultBlocked).toBe('Not offered here: this terminal has no settings writer.');
  });
  it('T4-B D1: "also make default" writes the user default through the governed writer (global layer) and the window names the winning setting', async () => {
    const { root, options } = await project({ terminal: { scopeId: 'scope' } });
    const writes: Record<string, unknown>[] = [];
    let source: 'project' | 'user-default' = 'project';
    const host: Parameters<typeof modelPanelSource>[2] = {
      inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog }) as never,
      describeTerminalChatPlan: async () => ({ schemaVersion: 1, status: 'ready', reference: ref('chat'), source, catalogRevision: 'catalog-1', maxCompletionTokens: 1, historyMessages: 1 }),
      resolveConfigPrincipal: async () => ({ id: 'os:1', issuer: 'host', subject: '1', assurance: 'os-user', scopeIds: ['scope'] }) as never,
      configApplication: (() => ({
        submit: async (action: string, input: Record<string, unknown>) => { writes.push({ action, ...input }); return { status: 'applied', approvalId: null,
          result: { keyPath: input['keyPath'], layer: input['layer'], beforeDigest: null, afterDigest: 'a'.repeat(64), backupPath: null, overridden: false } }; },
        explain: async () => ({ apply: 'restart' }),
      })) as never,
    };
    const source0 = modelPanelSource(root, 'scope', host, options, 'en');
    const view = await source0.inspect();
    expect(view.defaultBlocked).toBeNull();
    expect(view.notes).toContain("In use: chat (from this project's setting; it wins over your default).");
    const outcome = await source0.makeDefault!(view.choices[1]!);
    expect(writes).toEqual([expect.objectContaining({ action: 'set', keyPath: 'terminal.defaultModel', layer: 'global', scopeId: 'scope', value: ref('coder') })]);
    expect(outcome.status).toBe('applied');
    expect(outcome.lines.at(-1)).toBe('This project names its own model, so the project setting still wins here.');
    source = 'user-default';
    expect((await source0.inspect()).notes).toContain('In use: chat (your default model).');
  });
  it('OpenRouter carries the seed models and no next-slice note on its row or connect result', async () => {
    const { root, options } = await project({});
    const base = connectHost('ok');
    const connect = { ...base, kinds: [{ id: 'openrouter', labelKey: 'tui.provider.kind.openrouter', available: true, endpointDefault: 'https://openrouter.ai', endpointEditable: false,
      keyRequired: true, secretName: 'DECKENT_OPENROUTER_KEY', probePath: '/api/v1/key', endpointChoices: [], connectFamily: 'openai-chat-completions', seeded: true }],
      seedModels: async () => [{ nativeId: 'anthropic/claude-sonnet-5.5', displayName: 'Claude Sonnet 5.5', priced: true }] };
    const port = providerPanelPort(root, 'scope', { ...secrets([]).host, providerConnect: connect, connectModel: async () => { throw new Error('not called'); } }, options, 'en', errorText);
    expect((await port.inspect()).kinds[0]).toMatchObject({ id: 'openrouter', models: [{ label: 'Claude Sonnet 5.5' }] });
    expect((await port.inspect()).kinds[0]!.pendingNote).toBeUndefined();
    const outcome = await port.connect({ kind: 'openrouter', endpoint: null, key: CANARY });
    expect(JSON.stringify(outcome)).not.toContain('next slice');
  });

  it('(c) an old key name is warned, listed with removal as its only action, and removed through the store', async () => {
    const { root, options } = await project({});
    const store = secrets(['DECKENT_OPENAI_COMPATIBLE_KEY']);
    const connect = { ...connectHost('ok'), legacyKeys: [{ secretName: 'DECKENT_OPENAI_COMPATIBLE_KEY', moveTo: 'anthropic-api' }] };
    const port = providerPanelPort(root, 'scope', { ...store.host, providerConnect: connect }, options, 'en', errorText);
    const view = await port.inspect();
    expect(view.notes).toContain('An old key name was found: DECKENT_OPENAI_COMPATIBLE_KEY. No connection uses it any more; store the key again on Anthropic API, then remove the old one.');
    const legacy = view.kinds.at(-1)!;
    expect(legacy).toMatchObject({ id: 'legacy:DECKENT_OPENAI_COMPATIBLE_KEY', label: 'Old key name DECKENT_OPENAI_COMPATIBLE_KEY', legacy: true });
    expect(providerPanelTree(view, terminalPanelLabels('en').provider, true).items.at(-1)!.children!.map(child => child.id)).toEqual(['disconnect']);
    expect(await port.disconnect(legacy.id)).toEqual(['The stored key DECKENT_OPENAI_COMPATIBLE_KEY was removed.']);
    expect(store.deletes).toEqual([{ schemaVersion: 1, scopeId: 'scope', name: 'DECKENT_OPENAI_COMPATIBLE_KEY' }]);
  });

  it('(a) without typed readiness, a missing spending budget conservatively locks every model row and names the next step', async () => {
    const { root, options } = await project({ provider_spending: null, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile(ref('chat'), null)] } });
    const view = await modelPanelSource(root, 'scope', {
      inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog }) as never,
      inspectModelActivation: async (_root, query) => ({ schemaVersion: 1, scopeId: 'scope', reference: query.reference, availability: 'not-observed', activation: { state: 'active', revision: 1, catalogRevision: 'catalog-1', binding: { digest: 'd'.repeat(64) } } }) as never,
      inspectInvocableModels: async () => reading(() => ({ invocable: false, reason: { kind: 'budget', code: 'PROVIDER_SPEND_UNAVAILABLE' } })),
    }, options, 'en').inspect();
    expect(view.choices.every(choice => choice.blocked === modelInvocabilityText({ invocable: false, reason: { kind: 'budget', code: 'PROVIDER_SPEND_UNAVAILABLE' } }, 'en'))).toBe(true);
    // Stage 1: the next step is the window's own "Create budget" row, or the governed CLI command (never hand-written JSON).
    expect(view.notes[0]).toContain('No spending budget is set for scope scope'); expect(view.notes[0]).toContain('Create budget');
    expect(view.notes[0]).toContain('deckent models create-budget --scope scope --usd <amount>');
    const provider = await providerPanelPort(root, 'scope', { ...secrets([]).host, providerConnect: connectHost('ok'), inspectInvocableModels: async () => reading(() => ({ invocable: false, reason: { kind: 'budget', code: 'PROVIDER_SPEND_UNAVAILABLE' } })) }, options, 'en', errorText).inspect();
    expect(provider.notes).toContain(view.notes[0]);
    // A ledger account (governed create) counts as the scope's budget: the rows unlock and the note is gone.
    const inspectProviderSpendAccount = async (_root: string, query: unknown) => { expect(query).toEqual({ schemaVersion: 1, scopeId: 'scope', current: true });
      return { checkpoint: { account: {} } } as never; };
    const opened = await modelPanelSource(root, 'scope', { inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog }) as never,
      inspectModelActivation: async (_root, query) => ({ schemaVersion: 1, scopeId: 'scope', reference: query.reference, availability: 'not-observed', activation: { state: 'active', revision: 1, catalogRevision: 'catalog-1', binding: { digest: 'd'.repeat(64) } } }) as never,
      inspectModelBinding: async () => ({ status: 'declared', catalogRevision: 'catalog-1', binding: { digest: 'd'.repeat(64) } }) as never,
      inspectProviderSpendAccount, inspectInvocableModels: async () => reading(id => id === 'chat' ? { invocable: true, reason: null } : { invocable: false, reason: { kind: 'profile', code: 'MODEL_INVOCATION_PROFILE_CONFLICT' } }) }, options, 'en').inspect();
    // The connected model is ready; the others keep their own (non-budget) reasons.
    expect(opened.choices.find(choice => choice.reference.modelId === 'chat')!.blocked).toBeNull();
    expect(opened.choices.some(choice => choice.blocked?.includes('PROVIDER_SPEND_UNAVAILABLE'))).toBe(false); expect(opened.notes.join('\n')).not.toContain('No spending budget');
  });
  it.each(['en', 'tr'] as const)('uses typed readiness without a money budget: zero tariff is selectable and priced calls stay refused (%s)', async locale => {
    const paid = profile(ref('coder'), null);
    const { root, options } = await project({ provider_spending: null, provider_invocation_profiles: { schemaVersion: 1,
      profiles: [profile(ref('chat'), null), { ...paid, adapter: { ...paid.adapter, definition: { ...paid.adapter.definition,
        tariff: { ...tariff, inputMinorUnitsPerMillionTokens: 100 } } } }] } });
    const checked: string[] = [];
    const view = await modelPanelSource(root, 'scope', {
      inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog }) as never,
      // MODEL-STATE-PARITY: the shared invocable-now reader runs the same typed readiness per model (merge of CORE-BUDGET-HOLD's case).
      inspectInvocableModels: async () => new ModelInvocableNowApplication(async selected => {
        checked.push(selected.modelId);
        if (selected.modelId === 'coder') throw Object.assign(new Error('money budget absent'), { code: 'PROVIDER_SPEND_UNAVAILABLE' });
      }).read('scope', reading(() => ({ invocable: true, reason: null })).models.filter(model => ['chat', 'coder'].includes(model.reference.modelId))),
    }, options, locale).inspect();
    expect(checked.sort()).toEqual(['chat', 'coder']);
    expect(view.choices.find(choice => choice.reference.modelId === 'chat')!.blocked).toBeNull();
    expect(view.choices.find(choice => choice.reference.modelId === 'coder')!.blocked).toContain('PROVIDER_SPEND_UNAVAILABLE');
    expect(view.notes[0]).toContain(locale === 'en' ? 'zero-tariff models remain available' : 'sıfır tarifeli modeller kullanılabilir');
  });
  it('missing shared inspection locks every declared model even when legacy hosts claim it is active', async () => {
    const { root, options } = await project({});
    const view = await modelPanelSource(root, 'scope', { inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'declared', catalog }) }, options, 'en').inspect();
    expect(view.choices).toHaveLength(4); expect(view.choices.every(choice => choice.blocked?.includes('MODEL_INVOCATION_UNAVAILABLE'))).toBe(true);
  });
  it('an empty catalog says models are never added from here', async () => {
    const { root, options } = await project({});
    const view = await modelPanelSource(root, 'scope', { inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'not-configured', availability: 'not-observed', catalog: null }) }, options, 'tr')
      .inspect();
    expect(view.choices).toEqual([]); expect(view.notes[0]).toContain('buradan eklenmez');
  });
});
