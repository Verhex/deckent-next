import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ channel: 'mcp' as 'mcp' | undefined, values: new Map<string, string>(), seenActors: [] as string[] }));
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
    localInstallationBindingSource: () => ({ capture: async () => ({ schemaVersion: 2, strength: 'weak', source: 'location', canonicalRoot: '/fixture', device: '1', inode: '1' }) }),
    createInstallationSecretCustody: (_env: unknown, _platform: unknown, _wait: unknown, trusted: { snapshot(): Promise<{ actor: { issuer: string } }> }) => ({
      exclusive: async (work: () => Promise<unknown>) => work(), selected: async () => actual.SIWC_PROTOCOL.encryptedStoreId,
      assertPersonal: async (_store: unknown, owner: unknown) => {
        const snapshot = await trusted.snapshot(); state.seenActors.push(snapshot.actor.issuer);
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
