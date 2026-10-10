import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { modelPanelSource } from '#surfaces/core/cli-terminal/index.js';
import { clearConfigCache, ErrorRegistry } from '#platform/index.js';
import { runtime } from '../support/chat-turn-harness.js';
import { registerProviderConfig } from '#adapters/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { ProviderSpendError } from '#engine/index.js';

registerProviderConfig();
it.each(['en', 'tr'] as const)('shows reservation USD and a ready alternative in %s without exposing private account totals', async locale => {
  const f = await runtime({ noServer: true }), path = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
  const first = config.provider_invocation_profiles.profiles[0];
  const cheap = { ...first, id: 'cheap-profile', reference: { ...first.reference, modelId: 'cheap' } };
  config.provider_invocation_profiles.profiles.push(cheap);
  config.provider_spending = { schemaVersion: 1, budgets: [{ schemaVersion: 1, scopeId: 'scope', budgetId: 'shared', revision: 1, currency: 'USD', limitMinorUnits: 2500 }] };
  await writeFile(path, JSON.stringify(config)); clearConfigCache();
  const declared = { status: 'declared' as const, catalog: { providers: [{ id: first.reference.providerId, version: 1, models: [
    { id: first.reference.modelId, version: 1, nativeId: 'expensive' }, { id: 'cheap', version: 1, nativeId: 'cheap' }] }] } };
  const refusal = queryFailure(new ProviderSpendError('PROVIDER_SPEND_EXHAUSTED', { requested: 102451, currency: 'USD', settled: 'private', held: 12345, limit: 99999 }));
  expect(refusal.params).toMatchObject({ requested: 102451, currency: 'USD' });
  expect(refusal.params).not.toHaveProperty('held'); expect(refusal.params).not.toHaveProperty('settled'); expect(refusal.params).not.toHaveProperty('limit');
  const source = modelPanelSource(f.project, 'scope', { inspectDeclaredModels: async () => declared as never,
    inspectModelReadiness: async (_root, _scope, reference) => { if (reference.modelId !== 'cheap') throw refusal; } }, { env: f.env, heal: false }, locale);
  const view = await source.inspect(), blocked = view.choices.find(row => row.reference.modelId !== 'cheap')!;
  expect(blocked.blocked).toContain(locale === 'en' ? '1,024.51 USD' : '1.024,51 USD');
  expect(blocked.command).toContain('cheap'); expect(view.choices.find(row => row.reference.modelId === 'cheap')!.blocked).toBeNull();
  const unavailable = await modelPanelSource(f.project, 'scope', { inspectDeclaredModels: async () => declared as never,
    inspectModelReadiness: async () => { throw ErrorRegistry.createError('MODEL_INVOCATION_UNAVAILABLE'); } }, { env: f.env, heal: false }, locale).inspect();
  expect(unavailable.choices.every(row => row.blocked !== null)).toBe(true);
});
