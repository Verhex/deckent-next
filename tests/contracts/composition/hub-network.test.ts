import { governedHubRevocationReader } from '#adapters/core/hub-http/index.js';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { createGovernedHubFetch, type HubFetchDependencies } from '#composition/core/hub/index.js';
import { OperationPolicyAuthorization, type EffectStore } from '#engine/index.js';
import { type EffectRecord } from '#domain/index.js';
import { HUB_LIMITS } from '#domain/index.js';
import { fixture, source, hub } from '../../fixtures/hub-client.js';
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup(local = false) {
  const f = await fixture(); roots.push(f.root); await f.app.addSource({ ...source, endpoint: local ? 'http://hub.invalid/mcp' : 'https://hub.invalid/mcp', local });
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
  const g = await setup(true); g.approve();
  const local = (await g.app.listSources({ schemaVersion: 1, scopeId: 's' }))[0]!;
  let answer: Record<string, unknown> = { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } };
  let discovery: Record<string, unknown> = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
  const governed = governedHubOperations({ ...g.deps, accessToken: async () => undefined, transport: {
    resolve: async () => ['127.0.0.1'], connect: () => {
      let bytes = '', sent = false;
      const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) {
        bytes += String(chunk); callback();
        const end = bytes.indexOf('\r\n\r\n'), length = Number(/content-length: (\d+)/i.exec(bytes)?.[1] ?? 0);
        if (sent || end < 0 || Buffer.byteLength(bytes.slice(end + 4)) < length) return;
        sent = true;
        const request = JSON.parse(bytes.slice(end + 4)) as { id: string | number; method: string };
        const result = request.method === 'server/discover' ? discovery
          : request.method === 'tools/list' ? { tools: [], ttlMs: 0, cacheScope: 'private' } : answer;
        const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete', ...result } });
        queueMicrotask(() => { socket.push(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); socket.push(null); });
      } });
      queueMicrotask(() => socket.emit('connect')); return socket;
    },
  } }, 'test.invalid/hub');
  const call = () => governed({ operation: 'hub.publish', input: { schemaVersion: 1, scopeId: 's', hubId: hub.keyId, commandId: randomUUID(), input: { bundle: {} } } }, local, new AbortController().signal);
  expect(await call()).toEqual({ ok: true });
  // Whole wire message: envelope/jsonrpc/id + result/resultType/content/text block/type/text/padding + 16373 leaves = 16383.
  answer = { content: [{ type: 'text', text: 'ok' }], padding: Array(16373).fill(null) };
  expect(await call()).toEqual([{ type: 'text', text: 'ok' }]);
  answer = { content: Array.from({ length: 16384 }, () => ({})) };
  await expect(call()).rejects.toMatchObject({ code: 'HUB_NETWORK_INVALID' });
  answer = { content: [{ type: 'text', text: 'ok' }], padding: Array(16373).fill(null) };
  (answer['padding'] as null[]).push(null);
  await expect(call()).rejects.toMatchObject({ code: 'HUB_NETWORK_INVALID' });
  answer = { content: Array.from({ length: 100000 }, () => ({})), structuredContent: { ok: true } };
  await expect(call()).rejects.toMatchObject({ code: 'HUB_NETWORK_INVALID' });
  let nested: unknown = null;
  for (let depth = 0; depth < 30; depth++) nested = [nested];
  answer = { content: [{ type: 'text', text: 'ok' }], padding: nested };
  expect(await call()).toEqual([{ type: 'text', text: 'ok' }]); // Leaf at full-message depth 32 is allowed.
  answer['padding'] = [nested]; // Depth 33 is refused even with few nodes.
  await expect(call()).rejects.toMatchObject({ code: 'HUB_NETWORK_INVALID' });
  answer = { content: [{}] };
  await expect(call()).rejects.toMatchObject({ code: 'INVALID_RESULT' }); // Small malformed content still reaches the SDK validator.
  // Discovery validates its own schema before Protocol takes ownership; it must traverse the same guard.
  discovery = { supportedVersions: Array.from({ length: 100000 }, () => ({})), capabilities: {} };
  await expect(call()).rejects.toMatchObject({ code: 'HUB_NETWORK_INVALID' });
  expect([...g.records.values()].every(row => row.state === 'settled')).toBe(true);
  discovery = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
  answer = { content: [{ type: 'text', text: 'x'.repeat(HUB_LIMITS.httpMaxBytes) }] };
  await expect(call()).rejects.toMatchObject({ code: 'HUB_NETWORK_INVALID' });
  expect([...g.records.values()].at(-1)?.state).toBe('unknown'); // Oversized HTTP response is not a settled business effect.
  discovery = { supportedVersions: ['2026-07-28'], capabilities: {}, instructions: 'x'.repeat(HUB_LIMITS.httpMaxBytes) };
  await expect(call()).rejects.toMatchObject({ code: 'HUB_NETWORK_INVALID' });
  expect([...g.records.values()].at(-1)?.state).toBe('unknown');
});
