import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { inspectConfiguredInvocableModels } from '#composition/core/model-invocation/index.js';
import { configuredConfigChoiceSources } from '#composition/core/config/index.js';
import { inspectMonitor } from '#composition/core/monitor/index.js';
import { inspectDeclaredModels } from '#composition/core/provider-catalog/index.js';
import { connectConfiguredModel } from '#composition/core/model-connect/index.js';
import { modelPanelSource, providerPanelPort, type ProviderConnectHost } from '#surfaces/core/cli-terminal/index.js';
import { modelInvocabilityText } from '#surfaces/core/model-invocability/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { configPanelTree } from '#surfaces/core/terminal-panels/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import { PROVIDER_CONNECT_REGISTRY, parseProviderConnectRegistry, readProviderConnectSeed } from '#adapters/index.js';
import { runtime, me } from '../support/chat-turn-harness.js';

const providerConnect: ProviderConnectHost = { kinds: [], endpoint: () => ({ ok: false, reason: 'invalid' }), probe: async () => { throw new Error('inspection must never probe'); } };
type Fixture = Awaited<ReturnType<typeof runtime>>;
async function configOf(f: Fixture) { return JSON.parse(await readFile(join(f.project, '.deckent/config.json'), 'utf8')); }
async function writeConfig(f: Fixture, config: unknown) { await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify(config)); clearConfigCache(); }
async function fixture() {
  const f = await runtime({ noServer: true });
  const config = await configOf(f); config.terminal.scopeId = 'scope'; config.service.responseMaxBytes = 1_048_576;
  await writeConfig(f, config); return f;
}
async function parity(f: Fixture, locale: 'en' | 'tr') {
  const options = { env: { ...f.env, DECKENT_LANGUAGE: locale }, heal: false as const };
  const reading = await inspectConfiguredInvocableModels(f.project, 'scope', options);
  const choices = await configuredConfigChoiceSources(f.project, options).list('models', 'terminal.chat.reference');
  const host = { inspectDeclaredModels, inspectInvocableModels: inspectConfiguredInvocableModels, providerConnect };
  const model = await modelPanelSource(f.project, 'scope', host, options, locale).inspect();
  const provider = await providerPanelPort(f.project, 'scope', host, options, locale, () => 'ERROR').inspect();
  const monitor = await inspectMonitor(f.project, options);
  const mapped = monitor.installs[0]!.map!.models;
  const surface = await loadMonitorSurface();
  const rendered = surface.buildMonitorView(monitor, locale, true).tabs.map.flatMap(block => block.kind === 'line' ? block.line : []).map(span => span.text).join('');
  const configTree = configPanelTree({ title: 'Config', notes: [], fields: [{ key: 'terminal.chat.reference', section: 'terminal', description: 'Model', value: '-',
    source: '', apply: '', expected: '', choices, free: false, unsettable: false, sensitive: false,
    locks: { project: { blocked: null, note: null }, global: { blocked: null, note: null } } }] }, terminalPanelLabels(locale).config);
  const configRows = configTree.items[0]!.children![0]!.children!;
  expect(mapped).toHaveLength(reading.models.length);
  for (const entry of reading.models) {
    const reference = entry.reference, state = entry.availability, word = modelInvocabilityText(state, locale);
    const picked = choices.find(choice => JSON.stringify(choice.value) === JSON.stringify(reference))!;
    expect(Boolean(picked.blocked)).toBe(!state.invocable);
    expect(picked.blocked ?? null).toBe(state.invocable ? null : word);
    expect(configRows.find(item => item.id === picked.id)?.blocked?.reason ?? null).toBe(state.invocable ? null : word);
    expect(rendered).toContain(word);
    const row = model.choices.find(choice => JSON.stringify(choice.reference) === JSON.stringify(reference))!;
    expect(row.blocked).toBe(state.invocable ? null : word); expect(row.detail).toBe(word);
    expect(provider.invocableModels!.find(item => JSON.stringify(item.reference) === JSON.stringify(reference))!.availability).toEqual(state);
    expect(provider.notes).toContain(`${reference.providerId} / ${entry.label}: ${word}`);
    expect(mapped.find(item => item.channelId === reference.providerId && item.modelId === reference.modelId && item.scopeId === 'scope'))
      .toMatchObject({ reference, active: state.invocable, availability: state });
  }
  expect(f.state.requests).toEqual([]); expect(f.state.tokenize).toEqual([]);
  return reading;
}
async function fileNames(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
}

describe('one invocable-now model across monitor, /config, /model and /provider', () => {
  it.each(['active', 'stale-activation', 'not-carried', 'delivery-unfit', 'no-credential', 'local-zero-tariff', 'budget', 'tariff'] as const)('%s: exact same decision on all four surfaces, without model effects or state creation', async scenario => {
      const f = await fixture(), config = await configOf(f), profile = config.provider_invocation_profiles.profiles[0];
      if (scenario === 'stale-activation') config.provider_catalog.revision = 'catalog-2';
      if (scenario === 'not-carried') { const db = new DatabaseSync(f.ledger); try { db.exec('DELETE FROM model_activations'); } finally { db.close(); } }
      if (scenario === 'delivery-unfit') profile.limits.responseMaxBytes = 1_048_576;
      if (scenario === 'no-credential') { profile.adapter.definition.endpoint = 'https://provider.invalid/v1/chat/completions'; profile.adapter.definition.authentication = { type: 'bearer', credentialRef: 'W11_ABSENT_KEY' }; }
      if (scenario === 'local-zero-tariff') config.provider_spending.budgets[0].limitMinorUnits = 0;
      if (scenario === 'budget') delete config.provider_spending;
      if (scenario === 'tariff') { profile.adapter.version = 5; profile.adapter.definition.endpoint = 'https://openrouter.ai/api/v1/chat/completions';
        profile.adapter.definition.dialect = { tokenLimitField: 'max_tokens', streamUsage: 'omit', toolChoice: ['auto', 'none', 'required'] };
        profile.adapter.definition.tariff = { kind: 'openrouter-endpoint', version: 1, currency: 'USD', metadataEndpoint: 'https://openrouter.ai/api/v1/models/vendor/model/endpoints',
        endpointTag: 'provider/region', metadataLimits: { maxAgeMs: 60000, maxResponseBytes: 64000, timeoutMs: 1000 } }; }
      await writeConfig(f, config);
      const before = { files: await fileNames(f.data), activations: f.rows('SELECT * FROM model_activations'), invocations: f.rows('SELECT * FROM model_invocations'),
        accounts: f.rows('SELECT * FROM provider_spend_accounts'), audit: f.rows('SELECT * FROM audit_events') };
      for (const locale of ['en', 'tr'] as const) {
        const result = await parity(f, locale);
        const state = result.models[0]!.availability;
        if (scenario === 'active' || scenario === 'local-zero-tariff') expect(state).toEqual({ invocable: true, reason: null });
        else expect(state).toMatchObject({ invocable: false, reason: { kind: scenario } });
      }
      expect({ files: await fileNames(f.data), activations: f.rows('SELECT * FROM model_activations'), invocations: f.rows('SELECT * FROM model_invocations'),
        accounts: f.rows('SELECT * FROM provider_spend_accounts'), audit: f.rows('SELECT * FROM audit_events') }).toEqual(before);
    });

  it('regression: 13 API models connected through the /provider producer are invocable in the monitor, with no catalog activation rows', async () => {
    const f = await fixture();
    const extra = [
      { id: 'config', effect: 'allow', actions: ['write'], scopes: 'all', principals: me, resource: { kind: 'config', ids: 'all' } },
      { id: 'activation', effect: 'allow', actions: ['activate', 'inspect'], scopes: 'all', principals: me, resource: { kind: 'model-activation', ids: 'all' } },
      { id: 'invoke-all', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'model-invocation', ids: 'all' } },
    ];
    await f.writePolicy([...f.grants, ...extra]);
    const env = { ...f.env, DECKENT_OPENAI_KEY: 'W11-only-fake-credential', DECKENT_DEEPSEEK_KEY: 'W11-only-fake-credential',
      DECKENT_GLM_KEY: 'W11-only-fake-credential', DECKENT_ANTHROPIC_KEY: 'W11-only-fake-credential' };
    const registry = parseProviderConnectRegistry({ ...PROVIDER_CONNECT_REGISTRY, kinds: [...PROVIDER_CONNECT_REGISTRY.kinds,
      { id: 'w11-api-fixture', labelKey: 'tui.provider.kind.openrouter', available: true, endpoint: { default: null, editable: true },
        key: null, probe: null, connect: { adapter: 'openai-chat-http', chatPath: '/v1/chat/completions', seed: 'openrouter-api',
          dialect: { tokenLimitField: 'max_tokens', streamUsage: 'include', toolChoice: ['auto', 'none', 'required'] } } }] });
    const seeds = [ ['openai-api', 'openai-api', 3], ['deepseek-api', 'deepseek-api', 2], ['zai-api', 'zai-api', 2], ['w11-api-fixture', 'openrouter-api', 6] ] as const;
    const connected: string[] = [];
    // Seven real priced API profiles plus six seeded API references on a keyless, zero-tariff loopback fixture.
    // The fixture verifies the live ledger shape without any metadata/model endpoint or paid call.
    const port = providerPanelPort(f.project, 'scope', { providerConnect: { ...providerConnect, kinds: registry.kinds.map(kind => ({ id: kind.id, labelKey: kind.labelKey, available: kind.available,
        endpointDefault: kind.endpoint.default, endpointEditable: kind.endpoint.editable, keyRequired: kind.key?.required ?? false, secretName: kind.key?.secretName ?? null, probePath: null, endpointChoices: [] })) },
      connectModel: (root, command, options) => connectConfiguredModel(root, command, options, { registry }) }, { env }, 'en', error => String(error));
    for (const [connection, seed, count] of seeds) {
      const catalog = await readProviderConnectSeed(seed);
      for (const model of catalog.providers.flatMap(provider => provider.models).slice(0, count)) {
        const outcome = await port.connectModel!({ kind: connection, endpoint: connection === 'w11-api-fixture' ? 'http://127.0.0.1:9' : null, model: `seed:${model.nativeId}` });
        expect(outcome.connected, outcome.summary).toBe(true); connected.push(model.id);
      }
    }
    expect(connected).toHaveLength(13);
    expect(f.rows('SELECT * FROM model_catalog_activations')).toEqual([]);
    const snapshot = await inspectMonitor(f.project, { env });
    const shown = snapshot.installs[0]!.map!.models.filter(model => connected.includes(model.modelId));
    expect(shown).toHaveLength(13); for (const model of shown) expect(model.availability, `${model.channelId}/${model.modelId}`).toEqual({ invocable: true, reason: null });
    expect(f.state.requests).toEqual([]); expect(f.rows('SELECT * FROM model_invocations')).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain('W11-only-fake-credential');
  });
});
