import { expect, it } from 'vitest';
import { connectionAdapter, providerConnectKind, providerProfileProtocolOffer, parseProviderConnectRegistry,
  PROVIDER_CONNECT_REGISTRY, readProviderConnectSeed } from '#adapters/core/provider-connect/index.js';
import { lookupOpenAiCompatibleTariff, createOpenAiChatNativePort } from '#adapters/core/provider-openai-chat/index.js';
import { planProfileChanges } from '#engine/index.js';
import { RESPONSES_MODEL, responsesFixture } from '../support/openai-responses.js';

const input = { endpoint: 'https://api.openai.com/v1/chat/completions', credentialRef: 'DECKENT_OPENAI_KEY', nativeId: RESPONSES_MODEL, maxOutputTokens: 32, currency: 'USD' };
const kind = providerConnectKind('openai-api')!;
const oldProfile = () => {
  const f = responsesFixture(input.endpoint);
  return { ...f.profile, version: 3, adapter: { ...f.profile.adapter, version: 5, definition: {
    ...f.profile.adapter.definition, dialect: kind.connect!.dialect, authentication: { type: 'bearer', credentialRef: input.credentialRef },
    tariff: lookupOpenAiCompatibleTariff(input.endpoint, input.nativeId)! } } };
};
it('registry/catalog select Responses per model for new profiles; reconnect does not silently migrate an existing chat definition', async () => {
  const built = connectionAdapter(kind, input);
  expect(built.adapter).toMatchObject({ version: 6, definition: { endpoint: 'https://api.openai.com/v1/responses',
    authentication: { credentialRef: 'DECKENT_OPENAI_KEY' }, dialect: { protocol: 'responses', reasoningEffort: 'medium' } } });
  const legacy = connectionAdapter(kind, { ...input, existing: oldProfile().adapter.definition });
  expect(legacy.adapter).toMatchObject({ version: 5, definition: { endpoint: input.endpoint } });
  const current = connectionAdapter(kind, { ...input, existing: built.adapter.definition });
  expect(current.adapter).toEqual(built.adapter);
  const seed = await readProviderConnectSeed('openai-api');
  expect(seed.providers[0]?.channel?.protocolFamily).toBe('openai-responses');
  const native = createOpenAiChatNativePort(), f = responsesFixture(input.endpoint);
  await expect(native.prepare({ ...f.profile, adapter: built.adapter }, f.definition, f.request)).resolves.toBeDefined();
});
it('preview migration preserves key/reference/binding/activation/allocation/limits; changes endpoint, tariff and profile version only', async () => {
  const old = oldProfile(), untouched = structuredClone(old), offered = providerProfileProtocolOffer(old)!;
  expect(old).toEqual(untouched); expect(offered.detail).toEqual({ modelId: RESPONSES_MODEL, from: input.endpoint, to: 'https://api.openai.com/v1/responses', protocol: 'responses' });
  const next = offered.next as typeof old;
  expect(next.version).toBe(4); expect(next.adapter.version).toBe(6);
  for (const field of ['scopeId', 'reference', 'bindingDigest', 'allocation', 'limits', 'protocol', 'id'] as const) expect(next[field]).toEqual(old[field]);
  expect(next.adapter.definition.authentication).toEqual(old.adapter.definition.authentication);
  expect(providerProfileProtocolOffer(next)).toBeNull();
  const oldV4 = { ...old, adapter: { ...old.adapter, version: 4, definition: { ...old.adapter.definition } } };
  delete (oldV4.adapter.definition as Record<string, unknown>)['dialect'];
  expect(providerProfileProtocolOffer(oldV4)?.next['version']).toBe(4);
});
it('governed layer plan is scoped, selection-only, idempotent and preserves unrelated profiles; shared layers remain blocked like cache migration', () => {
  const old = oldProfile(), foreign = { ...old, scopeId: 'foreign', id: 'foreign' };
  const document = { schemaVersion: 1, profiles: [old, foreign] }, layers = { global: {}, project: { provider_invocation_profiles: document } };
  const before = JSON.stringify(layers), plan = planProfileChanges(layers, 'scope', providerProfileProtocolOffer);
  expect(JSON.stringify(layers)).toBe(before); expect(plan.models).toHaveLength(1); expect(plan.writes).toHaveLength(1); expect(plan.writes[0]?.layer).toBe('project');
  expect((plan.writes[0]?.value['profiles'] as unknown[])[1]).toEqual(foreign);
  expect(planProfileChanges({ global: {}, project: { provider_invocation_profiles: plan.writes[0]!.value } }, 'scope', providerProfileProtocolOffer).writes).toEqual([]);
  const shared = planProfileChanges({ global: layers.project, project: layers.project }, 'scope', providerProfileProtocolOffer);
  expect(shared.writes).toEqual([]); expect(shared.shared).toEqual([old.reference]);
});
it('unknown/foreign endpoints and forged tariffs cannot acquire a protocol migration; unsupported effort/duplicate routes fail registry parsing', () => {
  const old = oldProfile();
  expect(providerProfileProtocolOffer({ ...old, adapter: { ...old.adapter, definition: { ...old.adapter.definition, endpoint: 'https://foreign.example/v1/chat/completions' } } })).toBeNull();
  expect(providerProfileProtocolOffer({ ...old, adapter: { ...old.adapter, definition: { ...old.adapter.definition,
    tariff: { ...old.adapter.definition.tariff, usdPerMTok: { input: '0', cachedInput: '0', output: '0', cacheWrite: '0' } } } } })).toBeNull();
  const route = kind.connect!.protocolRoutes![0]!;
  const bad = (protocolRoutes: unknown[]) => ({ ...PROVIDER_CONNECT_REGISTRY, kinds: [{ ...kind, connect: { ...kind.connect, protocolRoutes } }] });
  expect(() => parseProviderConnectRegistry(bad([route, route]))).toThrow();
  expect(() => parseProviderConnectRegistry(bad([{ ...route, dialect: { ...route.dialect, reasoningEffort: 'none' } }]))).toThrow();
});
