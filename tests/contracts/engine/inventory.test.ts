import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { createAttempt, requestAttemptCancellation } from '#domain/index.js';
import { DispatchInventoryApplication, DispatchInventoryPolicyAuthorization } from '#engine/index.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-inventory-')); roots.push(root);
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }); stores.push(store);
  for (const scopeId of ['s', 'other']) for (const attemptId of ['a', 'b', 'c']) {
    const identity = { runId: 'r', taskId: 't', attemptId, scopeId, layoutRevision: 'l', generation: 1 };
    await store.commit({ commandId: attemptId, command: 'admit', expectedRevision: null, snapshot: createAttempt(identity) });
    const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity, workspace: '/private/path', argv: ['tool', 'private-token'] } };
    await store.claimDispatch(claim);
    if (attemptId === 'b') await store.finishDispatch(claim, { handle: 'container', exitCode: 0, interrupted: false });
    if (attemptId === 'c') await store.commit({ commandId: 'cancel-c', command: 'cancel', expectedRevision: 0, snapshot: requestAttemptCancellation(createAttempt(identity), 0) });
  }
  return store;
}
it('pages only the admitted scope with truthful output flags and no argv/workspace leakage', async () => {
  const store = await fixture(); const query = { schemaVersion: 1 as const, scopeId: 's', after: null, limit: 2 };
  const first = await store.listDispatches(query); expect(first.entries.map(x => x.identity.attemptId)).toEqual(['a', 'b']); expect(first.nextAfter).toBe('b');
  expect(first.entries[0]!.terminal).toBeNull(); expect(first.entries[1]!.outputRecorded).toBe(false);
  const second = await store.listDispatches({ ...query, after: first.nextAfter });
  expect(second.entries.map(x => x.identity.attemptId)).toEqual(['c']); expect(second.entries[0]!.cancellationRequested).toBe(true); expect(second.nextAfter).toBeNull();
  const encoded = JSON.stringify([first, second]); expect(encoded).not.toContain('private-token'); expect(encoded).not.toContain('/private/path'); expect(encoded).not.toContain('other');
});
it('enforces explicit page budget, authentication and scope inspection policy before storage access', async () => {
  const store = await fixture(); let reads = 0; let allowed = true;
  const reader = { async listDispatches(query: Parameters<typeof store.listDispatches>[0]) { reads++; return store.listDispatches(query); } };
  const principal = { id: 'user', issuer: 'host', subject: '1', assurance: 'os-user', scopeIds: ['s'] };
  const verifier = { async verify() { return principal; } };
  const policy = new DispatchInventoryPolicyAuthorization({ async load() { return { schemaVersion: 1, revision: 'p', restrictions: [], grants: allowed ? [
    { id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: 'host', subject: '1' }], resource: { kind: 'scope', ids: ['s'] } },
  ] : [] }; } });
  const app = new DispatchInventoryApplication(reader, verifier, policy, 2);
  const query = { schemaVersion: 1, scopeId: 's', after: null, limit: 2 };
  await expect(app.inspect({ ...query, limit: 3 })).rejects.toThrow('DISPATCH_INVENTORY_LIMIT');
  await expect(app.inspect({ ...query, scopeId: 'other' })).rejects.toThrow('AUTHENTICATION_SCOPE_DENIED'); expect(reads).toBe(0);
  expect((await app.inspect(query)).entries).toHaveLength(2); expect(reads).toBe(1);
  allowed = false; await expect(app.inspect(query)).rejects.toThrow('POLICY_DENIED'); expect(reads).toBe(1);
});
