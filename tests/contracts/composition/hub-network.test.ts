import { governedHubOperations, governedHubRevocationReader } from '#adapters/core/hub-http/index.js';
import { Client } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createGovernedHubFetch, type HubFetchDependencies } from '#composition/core/hub/index.js';
import { HubClientApplication, OperationPolicyAuthorization, type EffectStore } from '#engine/index.js';
import { type EffectRecord } from '#domain/index.js';
import { hubRevocationCursorMessage } from '#engine/core/hub/index.js';
import { HUB_LIMITS } from '#domain/index.js';
import { fixture, source, hub, feed } from '../../fixtures/hub-client.js';
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
  return { ...f, clientDependencies: f.deps, deps, records, approve: () => { approved = true; }, revokeConsent: () => { consent = false; }, counts: () => ({ dns, tokens }) };
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

  expect(() => governedHubOperations(f.deps, 'io.modelcontextprotocol/skills')).toThrow(expect.objectContaining({ code: 'HUB_NETWORK_INVALID' }));
  await expect(governedHubRevocationReader(f.deps, 'io.modelcontextprotocol/skills')(current, 0, new AbortController().signal)).rejects.toThrow(expect.objectContaining({ code: 'HUB_NETWORK_INVALID' }));
  const g = await setup(true); g.approve();
  const local = (await g.app.listSources({ schemaVersion: 1, scopeId: 's' }))[0]!;
  const cursor = { schemaVersion: 1 as const, hubId: hub.keyId, afterSequence: 0, throughSequence: 1, position: 1, throughPosition: 2,
    page: 1, issuedAtMs: 100, nextRefreshBy: 2000 };
  const next = { ...cursor, signature: { keyId: hub.keyId, algorithm: 'ed25519' as const, value: hub.sign(hubRevocationCursorMessage(cursor)).toString('base64') } };
  const first = feed({ sequence: 2, entries: [{ kind: 'package-version', id: 'acme/old@1.0.0', severity: 'yank', reason: 'old', atMs: 100 }],
    catchup: { schemaVersion: 1, afterSequence: 0, throughSequence: 1, position: 0, throughPosition: 2, page: 0, complete: false, next } });
  const last = feed({ sequence: 3, entries: [{ kind: 'package-version', id: 'acme/older@1.0.0', severity: 'revoke', reason: 'old', atMs: 100 }],
    catchup: { ...first.catchup!, position: 1, page: 1, complete: true, next: null } });
  let discoveries = 0, response: unknown = first, automatic = false;
  const continuations: unknown[] = [];
  const originalClose = Client.prototype.close, close = vi.spyOn(Client.prototype, 'close');
  const pages = governedHubRevocationReader({ ...g.deps, accessToken: async () => undefined, transport: {
    resolve: async () => ['127.0.0.1'], connect: () => {
      let bytes = '', sent = false;
      const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) {
        bytes += String(chunk); callback();
        const end = bytes.indexOf('\r\n\r\n'), length = Number(/content-length: (\d+)/i.exec(bytes)?.[1] ?? 0);
        if (sent || end < 0 || Buffer.byteLength(bytes.slice(end + 4)) < length) return;
        sent = true;
        const request = JSON.parse(bytes.slice(end + 4)) as { id: number; method: string; params?: { input?: { continuation?: unknown } } };
        let result: unknown;
        if (request.method === 'server/discover') { discoveries++; result = { supportedVersions: ['2026-07-28'], capabilities: { extensions: { 'test.invalid/hub': {} } } }; }
        else { continuations.push(request.params?.input?.continuation); result = { value: automatic ? request.params?.input?.continuation ? last : first : response }; }
        const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete', ...result as object } });
        queueMicrotask(() => { socket.push(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); socket.push(null); });
      } });
      queueMicrotask(() => socket.emit('connect')); return socket;
    },
  } }, 'test.invalid/hub');
  try {
    const aborted = new AbortController();
    expect(await pages(local, 0, aborted.signal)).toEqual(first);
    const beforeAbort = close.mock.calls.length;
    aborted.abort(); await new Promise(resolve => setImmediate(resolve));
    expect.soft(close.mock.calls.length).toBe(beforeAbort + 1);
    const fresh = new AbortController();
    expect(await pages(local, 0, fresh.signal)).toEqual(first);
    const beforeComplete = close.mock.calls.length, discoveryBefore = discoveries;
    response = last;
    expect(await pages(local, 0, fresh.signal, next)).toEqual(last);
    expect(discoveries).toBe(discoveryBefore);
    expect(continuations.at(-1)).toEqual(next);
    expect(close.mock.calls.length).toBe(beforeComplete + 1);
    response = first;
    const held = new AbortController(), beforeHeld = discoveries;
    await Promise.all([pages(local, 0, held.signal), pages(local, 0, held.signal)]);
    expect(discoveries).toBe(beforeHeld + 1);
    const beforeIndependent = close.mock.calls.length;
    response = last;
    await pages(local, 0, new AbortController().signal);
    expect(close.mock.calls.length).toBe(beforeIndependent + 1);
    held.abort(); await new Promise(resolve => setImmediate(resolve));
    expect(close.mock.calls.length).toBe(beforeIndependent + 2);
    response = first;
    const failed = new AbortController();
    await pages(local, 0, failed.signal);
    const beforeError = close.mock.calls.length;
    response = {};
    await expect(pages(local, 0, failed.signal, next)).rejects.toThrow();
    expect(close.mock.calls.length).toBe(beforeError + 1);
    response = last;
    expect(await pages(local, 0, new AbortController().signal)).toEqual(last);
    const closeFailure = new Error('synthetic close failure');
    close.mockImplementationOnce(async function (this: Client) { await originalClose.call(this); throw closeFailure; });
    await expect(pages(local, 0, new AbortController().signal)).rejects.toBe(closeFailure);
    expect(await pages(local, 0, new AbortController().signal)).toEqual(last);
    const application = new HubClientApplication({ ...g.clientDependencies, fetchRevocations: pages });
    const invalidSignature = new AbortController(), beforeInvalidSignatureClose = close.mock.calls.length;
    response = { ...first, signature: { ...first.signature, value: Buffer.alloc(64).toString('base64') } };
    try {
      await expect(application.refreshRevocations({ schemaVersion: 1, scopeId: 's', hubId: hub.keyId, commandId: 'invalid-page-signature', force: true }, undefined, invalidSignature.signal)).rejects.toMatchObject({ code: 'HUB_SIGNATURE_INVALID' });
      expect.soft(close.mock.calls.length, 'engine signature refusal closes the intermediate-page client').toBe(beforeInvalidSignatureClose + 1);
      expect(invalidSignature.signal.aborted).toBe(false);
    } finally { invalidSignature.abort(); }
    response = first;
    const writeFailure = new Error('synthetic feed write failure'), failedWrite = new AbortController();
    const failingStoreApplication = new HubClientApplication({ ...g.clientDependencies, fetchRevocations: pages, openStore: async access => {
      const store = await g.clientDependencies.openStore(access);
      store.saveFeed = async () => { throw writeFailure; };
      return store;
    } });
    const beforeFailedWriteClose = close.mock.calls.length;
    try {
      await expect(failingStoreApplication.refreshRevocations({ schemaVersion: 1, scopeId: 's', hubId: hub.keyId, commandId: 'failed-page-write', force: true }, undefined, failedWrite.signal)).rejects.toBe(writeFailure);
      expect.soft(close.mock.calls.length, 'engine persistence refusal closes the intermediate-page client').toBe(beforeFailedWriteClose + 1);
      expect(failedWrite.signal.aborted).toBe(false);
    } finally { failedWrite.abort(); }
    const beforeRetry = await g.clientDependencies.openStore('read');
    try { expect(await beforeRetry.feed('s', hub.keyId)).toBeNull(); } finally { beforeRetry.close(); }
    automatic = true;
    const beforeRefresh = discoveries, beforeRefreshClose = close.mock.calls.length;
    await application.refreshRevocations({ schemaVersion: 1, scopeId: 's', hubId: hub.keyId, commandId: 'two-page-refresh', force: true });
    expect(discoveries).toBe(beforeRefresh + 1);
    expect(close.mock.calls.length).toBe(beforeRefreshClose + 1);
    const persisted = await g.clientDependencies.openStore('read');
    try { expect(await persisted.feed('s', hub.keyId)).toEqual(last); } finally { persisted.close(); }
    expect([...g.records.values()].every(row => row.state === 'settled')).toBe(true);
  } finally { close.mockRestore(); }
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
