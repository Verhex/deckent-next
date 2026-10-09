import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_CONNECT_REGISTRY, parseProviderConnectRegistry } from '#adapters/index.js';
import { connectConfiguredModel, planConfiguredProfileCache } from '#composition/core/model-connect/index.js';
import { admitConfiguredModelActivation, inspectConfiguredModelActivation } from '#composition/core/model-activation/index.js';
import { assessConfiguredModelInvocationDelivery } from '#composition/core/model-invocation/index.js';
import { inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { cachePanelPort } from '#surfaces/core/cli-terminal/index.js';
import { clearConfigCache } from '#platform/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';

// P1 DELIVERY-FIT (batch D 2026-10-09): a connect-seeded Anthropic profile must stay activatable after the governed changes the product
// itself offers — the 5-minute cache window and a catalog revision change. No provider is called; nothing listens on the endpoint.
const grants = [
  { id: 'models', effect: 'allow', actions: ['register', 'inspect'], scopes: 'all', principals: me, resource: { kind: 'model-catalog', ids: 'all' } },
  { id: 'activation', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: 'all', principals: me, resource: { kind: 'model-activation', ids: 'all' } },
  { id: 'config', effect: 'allow', actions: ['read', 'write'], scopes: 'all', principals: me, resource: { kind: 'config', ids: 'all' } },
];
const registry = parseProviderConnectRegistry({ ...PROVIDER_CONNECT_REGISTRY, kinds: [{ id: 'claude-fixture', labelKey: 'tui.provider.kind.anthropicApi', available: true,
  endpoint: { default: 'https://127.0.0.1:9', editable: false }, key: { required: true, secretName: 'DECKENT_ANTHROPIC_KEY' }, probe: null,
  connect: { adapter: 'anthropic-messages-http', chatPath: '/v1/messages', seed: 'anthropic-api' } }] });

describe.skipIf(process.platform === 'win32')('connect-seeded delivery headroom (POSIX local principal)', () => {
  async function connected() {
    const f = await runtime({ extraGrants: grants, noServer: true });
    const path = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
    // The product's default service frame (1 MiB) and terminal scope: MCP (`invoke_model`) is then the tightest delivery surface.
    config.service.responseMaxBytes = 1_048_576; config.terminal = { ...config.terminal, scopeId: 'scope' };
    await writeFile(path, JSON.stringify(config), { mode: 0o600 }); clearConfigCache();
    const options = { env: { ...f.env, DECKENT_ANTHROPIC_KEY: 'fixture-only-not-a-provider-key' }, heal: false as const };
    const connect = (commandId: string) => connectConfiguredModel(f.project, { schemaVersion: 1, commandId, scopeId: 'scope', connection: 'claude-fixture',
      endpoint: null, model: { nativeId: 'claude-sonnet-5-5' } }, options, { registry });
    const result = await connect('connect-claude');
    expect(result).toMatchObject({ status: 'connected', steps: { profile: 'written', activation: 'written' } });
    const reference = result.reference!;
    const profile = async () => JSON.parse(await readFile(path, 'utf8')).provider_invocation_profiles.profiles
      .find((item: { reference: unknown }) => JSON.stringify(item.reference) === JSON.stringify(reference));
    const app = createConfiguredConfigApplication(f.project, options), principal = await resolveConfiguredConfigPrincipal(f.project, 'scope', options);
    // The governed cache window (the terminal's own port) adds `cache: '5m'` and bumps the profile version; the activation is untouched.
    const cache = cachePanelPort(f.project, 'scope', { planProfileCache: planConfiguredProfileCache, configApplication: createConfiguredConfigApplication,
      resolveConfigPrincipal: resolveConfiguredConfigPrincipal }, options, 'en');
    // A catalog revision change (any later register/connect) makes the activation stale; the profile and binding are unchanged.
    const changeCatalog = async (revision: string) => {
      const current = JSON.parse(await readFile(path, 'utf8'));
      expect((await app.submit('set', { keyPath: 'provider_catalog', value: { ...current.provider_catalog, revision }, layer: 'project',
        scopeId: 'scope', principal, commandId: revision })).status).toBe('applied');
    };
    // The governed repair (the same admission `/model` and the in-invoke repair use): re-pin the unchanged binding at the current revision.
    const reactivate = async (commandId: string) => {
      const before = (await inspectConfiguredModelActivation(f.project, { schemaVersion: 1, scopeId: 'scope', reference }, options)).activation!;
      const binding = await inspectModelBinding(f.project, reference, options);
      if (binding.status !== 'declared') throw new Error('FIXTURE_BINDING');
      return { before, result: admitConfiguredModelActivation(f.project, { schemaVersion: 1, action: 'activate', commandId, scopeId: 'scope', reference,
        expectedRevision: before.revision, catalogRevision: binding.catalogRevision, expectedBinding: binding.binding }, options) };
    };
    const audit = () => assessConfiguredModelInvocationDelivery(f.project, options);
    return { f, path, options, connect, profile, cache, changeCatalog, reactivate, audit };
  }

  it('a connected Anthropic profile stays deliverable and re-activatable after the cache window and a catalog revision change', async () => {
    const c = await connected();
    expect(await c.audit()).toEqual([]);
    expect((await c.cache.apply()).status).toBe('applied');
    expect(await c.profile()).toMatchObject({ version: 2, adapter: { definition: { cache: '5m' } } });
    // Before the fix the seeded cap was the exact fit: the cache field alone made the profile 12 bytes too large for MCP (P1-DELIVERY-FIT.md).
    expect(await c.audit()).toEqual([]);
    await c.changeCatalog('catalog-after-cache');
    expect(await c.audit()).toEqual([]);
    const { before, result } = await c.reactivate('reactivate');
    expect((await result).receipt.record).toMatchObject({ state: 'active', revision: before.revision + 1, catalogRevision: 'catalog-after-cache' });
  });

  it('a profile seeded at the old exact fit stays refused (the gate holds) until a re-run of connect re-sizes it and keeps the cache', async () => {
    const c = await connected();
    // The pre-fix seed: the cap that leaves no headroom (half the headroom bytes more, the native response counts twice).
    const config = JSON.parse(await readFile(c.path, 'utf8')), seeded = config.provider_invocation_profiles.profiles.find((item: { id: string }) => item.id.startsWith('claude-fixture.'));
    const headroomCap = seeded.limits.responseMaxBytes as number;
    seeded.limits.responseMaxBytes = headroomCap + PROVIDER_CONNECT_REGISTRY.profileDefaults.deliveryHeadroomBytes / 2;
    await writeFile(c.path, JSON.stringify(config), { mode: 0o600 }); clearConfigCache();
    expect((await c.cache.apply()).status).toBe('applied');
    expect(await c.audit()).toMatchObject([{ surface: 'mcp' }]);
    await c.changeCatalog('catalog-after-cache');
    const { result } = await c.reactivate('reactivate-unfit');
    await expect(result).rejects.toMatchObject({ code: 'MODEL_ACTIVATION_DELIVERY_UNFIT' });
    // Recovery: connecting the same model again rewrites the profile at the headroom cap (the person's cache choice kept) and re-pins it.
    const again = await c.connect('connect-claude-again');
    expect(again).toMatchObject({ status: 'connected', steps: { profile: 'written', activation: 'written' } });
    const healed = await c.profile();
    expect(healed).toMatchObject({ version: 3, adapter: { definition: { cache: '5m' } } });
    expect(healed.limits.responseMaxBytes).toBeLessThanOrEqual(headroomCap); // sized on the cached profile it writes
    expect(await c.audit()).toEqual([]);
  });
});
