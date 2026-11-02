import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ records: [] as { connectionId: string; state: string; planUse: boolean }[], connect: vi.fn(),
  models: vi.fn(), custody: vi.fn(), catalog: vi.fn(), oauth: null as OAuthConnectionApplication | null, owner: null as { issuer: string; subject: string } | null }));
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
    return work({ list: async () => state.oauth ? state.oauth.list() : state.records, connect: state.connect },
      { principal: { id: 'person', ...(state.owner ?? { issuer: 'host', subject: '1000' }), assurance: 'os-user', scopeIds: ['scope'] } });
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
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredSiwcConnect } from '#composition/core/siwc/index.js';
import { runtime } from '../support/chat-turn-harness.js';
import { connectConfiguredModel, executeConfiguredSiwc } from '#composition/core/model-connect/index.js';
import { assertAuthorityWitness, ModelConnectApplication, type ModelConnectPorts, OAuthConnectionApplication, personalCustodyEvidenceSchema, OAuthConnectionError } from '#engine/index.js';
import { SIWC_PROTOCOL, SIWC_INFERENCE, PROVIDER_CONNECT_REGISTRY, discoveredProviderCatalog } from '#adapters/index.js';
import { resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { encodeModelBindingDefinition, modelConnectCommandSchema } from '#domain/index.js';

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
  const f = await runtime({ noServer: true }), path = join(f.project, '.deckent/config.json');
  const principal = await resolveConfiguredConfigPrincipal(f.project, 'scope', { env: f.env });
  const kind = PROVIDER_CONNECT_REGISTRY.kinds.find(row => row.id === 'chatgpt-login')!;
  const seed = discoveredProviderCatalog(kind, '', 'a'), provider = seed.providers[0]!, entry = provider.models[0]!;
  const modelA = { id: entry.id, version: entry.version, nativeId: entry.nativeId, protocols: entry.protocols };
  const a = { providerId: provider.id, providerVersion: provider.version, modelId: modelA.id, modelVersion: modelA.version };
  const config = JSON.parse(await readFile(path, 'utf8')), source = config.provider_invocation_profiles.profiles[0];
  config.provider_catalog.providers.push({ id: provider.id, version: provider.version, models: [modelA] });
  const { createHash } = await import('node:crypto');
  config.provider_invocation_profiles.profiles.push({ ...source, schemaVersion: 2, billingAxis: 'subscription',
    id: ['chatgpt-login', a.providerId, a.modelId, String(a.modelVersion)].join('.'), reference: a,
    bindingDigest: createHash('sha256').update(encodeModelBindingDefinition({ encodingVersion: 1, provider: { id: provider.id, version: provider.version }, model: modelA })).digest('hex'),
    adapter: { ...SIWC_INFERENCE.adapter, definition: { schemaVersion: 2, connectionId, owner: { issuer: principal.issuer, subject: principal.subject }, rawUse: 'person',
      delegatedUse: { classes: ['ai'], consentedBy: { issuer: principal.issuer, subject: principal.subject }, atMs: 1 }, apiContinuation: null } } });
  const values = new Map<string, string>();
  const owner = { installationId: 'fixture-installation', companyId: 'fixture-company', scopeId: 'scope', principal: { issuer: principal.issuer, subject: principal.subject } };
  const storeSet = vi.fn(async (name: string, value: string) => { values.set(name, value); }), audit = vi.fn(async () => {});
  const browser = vi.fn(async (makeUrl: (redirect: string) => string) => {
    const redirectUri = 'http://127.0.0.1:43210/auth/callback', url = new URL(makeUrl(redirectUri)), callback = new URL(redirectUri);
    callback.search = new URLSearchParams({ code: 'fixture-code', state: url.searchParams.get('state')!,
      client_id: url.searchParams.get('client_id') === SIWC_PROTOCOL.dynamicClientId ? 'oaiapp_fixture' : url.searchParams.get('client_id')! }).toString();
    return { callback: callback.href, redirectUri };
  });
  const oauth = new OAuthConnectionApplication({ owner, protocol: SIWC_PROTOCOL, now: Date.now, connectionLock: async (_id, work) => work(),
    store: { descriptor: { id: SIWC_PROTOCOL.encryptedStoreId, writable: true, enumerable: true, encryptedAtRest: true }, get: async name => values.get(name),
      set: storeSet, delete: async name => values.delete(name), listNames: async () => [...values.keys()] },
    custody: { exclusive: async work => work(), selected: async () => SIWC_PROTOCOL.encryptedStoreId,
      assertPersonal: async () => personalCustodyEvidenceSchema.parse({ schemaVersion: 1, producer: 'local-os-store', owner,
        os: { uid: 1000, assurance: 'os-user', peerPid: null, connectionWitness: null }, profile: { id: 'core:solo', version: 1, digest: 'a'.repeat(64) },
        store: { backendId: SIWC_PROTOCOL.encryptedStoreId, instanceBindingId: '00000000-0000-4000-8000-000000000003', generation: 1, role: 'personal-main', selectionDigest: null },
        host: { locationDigest: 'b'.repeat(64), keyIdentityDigest: 'c'.repeat(64), mountEvidenceDigest: 'd'.repeat(64), locality: 'local', control: 'os-account-exclusive' },
        cleanup: { state: 'complete', revision: 1 }, observedAtMs: Date.now() }) },
    authorize: async () => ({ effect: 'allow', policyRevision: 'fixture-policy', ruleId: 'fixture-rule' }), audit, browser,
    exchange: async () => ({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: 'synthetic-id',
      scopes: [...SIWC_PROTOCOL.identityScopes, ...SIWC_PROTOCOL.usageScopes], expiresAtMs: Date.now() + 60_000, earliestRefreshAtMs: null }),
    verifyIdentity: async () => ({ issuer: SIWC_PROTOCOL.issuer, subject: 'fixture-account', email: null }), revoke: async () => true, unusableRefresh: () => false });
  // A retained A profile with a disconnected real OAuth record exercises reauthorization, not an effectless connect stub.
  const connected = await oauth.connect({ planUse: true });
  config.provider_invocation_profiles.profiles.at(-1).adapter.definition.connectionId = connected.connectionId;
  await writeFile(path, JSON.stringify(config));
  const before = await readFile(path, 'utf8');
  state.oauth = oauth; state.owner = owner.principal; state.connect.mockImplementation((input, signal) => oauth.connect(input, signal));
  host.witness = true;
  try {
    for (const model of [{ nativeId: 'b' }, { pull: 'available' }, { nativeId: 'a' }]) {
      await oauth.disconnect(connected.connectionId);
      state.connect.mockClear(); state.models.mockClear(); state.custody.mockClear(); state.catalog.mockClear();
      storeSet.mockClear(); audit.mockClear(); browser.mockClear();
      const stored = new Map(values), request = { ...command, subscription: undefined, commandId: 'siwc-unwitnessed-delegation', connection: 'chatgpt-login', model, delegate: ['ai'] };
      // Astra 2955: SIWC has no seed, so even the consented A's nativeId is resolved only by discovery and cannot skip the early witness.
      {
        state.catalog.mockResolvedValue([{ slug: 'a' }, { slug: 'b' }]); // This list would add B if discovery were reached.
        await expect(connectConfiguredModel(f.project, request, { env: { ...f.env, CLAUDECODE: '1' } }))
          .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
        for (const delegate of [['system'], ['ai', 'system']]) {
          await expect(connectConfiguredModel(f.project, { ...request, delegate }, { env: { ...f.env, CLAUDECODE: '1' } }))
            .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
        }
        expect(await readFile(path, 'utf8')).toBe(before); untouched();
        expect(storeSet).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled(); expect(values).toEqual(stored);
        console.info('F11-R3 refused before effects:', JSON.stringify({ model, models: state.models.mock.calls.length, ensure: state.custody.mock.calls.length,
          connect: state.connect.mock.calls.length, storeSet: storeSet.mock.calls.length, audit: audit.mock.calls.length, browser: browser.mock.calls.length, configUnchanged: true }));
      }
      // Person witness reaches real SIWC models/ensure and real OAuth effects; only network/model listing is synthetic.
      state.catalog.mockRejectedValue(new OAuthConnectionError('OAUTH_CONNECTION_REAUTHORIZE'));
      await expect(connectConfiguredModel(f.project, request, { env: f.env })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_REAUTHORIZE' });
      expect(state.models).toHaveBeenCalledTimes(1); expect(state.custody.mock.calls).toEqual([['connect'], ['lease']]);
      expect(state.connect).toHaveBeenCalledTimes(1); expect(state.catalog).toHaveBeenCalledTimes(1);
      expect(storeSet).toHaveBeenCalled(); expect(audit).toHaveBeenCalled(); expect(browser).toHaveBeenCalledTimes(1);
      console.info('F11-R3 local OAuth positive:', JSON.stringify({ model, storeSet: storeSet.mock.calls.length, audit: audit.mock.calls.length, browser: browser.mock.calls.length }));
      expect(await readFile(path, 'utf8')).toBe(before);
    }
  } finally { host.witness = true; state.oauth = null; state.owner = null; }

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
