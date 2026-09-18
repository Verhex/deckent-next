import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { RunApplication, RunCancellationCoordinator, PolicyAuthorizationError } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission } from '../support/custody.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('bounds concurrent deliveries and reports each failure without skipping siblings or exposing private errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-cancel-coordinator-')); roots.push(root);
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'allow', custodyProfiles); stores.push(store);
  const identities = ['a', 'b', 'c', 'd', 'e'].map(id => ({ runId: 'r', scopeId: 's', taskId: id, attemptId: id, layoutRevision: 'l', generation: 1 }));
  await admitRunAttempts(store, identities);
  for (const identity of identities.slice(0, 4)) await store.claimDispatch(dispatchAdmission({ owner: 'w', request: { protocolVersion: 1, identity, workspace: '/private', argv: ['secret'] } }));
  const app = new RunApplication(store, { async verify() { return { id: 'u', issuer: 'host', subject: '1', assurance: 'os-user', scopeIds: ['s'] }; } }, { async authorize() {} });
  let now = 100; let deniedBeforeClaim = false;
  let active = 0; let peak = 0; const visited: string[] = [];
  const coordinator = new RunCancellationCoordinator(app, store, { async authorizeCancellation() { if (deniedBeforeClaim) throw new PolicyAuthorizationError('POLICY_DENIED'); }, async cancel(request) {
    const input = request as { identity: { attemptId: string } }; const id = input.identity.attemptId; visited.push(id); active++; peak = Math.max(peak, active);
    try {
      await sleep(5);
      if (id === 'b') throw new PolicyAuthorizationError('POLICY_DENIED');
      if (id === 'c') throw new Error('/private secret');
      return { kind: 'unresolved' as const, record: (await store.loadCancellationDispatch(identities.find(i => i.attemptId === id)!))! };
    } finally { active--; }
  } }, { maxConcurrentDeliveries: 2, maxAttempts: 3, retryDelayMs: 10, claimTtlMs: 1000 }, { now: () => now, token: randomUUID });
  const report = await coordinator.cancel({ schemaVersion: 1, action: 'cancel', commandId: 'cancel', scopeId: 's', runId: 'r', expectedRevision: 1 });
  expect(peak).toBe(2); expect(visited.sort()).toEqual(['a', 'b', 'c', 'd']);
  expect(report.outcomes.map(o => o.status)).toEqual(['unresolved', 'denied', 'unavailable', 'unresolved', 'not-dispatched']);
  expect(JSON.stringify(report)).not.toContain('secret'); expect((await store.loadRun('s', 'r'))!.cancelRequested).toBe(true);
  const replayCommand = { schemaVersion: 1, action: 'cancel', commandId: 'cancel', scopeId: 's', runId: 'r', expectedRevision: 1 };
  const beforeRetry = await coordinator.cancel(replayCommand);
  expect(visited).toHaveLength(4); expect(beforeRetry.outcomes[0]?.delivery).toMatchObject({ attempts: 1, state: 'queued', nextEligibleAt: 110 });
  deniedBeforeClaim = true; now = 110;
  const denied = await coordinator.cancel(replayCommand); expect(denied.outcomes[0]?.status).toBe('denied'); expect(visited).toHaveLength(4);
  deniedBeforeClaim = false;
  const retried = await coordinator.cancel(replayCommand); expect(visited).toHaveLength(8); expect(retried.outcomes[0]?.delivery?.attempts).toBe(2);
  await expect(store.loadCancellationDispatch({ ...identities[0]!, generation: 2 })).rejects.toThrow('RUN_STORE_CONFLICT');
});
