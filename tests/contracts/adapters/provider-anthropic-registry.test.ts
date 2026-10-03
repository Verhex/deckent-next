import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

const assetPath = '#adapters/core/provider-anthropic-messages/internal/models.json';
const shipped = () => JSON.parse(readFileSync(new URL('../../../src/adapters/core/provider-anthropic-messages/internal/models.json', import.meta.url), 'utf8'));
const candidate = () => ({ ...shipped(), schemaVersion: 2,
  effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], order: 'ascending' },
  metering: { promptOverheadTokens: 2048, thinkingBudgetMinTokens: 1024 } });
async function load(asset: unknown) {
  vi.resetModules();
  vi.doMock(assetPath, () => ({ default: asset }));
  return import('#adapters/core/provider-anthropic-messages/index.js');
}
afterEach(() => { vi.doUnmock(assetPath); vi.resetModules(); });

it('loads the shipped versioned vocabulary and preserves the reservation coefficients', async () => {
  expect(shipped()).toMatchObject({ schemaVersion: 2, effort: candidate().effort, metering: candidate().metering });
  const adapter = await load(shipped());
  expect(adapter.ANTHROPIC_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(adapter.ANTHROPIC_PROMPT_OVERHEAD_TOKENS).toBe(2048);
});

it.each([
  ['old schema', (a: ReturnType<typeof candidate>) => { a.schemaVersion = 1; }],
  ['missing vocabulary', (a: ReturnType<typeof candidate>) => { Reflect.deleteProperty(a, 'effort'); }],
  ['missing overhead', (a: ReturnType<typeof candidate>) => { Reflect.deleteProperty(a.metering, 'promptOverheadTokens'); }],
  ['missing minimum', (a: ReturnType<typeof candidate>) => { Reflect.deleteProperty(a.metering, 'thinkingBudgetMinTokens'); }],
  ['zero overhead', (a: ReturnType<typeof candidate>) => { a.metering.promptOverheadTokens = 0; }],
  ['fractional minimum', (a: ReturnType<typeof candidate>) => { a.metering.thinkingBudgetMinTokens = 1.5; }],
  ['unsafe overhead', (a: ReturnType<typeof candidate>) => { a.metering.promptOverheadTokens = Number.MAX_SAFE_INTEGER + 1; }],
  ['duplicate vocabulary', (a: ReturnType<typeof candidate>) => { a.effort.levels.push('high'); }],
  ['descending declaration', (a: ReturnType<typeof candidate>) => { a.effort.order = 'descending'; }],
  ['model vocabulary outside registry', (a: ReturnType<typeof candidate>) => { a.models[0].effort.levels.unshift('turbo'); }],
  ['model levels not ascending', (a: ReturnType<typeof candidate>) => { a.models[0].effort.levels.reverse(); }],
  ['model levels duplicated', (a: ReturnType<typeof candidate>) => { a.models[0].effort.levels.push('max'); }],
  ['default outside model levels', (a: ReturnType<typeof candidate>) => { a.models[0].effort.default = 'turbo'; }],
  ['off ceiling outside vocabulary', (a: ReturnType<typeof candidate>) => { a.models[3].thinking.offMaxEffort = 'turbo'; }],
])('refuses %s at module load with a typed validation error', async (_name, mutate) => {
  const asset = candidate(); mutate(asset);
  await expect(load(asset)).rejects.toMatchObject({ name: 'ZodError' });
});

it('derives admission vocabulary and rank from alternate registry data without model-name code', async () => {
  const asset = candidate(); asset.effort.levels = ['light', 'heavy'];
  asset.models = [{ modelId: 'test-model', thinking: { adaptive: true, enabled: true, off: 'disabled', offMaxEffort: 'light' },
    effort: { levels: ['light', 'heavy'], default: 'heavy' }, maxOutputTokens: 4096, source: 'https://example.com/model' }];
  const adapter = await load(asset), base = { maxOutputTokens: 2048, thinking: { mode: 'model-default' as const, off: 'disabled' as const } };
  expect(adapter.ANTHROPIC_EFFORT_LEVELS).toEqual(['light', 'heavy']);
  expect(adapter.anthropicControlsAdmitted('test-model', { ...base, effort: 'light' })).toBe(true);
  expect(adapter.anthropicControlsAdmitted('test-model', { ...base, effort: 'heavy' })).toBe(false);
  expect(adapter.anthropicControlsAdmitted('test-model', base)).toBe(false);
  expect(adapter.anthropicControlsAdmitted('test-model', { ...base, effort: 'high' })).toBe(false);
});

it('uses registry overhead for the tariff reservation and registry minimum at profile ingress', async () => {
  const asset = candidate(); asset.metering = { promptOverheadTokens: 4096, thinkingBudgetMinTokens: 2048 };
  const adapter = await load(asset);
  const tariff = { kind: 'anthropic-published' as const, version: 1 as const, currency: 'USD' as const, modelId: 'claude-opus-4-6',
    usdPerMTok: { input: '100', cacheWrite5m: '100', cacheWrite1h: '100', cacheRead: '100', output: '100' },
    source: { url: 'https://example.com/prices', retrievedAt: '2026-10-03' } };
  expect(adapter.anthropicMaxChargeMinorUnits(tariff, 'none', 1000, 64)).toBe(52);
  const definition = { endpoint: 'https://api.anthropic.com/v1/messages', maxOutputTokens: 4096,
    authentication: { type: 'header', name: 'x-api-key', credentialRef: 'TEST_KEY' }, tariff };
  expect(() => adapter.parseAnthropicMessagesDefinition({ ...definition, thinking: { mode: 'enabled', budgetTokens: 1024 } })).toThrow();
  expect(adapter.parseAnthropicMessagesDefinition({ ...definition, thinking: { mode: 'enabled', budgetTokens: 2048 } }).thinking)
    .toEqual({ mode: 'enabled', budgetTokens: 2048 });
  expect(() => adapter.parseAnthropicMessagesDefinition({ ...definition, thinking: { mode: 'enabled', budgetTokens: 4096 } })).toThrow();
});
