import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ records: [] as { connectionId: string; state: string; planUse: boolean }[], connect: vi.fn() }));
vi.mock('../../../src/composition/core/siwc/internal/connection.js', () => ({
  withConfiguredSiwc: async (_root: string, _scope: string, _options: unknown, _operation: string,
    work: (app: unknown, caller: unknown) => Promise<unknown>) => work({ list: async () => state.records, connect: state.connect },
      { principal: { id: 'person', issuer: 'host', subject: '1000', assurance: 'os-user', scopeIds: ['scope'] } }),
}));
vi.mock('#composition/core/scoped-request/index.js', async original => ({ ...await original<object>(),
  loadConfiguredScopeContext: async () => ({ principal: { id: 'person', issuer: 'host', subject: '1000', assurance: 'os-user', scopeIds: ['scope'] } }) }));
vi.mock('#engine/index.js', async original => ({ ...await original<object>(), assertAuthorityWitness: async () => {} }));
const host = vi.hoisted(() => ({ available: true, root: '' }));
vi.mock('#adapters/index.js', async original => {
  const real = await original<typeof import('#adapters/index.js')>();
  return { ...real, installationSecretRoot: () => host.root, PROVIDER_CONNECT_REGISTRY: { ...real.PROVIDER_CONNECT_REGISTRY,
    kinds: real.PROVIDER_CONNECT_REGISTRY.kinds.map(kind => kind.connect?.adapter === real.SIWC_INFERENCE.adapter.id ? { ...kind, get available() { return host.available; } } : kind) } };
});
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredSiwcConnect } from '#composition/core/siwc/index.js';
import { executeConfiguredSiwc } from '#composition/core/model-connect/index.js';
import { OAuthConnectionError } from '#engine/index.js';
import { modelConnectCommandSchema } from '#domain/index.js';

it('requires an explicit disconnected old account for new authorization and writes only the owner reference into a default-off profile', async () => {
  // Synthetic lifecycle ports; this is not a TTY witness, browser login or account entitlement proof.
  const command = modelConnectCommandSchema.parse({ schemaVersion: 1, commandId: 'fixture', scopeId: 'scope', connection: 'fixture-connection',
    model: { pull: 'available' }, subscription: { newAccount: true } });
  state.records = [{ connectionId: '00000000-0000-4000-8000-000000000001', state: 'connected', planUse: true }]; state.connect.mockReset();
  await expect(configuredSiwcConnect('/fixture', command, {}).adapter()).rejects.toMatchObject({ code: 'SIWC_ACCOUNT_STILL_CONNECTED' });
  expect(state.connect).not.toHaveBeenCalled();
  state.records = [{ ...state.records[0]!, state: 'disconnected', planUse: false }];
  const connectionId = '00000000-0000-4000-8000-000000000002';
  state.connect.mockResolvedValue({ connectionId, state: 'connected', planUse: true });
  const profile = await configuredSiwcConnect('/fixture', command, {}).adapter();
  expect(state.connect).toHaveBeenCalledWith({ planUse: true }, undefined);
  expect(profile).toMatchObject({ billingAxis: 'subscription', tariff: 'unmetered', adapter: { definition: { schemaVersion: 2, connectionId,
    owner: { issuer: 'host', subject: '1000' }, rawUse: 'person', delegatedUse: null, apiContinuation: null } } });
  expect(profile.adapter.definition['owner']).not.toHaveProperty('id');
});

it('gates sign-in on the registry row for CLI and terminal alike and gives a custody refusal its registered fix, never a raw error (FIX8b R22/R23)', async () => {
  const login = { operation: 'login', scopeId: 'scope' } as const;
  host.available = false; state.connect.mockReset(); state.records = [];
  await expect(executeConfiguredSiwc('/fixture', login, {})).rejects.toMatchObject({ code: 'MODEL_CONNECT_NOT_CONNECTABLE' });
  await expect(executeConfiguredSiwc('/fixture', { operation: 'prepare', scopeId: 'scope' }, {})).rejects.toMatchObject({ code: 'MODEL_CONNECT_NOT_CONNECTABLE' });
  expect(state.connect).not.toHaveBeenCalled();
  host.available = true; host.root = await mkdtemp(join(tmpdir(), 'siwc-root-'));
  try {
    await chmod(host.root, 0o755);
    state.connect.mockRejectedValue(new OAuthConnectionError('SIWC_STORE_NOT_PERSONAL', 'unsafe-root'));
    const refused = await executeConfiguredSiwc('/fixture', login, {}).catch((error: unknown) => error) as { code: string; params: object; localize(locale: string): { message: string } };
    expect(refused).toMatchObject({ code: 'SIWC_STORE_NOT_PERSONAL', params: { reason: 'unsafe-root', path: host.root, mode: '0755', folder: 'root' } });
    expect(refused.localize('en').message).toContain(`chmod 700 ${host.root}`);
    expect(refused.localize('tr').message).toContain(`chmod 700 ${host.root}`);
    state.connect.mockRejectedValue(new OAuthConnectionError('OAUTH_CONNECTION_STORE_REQUIRED'));
    expect((await executeConfiguredSiwc('/fixture', login, {}).catch((error: { localize(locale: string): { message: string } }) => error.localize('en').message)))
      .toContain('deckent secret store --to core.secret-store.encrypted-file@1');
  } finally { await rm(host.root, { recursive: true, force: true }); }
});
