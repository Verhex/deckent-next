import { expect, it } from 'vitest';
import { modelInvocationProfileSchema } from '#domain/index.js';
import { openInvocationWorkspaceSelection, type WorkspaceSelectionPorts, type WorkspaceSelectionContext } from '#engine/index.js';
import { providerProfileWorkspaceOffer, connectionAdapter, providerConnectKind } from '#adapters/core/provider-connect/index.js';

function fixture() {
  const kind = providerConnectKind('anthropic-api')!, adapter = connectionAdapter(kind, { endpoint: 'https://api.anthropic.com/v1/messages',
    credentialRef: 'FIXTURE_KEY', nativeId: 'claude-sonnet-5-5', maxOutputTokens: 256, currency: 'USD' });
  const profile = modelInvocationProfileSchema.parse({ schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope',
    reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 }, bindingDigest: 'a'.repeat(64), adapter: adapter.adapter,
    protocol: adapter.protocol, allocation: { id: 'allocation', maxCalls: 10, maxInFlight: 1 }, limits: { requestMaxBytes: 65536, responseMaxBytes: 65536, timeoutMs: 1000 } });
  let current: WorkspaceSelectionContext = { identity: 'installation/project', profiles: [profile, { ...profile, id: 'foreign', scopeId: 'other' }] };
  const calls: string[] = []; let denied = false, staleAfterCredential = false, changedWorkspace = false;
  const ports: WorkspaceSelectionPorts<WorkspaceSelectionContext> = {
    read: async () => current, eligible: () => true,
    authorize: async () => { calls.push('authorize'); if (denied) throw new Error('revoked'); },
    credential: async () => { calls.push('credential'); if (staleAfterCredential) current = { ...current, identity: 'other-installation' }; return 'fixture-key'; },
    discover: async () => { calls.push('discover'); return [{ id: changedWorkspace ? 'wrkspc_Changed' : 'wrkspc_Selected', name: 'Team' }]; },
    snapshots: async () => { const snapshot = { global: {}, project: { provider_invocation_profiles: { schemaVersion: 1, profiles: current.profiles } }, digest: 'd'.repeat(64) }; return [snapshot, snapshot]; },
    offer: providerProfileWorkspaceOffer,
  };
  return { ports, calls, revoke: () => { denied = true; }, stale: () => { staleAfterCredential = true; }, changeWorkspace: () => { changedWorkspace = true; } };
}

it('keeps choice custody, re-reads discovery at confirmation and plans only the scoped profile with a snapshot expectation', async () => {
  const f = fixture(), session = await openInvocationWorkspaceSelection('scope', f.ports);
  expect(session.profiles.map(row => row.id)).toEqual(['profile']);
  await expect(session.plan('profile', 'wrkspc_Selected')).rejects.toMatchObject({ code: 'MODEL_CONNECT_DEFINITION_INVALID' });
  await session.list('profile'); const plan = await session.plan('profile', 'wrkspc_Selected');
  expect(f.calls.filter(call => call === 'discover')).toHaveLength(2);
  expect(plan.writes).toHaveLength(1); expect(plan.writes[0]!.expect).toBe('d'.repeat(64));
  const profiles = plan.writes[0]!.value['profiles'] as { scopeId: string; version: number; adapter: { definition: { workspaceId?: string } } }[];
  expect(profiles[0]).toMatchObject({ version: 2, adapter: { definition: { workspaceId: 'wrkspc_Selected' } } });
  expect(profiles[1]!.version).toBe(1); expect(profiles[1]!.adapter.definition.workspaceId).toBeUndefined();
  f.changeWorkspace(); await expect(session.plan('profile', 'wrkspc_Selected')).rejects.toMatchObject({ code: 'CONFIG_CONCURRENT_REVISION_HOLD' });
});

it('a revoked invoke grant blocks before credential resolution and discovery; foreign scope stays inaccessible', async () => {
  const f = fixture(), session = await openInvocationWorkspaceSelection('scope', f.ports); f.calls.length = 0; f.revoke();
  await expect(session.list('profile')).rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_UNAVAILABLE' });
  await expect(session.list('foreign')).rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_UNAVAILABLE' });
  expect(f.calls).toEqual(['authorize']);
});

it('identity changes after asynchronous credential resolution refuse before a network request', async () => {
  const f = fixture(), session = await openInvocationWorkspaceSelection('scope', f.ports); f.calls.length = 0; f.stale();
  await expect(session.list('profile')).rejects.toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_UNAVAILABLE' });
  expect(f.calls).toEqual(['authorize', 'credential']);
});
