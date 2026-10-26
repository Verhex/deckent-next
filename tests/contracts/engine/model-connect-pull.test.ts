import { expect, it } from 'vitest';
import { workerConnectionModelIds, ModelConnectApplication, type ModelConnectPorts } from '#engine/index.js';
import { parseProviderCatalogDocument, type AuditEvent } from '#domain/index.js';

it('pull intersects a fresh key list with active priced seed rows, writes each layer once, and preflights AI before any write', async () => {
  const seed = parseProviderCatalogDocument({ schemaVersion: 2, revision: 'seed', providers: [{ id: 'vendor', version: 1,
    channel: { kind: 'http-api', cli: null, aliases: [] }, models: ['a', 'b', 'c'].map(id => ({ id, version: 1, nativeId: id,
      protocols: [{ family: 'test', version: 'v1', capabilities: [] }], lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null },
      minCliVersion: null, efforts: [], aliases: [] })) }] });
  const global: Record<string, unknown> = {}, project: Record<string, unknown> = {}, writes: string[] = [], activations: string[] = [], audits: AuditEvent[] = [];
  let catalogRegistered = false, profileApproved = false;
  const ports: ModelConnectPorts = {
    kind: () => ({ id: 'vendor', available: true, endpoint: { default: 'https://provider.example', editable: false }, keyRequired: false, connect: { seed: 'vendor', chatPath: '/chat', pull: 'available' } }),
    defaults: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000, maxInFlight: 1, maxOutputTokens: 100, currency: 'USD', deliveryHeadroomBytes: 512 },
    endpoint: text => text, secretName: () => null, seed: async () => seed, available: async () => ['a', 'c', 'd'], priced: (_kind, id) => id !== 'c',
    adapter: () => ({ adapter: { id: 'test', version: 1, definition: {} }, protocol: { family: 'test', version: 'v1' }, tariff: 'unmetered', billingAxis: 'subscription' }),
    principal: async () => ({ id: 'person', issuer: 'host', subject: 'alice', assurance: 'os-user', scopeIds: ['s'] }),
    layers: async () => ({ global, project, effective: { ...global, ...project } }),
    write: async change => {
      if (change.keyPath === 'provider_invocation_profiles' && !profileApproved) return { approvalId: 'profile-card' };
      writes.push(change.keyPath); project[change.keyPath] = change.value; return null;
    },
    catalogHas: async () => catalogRegistered, register: async () => { catalogRegistered = true; writes.push('register'); },
    binding: async reference => ({ status: 'declared', catalogRevision: 'r', definition: { provider: { id: 'vendor', version: 1 }, model: { id: reference.modelId, version: 1, nativeId: reference.modelId, protocols: [{ family: 'test', version: 'v1', capabilities: [] }] } }, binding: { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) } }),
    activation: async () => null, activate: async input => { activations.push(input.reference.modelId); }, delivers: () => true,
    audit: async event => { audits.push(event); }, policyRevision: async () => 'p', keyStored: async () => null, service: async () => null,
  };
  const command = { schemaVersion: 1, commandId: 'pull', scopeId: 's', connection: 'vendor', model: { pull: 'available' } };
  const app = new ModelConnectApplication(ports), pending = await app.connect(command);
  expect(pending).toMatchObject({ status: 'approval-pending', approval: { approvalId: 'profile-card', keyPath: 'provider_invocation_profiles', layer: 'project' },
    steps: { declaration: 'written', profile: 'present', activation: 'present' } });
  expect(project).not.toHaveProperty('provider_invocation_profiles');
  expect(writes).toEqual(['register', 'provider_catalog']); expect(activations).toEqual([]); expect(audits).toEqual([]);
  profileApproved = true;
  const result = await app.connect(command);
  expect(result.models).toEqual([{ nativeId: 'b', state: 'notOnKey' }, { nativeId: 'c', state: 'unpriced' }, { nativeId: 'd', state: 'notInCatalog' },
    { nativeId: 'a', reference: { providerId: 'vendor', providerVersion: 1, modelId: 'a', modelVersion: 1 }, state: 'connected' }]);
  expect(writes).toEqual(['register', 'provider_catalog', 'provider_invocation_profiles']); expect(activations).toEqual(['a']); expect(audits).toHaveLength(1);
  const before = JSON.stringify({ global, project, writes, activations, audits });
  await expect(new ModelConnectApplication({ ...ports, principal: async () => ({ id: 'ai', issuer: 'host/mcp', subject: 'alice', assurance: 'workload-verified', scopeIds: ['s'] }),
    preflight: async () => { throw Object.assign(Error('refused'), { code: 'POLICY_DENIED' }); } }).connect(command)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(JSON.stringify({ global, project, writes, activations, audits })).toBe(before);
  await expect(new ModelConnectApplication({ ...ports, kind: () => ({ ...ports.kind('vendor')!, connect: { ...ports.kind('vendor')!.connect!, pull: 'pick' } }) }).connect(command)).rejects.toMatchObject({ code: 'MODEL_CONNECT_MODEL_UNKNOWN' });
});

it('worker-only connection uses admitted CLI versions, writes no chat config, and activates only the named current models', async () => {
  const seed = parseProviderCatalogDocument({ schemaVersion: 2, revision: 'cli', providers: [{ id: 'workers', version: 1, channel: { kind: 'native-cli', cli: 'codex', aliases: [] },
    models: [{ id: 'a', version: 1, nativeId: 'a', protocols: [{ family: 'worker', version: 'v1', capabilities: [] }], minCliVersion: '0.159.2', efforts: [], aliases: [],
      lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null } }] }] });
  const source = (cliVersion: string) => ({ admission: { registry: { profiles: [{ id: 'worker', version: 1, parameters: { nativeSubscription: { provider: 'codex', preflight: { cliVersion } } } }] } } });
  expect(workerConnectionModelIds(seed, source('codex-cli 0.159.1'))).toEqual([]);
  expect(workerConnectionModelIds(seed, source('codex-cli 0.159.2'))).toEqual(['a']);
  const writes: string[] = [];
  const ports = { kind: () => ({ id: 'workers', available: true, endpoint: { default: null, editable: false }, keyRequired: false, connect: { seed: 'workers', chatPath: null, catalogOnly: true, pull: 'available' } }),
    defaults: {}, endpoint: () => null, secretName: () => null, seed: async () => seed, available: async () => ['a'], priced: () => true,
    principal: async () => ({ id: 'person', issuer: 'host', subject: 'alice', assurance: 'os-user', scopeIds: ['s'] }), layers: async () => ({ global: {}, project: {}, effective: {} }),
    catalogHas: async () => false, register: async () => { writes.push('catalog'); }, workerActivate: async () => { writes.push('worker'); return true; },
    write: async () => { throw Error('chat config must stay untouched'); }, adapter: async () => { throw Error('worker connection has no chat adapter'); },
    binding: async () => { throw Error('worker connection has no chat binding'); }, audit: async () => {}, policyRevision: async () => 'p', keyStored: async () => null, service: async () => null } as unknown as ModelConnectPorts;
  const result = await new ModelConnectApplication(ports).connect({ schemaVersion: 1, commandId: 'worker', scopeId: 's', connection: 'workers', model: { pull: 'available' } });
  expect(result).toMatchObject({ status: 'connected', steps: { declaration: 'skipped', profile: 'skipped', activation: 'written' } });
  expect(writes).toEqual(['catalog', 'worker']);
});
