import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { modelPanelSource } from '#surfaces/core/cli-terminal/index.js';
import { clearConfigCache, ErrorRegistry } from '#platform/index.js';
import { runtime } from '../support/chat-turn-harness.js';
import { registerProviderConfig } from '#adapters/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { ModelInvocableNowApplication, ProviderSpendError } from '#engine/index.js';
import type { ModelReference } from '#domain/index.js';

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
  // MODEL-STATE-PARITY: the panel reads the shared invocable-now reader; the same typed refusal reaches it through the engine read owner.
  const targets = declared.catalog.providers.flatMap(provider => provider.models.map(model => ({ reference: { providerId: provider.id, providerVersion: provider.version,
    modelId: model.id, modelVersion: model.version }, label: model.id, nativeId: model.nativeId, catalogRevision: 'catalog-1', bindingDigest: 'd'.repeat(64) })));
  const invocable = (inspect: (reference: ModelReference) => Promise<void>) => async () => new ModelInvocableNowApplication(inspect).read('scope', targets);
  const source = modelPanelSource(f.project, 'scope', { inspectDeclaredModels: async () => declared as never,
    inspectInvocableModels: invocable(async reference => { if (reference.modelId !== 'cheap') throw refusal; }) }, { env: f.env, heal: false }, locale);
  const view = await source.inspect(), blocked = view.choices.find(row => row.reference.modelId !== 'cheap')!;
  expect(blocked.blocked).toContain(locale === 'en' ? '1,024.51 USD' : '1.024,51 USD');
  expect(blocked.command).toContain('cheap'); expect(view.choices.find(row => row.reference.modelId === 'cheap')!.blocked).toBeNull();
  // The composed reader sees the raw engine refusal (amounts, not query params): the same reservation text, still without account totals.
  const raw = new ProviderSpendError('PROVIDER_SPEND_EXHAUSTED', { requested: 102451, currency: 'USD', settled: '0.00', held: 12345, limit: 99999 });
  const direct = await modelPanelSource(f.project, 'scope', { inspectDeclaredModels: async () => declared as never,
    inspectInvocableModels: invocable(async reference => { if (reference.modelId !== 'cheap') throw raw; }) }, { env: f.env, heal: false }, locale).inspect();
  const directBlocked = direct.choices.find(row => row.reference.modelId !== 'cheap')!;
  expect(directBlocked.blocked).toContain(locale === 'en' ? '1,024.51 USD' : '1.024,51 USD');
  expect(directBlocked.blocked).not.toContain('123.45'); expect(directBlocked.blocked).not.toContain('999.99'); expect(directBlocked.command).toContain('cheap');
  const unavailable = await modelPanelSource(f.project, 'scope', { inspectDeclaredModels: async () => declared as never,
    inspectInvocableModels: invocable(async () => { throw ErrorRegistry.createError('MODEL_INVOCATION_UNAVAILABLE'); }) }, { env: f.env, heal: false }, locale).inspect();
  expect(unavailable.choices.every(row => row.blocked !== null)).toBe(true);
});
