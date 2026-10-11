import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { applyAttemptObservation } from '#domain/index.js';
import { DispatchError, measureTaskOccupancy } from '#engine/index.js';
import { AuditApplication, encodeLostDispatchWrite, dispatchFenceReceiptId } from '#engine/index.js';
import { createHash } from 'node:crypto';
import { createHmacIntegrity } from '#platform/index.js';
import { custodyPrincipal } from '../support/custody.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const stores: SqliteAttemptStore[] = [], roots: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const };
const timing = { now: () => 10, timeoutMs: 1000 };
const terminal = { handle: 'worker', exitCode: 0, interrupted: null };
const artifact = { schemaVersion: 1 as const, scopeId: 's', digest: 'a'.repeat(64), byteLength: 1 };
async function open(path: string) {
  const store = await openSqliteAttemptStore(path, options, timing, 'allow', custodyProfiles);
  stores.push(store); return store;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-fence-')); roots.push(root);
  const path = join(root, 'ledger.db'), store = await open(path);
  const identity = { scopeId: 's', runId: 'run', taskId: 'task', attemptId: 'attempt', layoutRevision: 'layout', generation: 1 };
  await admitRunAttempts(store, [identity]);
  const claim = { request: { protocolVersion: 1 as const, identity, workspace: root, argv: ['fixture'] }, owner: 'owner' };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  return { store, path, claim };
}
/** Real audited atomic writer: no fixture receipt or separate projection. */
async function installFixtureFence(value: Awaited<ReturnType<typeof fixture>>) {
  const { store, claim } = value, identity = claim.request.identity;
  const current = (await store.load('s', 'attempt'))!, run = (await store.loadRun('s', 'run'))!;
  const { write, commandId, command } = encodeLostDispatchWrite({ schemaVersion: 1, identity, owner: claim.owner,
    actor: custodyPrincipal, expectedRunRevision: run.revision, expectedAttemptRevision: current.revision, now: 10, reasonCode: 'WORKER_LOST' });
  await store.fenceLostDispatch(write, (audit, snapshot) => new AuditApplication(audit,
    createHmacIntegrity('fixture', Buffer.alloc(32, 7))).record({ schemaVersion: 1,
      eventId: commandId, scopeId: 's', principal: { issuer: write.actor.issuer, subject: write.actor.subject },
      policyRevision: 'fixture-policy', atMs: write.now, subject: { kind: 'run-lifecycle', action: 'hold', runId: identity.runId,
        taskId: identity.taskId, commandId, revision: snapshot.revision, evidence: null,
        inputDigest: createHash('sha256').update(command).digest('hex') } }));
  return (await store.load('s', 'attempt'))!;
}
async function write(store: SqliteAttemptStore, claim: Awaited<ReturnType<typeof fixture>>['claim'], action: string) {
  if (action === 'finish') return store.finishDispatch(claim, terminal);
  if (action === 'output') return store.retainDispatchOutput(claim, artifact);
  return store.retainDispatchPatch(claim, artifact);
}

it.each(['finish', 'output', 'patch'])('rejects late %s after disk reopen without clearing unknown or capacity', async action => {
  const value = await fixture(), snapshot = await installFixtureFence(value);
  const before = await value.store.readDispatch(value.claim.request), run = (await value.store.loadRun('s', 'run'))!;
  value.store.close(); stores.splice(stores.indexOf(value.store), 1);
  const reopened = await open(value.path);
  await expect(write(reopened, value.claim, action)).rejects.toMatchObject({ name: 'DispatchError', code: 'DISPATCH_FENCED' });
  expect(await reopened.load('s', 'attempt')).toEqual(snapshot);
  expect(await reopened.loadRun('s', 'run')).toEqual(run);
  expect(measureTaskOccupancy(run.progress)).toEqual({ execution: 1, inFlight: 1 });
  expect(run.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  expect(await reopened.readDispatch(value.claim.request)).toEqual(before);
  expect((await reopened.listDispatches({ schemaVersion: 1, scopeId: 's', after: null, limit: 10 })).entries).toHaveLength(1);
});

it('rejects output replay before returning the existing artifact', async () => {
  const value = await fixture();
  await value.store.retainDispatchOutput(value.claim, artifact);
  await installFixtureFence(value);
  await expect(value.store.retainDispatchOutput(value.claim, artifact)).rejects.toMatchObject({ code: 'DISPATCH_FENCED' });
  expect((await value.store.readDispatch(value.claim.request))!.output).toEqual(artifact);
});

it.each(['finish', 'patch'])('rejects %s replay when a late terminal was retained before the fence', async action => {
  const value = await fixture(), identity = value.claim.request.identity, current = (await value.store.load('s', 'attempt'))!;
  const unknown = applyAttemptObservation(current, { protocolVersion: 1, identity, sequence: (current.lastObservation?.sequence ?? 0) + 1,
    eventId: 'earlier-lost', result: { kind: 'unknown', reasonCode: 'WORKER_LOST' } }, current.revision);
  await value.store.commit({ commandId: 'earlier-lost', command: 'fixture-lost', snapshot: unknown, expectedRevision: current.revision });
  await value.store.finishDispatch(value.claim, terminal);
  await value.store.retainDispatchPatch(value.claim, artifact);
  await installFixtureFence(value);
  const before = await value.store.readDispatch(value.claim.request);
  await expect(write(value.store, value.claim, action)).rejects.toMatchObject({ code: 'DISPATCH_FENCED' });
  expect(await value.store.readDispatch(value.claim.request)).toEqual(before);
});

it('a second SQLite writer sees a committed fence before writing a late result', async () => {
  const value = await fixture(), other = await open(value.path);
  expect((await other.readDispatch(value.claim.request))!.terminal).toBeNull();
  const snapshot = await installFixtureFence(value);
  await expect(other.finishDispatch(value.claim, terminal)).rejects.toMatchObject({ code: 'DISPATCH_FENCED' });
  expect(await other.load('s', 'attempt')).toEqual(snapshot);
});

it.each(['invalid-json', 'foreign-generation', 'wrong-event', 'non-unknown'])('fails closed on %s fence receipt corruption', async corruption => {
  const value = await fixture(), snapshot = await installFixtureFence(value);
  const foreignIdentity = { ...snapshot.identity, generation: 2 };
  const changed = corruption === 'foreign-generation' ? { ...snapshot, identity: foreignIdentity, lastObservation: { ...snapshot.lastObservation!, identity: foreignIdentity } }
    : { ...snapshot, lastObservation: { ...snapshot.lastObservation!, ...(corruption === 'wrong-event' ? { eventId: 'foreign' } : { result: { kind: 'exited', exitCode: 0 } }) } };
  const db = new DatabaseSync(value.path);
  try { db.prepare('UPDATE attempt_receipts SET snapshot=? WHERE scope_id=? AND command_id=?')
    .run(corruption === 'invalid-json' ? '{' : JSON.stringify(changed), 's', dispatchFenceReceiptId(value.claim.request.identity, value.claim.owner)); }
  finally { db.close(); }
  await expect(value.store.finishDispatch(value.claim, terminal)).rejects.toMatchObject({ name: 'DispatchError', code: 'DISPATCH_CORRUPT' });
  expect((await value.store.readDispatch(value.claim.request))!.terminal).toBeNull();
});

it('retains ordinary output, terminal and patch replay without a fence', async () => {
  const value = await fixture();
  await value.store.retainDispatchOutput(value.claim, artifact);
  await value.store.finishDispatch(value.claim, terminal);
  const first = await value.store.retainDispatchPatch(value.claim, artifact);
  expect(await value.store.retainDispatchPatch(value.claim, artifact)).toEqual(first);
  expect(await value.store.retainDispatchOutput(value.claim, artifact)).toEqual(first);
  expect(await value.store.finishDispatch(value.claim, terminal)).toEqual(first);
  expect((await value.store.load('s', 'attempt'))!.lastObservation?.result.kind).toBe('exited');
});

it('keeps custody owner immutable and rejects a foreign writer', async () => {
  const value = await fixture(); await installFixtureFence(value);
  await expect(value.store.finishDispatch({ ...value.claim, owner: 'foreign' }, terminal)).rejects.toBeInstanceOf(DispatchError);
  expect((await value.store.readDispatch(value.claim.request))!.owner).toBe(value.claim.owner);
  expect((await value.store.readDispatch(value.claim.request))!.terminal).toBeNull();
});
