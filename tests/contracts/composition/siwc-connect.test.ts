import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ records: [] as { connectionId: string; state: string; planUse: boolean }[], connect: vi.fn(),
  models: vi.fn(), custody: vi.fn(), catalog: vi.fn() }));
vi.mock('../../../src/composition/core/siwc/internal/connect.js', async original => {
  const real = await original<typeof import('../../../src/composition/core/siwc/internal/connect.js')>();
  return { ...real, configuredSiwcConnect: (...args: Parameters<typeof real.configuredSiwcConnect>) => {
    const ports = real.configuredSiwcConnect(...args);
    return { ...ports, models: () => { state.models(); return ports.models(); } };
  } };
});
vi.mock('../../../src/composition/core/siwc/internal/connection.js', () => ({
  withConfiguredSiwc: async (_root: string, _scope: string, _options: unknown, _operation: string,
    work: (app: unknown, caller: unknown) => Promise<unknown>) => {
    state.custody(_operation);
    return work({ list: async () => state.records, connect: state.connect },
      { principal: { id: 'person', issuer: 'host', subject: '1000', assurance: 'os-user', scopeIds: ['scope'] } });
  },
}));
vi.mock('#composition/core/scoped-request/index.js', async original => {
  const real = await original<typeof import('#composition/core/scoped-request/index.js')>();
  return { ...real, loadConfiguredScopeContext: async (...args: Parameters<typeof real.loadConfiguredScopeContext>) => args[0] === '/fixture'
    ? { principal: { id: 'person', issuer: 'host', subject: '1000', assurance: 'os-user', scopeIds: ['scope'] } } : real.loadConfiguredScopeContext(...args) };
});
const host = vi.hoisted(() => ({ available: true, root: '', witness: true }));
vi.mock('#adapters/index.js', async original => {
  const real = await original<typeof import('#adapters/index.js')>();
  return { ...real, listSiwcModels: state.catalog, attestLocalInteractiveTerminal: async () => host.witness, installationSecretRoot: () => host.root, PROVIDER_CONNECT_REGISTRY: { ...real.PROVIDER_CONNECT_REGISTRY,
    kinds: real.PROVIDER_CONNECT_REGISTRY.kinds.map(kind => kind.connect?.adapter === real.SIWC_INFERENCE.adapter.id ? { ...kind, get available() { return host.available; } } : kind) } };
});
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredSiwcConnect } from '#composition/core/siwc/index.js';
import { runtime } from '../support/chat-turn-harness.js';
import { connectConfiguredModel, executeConfiguredSiwc } from '#composition/core/model-connect/index.js';
import { assertAuthorityWitness, ModelConnectApplication, type ModelConnectPorts, OAuthConnectionError } from '#engine/index.js';
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
  // The shared SIWC refusal remains active on every platform, including hosts without managed private ledgers.
  const reference = { providerId: 'fixture', providerVersion: 1, modelId: 'fixture', modelVersion: 1 };
  const document = { provider_catalog: { schemaVersion: 1, revision: 'fixture', providers: [{ id: reference.providerId, version: 1,
    models: [{ id: reference.modelId, version: 1, nativeId: 'fixture', protocols: [{ ...profile.protocol, capabilities: [] }] }] }] } };
  const adapter = vi.fn(() => configuredSiwcConnect('/fixture', command, {}).adapter());
  const discovery = vi.fn(() => configuredSiwcConnect('/fixture', command, {}).models());
  const ports = { kind: () => ({ id: 'chatgpt-login', available: true, keyRequired: false, endpoint: { default: null, editable: false },
    connect: { chatPath: null, seed: null, personOnly: true } }), defaults: { maxOutputTokens: 1 },
    principal: async () => ({ id: 'person', issuer: 'host', subject: '1000', assurance: 'os-user', scopeIds: ['scope'] }),
    layers: async () => ({ global: {}, project: document, effective: document }), adapter, available: discovery, discover: discovery,
    authorizeDelegation: () => assertAuthorityWitness('models.connect.delegate', undefined, { attest: async () => false }) } as unknown as ModelConnectPorts;
  const untouched = () => {
    expect(discovery).not.toHaveBeenCalled(); expect(adapter).not.toHaveBeenCalled(); expect(state.models).not.toHaveBeenCalled();
    expect(state.custody).not.toHaveBeenCalled(); expect(state.connect).not.toHaveBeenCalled(); expect(state.catalog).not.toHaveBeenCalled();
  };
  state.connect.mockClear(); state.models.mockClear(); state.custody.mockClear(); state.catalog.mockReset();
  state.records = []; state.catalog.mockRejectedValue(new OAuthConnectionError('OAUTH_CONNECTION_REAUTHORIZE'));
  for (const model of [{ reference }, { pull: 'available' }, { nativeId: 'fixture' }]) {
    await expect(new ModelConnectApplication(ports).connect({ ...command, connection: 'chatgpt-login', model, delegate: ['ai', 'system'] }))
      .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    untouched();
  }
  if (process.platform === 'win32') {
    console.info('verify-not-run:', JSON.stringify({ file: 'tests/contracts/composition/siwc-connect.test.ts', surface: 'native SIWC composition fixture',
      reason: 'managed POSIX private ledgers unsupported; shared delegation refusal verified above' }));
    return;
  }
  const f = await runtime({ noServer: true }), path = join(f.project, '.deckent/config.json'), before = await readFile(path, 'utf8');
  // A controlling terminal alone is insufficient: the same synthetic TTY must refuse AI markers before SIWC models -> ensure -> OAuth.
  host.witness = true;
  try {
    for (const model of [{ pull: 'available' }, { nativeId: 'fixture' }]) {
      const request = { ...command, commandId: 'siwc-unwitnessed-delegation', connection: 'chatgpt-login', model, delegate: ['ai', 'system'] };
      await expect(connectConfiguredModel(f.project, request, { env: { ...f.env, CLAUDECODE: '1' } }))
        .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
      expect(await readFile(path, 'utf8')).toBe(before); untouched();
      // A person witness reaches real models/ensure and the synthetic OAuth port; stop at the local model-list fixture, with no network call.
      await expect(connectConfiguredModel(f.project, request, { env: f.env })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_REAUTHORIZE' });
      expect(state.models).toHaveBeenCalledTimes(1); expect(state.custody.mock.calls).toEqual([['connect'], ['lease']]);
      expect(state.connect).toHaveBeenCalledTimes(1); expect(state.catalog).toHaveBeenCalledTimes(1);
      expect(await readFile(path, 'utf8')).toBe(before);
      state.models.mockClear(); state.custody.mockClear(); state.connect.mockClear(); state.catalog.mockClear();
    }
  } finally { host.witness = true; }
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
