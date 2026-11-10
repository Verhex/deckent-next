import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache, resolveGlobalConfigPaths, resolveProductLayout, productResourcePath, ErrorRegistry, formatHumanError, t } from '#platform/index.js';
import * as adapters from '#adapters/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { probeProviderConnection, providerEndpoint } from '#adapters/core/provider-connect/index.js';
import { modelPanelSource, providerOutcomeWord, providerPanelPort, type ProviderConnectHost, type TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import { modelInvocationProfileSchema, type ModelConnectCommand, type ModelConnectResult } from '#domain/index.js';
import { providerModelTree, providerPanelTree, subscriptionModelView, subscriptionReadinessText } from '#surfaces/core/terminal-provider/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import type { NativeAgentReadiness } from '#capabilities/index.js';
import { ModelInvocableNowApplication, modelInvocationProfileDigest, modelInvocabilityText, type ModelInvocability, type InvocableModels } from '#engine/index.js';
import { main as runConfiguredCli } from '#composition/core/cli/index.js';
import * as cliSurface from '#surfaces/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';

// T4-A ports over the host's handlers (no runtime, no network): `/provider` runs the free check and sends the key only to the secret store
// handler, and only when the check passes; `/model` lists declared models with the first missing precondition as the reason.
const CANARY = 'sk-canary-T4-6f1d2e9c0b7a';
// The provider sections are registered by the composition root in the product; here the test registers them once.
adapters.registerProviderConfig();
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
  const host = { ...connectHost('ok'), probe: async () => ({ outcome: 'ok', httpStatus: 400, key: 'unverified' as const, workspaceRequired: true as const }) };
  const result = await providerPanelPort(root, 'scope', { ...store.host, providerConnect: host }, options, locale, errorText)
    .connect({ kind: 'anthropic-api', endpoint: null, key: CANARY });
  expect(result.stored).toBe(true); expect(result.lines.at(-1)!.text).toContain('/model');
  expect(result.lines.at(-1)!.text).toContain(locale === 'en' ? 'Select provider workspace' : 'Sağlayıcı workspace seç');
  expect(JSON.stringify(result)).not.toContain(CANARY);
});

it('BeUser re-walk (3t): an environment-variable store that cannot list names is said plainly as non-blocking, never as a failure', async () => {
  const { root, options } = await project({}), store = secrets();
  for (const locale of ['en', 'tr'] as const) {
    const port = providerPanelPort(root, 'scope', { ...store.host, listSecretNames: async () => { throw ErrorRegistry.createError('SECRET_STORE_UNSUPPORTED', { params: { backend: 'core.secret-store.env@1' } }); },
      providerConnect: connectHost('ok') }, options, locale, errorText);
    const notes = (await port.inspect()).notes.join('\n');
    expect(notes).toContain(locale === 'en' ? 'This does not block anything; a local server needs no key.' : 'Bu hiçbir şeyi engellemez; yerel sunucu anahtar istemez.');
    expect(notes).not.toContain('core.secret-store.env@1');
    // AYSE-R2-05: the keyless local server row never shows the key store's listing problem.
    const local = (await port.inspect()).kinds.find(kind => kind.id === 'local-openai')!;
    expect(local.detail).toBe(t('tui.provider.state.notConnected', {}, locale));
  }
});

describe('/provider port', () => {
  it('a passing check stores the key under its name through the store handler; rows name the outcome, the key name and the next step, never the key', async () => {
    const { root, options } = await project({ provider_invocation_profiles: { schemaVersion: 1, profiles: [] } });
    const connect = connectHost('ok'), store = secrets();
    const port = providerPanelPort(root, 'scope', { ...store.host, providerConnect: connect }, options, 'en', errorText);
    const view = await port.inspect();
    expect(view.kinds.map(kind => [kind.label, kind.detail, kind.blocked])).toEqual([['Anthropic API', 'not connected', null],
      ['Local server (vLLM / OpenAI-compatible)', 'not connected', null], ['Sign in with ChatGPT', '', 'Not available yet. Connect with an API key']]);
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

  it('a keyless server whose models were pulled reads as connected: no "no model uses the key" line and no "not connected" row (FIX8c)', async () => {
    const { root, options } = await project({});
    const local = { ...connectHost('ok').kinds[1]!, pull: 'available' as const, connectFamily: 'openai-chat-completions' };
    const pulled = { providerId: `local-openai-${'a'.repeat(32)}`, providerVersion: 1, modelId: 'fixture-small', modelVersion: 1 };
    const port = providerPanelPort(root, 'scope', { ...secrets().host, providerConnect: { ...connectHost('ok'), kinds: [local] },
      connectModel: async () => ({ schemaVersion: 1, operation: 'models.connect', commandId: 'x', scopeId: 'scope', connection: 'local-openai', status: 'connected', reference: pulled,
        models: [{ nativeId: 'fixture-small', state: 'connected', reference: pulled }], credentialRef: null, keyStored: null,
        steps: { catalog: 'written', declaration: 'written', profile: 'written', activation: 'written', carried: 0 }, notCarried: [], carriedModels: [], tariff: 'unmetered', approval: null, service: 'current' }) as never,
      inspectInvocableModels: async () => ({ schemaVersion: 1, scopeId: 'scope', models: [{ reference: pulled, label: 'fixture-small', nativeId: 'fixture-small', catalogRevision: 'c',
        bindingDigest: 'd'.repeat(64), availability: { invocable: true, reason: null } }] }) as never }, options, 'en', errorText);
    const outcome = await port.connect({ kind: 'local-openai', endpoint: 'http://127.0.0.1:18777', key: null });
    expect(outcome.lines.map(line => line.text).join('\n')).not.toContain('No model uses');
    expect(outcome.lines.at(-1)!.text).toBe(t('tui.provider.model.next', {}, 'en'));
    expect((await port.inspect()).kinds[0]!.detail).toBe('1 model(s) connected');
    // Negative: a key-required kind whose key is gone stays "not connected" even when a profile of its provider remains.
    const keyed = { ...connectHost('ok').kinds[0]!, catalogProviderId: pulled.providerId };
    const gone = providerPanelPort(root, 'scope', { ...secrets().host, providerConnect: { ...connectHost('ok'), kinds: [keyed] },
      inspectInvocableModels: async () => ({ schemaVersion: 1, scopeId: 'scope', models: [{ reference: pulled, label: 'fixture-small', nativeId: 'fixture-small', catalogRevision: 'c',
        bindingDigest: 'd'.repeat(64), availability: { invocable: true, reason: null } }] }) as never }, options, 'en', errorText);
    expect((await gone.inspect()).kinds[0]!.detail).toBe('not connected');
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

// G2-7 (owner 2026-10-18, "no key over plain http"): a key typed for a plain-http local server is refused by the real connection check before
// any request; the window says why in the person's language and nothing is stored.
describe('/provider: a key for a plain-http address', () => {
  it.each([['en', 'Key: not sent, not checked and not stored — a key never travels over plain http'], ['tr', 'Anahtar: gönderilmedi, denenmedi ve saklanmadı — anahtar düz http üzerinden']] as const)(
    '%s: refused before any request, explained, nothing stored; an empty key still checks the server', async (locale, text) => {
      const { root, options } = await project({});
      const store = secrets(), sent: string[] = [];
      const fetch = async (url: string, init: { headers: Record<string, string> }) => { sent.push(`${url} ${init.headers['authorization'] ?? 'no-key'}`); return new Response('{"data":[]}', { status: 200 }); };
      const host = { ...connectHost('ok'), probe: (input: { kind: string; endpoint: string | null; key: string | null }) => probeProviderConnection(input, { fetch }) };
      const port = providerPanelPort(root, 'scope', { ...store.host, providerConnect: host }, options, locale, errorText);
      for (const endpoint of ['http://127.0.0.1:8000', 'http://[::1]:11434']) {
        const refused = await port.connect({ kind: 'local-openai', endpoint, key: CANARY });
        expect(refused).toMatchObject({ stored: false });
        expect(refused.lines[0]).toMatchObject({ tone: 'warning', text: expect.stringContaining(text) });
        expect(JSON.stringify(refused)).not.toContain(CANARY);
      }
      expect(sent).toEqual([]); expect(store.sets).toEqual([]);
      expect(await port.connect({ kind: 'local-openai', endpoint: 'http://127.0.0.1:8000', key: null })).toMatchObject({ stored: false });
      expect(sent).toEqual(['http://127.0.0.1:8000/v1/models no-key']); expect(store.sets).toEqual([]);
    });
});

describe('/provider addresses (owner 2026-10-08, D3: chosen from a list; a typed address is the narrow exception)', () => {
  it.each(['en', 'tr'] as const)('%s: a refused HTTP address names the literal loopback alternatives and suggests 127.0.0.1', async locale => {
    const { root, options } = await project({});
    const store = secrets(), host = connectHost('ok');
    const port = providerPanelPort(root, 'scope', { ...store.host, providerConnect: host }, options, locale, errorText);
    const reason = locale === 'en'
      ? 'Plain http is allowed only for 127.0.0.1 / [::1]; use 127.0.0.1 for a local server, or https for other addresses.'
      : 'Düz http yalnız 127.0.0.1 / [::1] için kullanılabilir; yerel sunucu için 127.0.0.1, diğer adresler için https kullanın.';
    for (const host of ['localhost', '10.0.0.2', '172.28.64.1']) {
      expect(port.endpoint('local-openai', `http://${host}:8000`)).toEqual({ ok: false, reason });
      expect(port.endpoint('local-openai', `https://${host}:8000`)).toMatchObject({ ok: true });
    }
    for (const host of ['127.0.0.1', '[::1]']) {
      expect(port.endpoint('local-openai', `http://${host}:8000`)).toEqual({ ok: true, base: `http://${host}:8000`, check: `http://${host}:8000/v1/models` });
    }
    for (const text of [terminalPanelLabels(locale).provider.endpointHint, t('error.MODEL_CONNECT_ENDPOINT_INVALID', {}, locale)]) {
      expect(text).toContain('127.0.0.1 / [::1]');
      expect(text).not.toContain(locale === 'en' ? 'only on this machine' : 'yalnız bu makinede');
    }
    expect(host.probes).toEqual([]); expect(store.sets).toEqual([]);
  });

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
    expect(port.endpoint('local-openai', 'http://localhost:9000/v1/')).toEqual({ ok: false, reason: 'Düz http yalnız 127.0.0.1 / [::1] için kullanılabilir; yerel sunucu için 127.0.0.1, diğer adresler için https kullanın.' });
    expect(port.endpoint('local-openai', 'http://10.0.0.2:8000')).toEqual({ ok: false, reason: 'Düz http yalnız 127.0.0.1 / [::1] için kullanılabilir; yerel sunucu için 127.0.0.1, diğer adresler için https kullanın.' });
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
      // U2: "connected" is said only when the invocable-now reading names the model; this host's reading does.
      inspectInvocableModels: async () => ({ schemaVersion: 1, scopeId: 'scope', models: [{ reference: { providerId: 'openai-api', providerVersion: 1, modelId: 'gpt-6-luna', modelVersion: 1 },
        label: 'gpt-6-luna', nativeId: 'gpt-6-luna', catalogRevision: 'c', bindingDigest: 'd'.repeat(64), availability: { invocable: true, reason: null } }] }) as never,
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
    expect(done.lines.map(line => line.label)).toEqual(['Model', 'Steps', 'Key', 'Spending', 'Service', '']);
    expect(done.lines.at(-1)).toEqual({ label: '', text: 'Choose it with /model (this session, or also as your default).', tone: 'success' });
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
    expect(await modelPanelSource(root, 'scope', host, options, 'en').toolsDeclared!(ref('chat'))).toBeNull();
    expect(view.choices.map(choice => [choice.reference.modelId, choice.configured, choice.blocked])).toEqual(states.models.map(entry => [entry.reference.modelId,
      entry.reference.modelId === 'chat', entry.availability.invocable ? null : modelInvocabilityText(entry.availability, 'en')]));
    // U2: each row leads with its chat on/off state, then the same shared invocability words.
    expect(view.choices.map(choice => choice.detail)).toEqual(states.models.map(entry => `${active.has(entry.reference.modelId) ? 'On' : 'Off'} · ${modelInvocabilityText(entry.availability, 'en')} · tool support unknown`));
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
    expect(view.notes).toContain("In use: native-chat (from this project's setting; it wins over your default).");
    const outcome = await source0.makeDefault!(view.choices[1]!);
    expect(writes).toEqual([expect.objectContaining({ action: 'set', keyPath: 'terminal.defaultModel', layer: 'global', scopeId: 'scope', value: ref('coder') })]);
    expect(outcome.status).toBe('applied');
    expect(outcome.lines.at(-1)).toBe('This project names its own model, so the project setting still wins here.');
    source = 'user-default';
    expect((await source0.inspect()).notes).toContain('In use: native-chat (your default model).');
  });
  it('R9b (owner 2026-11-06): the recommended Brain models are marked and suggested while none is chosen, every runnable model can be chosen; "Use as Brain model" writes brain_planner.reference on the chosen layer', async () => {
    const { root, options } = await project({ terminal: { scopeId: 'scope' } });
    const writes: Record<string, unknown>[] = [];
    const host: Parameters<typeof modelPanelSource>[2] = {
      inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog }) as never,
      inspectInvocableModels: async () => reading(id => id === 'fast' ? { invocable: false, reason: { kind: 'profile', code: 'MODEL_INVOCATION_UNAVAILABLE' } } : { invocable: true, reason: null }),
      // `coder` holds the role by tier; `fast` by a current exception but cannot run now (marked, never offered); `chat` is not recommended yet can be chosen.
      inspectBrainModels: async () => ({ models: [{ channelId: 'local-openai', modelId: 'native-coder', tier: 'frontier', basis: 'tier', measured: false, active: true },
        { channelId: 'local-openai', modelId: 'native-fast', tier: null, basis: 'exception', exceptionId: 'interim', expiresOn: '2099-01-01', active: false }] }),
      resolveConfigPrincipal: async () => ({ id: 'os:1', issuer: 'host', subject: '1', assurance: 'os-user', scopeIds: ['scope'] }) as never,
      configApplication: (() => ({
        submit: async (action: string, input: Record<string, unknown>) => { writes.push({ action, ...input }); return { status: 'applied', approvalId: null,
          result: { keyPath: input['keyPath'], layer: input['layer'], beforeDigest: null, afterDigest: 'a'.repeat(64), backupPath: null, overridden: false } }; },
        explain: async () => ({ apply: 'live' }), inspectValue: async () => ({ value: (JSON.parse(await readFile(join(root, '.deckent/config.json'), 'utf8')) as { brain_planner?: { excluded?: unknown } }).brain_planner?.excluded }),
      })) as never,
    };
    const source = modelPanelSource(root, 'scope', host, options, 'en'), view = await source.inspect(), row = (id: string) => view.choices.find(choice => choice.reference.modelId === id)!;
    expect(row('coder').detail).toMatch(/ · recommended for planning \/do work \(Brain\)$/u); expect(row('fast').detail).toMatch(/ · recommended for planning \/do work \(Brain\)$/u);
    expect(row('chat').detail).not.toContain('Brain');
    for (const id of ['coder', 'chat']) expect(row(id).fixes!.map(fix => fix.id)).toEqual(expect.arrayContaining(['brain-global', 'brain-project']));
    expect(row('fast').fixes!.some(fix => fix.id.startsWith('brain'))).toBe(false);
    expect(view.notes).toContain('No Brain model chosen: /do plans with the chat model. Recommended for planning: native-coder. Open one and choose “Use as Brain model”.');
    expect((await source.setBrain!(row('coder'), 'project')).lines[0]).toBe('native-coder now plans /do work. Chat keeps its own model.');
    expect(writes).toEqual([expect.objectContaining({ action: 'set', keyPath: 'brain_planner.reference', layer: 'project', scopeId: 'scope', value: ref('coder') })]);
    // A project Brain keeps winning over a user one: the window says so instead of claiming the switch; nothing is suggested once one is chosen.
    const configPath = join(root, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(configPath, JSON.stringify({ ...config, brain_planner: { reference: ref('chat') } })); clearConfigCache();
    expect((await source.setBrain!(row('coder'), 'global')).lines[0]).toBe('This project names its own Brain model, so the project setting still wins here.');
    const after = await source.inspect();
    // J1: the chosen Brain model is marked on its row (`brain`), not in the detail line the list does not show.
    const brainRow = after.choices.find(choice => choice.reference.modelId === 'chat')!; expect(brainRow.brain).toBe(true); expect(brainRow.detail).not.toContain('plans /do work');
    expect(after.notes.some(note => note.startsWith('No Brain model chosen'))).toBe(false);
    // Owner 2026-11-06 ("can be Brain", default on): a runnable row offers "Don't offer as Brain"; a switched-off row is not offered as Brain (no
    // "Use as Brain", no recommendation) and offers "Offer as Brain", written to brain_planner.excluded on the layer that holds it.
    expect(row('coder').fixes!.map(fix => fix.id)).toContain('brain-off');
    await writeFile(configPath, JSON.stringify({ ...config, brain_planner: { reference: ref('chat'), excluded: [{ channelId: 'local-openai', modelId: 'native-coder' }] } })); clearConfigCache();
    const off = (await source.inspect()).choices.find(choice => choice.reference.modelId === 'coder')!;
    expect(off.fixes!.filter(fix => fix.id.startsWith('brain')).map(fix => fix.id)).toEqual(['brain-on']);
    expect(off.detail).toContain('switched off as Brain'); expect(off.detail).not.toContain('recommended for planning');
    expect((await source.setBrainOffer!(off, true)).lines[0]).toBe('native-coder can be chosen as Brain again.');
    expect(writes.at(-1)).toMatchObject({ action: 'set', keyPath: 'brain_planner.excluded', layer: 'project', value: [] });
    { // F2-14 (owner walk 2026-11-08): /model lists the higher registry tier first, then the catalog's own priority, not the declared (alphabetical) order
    // The tier comes from the tier/role registry overlay; `keyless` is frontier, the rest are not registered. The catalog has no release date.
    const roles = { schemaVersion: 1, overlays: [{ schemaVersion: 1, revision: 'tiers-1', roles: [], exceptions: [],
      models: [{ channelId: 'local-openai', modelId: 'native-keyless', version: 1, tier: 'frontier', roles: [] }] }] };
    const { root, options } = await project({ terminal: { scopeId: 'scope' } });
    await mkdir(join(root, 'global'), { recursive: true }); await writeFile(join(root, 'global/config.json'), JSON.stringify({ model_roles: roles }), { mode: 0o600 }); // a global-layer section
    const priority: Readonly<Record<string, number>> = { chat: 3, coder: 1, fast: 2 };
    const host: Parameters<typeof modelPanelSource>[2] = {
      inspectDeclaredModels: async () => ({ schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog }) as never,
      inspectInvocableModels: async () => reading(() => ({ invocable: true, reason: null })),
      inspectModelCatalog: async () => ({ channels: [{ access: 'allowed', channelId: 'local-openai', providerVersion: 1, activation: null,
        models: catalog.providers[0]!.models.map(model => ({ model: { id: model.id, version: 1, ...(priority[model.id] ? { priority: priority[model.id] } : {}) }, activation: null })) }] }) as never,
    };
    expect((await modelPanelSource(root, 'scope', host, options, 'en').inspect()).choices.map(choice => choice.reference.modelId)).toEqual(['keyless', 'coder', 'fast', 'chat']);
    }
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
    expect(view.choices).toHaveLength(4); expect(view.choices.every(choice => choice.blocked === t('model.invocable.unsupported', {}, 'en'))).toBe(true);
  });
  it('an empty catalog says models are never added from here', async () => {
    const { root, options } = await project({});
    const empty = { inspectDeclaredModels: async () => ({ schemaVersion: 1 as const, status: 'not-configured' as const, availability: 'not-observed' as const, catalog: null }) };
    const view = await modelPanelSource(root, 'scope', { ...empty, providerConnect: connectHost('ok') } as never, options, 'tr').inspect();
    expect(view.choices).toEqual([]); expect(view.notes[0]).toContain('Henüz bağlı bir model yok'); expect(view.notes[0]).toContain('/provider');
    // Astra D10-M1: without a provider port there is no "Connect a model…" row, so the note names the CLI instead.
    const bare = await modelPanelSource(root, 'scope', empty as never, options, 'en').inspect();
    expect(bare.notes[0]).toContain('deckent models connect'); expect(bare.notes[0]).not.toContain('Connect a model…');
    expect(bare.title).toBe(t('tui.model.title', { scope: 'scope' }, 'en')); // an own installation keeps its scope
    // a64 (owner walk): an attached project (generated scope id) titles /model with its folder name; the scope id stays in a note.
    const scopeId = '0d9e3a52-6b1f-4c7a-9a43-2f5c8e7d1b60', attached = await project({ schema_version: 5, installation: { sharedRegistrationId: '8b2d4f6a-1c3e-4a5b-9d7f-0e1a2b3c4d5e' } });
    const shown = await modelPanelSource(attached.root, scopeId, empty as never, attached.options, 'en').inspect(), folder = attached.root.split(/[\\/]/u).at(-1)!;
    expect(shown.title).toBe(t('tui.model.title', { scope: folder }, 'en')); expect(shown.notes[0]).toBe(t('tui.model.scopeNote', { scope: scopeId }, 'en'));
  });
});

it('U1 provider port blocks unknown/grantless keys and renders custody refusal or retained-key administrator action without the value', async () => {
  const { root, options } = await project({}), store = secrets(['DECKENT_ANTHROPIC_KEY']);
  let ready = false, grantFailure: unknown = ErrorRegistry.createError('SECRET_GRANT_REQUIRED');
  const port = providerPanelPort(root, 'scope', { ...store.host, providerConnect: connectHost('ok'), connectModel: async () => { throw grantFailure; },
    prepareMainSecret: async () => ready ? { state: 'ready', backend: 'core.secret-store.encrypted-file@1' }
      : { state: 'refused', backend: null, code: 'SECRET_STORE_UNSAFE', path: root },
    connectProviderSecret: async (_root, input) => ({ name: input.name, backend: 'core.secret-store.encrypted-file@1', custody: { state: 'ready' },
      key: { state: 'stored' }, grant: { state: 'admin', code: 'SECRET_GRANT_REQUIRED' } }),
  }, options, 'tr', errorText, { offer: async () => false, grant: async () => {}, question: () => ({ title: '', lines: [], prompt: '' }),
    check: async () => { throw grantFailure; } });
  expect((await port.inspect()).kinds[0]).toMatchObject({ modelBlocked: 'ERR:SECRET_GRANT_REQUIRED', grantRequired: true });
  class EnterpriseCopy extends Error { readonly code = 'SECRET_GRANT_REQUIRED'; }
  Object.defineProperty(EnterpriseCopy.prototype, Symbol.for('deckent.coded-error'), { value: true });
  grantFailure = new EnterpriseCopy();
  await expect(port.connectModel!({ kind: 'anthropic-api', endpoint: null, model: 'seed:fixture' })).rejects.toBe(grantFailure);
  expect((await port.inspect()).kinds[0]).toMatchObject({ grantRequired: true });
  grantFailure = { code: 'SECRET_GRANT_REQUIRED' };
  await expect(port.connectModel!({ kind: 'anthropic-api', endpoint: null, model: 'seed:fixture' })).resolves.toMatchObject({ connected: false });
  expect((await port.inspect()).kinds[0]).toMatchObject({ grantRequired: false, modelBlocked: 'ERR:SECRET_GRANT_REQUIRED' });
  await expect(port.prepareKey!('anthropic-api', null)).rejects.toMatchObject({ code: 'SECRET_STORE_UNSAFE', params: { path: root } });
  expect(store.sets).toEqual([]);
  ready = true;
  const card = await port.prepareKey!('anthropic-api', null);
  expect(card.grant).toBe(false); expect(card.lines[0]!.text).toContain('deckent secret grant DECKENT_ANTHROPIC_KEY --scope scope');
  const connected = await port.connect({ kind: 'anthropic-api', endpoint: null, key: CANARY, grant: false });
  expect(connected.stored).toBe(true); expect(connected.title).toContain('proje izni yok'); expect(connected.lines.at(-1)!.text).toContain('yönetici izni');
  expect(JSON.stringify(connected)).not.toContain(CANARY); expect(store.sets).toEqual([]);
});

it('BeUser M-01: a refused check shows its typed cause; "connect all" with nothing usable says so and never leaks an internal id', async () => {
  const { root, options } = await project({});
  const local = { ...connectHost('ok').kinds[1]!, pull: 'available' as const, connectFamily: 'openai-chat-completions' };
  const port = providerPanelPort(root, 'scope', { ...secrets().host, providerConnect: { ...connectHost('ok'), kinds: [local],
    probe: async () => { throw ErrorRegistry.createError('HEADLESS_ISOLATION_UNAVAILABLE'); } },
    connectModel: async () => { throw ErrorRegistry.createError('MODEL_CONNECT_NO_AVAILABLE', { params: { models: '-' } }); } }, options, 'en', errorText);
  const checked = await port.connect({ kind: 'local-openai', endpoint: 'http://127.0.0.1:18777', key: null });
  expect(checked.lines[0]!.text).toBe('ERR:HEADLESS_ISOLATION_UNAVAILABLE'); expect(JSON.stringify(checked)).not.toContain('Not available yet');
  const pulled = await port.connectModel!({ kind: 'local-openai', endpoint: 'http://127.0.0.1:18777', model: 'pull:available' });
  const text = JSON.stringify(pulled);
  expect(text).toContain('Nothing to connect: '); expect(text).toContain('ERR:MODEL_CONNECT_NO_AVAILABLE'); expect(text).not.toContain(':available');
});

it('BeUser D-05b: a CLI worker channel shows its real readiness (channel, sign-in, image), never "Connected, unusable"', async () => {
  const { root, options } = await project({});
  const codex = { ...connectHost('ok').kinds[1]!, id: 'codex-cli-subscription', pull: 'available' as const, connectFamily: 'codex-jsonl', endpointEditable: false, billing: 'subscription' as const, secretName: null };
  const ref = { providerId: 'codex-cli-subscription', providerVersion: 1, modelId: 'gpt-x', modelVersion: 1 };
  const { ProviderProbeError } = await import('#adapters/core/provider-connect/index.js');
  const port = providerPanelPort(root, 'scope', { ...secrets().host, providerConnect: { ...connectHost('ok'), kinds: [codex], probe: async () => { throw new ProviderProbeError('PROVIDER_KIND_UNAVAILABLE'); } },
    connectModel: async () => ({ schemaVersion: 1, operation: 'models.connect', commandId: 'x', scopeId: 'scope', connection: 'codex-cli-subscription', status: 'connected', reference: ref,
      models: [{ nativeId: 'gpt-x', state: 'connected', reference: ref }, { nativeId: 'gpt-old', state: 'notInCatalog' }], credentialRef: null, keyStored: null,
      steps: { catalog: 'present', declaration: 'skipped', profile: 'present', activation: 'present', carried: 0 }, notCarried: [], carriedModels: [], tariff: 'unmetered', approval: null, service: 'current' }) as never,
    inspectInvocableModels: async () => ({ schemaVersion: 1, scopeId: 'scope', models: [] }) as never,
    inspectModelCatalog: async () => ({ schemaVersion: 1, scopeId: 'scope', channels: [{ channelId: 'codex-cli-subscription', access: 'allowed', channel: { kind: 'native-cli', cli: 'codex' },
      activation: { state: 'active', revision: 1 }, models: [] }] }) as never,
    observeSetup: async () => ({ observation: { families: { coding: { hosts: [{ id: 'codex', cli: 'found', login: 'found' }] }, execution: { worker: { image: 'missing', acquisition: null } } } } }) }, options, 'en', errorText);
  const outcome = await port.connect({ kind: 'codex-cli-subscription', endpoint: null, key: null });
  const text = outcome.lines.map(line => line.text).join('\n');
  expect(text).toContain('Connected as a codex worker channel'); expect(text).toContain('Channel on: yes'); expect(text).toContain('signed in on this machine: yes');
  expect(text).toContain('worker image has codex: no'); expect(text).not.toContain('Connected, unavailable');
  // PV 2d: a subscription is worded as its CLI login and usage quota, never as a local server at a zero tariff.
  expect(text).toContain(t('models.connect.subscription', {}, 'en')); expect(text).not.toMatch(/local server|zero tariff/u);
  // R2b: the title follows the connection's own status (here a worker row without a success tone), never "Not connected".
  expect(outcome.title).toMatch(/^Connected: /u);
  // R1a: a subscription has no key and no price list: "connect all" and an unadmitted model are worded as the subscription's.
  expect(text).toContain(t('models.connect.pull.notInCatalogSubscription', { model: 'gpt-old' }, 'en')); expect(text).not.toMatch(/priced|on this key/u);
  expect((await port.inspect()).kinds[0]!.models[0]!.label).toBe(t('tui.provider.pull.subscription', {}, 'en'));
});

it('BeUser M-01: Connect on a key-less CLI subscription runs its model connection and shows that check\'s cause, not "The chat turn failed"', async () => {
  const { root, options } = await project({});
  const claude = { ...connectHost('ok').kinds[2]!, id: 'claude-cli-subscription', available: true, pull: 'available' as const, connectFamily: 'claude-code-stream-json', secretName: null };
  const { ProviderProbeError } = await import('#adapters/core/provider-connect/index.js');
  const port = providerPanelPort(root, 'scope', { ...secrets().host, providerConnect: { ...connectHost('ok'), kinds: [claude], probe: async () => { throw new ProviderProbeError('PROVIDER_KIND_UNAVAILABLE'); } },
    connectModel: async () => { throw ErrorRegistry.createError('HEADLESS_LOGIN_REQUIRED'); } }, options, 'en', error => formatHumanError(error, { locale: 'en', noColor: true }));
  const outcome = await port.connect({ kind: 'claude-cli-subscription', endpoint: null, key: null });
  const text = outcome.lines.map(line => line.text).join('\n');
  expect(text).toContain('deckent models login --connection <connection>'); expect(text).toContain('claude-cli-subscription or codex-cli-subscription'); expect(outcome.stored).toBe(false);
  // PV 3: the /provider sign-in: the person check refuses before any dir or spawn; the person's run names the Brain's own dir, the CLI's own sign-in result,
  // and the connect carries only the dir and the consent the card gave (never MCP); a dir the person names goes as `cli.configDir`.
  const commands: ModelConnectCommand[] = [], ref = { providerId: 'claude-cli-subscription', providerVersion: 1, modelId: 'm', modelVersion: 1 };
  let person = false, mutationFails = false, observationFails = false;
  let connectFault: 'persist' | 'post-write' | 'untyped' | null = null;
  let persisted: readonly ('ai' | 'system')[] = [];
  let authored: readonly ('global' | 'project')[] = [], policy: 'allow' | 'require-approval' | 'deny' | 'unreadable' | 'missing' = 'allow';
  const permissionReads: string[][] = [];
  const localPrincipal = process.platform !== 'win32';
  if (localPrincipal) await applyPolicyTemplateInstallation(root, 'scope', options);
  const principal = localPrincipal ? await resolveConfiguredConfigPrincipal(root, 'scope', options) : null, policyPath = productResourcePath(resolveProductLayout({ projectRoot: root }), 'policy');
  const installedPolicy = (localPrincipal ? JSON.parse(await readFile(policyPath, 'utf8')) : { grants: [] }) as { grants: unknown[] };
  if (!localPrincipal) console.info('verify-not-run: PV configured policy producer requires a POSIX OS principal; typed port negatives remain active');
  const globalPath = resolveGlobalConfigPaths(options.env).platformPath, projectPath = join(root, '.deckent/config.json');
  const document = { provider_invocation_profiles: { schemaVersion: 1, profiles: [] } };
  const writePolicy = async () => {
    if (!principal) return;
    const principals = [{ issuer: principal.issuer, subject: principal.subject }];
    await writeFile(policyPath, JSON.stringify({ ...installedPolicy, grants: [...installedPolicy.grants,
      { id: 'pv-config-write', effect: 'allow', actions: ['write'], scopes: 'all', principals, resource: { kind: 'config', ids: 'all' } },
      ...(policy === 'deny' || policy === 'require-approval' ? [{ id: 'managed-no-config', effect: policy, actions: ['write'], scopes: 'all', principals,
        resource: { kind: 'config', ids: [`${authored.at(-1) ?? 'project'}:provider_invocation_profiles`] } }] : [])] }), { mode: 0o600 });
    clearConfigCache();
  };
  await writePolicy();
  let inspect: TerminalLaunchContext['inspectDelegationPermission'];
  const entry = vi.spyOn(cliSurface, 'main').mockImplementation(async (_argv, context) => { inspect = (await context!.loadHost!()).inspectDelegationPermission; return 0; });
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubEnv('DECKENT_GLOBAL_HOME', options.env.DECKENT_GLOBAL_HOME); vi.stubEnv('HOME', options.env.HOME);
  try { expect(await runConfiguredCli(['--lang', 'en'])).toBe(0); }
  finally { entry.mockRestore(); cwd.mockRestore(); vi.unstubAllEnvs(); }
  expect(inspect).toBeTypeOf('function');
  const inspectDelegationPermission: NonNullable<typeof inspect> = async (...args) => {
    if (policy === 'unreadable') throw new Error('unreadable');
    if (policy === 'missing') return null;
    if (!localPrincipal) {
      const layers: ('global' | 'project')[] = authored.length ? [...authored] : ['project'];
      permissionReads.push(layers.map(layer => `${layer}:provider_invocation_profiles`));
      return { layers, decisions: layers.map(layer => ({ layer, ruleId: 'managed-no-config',
        decision: policy === 'deny' && layer === authored.at(-1) ? 'deny' : policy === 'require-approval' ? 'require-approval' : 'allow' })) };
    }
    const paths = [projectPath, globalPath, policyPath], before = await Promise.all(paths.map(path => readFile(path, 'utf8').catch(() => null)));
    const view = await inspect!(...args);
    expect(await Promise.all(paths.map(path => readFile(path, 'utf8').catch(() => null)))).toEqual(before);
    expect(Object.keys(view!).sort()).toEqual(['decisions', 'layers']);
    for (const row of view!.decisions) expect(Object.keys(row).sort()).toEqual(['decision', 'layer', 'ruleId']);
    permissionReads.push(view!.layers.map(layer => `${layer}:provider_invocation_profiles`));
    return view;
  };
  const subscription = (locale: 'en' | 'tr') => providerPanelPort(root, 'scope', { ...secrets().host, providerConnect: { ...connectHost('ok'), kinds: [{ ...claude, headlessLogin: true }],
    loginDir: async () => { if (!person) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'models.login' } }); return { owned: '/state/logins/claude' }; },
    login: async command => ({ configDir: command.configDir ?? '/state/logins/claude', owned: !command.configDir, exit: 'completed', signedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }) },
  inspectDelegationPermission,
  connectModel: async (_root, command) => { if (mutationFails) throw ErrorRegistry.createError('POLICY_DENIED', { params: { connectPhase: 'before-profile-write' } });
    commands.push(command); persisted = command.delegate ?? persisted;
    if (connectFault) throw ErrorRegistry.createError(connectFault === 'persist' ? 'CONFIG_BACKUP_PRUNE_FAILED' : 'POLICY_DENIED',
      { params: connectFault === 'untyped' ? {} : { connectPhase: connectFault === 'persist' ? 'profile-write-started' : 'profile-written' } });
    return { schemaVersion: 1, operation: 'models.connect', commandId: command.commandId, scopeId: 'scope', connection: command.connection,
    status: 'connected', reference: ref, models: [{ nativeId: 'm', state: 'connected', reference: ref }], credentialRef: null, keyStored: null, steps: { catalog: 'present', declaration: 'skipped',
      profile: 'written', activation: 'present', carried: 0 }, notCarried: [], carriedModels: [], tariff: 'unmetered', approval: null, service: 'current',
    cli: { configDir: command.cli?.configDir ?? '/state/logins/claude', owned: !command.cli, delegate: [...persisted] } } as ModelConnectResult; },
  // The chat readiness read refuses a CLI subscription by protocol: that is its expected Brain-only state, worded as such (never "Connected, unavailable").
  inspectInvocableModels: async () => { if (observationFails) throw ErrorRegistry.createError('POLICY_DENIED');
    return { schemaVersion: 1, scopeId: 'scope', models: [{ reference: ref, label: 'm', nativeId: 'm', catalogRevision: 'r', bindingDigest: '',
      availability: { invocable: false, reason: { code: 'MODEL_INVOCATION_UNAVAILABLE' } } }] } as never; } }, options, locale, errorText).subscription!;
  const signIn = subscription('en');
  expect(signIn.kinds).toEqual(['claude-cli-subscription']);
  expect(await signIn.prepare('claude-cli-subscription')).toMatchObject({ owned: null, lines: [{ text: 'ERR:AUTHORITY_WITNESS_REQUIRED' }] });
  person = true;
  const ready = await signIn.prepare('claude-cli-subscription');
  expect(ready.owned).toBe('/state/logins/claude'); expect(ready.lines.map(line => line.text).join('\n')).toContain('deckent models login --connection claude-cli-subscription');
  expect(await signIn.login('claude-cli-subscription', null)).toMatchObject({ signedIn: true, refused: false });
  const first = await signIn.connect('claude-cli-subscription', null);
  expect(first.delegate).toEqual([]); expect(first).toMatchObject({ connected: true, summary: t('tui.provider.login.brainOnly', {}, 'en') });
  expect(first.lines.map(line => line.text)).toContain(t('tui.provider.login.brainOnly', {}, 'en'));
  const delegated = await signIn.connect('claude-cli-subscription', '/state/logins/claude', ['ai']);
  expect(delegated.delegate).toEqual(['ai']); // R1b: who may use the login is said in the consent card's words, never the raw class id
  expect(delegated.lines.map(line => line.text)).toContain(t('headless.connect.delegated', { classes: t('tui.provider.login.ai', {}, 'en') }, 'en'));
  await signIn.connect('claude-cli-subscription', '/home/person/.claude', []);
  expect(commands.map(command => [command.cli ?? null, command.delegate ?? null, command.model])).toEqual([[null, null, { pull: 'available' }], [null, ['ai'], { pull: 'available' }],
    [{ configDir: '/home/person/.claude' }, [], { pull: 'available' }]]);
  // R1: widening and narrowing must report the new mutation, never an older successful consent.
  for (const locale of ['en', 'tr'] as const) for (const wanted of [['ai'], []] as const) {
    const before = wanted.length ? [] : ['ai'] as const;
    persisted = before; mutationFails = true; observationFails = false;
    const writes = commands.length, card = subscription(locale);
    const refused = await card.connect(claude.id, null, wanted);
    expect(commands).toHaveLength(writes); expect(persisted).toEqual(before);
    expect(refused).toMatchObject({ state: 'not-applied', connected: false, delegate: null,
      summary: t('tui.provider.login.notApplied', {}, locale) });
    expect(refused.lines.map(line => line.text).join('\n')).toContain('POLICY_DENIED');
    expect(refused.lines.map(line => line.text)).not.toContain(t('tui.provider.login.personOnly', {}, locale));
    mutationFails = false;
    for (connectFault of ['persist', 'post-write', 'untyped']) {
      persisted = before;
      const attempts = commands.length, failed = await card.connect(claude.id, null, wanted);
      expect(commands).toHaveLength(attempts + 1); expect(persisted).toEqual(wanted); // no automatic retry or assumed rollback
      expect(failed).toMatchObject({ state: connectFault === 'post-write' ? 'applied-unverified' : 'unknown', connected: false, delegate: null,
        summary: t(connectFault === 'post-write' ? 'tui.provider.login.appliedUnverified' : 'tui.provider.login.unknown', {}, locale) });
      expect(failed.lines.map(line => line.text).join('\n')).toContain(connectFault === 'persist' ? 'CONFIG_BACKUP_PRUNE_FAILED' : 'POLICY_DENIED');
      expect(failed.lines.map(line => line.text)).not.toContain(t('tui.provider.login.notApplied', {}, locale));
      if (connectFault !== 'post-write') expect(failed.summary).toContain('/provider');
    }
    connectFault = null; persisted = before; observationFails = true;
    const observations = commands.length;
    const uncertain = await card.connect(claude.id, null, wanted);
    expect(commands).toHaveLength(observations + 1); expect(persisted).toEqual(wanted);
    expect(uncertain).toMatchObject({ state: 'applied-unverified', connected: true, delegate: null,
      summary: t('tui.provider.login.appliedUnverified', {}, locale) });
    expect(uncertain.lines.map(line => line.text).join('\n')).toContain('POLICY_DENIED');
    expect(uncertain.lines.map(line => line.text)).not.toContain(t('tui.provider.login.personOnly', {}, locale));
  }
  mutationFails = false; observationFails = false;
  // R3: the display uses the same authored-layer selection as governed connect; a denied layer blocks both classes.
  for (const locale of ['en', 'tr'] as const) for (authored of [[], ['project'], ['global'], ['global', 'project']] as const) {
    const layers = authored.length ? authored : ['project'];
    await mkdir(dirname(globalPath), { recursive: true });
    await writeFile(globalPath, JSON.stringify(authored.includes('global') ? document : {}), { mode: 0o600 });
    await writeFile(projectPath, JSON.stringify(authored.includes('project') ? document : {}), { mode: 0o600 });
    policy = 'allow'; await writePolicy();
    expect((await subscription(locale).connect(claude.id, null)).delegationBlocked).toBeNull();
    expect(permissionReads.at(-1)).toEqual(layers.map(layer => `${layer}:provider_invocation_profiles`));
    policy = 'require-approval'; await writePolicy();
    expect((await subscription(locale).connect(claude.id, null)).delegationBlocked).toBeNull();
    if (authored.length) {
      policy = 'deny'; await writePolicy();
      const denied = await subscription(locale).connect(claude.id, null);
      expect(denied.delegationBlocked).toBe(t('tui.provider.login.policyBlocked', { policy: 'managed-no-config', layer: authored.at(-1)! }, locale));
      mutationFails = true;
      const refused = await subscription(locale).connect(claude.id, null);
      expect(refused.state).toBe('not-applied'); expect(refused.lines.map(line => line.text)).toContain(denied.delegationBlocked);
      mutationFails = false;
    }
    for (policy of ['unreadable', 'missing']) expect((await subscription(locale).connect(claude.id, null)).delegationBlocked).toBe(t('tui.provider.login.policyUnread', {}, locale));
  }
});

it('BeUser M-28 tail: a keyless CLI channel row counts its active catalog models instead of "-"', async () => {
  const { root, options } = await project({});
  const codex = { ...connectHost('ok').kinds[2]!, id: 'codex-cli-subscription', available: true, secretName: null, keyRequired: false };
  const models = (count: number) => Array.from({ length: count }, (_, index) => ({ modelId: `m${index}`, activation: { state: index < 7 ? 'active' : 'inactive', revision: 1 } }));
  const view = await providerPanelPort(root, 'scope', { ...secrets().host, providerConnect: { ...connectHost('ok'), kinds: [codex] },
    inspectModelCatalog: async () => ({ schemaVersion: 1, scopeId: 'scope', channels: [{ channelId: 'codex-cli-subscription', access: 'allowed', models: models(8) }] }) as never }, options, 'en', errorText).inspect();
  expect(view.kinds[0]!.detail).toBe('7 model(s) connected');
  // R8e: four chat rows, one switched off in the catalog: the row says 3 connected and the notes show the fourth as Off (one source).
  const chat = Array.from({ length: 4 }, (_, index) => ({ reference: { providerId: codex.id, providerVersion: 1, modelId: `c${index}`, modelVersion: 1 }, nativeId: `c${index}`,
    availability: { invocable: true, reason: null } }));
  const login = { ...codex, headlessLogin: true }, listed4 = await providerPanelPort(root, 'scope', { ...secrets().host, providerConnect: { ...connectHost('ok'), kinds: [login] },
    inspectInvocableModels: async () => ({ schemaVersion: 1, scopeId: 'scope', models: chat }) as never, inspectModelCatalog: async () => ({ schemaVersion: 1, scopeId: 'scope', channels: [{ channelId: codex.id,
      access: 'allowed', models: chat.map((row, index) => ({ modelId: row.nativeId, activation: { state: index < 3 ? 'active' : 'inactive', revision: 1 } })) }] }) as never }, options, 'en', errorText).inspect();
  const label = listed4.kinds[0]!.label, unsealed = subscriptionReadinessText({ state: 'unknown', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' }, 'en');
  expect(listed4.kinds[0]!.detail).toContain('3 model(s) connected');
  expect(listed4.notes.filter(note => note.startsWith(label))).toEqual([`${label} · 3 model(s) connected: ${unsealed}`, `${label} / c3: ${t('tui.model.state.off', {}, 'en')}`]);
  const none = await providerPanelPort(root, 'scope', { ...secrets().host, providerConnect: { ...connectHost('ok'), kinds: [codex] } }, options, 'en', errorText).inspect();
  expect(none.kinds[0]!.detail).toBe('-');
  // PV 2a: without usable isolation the CLI subscription row is disabled with its reason before anything is chosen; its card names the typed cause and the rows usable here.
  const host = { ...secrets().host, connectModel: async () => { throw new Error('NOT_REACHED'); }, providerConnect: { ...connectHost('ok'), kinds: [{ ...codex, billing: 'subscription' as const, headlessLogin: true },
    connectHost('ok').kinds[0]!], isolationRefusal: async () => ErrorRegistry.createError('HEADLESS_ISOLATION_UNAVAILABLE', { params: { check: 'launcher' } }),
    loginDir: async () => ({ owned: '/x' }), login: async () => null } };
  const blocked = providerPanelPort(root, 'scope', host, options, 'en', errorText), listed = await blocked.inspect();
  expect(listed.kinds[0]).toMatchObject({ blocked: t('error.HEADLESS_ISOLATION_UNAVAILABLE', {}, 'en') }); expect(listed.kinds[0]!.detail).toBe("subscription: no API key, uses your plan's usage quota"); // BeUser r-rest 4: no dangling "· -"
  expect(listed.kinds[1]!.blocked).toBeNull();
  const card = blocked.subscription!.refusal('codex-cli-subscription', ['Anthropic API']);
  expect(card.lines.map(line => line.text)).toEqual(['ERR:HEADLESS_ISOLATION_UNAVAILABLE', 'Anthropic API', t('tui.provider.isolation.next', {}, 'en')]);
  expect((await providerPanelPort(root, 'scope', { ...host, providerConnect: { ...host.providerConnect, isolationRefusal: async () => null } }, options, 'en', errorText).inspect()).kinds[0]!.blocked).toBeNull();
});

it('K13: registry login methods reach the same typed login, Codex is visible and the SIWC beta stays hidden in EN/TR', async () => {
  const { root, options } = await project({}), requests: unknown[] = [];
  const base = connectHost('ok'), codex = { ...base.kinds[1]!, id: 'codex-cli-subscription', catalogProviderId: 'codex-cli-subscription',
    labelKey: 'tui.provider.kind.codexCli', headlessLogin: true, billing: 'subscription' as const, presentation: 'hidden' as const, terminalTextChat: true };
  const methods = nativeCliAgent('codex-jsonl')!.agent.loginMethods.map(row => row.method);
  expect(methods).toEqual(['browser', 'device-auth']);
  for (const locale of ['en', 'tr'] as const) {
    const port = providerPanelPort(root, 'scope', { connectModel: async () => { throw new Error('not a login'); }, providerConnect: { ...base,
      kinds: [codex, { ...base.kinds[2]!, available: true, presentation: 'beta', billing: 'subscription' }], loginMethods: () => methods,
      loginDir: async () => ({ owned: '/fixture/login' }), login: async request => { requests.push(request); return { configDir: '/fixture/login', owned: true,
        signedIn: true, exit: 'completed', authMethod: 'chatgpt', subscriptionType: null }; } } }, options, locale, errorText);
    const view = await port.inspect();
    expect(view.kinds.map(row => row.id)).toEqual([codex.id]);
    expect(view.kinds[0]!.label).toBe(locale === 'en' ? 'Sign in with ChatGPT (Codex CLI)' : 'ChatGPT ile giriş (Codex CLI)');
    expect(port.subscription!.methods!(codex.id).map(row => row.command)).toEqual(methods.map(method => `deckent models login --connection ${codex.id} --login-method ${method}`));
    expect(await port.subscription!.login(codex.id, null, 'device-auth')).toMatchObject({ signedIn: true, refused: false });
    expect(requests.at(-1)).toEqual({ connection: codex.id, loginMethod: 'device-auth' });
    const before = requests.length;
    expect(await port.subscription!.login(codex.id, null, 'claudeai')).toMatchObject({ signedIn: false, refused: true });
    expect(requests).toHaveLength(before);
  }
});

it('K13: text invocability never mints agent readiness; the model and provider share unknown, refusal and verified prerequisites', async () => {
  const { root, options } = await project({}), calls: unknown[] = [], base = connectHost('ok');
  const native = { ...base.kinds[1]!, id: 'fixture-native', catalogProviderId: 'fixture-native', terminalTextChat: true, headlessLogin: true, keyRequired: false,
    secretName: null, pull: 'available' as const, connectFamily: 'fixture-jsonl' };
  const reference = { providerId: native.id, providerVersion: 1, modelId: 'fixture', modelVersion: 1 };
  const choice = { reference, label: 'Fixture', detail: 'OLD TEXT READY', group: native.id, blocked: null, configured: false, exact: 'fixture', command: null };
  let state: NativeAgentReadiness | undefined;
  const host = { providerConnect: { ...base, kinds: [native] }, inspectInvocableModels: async () => ({ scopeId: 'scope', models: [{ reference, nativeId: 'fixture', availability: { invocable: true, reason: null } }] }) as never,
    inspectSubscriptionReadiness: async (_root: string, query: { references: readonly unknown[] }) => { calls.push(query); return query.references.map(() => state as NativeAgentReadiness); } };
  const plain = { title: 'models', choices: [choice, { ...choice, reference: { ...reference, providerId: 'api-fixture' } }], notes: [], defaultBlocked: null };
  for (const locale of ['en', 'tr'] as const) {
    const port = providerPanelPort(root, 'scope', host, options, locale, errorText);
    state = undefined;
    // R2a: unknown stays selectable (the guarded first turn verifies it); only unavailable blocks.
    const unknown = await subscriptionModelView(plain, port, locale);
    expect(unknown.choices[0]!.blocked).toBeNull(); expect(unknown.choices[0]!.detail).toContain(t('headless.agent.unknown.sealed', {}, locale));
    expect(unknown.choices[0]!.detail).not.toContain('OLD TEXT READY'); expect(unknown.choices[1]).toEqual(plain.choices[1]);
    expect((await port.inspect()).notes.join('\n')).toContain(unknown.choices[0]!.detail);
    state = { state: 'unknown', reason: 'NATIVE_AGENT_CLI_UNAVAILABLE' };
    const unchecked = await subscriptionModelView(plain, port, locale);
    expect(unchecked.choices[0]!.detail).toContain(t('headless.agent.unknown.cli', {}, locale));
    expect(unchecked.choices[0]!.detail).not.toContain(t('headless.agent.reason.NATIVE_AGENT_CLI_UNAVAILABLE', {}, locale)); expect(unchecked.choices[0]!.blocked).toBeNull();
    state = { state: 'unavailable', reason: 'NATIVE_AGENT_PLUGIN_UNEXPECTED' };
    expect((await subscriptionModelView(plain, port, locale)).choices[0]!.blocked).toContain(t('headless.agent.reason.NATIVE_AGENT_PLUGIN_UNEXPECTED', {}, locale));
    state = { state: 'ready', execution: { schemaVersion: 1, capability: 'NativeAgentExecution', executable: '/fixture/cli', cliVersion: '1.2.3',
      profileDigest: 'a'.repeat(64), flagSetDigest: 'b'.repeat(64), ownerUid: 1000 } };
    const ready = await subscriptionModelView(plain, port, locale);
    expect(ready.choices[0]!.blocked).toBeNull(); expect(ready.choices[0]!.detail).toBe(t('headless.agent.readiness.ready', {}, locale));
    expect(calls.at(-1)).toEqual({ scopeId: 'scope', surface: 'chat', references: [reference] });
    // A later missing observation cannot retain an earlier ready projection: every view build reads again (no cross-build cache).
    state = undefined; const builds = calls.length;
    expect((await subscriptionModelView(plain, port, locale)).choices[0]!.detail).toContain(t('headless.agent.unknown.sealed', {}, locale));
    expect(calls).toHaveLength(builds + 1);
    const absent = providerPanelPort(root, 'scope', { providerConnect: host.providerConnect }, options, locale, errorText);
    expect((await subscriptionModelView(plain, absent, locale)).choices[0]!.detail).toContain(t('headless.agent.unknown.sealed', {}, locale));
  }
  // R3c: a login with several models gives one note (onboarding pushes notes to scrollback), not one per model.
  state = undefined; calls.length = 0;
  const two = await providerPanelPort(root, 'scope', { ...host, inspectInvocableModels: async () => ({ scopeId: 'scope', models: [{ reference, nativeId: 'fixture', availability: { invocable: true, reason: null } },
    { reference: { ...reference, modelId: 'fixture-2' }, nativeId: 'fixture-2', availability: { invocable: true, reason: null } }] }) as never }, options, 'en', errorText).inspect();
  expect(two.notes.filter(note => note.startsWith(two.kinds[0]!.label))).toEqual([`${two.kinds[0]!.label} · 2 model(s) connected: ${subscriptionReadinessText({ state: 'unknown', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' }, 'en')}`]);
  expect(calls).toEqual([{ scopeId: 'scope', surface: 'chat', references: [reference, { ...reference, modelId: 'fixture-2' }] }]); // KG6 F5: one host read per view build
  // R8e: the production CLI host reads the seal a guarded turn wrote, so /provider says ready (without the host wiring it stayed "unknown").
  const sealedRoot = await mkdtemp(join(tmpdir(), 'deckent-r8e-')); roots.push(sealedRoot);
  const global = join(sealedRoot, 'global'), bin = join(sealedRoot, 'bin'), configDir = join(global, 'headless', 'logins', 'claude'), stateDir = join(global, 'headless', 'connections', 'r8e');
  await mkdir(configDir, { recursive: true, mode: 0o700 }); await mkdir(stateDir, { recursive: true, mode: 0o700 }); await mkdir(bin);
  const executable = join(bin, 'claude'); await writeFile(executable, '#!/bin/sh\n', { mode: 0o700 });
  const f = await brainProviderFixture({ headless: { executable, configDir, stateDir } }), sealedOptions = { env: { ...f.options.env, DECKENT_GLOBAL_HOME: global } };
  const sealed = modelInvocationProfileSchema.parse(f.config.provider_invocation_profiles.profiles[0]);
  const observation = vi.spyOn(adapters, 'readNativeAgentObservation').mockResolvedValue({ cli: true, login: true, environment: true, toolSurface: true, plugins: true, bridge: true,
    execution: { schemaVersion: 1, capability: 'NativeAgentExecution', executable: await realpath(executable), cliVersion: '9.0.0', ownerUid: process.getuid!(),
      flagSetDigest: adapters.nativeAgentFlagSetDigest(nativeCliAgent(sealed.protocol.family)!), profileDigest: modelInvocationProfileDigest(sealed) } });
  let cliHost: TerminalLaunchContext | undefined;
  const entry = vi.spyOn(cliSurface, 'main').mockImplementation(async (_argv, context) => { cliHost = await context!.loadHost!() as TerminalLaunchContext; return 0; });
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(f.project);
  try {
    expect(await runConfiguredCli(['--lang', 'en'])).toBe(0);
    const sealedPort = providerPanelPort(f.project, 's', { ...cliHost!, providerConnect: { ...base, kinds: [{ ...native, id: f.reference.providerId, catalogProviderId: f.reference.providerId }] } },
      sealedOptions, 'en', errorText);
    expect(subscriptionReadinessText(await sealedPort.subscriptionReadiness!.inspect('chat', f.reference), 'en')).toBe(t('headless.agent.readiness.ready', {}, 'en'));
    expect(observation).toHaveBeenCalled();
  } finally { entry.mockRestore(); cwd.mockRestore(); observation.mockRestore(); await f.close(); }
});

it('K13: unavailable observation readers are bounded and never leak their error or keep a ready result', async () => {
  const { root, options } = await project({}), base = connectHost('ok');
  const reference = { providerId: 'fixture-native', providerVersion: 1, modelId: 'fixture', modelVersion: 1 };
  const providerConnect = { ...base, kinds: [{ ...base.kinds[1]!, id: reference.providerId, headlessLogin: true }] };
  const failed = providerPanelPort(root, 'scope', { providerConnect, inspectSubscriptionReadiness: async () => { throw new Error(CANARY); } }, options, 'en', errorText);
  const refusal = await failed.subscriptionReadiness!.inspect('chat', reference);
  expect(refusal).toEqual({ state: 'unknown', reason: 'NATIVE_AGENT_ENVIRONMENT_REFUSED' }); expect(JSON.stringify(refusal)).not.toContain(CANARY);
  vi.useFakeTimers();
  try {
    const stalled = providerPanelPort(root, 'scope', { providerConnect, inspectSubscriptionReadiness: () => new Promise(() => {}) }, options, 'en', errorText);
    const result = stalled.subscriptionReadiness!.inspect('chat', reference);
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ state: 'unknown', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
