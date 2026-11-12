import { createHash } from 'node:crypto';
import type { InstallationBindingCapture } from '#domain/index.js';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ channel: 'mcp' as 'mcp' | undefined, values: new Map<string, string>(), seenActors: [] as string[],
  location: undefined as InstallationBindingCapture | undefined, locationDigests: [] as string[] }));
// The real scope audit helper runs on the mocked adapters' audit store below (FIX6: one helper for every scope audit).
vi.mock('#composition/core/scoped-request/index.js', async original => ({ ...await original<object>(), loadConfiguredScopeContext: async () => ({
  principal: { id: 'person', issuer: state.channel ? 'host/mcp' : 'host', subject: '1000', assurance: state.channel ? 'workload-verified' : 'os-user', scopeIds: ['scope'] },
  installationId: 'installation', config: { projectRoot: '/fixture', company: { id: 'company' }, identity: { profile: { id: 'core:solo', version: 1 } },
    installation: {}, storage: { sqlite: {} }, approvals: { keyFile: 'fixture.key' } }, layout: {}, path: async () => 'fixture-ledger',
  document: { schemaVersion: 1, revision: 'policy', restrictions: [], grants: [{ id: 'owner-session', effect: 'allow', actions: ['set'], scopes: ['scope'],
    principals: [{ issuer: 'host', subject: '1000' }], resource: { kind: 'secret', ids: 'all' } }] },
}) }));
vi.mock('#adapters/index.js', async original => {
  const actual = await original<typeof import('#adapters/index.js')>();
  return { ...actual,
    localPrincipalChannel: () => state.channel, localPrincipalPeer: () => undefined,
    withLocalPrincipalChannel: async (channel: 'mcp' | undefined, work: () => Promise<unknown>) => {
      const before = state.channel; state.channel = channel; try { return await work(); } finally { state.channel = before; }
    },
    localInstallationBindingSource: () => ({ capture: async () => state.location ?? ({ schemaVersion: 2, strength: 'weak', source: 'location', canonicalRoot: '/fixture', device: '1', inode: '1' }) }),
    createInstallationSecretCustody: (_env: unknown, _platform: unknown, _wait: unknown, trusted: { snapshot(): Promise<{ actor: { issuer: string }; locationDigest: string }> }) => ({
      exclusive: async (work: () => Promise<unknown>) => work(), selected: async () => actual.SIWC_PROTOCOL.encryptedStoreId,
      assertPersonal: async (_store: unknown, owner: unknown) => {
        const snapshot = await trusted.snapshot(); state.seenActors.push(snapshot.actor.issuer); state.locationDigests.push(snapshot.locationDigest);
        return { schemaVersion: 1, producer: 'local-os-store', owner,
          os: { uid: 1000, assurance: 'os-user', peerPid: null, connectionWitness: null }, profile: { id: 'core:solo', version: 1, digest: 'a'.repeat(64) },
          store: { backendId: actual.SIWC_PROTOCOL.encryptedStoreId, instanceBindingId: '00000000-0000-4000-8000-000000000002', generation: 1, role: 'personal-main', selectionDigest: null },
          host: { locationDigest: 'b'.repeat(64), keyIdentityDigest: 'c'.repeat(64), mountEvidenceDigest: 'd'.repeat(64), locality: 'local', control: 'os-account-exclusive' },
          cleanup: { state: 'complete', revision: 1 }, observedAtMs: Date.now() };
      },
    }),
    openConfiguredSecretStore: () => ({ descriptor: { id: actual.SIWC_PROTOCOL.encryptedStoreId, writable: true, enumerable: true, encryptedAtRest: true },
      get: async (name: string) => state.values.get(name), set: vi.fn(), delete: vi.fn(), listNames: async () => [...state.values.keys()] }),
    openSqliteAuditStore: async () => ({ close() {} }), openLocalIntegrityAuthority: async () => ({}),
    createSiwcConnectionLock: () => async (_id: string, work: () => Promise<unknown>) => work(),
  };
});
// The custody factory now lives behind its adapter; mock the same owner seams, preserving every actor and token assertion below.
vi.mock('#adapters/core/local-principal/index.js', async original => ({ ...await original<object>(),
  localPrincipalChannel: () => state.channel, localPrincipalPeer: () => undefined,
  withLocalPrincipalChannel: async (channel: 'mcp' | undefined, work: () => Promise<unknown>) => {
    const before = state.channel; state.channel = channel; try { return await work(); } finally { state.channel = before; }
  },
}));
vi.mock('#adapters/core/installation-files/index.js', async original => ({ ...await original<object>(),
  localInstallationBindingSource: () => ({ capture: async () => state.location ?? ({ schemaVersion: 2, strength: 'weak', source: 'location', canonicalRoot: '/fixture', device: '1', inode: '1' }) }),
}));
vi.mock('#adapters/core/provider-siwc/index.js', async original => ({ ...await original<object>(),
  createSiwcConnectionLock: () => async (_id: string, work: () => Promise<unknown>) => work(),
}));
vi.mock('#adapters/core/contract/index.js', async original => {
  const actual = await original<object>(), { SIWC_PROTOCOL: protocol } = await import('#adapters/core/provider-siwc/index.js');
  return { ...actual,
    createInstallationSecretCustody: (_env: unknown, _platform: unknown, _wait: unknown, trusted: { snapshot(): Promise<{ actor: { issuer: string }; locationDigest: string }> }) => ({
      exclusive: async (work: () => Promise<unknown>) => work(), selected: async () => protocol.encryptedStoreId,
      assertPersonal: async (_store: unknown, owner: unknown) => {
        const snapshot = await trusted.snapshot(); state.seenActors.push(snapshot.actor.issuer); state.locationDigests.push(snapshot.locationDigest);
        return { schemaVersion: 1, producer: 'local-os-store', owner,
          os: { uid: 1000, assurance: 'os-user', peerPid: null, connectionWitness: null }, profile: { id: 'core:solo', version: 1, digest: 'a'.repeat(64) },
          store: { backendId: protocol.encryptedStoreId, instanceBindingId: '00000000-0000-4000-8000-000000000002', generation: 1, role: 'personal-main', selectionDigest: null },
          host: { locationDigest: 'b'.repeat(64), keyIdentityDigest: 'c'.repeat(64), mountEvidenceDigest: 'd'.repeat(64), locality: 'local', control: 'os-account-exclusive' },
          cleanup: { state: 'complete', revision: 1 }, observedAtMs: Date.now() };
      },
    }),
    openConfiguredSecretStore: () => ({ descriptor: { id: protocol.encryptedStoreId, writable: true, enumerable: true, encryptedAtRest: true },
      get: async (name: string) => state.values.get(name), set: vi.fn(), delete: vi.fn(), listNames: async () => [...state.values.keys()] }),
  };
});
import { withConfiguredSiwc } from '#composition/core/siwc/index.js';
import { SIWC_PROTOCOL } from '#adapters/core/provider-siwc/index.js';

it('keeps the authenticated MCP caller separate from the person who owns and authorizes the OAuth store', async () => {
  const id = '00000000-0000-4000-8000-000000000001', owner = { installationId: 'installation', companyId: 'company', scopeId: 'scope', principal: { issuer: 'host', subject: '1000' } };
  state.values.set(`${SIWC_PROTOCOL.connectionSecretPrefix}${id.replaceAll('-', '').toUpperCase()}`, JSON.stringify({ schemaVersion: 2, connectionId: id, owner,
    custody: { bindingId: '00000000-0000-4000-8000-000000000002', generation: 1 }, clientId: 'fixture-client', identity: { issuer: SIWC_PROTOCOL.issuer, subject: 'fixture-account', email: null },
    generation: 1, planUseEnabled: true, state: 'connected', remoteRevocation: 'not-attempted', tokens: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: null,
      scopes: [SIWC_PROTOCOL.usagePermission], expiresAtMs: Date.now() + 3_600_000, earliestRefreshAtMs: null } }));
  const leased = await withConfiguredSiwc('/fixture', 'scope', { env: { HOME: '/fixture' } }, 'lease', async (app, caller) => {
    expect(caller).toEqual({ ...owner, principal: { issuer: 'host/mcp', subject: '1000' } });
    return app.lease(id, caller);
  });
  expect(leased.accessToken).toBe('synthetic-access'); expect(state.seenActors).toEqual(['host/mcp']); expect(state.channel).toBe('mcp');
});


it('keeps the beta.1.2 personal location digest across additive capture observations, upgrade and rollback', async () => {
  // Golden bytes follow 56d9ce858's capture schema order; SHA-256 literals were computed independently with Python hashlib.
  const location = { canonicalRoot: '/srv/installation/.deckent', device: '2049', inode: '131' };
  const filesystemIdentity = { kind: 'linux.ext4.statfs-fsid.v1', value: '033b6aacc3f1ba86' };
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const snapshotDigest = async (capture: InstallationBindingCapture) => {
    state.location = capture; state.locationDigests.length = 0;
    return withConfiguredSiwc('/fixture', 'scope', { env: { HOME: '/fixture' } }, 'lease', async (app, caller) => {
      // No saved connection is needed: lease checks personal custody before looking up the connection.
      await expect(app.lease('00000000-0000-4000-8000-000000000003', caller)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_INVALID' });
      return state.locationDigests.at(-1);
    });
  };
  try {
    for (const [source, golden] of [
      ['platform', '20eff2945e85432d219a62952260f347a4709794127e3f8a164b0fd7db8e317e'],
      ['configured', 'a5afd725f5f18c3c22bb74fb49de81599f2e0c2e373944ad724d528fa411c1ff'],
      ['location', 'f4b3fd41dcfb3ba35bfd3a2dff98751c9930dba9de35b0ce8fa61d1f79c6c82d'],
    ] as const) {
      const legacy: InstallationBindingCapture = source === 'location'
        ? { schemaVersion: 2, strength: 'weak', source, ...location }
        : { schemaVersion: 2, strength: 'machine', source, machineDigest: 'a'.repeat(64), ...location };
      const current = { ...legacy, filesystemIdentity };
      expect(hash(legacy)).toBe(golden);
      expect(hash(current)).not.toBe(golden); // The old whole-capture input breaks compatibility.
      expect(await snapshotDigest(legacy)).toBe(golden);
      expect(await snapshotDigest(current)).toBe(golden);
      // Future observations and input key order must not silently change this unversioned digest either.
      const future = { futureObservation: 'not-digest-input', ...Object.fromEntries(Object.entries(current).reverse()) };
      expect(await snapshotDigest(future as unknown as InstallationBindingCapture)).toBe(golden);
      expect(await snapshotDigest(legacy)).toBe(golden); // rollback
      expect(await snapshotDigest({ ...legacy, inode: '132' })).not.toBe(golden); // real location drift still matters
    }
  } finally { state.location = undefined; }
});
