import { governedHubRevocationReader } from '#adapters/core/hub-http/index.js';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { createGovernedHubFetch, type HubFetchDependencies } from '#composition/core/hub/index.js';
import { OperationPolicyAuthorization, type EffectStore } from '#engine/index.js';
import { type EffectRecord } from '#domain/index.js';
import { fixture, source, hub } from '../../fixtures/hub-client.js';
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup() {
  const f = await fixture(); roots.push(f.root); await f.app.addSource({ ...source, endpoint: 'https://hub.invalid/mcp', local: false });
  const records = new Map<string, EffectRecord>();
  const store: EffectStore = { loadEffect: async (_scope, id) => records.get(id) ?? null,
    claimEffect: async intent => { const record: EffectRecord = { intent, sequence: 1, state: 'claimed', evidence: null, refusal: null }; records.set(intent.command.commandId, record); return record; },
    saveEffect: async (_previous, next) => { records.set(next.intent.command.commandId, next); return next; } };
  const principal = { id: 'person', issuer: 'test', subject: 'person', assurance: 'token-verified', scopeIds: ['s'] };
  const session = { schemaVersion: 1, sessionId: 'test-session', authorityRef: 'test', kind: 'token-verified', principalRef: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, scopeIds: ['s'], authenticatedAt: 1, expiresAt: 10_000 };
  let approved = false, consent = true, dns = 0, tokens = 0;
  const deps: HubFetchDependencies = { client: f.app, scopeId: 's', hubId: hub.keyId, store,
    approvals: { admit: async () => { if (!approved) throw Object.assign(new Error(), { code: 'EFFECT_APPROVAL_REQUIRED' }); } },
    sessions: { verifySession: async () => ({ principal, session }), isSessionActive: async () => true, revoke: async () => undefined },
    authorization: new OperationPolicyAuthorization({ load: async () => ({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
      { id: 'network', effect: 'allow', principals: 'all', scopes: ['s'], actions: ['execute'], resource: { kind: 'operation', ids: ['network.hub'] } }] }) }),
    clock: { sample: () => ({ wallMs: 1000, monotonicMs: 1000 }) }, commandId: randomUUID,
    firstUse: async current => { if (!consent) throw Object.assign(new Error(), { code: 'HUB_FIRST_USE_REQUIRED' }); return { scopeId: 's', hubId: current.hubId,
      sourceRevision: current.revision, endpoint: current.endpoint, person: { issuer: 'test', subject: 'person' }, receiptDigest: 'a'.repeat(64) }; },
    accessToken: async () => { tokens++; return 'synthetic-test-token'; },
    transport: { resolve: async () => { dns++; return ['127.0.0.1']; }, connect: () => { throw new Error('private addresses must not connect'); } } };
  return { ...f, deps, records, approve: () => { approved = true; }, revokeConsent: () => { consent = false; }, counts: () => ({ dns, tokens }) };
}
it('sends no DNS/token/network before both the durable person card and generic effect approval (G41)', async () => {
  const f = await setup(), fetch = createGovernedHubFetch(f.deps);
  await expect(fetch('https://hub.invalid/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'EFFECT_APPROVAL_REQUIRED' });
  expect(f.counts()).toEqual({ dns: 0, tokens: 0 }); expect(f.records.size).toBe(0);
  f.approve(); f.revokeConsent();
  await expect(fetch('https://hub.invalid/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'HUB_FIRST_USE_REQUIRED' });
  expect(f.counts()).toEqual({ dns: 0, tokens: 0 }); expect(f.records.size).toBe(0);
});
it('records intent before DNS, keeps bearer material outside audit, refuses private DNS and never sends again on replay', async () => {
  const f = await setup(); f.approve();
  const fetch = createGovernedHubFetch({ ...f.deps, commandId: () => 'one-request' });
  await expect(fetch('https://hub.invalid/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'EFFECT_REJECTED' });
  expect(f.counts()).toEqual({ dns: 1, tokens: 1 });
  expect(f.records.get('one-request')?.state).toBe('refused');
  expect(JSON.stringify([...f.records.values()])).not.toContain('synthetic-test-token');
  await expect(fetch('https://hub.invalid/mcp', { method: 'POST', body: '{}' })).rejects.toThrow();
  expect(f.counts()).toEqual({ dns: 1, tokens: 1 });
});
it('rechecks source removal after the approval wait before token resolution or DNS', async () => {
  const f = await setup(); f.approve(); let removed = false;
  const fetch = createGovernedHubFetch({ ...f.deps, approvals: { admit: async () => {
    if (!removed) { removed = true; await f.app.removeSource({ schemaVersion: 1, scopeId: 's', hubId: hub.keyId, commandId: 'remove-source', expectedRevision: 1 }); }
  } } });
  await expect(fetch('https://hub.invalid/mcp', { method: 'POST', body: '{}' })).rejects.toThrow();
  expect(f.counts()).toEqual({ dns: 0, tokens: 0 });
});

it('refresh uses the governed MCP fetch and preserves both approval gates before private-DNS refusal (H5/G41)', async () => {
  const f = await setup(), current = (await f.app.listSources({ schemaVersion: 1, scopeId: 's' }))[0]!;
  const reader = governedHubRevocationReader(f.deps, 'test.invalid/hub');
  await expect(reader(current, 0, new AbortController().signal)).rejects.toThrow();
  expect(f.counts()).toEqual({ dns: 0, tokens: 0 }); expect(f.records.size).toBe(0);
  f.approve();
  await expect(reader(current, 0, new AbortController().signal)).rejects.toThrow();
  expect(f.counts()).toEqual({ dns: 1, tokens: 1 });
  expect([...f.records.values()].every(row => row.state === 'refused')).toBe(true);
  f.revokeConsent();
  await expect(reader(current, 0, new AbortController().signal)).rejects.toThrow();
  expect(f.counts()).toEqual({ dns: 1, tokens: 1 });
});

it('H7 person Hub steps refuse MCP and missing TTY witness before inspecting a project or opening storage', async () => {
  const { executeConfiguredHub } = await import('#composition/core/hub/index.js');
  const { withMcpPrincipal } = await import('#adapters/core/local-principal/index.js');
  const request = { operation: 'hub.sources.add' as const, input: { ...source, trustPolicy: 'publisher-pinned' } };
  let attestations = 0;
  const witness = { attest: async () => { attestations++; return true; } };
  await expect(withMcpPrincipal(() => executeConfiguredHub('/does-not-exist/h7', request, {}, { witness }))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(attestations).toBe(0);
  await expect(executeConfiguredHub('/does-not-exist/h7', request, {}, { witness: { attest: async () => false } })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
});


it('H7 remote operations share the first-use/effect boundary and never start network without its person decision', async () => {
  const { governedHubOperations } = await import('#adapters/core/hub-http/index.js');
  const f = await setup(), current = (await f.app.listSources({ schemaVersion: 1, scopeId: 's' }))[0]!;
  f.approve(); f.revokeConsent();
  const remote = governedHubOperations(f.deps, 'test.invalid/hub');
  await expect(remote({ operation: 'hub.search', input: { schemaVersion: 1, scopeId: 's', hubId: hub.keyId, after: '', limit: 1 } }, current, new AbortController().signal)).rejects.toThrow();
  expect(f.counts()).toEqual({ dns: 0, tokens: 0 }); expect(f.records.size).toBe(0);
});
