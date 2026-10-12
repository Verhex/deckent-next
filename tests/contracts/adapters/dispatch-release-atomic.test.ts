import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { projectMonitorRun, dispatchReleaseReceiptId, projectRunView, AuditApplication, LostDispatchApplication, encodeLostDispatchWrite, type LostDispatchAudit } from '#engine/index.js';
import { verifyAuditRecord } from '#engine/core/audit/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, custodyPrincipal, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = [], stores: SqliteAttemptStore[] = [];
const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const };
const timing = { now: () => 10, timeoutMs: 1000 };
const integrity = createHmacIntegrity('fixture', Buffer.alloc(32, 7));
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function open(path: string) {
  const store = await openSqliteAttemptStore(path, options, timing, 'allow', custodyProfiles); stores.push(store); return store;
}
async function fixture(granted = true, siblings = false) {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-fence-atomic-')); roots.push(root);
  const path = join(root, 'ledger.db'), store = await open(path);
  const identity = { scopeId: 's', runId: 'run', taskId: 'task', attemptId: 'attempt', layoutRevision: 'layout', generation: 1 };
  const siblingIdentity = { ...identity, taskId: 'sibling', attemptId: 'sibling-attempt' };
  await admitRunAttempts(store, siblings ? [identity, siblingIdentity] : [identity]);
  const claim = { request: { protocolVersion: 1 as const, identity, workspace: root, argv: ['fixture'] }, owner: 'owner' };
  await store.claimDispatch(dispatchAdmission(claim)); if (granted) await grantTestLaunch(store, claim);
  const worker = { kind: 'container' as const, id: 'a'.repeat(64), startedAt: '2026-10-11T01:00:00.000000001Z' };
  await store.retainDispatchWorker(claim, worker);
  const sibling = { request: { ...claim.request, identity: siblingIdentity }, owner: 'sibling-owner' };
  if (siblings) { await store.claimDispatch(dispatchAdmission(sibling)); await grantTestLaunch(store, sibling); }
  const attempt = (await store.load('s', 'attempt'))!, run = (await store.loadRun('s', 'run'))!;
  const { write, commandId, command } = encodeLostDispatchWrite({ schemaVersion: 1, identity, owner: claim.owner,
    actor: custodyPrincipal, reasonCode: 'WORKER_LOST', now: 10,
    expectedRunRevision: run.revision, expectedAttemptRevision: attempt.revision });
  const audit: LostDispatchAudit = (target, snapshot) => new AuditApplication(target, integrity).record({ schemaVersion: 1,
    eventId: commandId, scopeId: 's', principal: { issuer: write.actor.issuer, subject: write.actor.subject },
    policyRevision: 'fixture-policy', atMs: write.now, subject: { kind: 'run-lifecycle', action: 'hold',
      runId: 'run', taskId: 'task', commandId, revision: snapshot.revision, evidence: null,
      inputDigest: createHash('sha256').update(command).digest('hex') } });
  return { path, store, claim, sibling, worker, attempt, run, write, commandId, audit };
}

async function fenced() { const f = await fixture(); await f.store.fenceLostDispatch(f.write, f.audit); return f; }
async function input(f: Awaited<ReturnType<typeof fixture>>, store = f.store) {
  return { schemaVersion: 1, identity: f.write.identity, expectedRunRevision: (await store.loadRun('s', 'run'))!.revision, expectedAttemptRevision: (await store.load('s', 'attempt'))!.revision };
}
function application(f: Awaited<ReturnType<typeof fixture>>, termination: NonNullable<import('#engine/index.js').LostDispatchObserver['termination']>, store = f.store) {
  return new LostDispatchApplication(store, { async verify() { return custodyPrincipal; } }, { async authorizeIdentity() {} },
    { async observe() { throw new Error('fence replay must not observe'); }, termination }, target => new AuditApplication(target, integrity), 'fixture-policy', () => 20);
}
it.each(['supervisor-exit', 'worker-absent'] as const)('releases real occupancy only with %s; restart/reopen remains 0/0 and late terminal stays fenced', async kind => {
  const f = await fenced(), before = (await f.store.readPoolHold('fixture-pool')).occupancy;
  const attempt = await f.store.load('s', 'attempt'); let observations = 0;
  const app = application(f, async record => { observations++; expect(record.worker).toEqual(f.worker);
    return kind === 'worker-absent' ? { kind, worker: f.worker } : { kind, worker: f.worker, result: { exitCode: 1 } }; });
  const released = await app.recover(await input(f));
  expect(released.decision.kind).toBe('release');
  expect(released.receipt.snapshot.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true, workerCustody: { state: 'released', basis: 'termination-proof' } });
  expect(released.receipt.snapshot.bindings).toEqual(f.run.bindings.map(binding => ({ ...binding, observedKind: 'unknown', observedRevision: f.attempt.revision + 1 })));
  expect(await f.store.load('s', 'attempt')).toEqual(attempt);
  const after = (await f.store.readPoolHold('fixture-pool')).occupancy;
  expect(before).toEqual({ execution: 1, inFlight: 1 }); expect(after).toEqual({ execution: 0, inFlight: 0 });
  expect(projectRunView(released.receipt.snapshot).tasks[0]?.custodyDisposition).toBe('released');
  expect(projectMonitorRun({ run: { snapshot: released.receipt.snapshot, poolId: 'fixture-pool', admitted: true, createdAtMs: 0, attempts: [] }, approvals: [], pool: null, workers: new Map(), observedAt: 20 }).tasks[0]?.custodyDisposition).toBe('released');
  const raw = new DatabaseSync(f.path); try {
    expect(raw.prepare('SELECT count(*) AS n FROM audit_events').get()?.n).toBe(2);
    const sealed = JSON.parse(String(raw.prepare('SELECT record FROM audit_events WHERE event_id=?').get(dispatchReleaseReceiptId(f.write.identity, f.claim.owner))?.record));
    expect(verifyAuditRecord(sealed, integrity)).toEqual(sealed); expect(sealed.event.subject.action).toBe('release-worker-custody');
  } finally { raw.close(); }
  f.store.close(); stores.splice(stores.indexOf(f.store), 1); const reopened = await open(f.path);
  const replay = await application(f, async () => { throw new Error('release replay must not observe'); }, reopened).recover(await input(f, reopened));
  expect(replay).toEqual(released); expect(observations).toBe(1);
  expect((await reopened.readPoolHold('fixture-pool')).occupancy).toEqual(after);
  expect(await reopened.loadRun('s', 'run')).toEqual(released.receipt.snapshot);
  await expect(reopened.finishDispatch(f.claim, { handle: 'worker', exitCode: 0, interrupted: null })).rejects.toMatchObject({ code: 'DISPATCH_FENCED' });
  console.log(JSON.stringify({ kind, before, after, reopen: after, attemptUnchanged: true }));
});
it('without termination proof keeps real occupancy and exposes hold-manual without accepting or retrying', async () => {
  const f = await fenced(), run = (await f.store.loadRun('s', 'run'))!;
  const result = await application(f, async () => null).recover(await input(f));
  expect(result.decision).toEqual({ kind: 'hold-manual', reason: 'termination-required' });
  expect(projectRunView(run).tasks[0]?.custodyDisposition).toBe('hold-manual');
  expect(projectMonitorRun({ run: { snapshot: run, poolId: 'fixture-pool', admitted: true, createdAtMs: 0, attempts: [] }, approvals: [], pool: null, workers: new Map(), observedAt: 20 }).tasks[0]?.custodyDisposition).toBe('hold-manual');
  expect(await f.store.loadRun('s', 'run')).toEqual(run);
  expect((await f.store.readPoolHold('fixture-pool')).occupancy).toEqual({ execution: 1, inFlight: 1 });
  expect(await f.store.loadRunReceipt('s', dispatchReleaseReceiptId(f.write.identity, f.claim.owner))).toBeNull();
});
it.each(['id', 'startedAt'] as const)('refuses the wrong container %s and retains capacity', async key => {
  const f = await fenced(), run = await f.store.loadRun('s', 'run');
  await expect(application(f, async () => ({ kind: 'worker-absent', worker: { ...f.worker, [key]: key === 'id' ? 'b'.repeat(64) : '2026-10-11T02:00:00Z' } })).recover(await input(f))).rejects.toMatchObject({ code: 'RUN_ATTEMPT_CONFLICT' });
  expect(await f.store.loadRun('s', 'run')).toEqual(run); expect((await f.store.readPoolHold('fixture-pool')).occupancy).toEqual({ execution: 1, inFlight: 1 });
});
it.each(['owner', 'identity'] as const)('refuses foreign termination %s at the writer boundary', async key => {
  const f = await fenced(), run = (await f.store.loadRun('s', 'run'))!, commandId = dispatchReleaseReceiptId(f.write.identity, f.claim.owner);
  const proof = { kind: 'worker-absent' as const, identity: f.write.identity, owner: f.claim.owner, receiptId: commandId, worker: f.worker,
    ...(key === 'owner' ? { owner: 'foreign' } : { identity: { ...f.write.identity, generation: 2 } }) };
  await expect(f.store.releaseLostDispatch({ identity: f.write.identity, owner: f.claim.owner, actor: custodyPrincipal, expectedRunRevision: run.revision, now: 20, proof }, f.audit)).rejects.toMatchObject({ code: 'RUN_ATTEMPT_CONFLICT' });
  expect(await f.store.loadRun('s', 'run')).toEqual(run);
});
it.each(['runs', 'audit_events', 'run_receipts'])('rolls back the custody release if %s fails', async table => {
  const f = await fenced(), run = await f.store.loadRun('s', 'run'), raw = new DatabaseSync(f.path);
  try { raw.exec(`CREATE TRIGGER release_fault BEFORE ${table === 'runs' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture fault'); END`); } finally { raw.close(); }
  await expect(application(f, async () => ({ kind: 'worker-absent', worker: f.worker })).recover(await input(f))).rejects.toThrow();
  expect(await f.store.loadRun('s', 'run')).toEqual(run); expect((await f.store.readPoolHold('fixture-pool')).occupancy).toEqual({ execution: 1, inFlight: 1 });
  expect(await f.store.loadRunReceipt('s', dispatchReleaseReceiptId(f.write.identity, f.claim.owner))).toBeNull();
});

// The first recovery must create its own fence and use that committed revision for release.
it.each([true, false])('first unfenced recover releases only with termination evidence %s', async terminated => {
  const f = await fixture(); let observed = 0;
  const app = new LostDispatchApplication(f.store, { async verify() { return custodyPrincipal; } }, { async authorizeIdentity() {} },
    { async observe() { observed++; return { handle: 'worker', result: { kind: 'unknown', reasonCode: 'WORKER_LOST' } }; },
      async termination() { return terminated ? { kind: 'worker-absent', worker: f.worker } : null; } },
    target => new AuditApplication(target, integrity), 'fixture-policy', () => 20);
  expect(await f.store.loadRunReceipt('s', f.commandId)).toBeNull();
  const originalInput = await input(f), result = await app.recover(originalInput);
  expect(observed).toBe(1);
  expect(result.decision.kind).toBe(terminated ? 'release' : 'hold-manual');
  const run = (await f.store.loadRun('s', 'run'))!;
  expect(run.revision).toBe(f.run.revision + (terminated ? 2 : 1));
  expect(run.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  expect((await f.store.readPoolHold('fixture-pool')).occupancy).toEqual(terminated ? { execution: 0, inFlight: 0 } : { execution: 1, inFlight: 1 });
  expect(await app.recover(originalInput)).toEqual(result);
  expect(observed).toBe(1);
  const raw = new DatabaseSync(f.path);
  try { expect(raw.prepare('SELECT count(*) AS n FROM audit_events').get()?.n).toBe(terminated ? 2 : 1); } finally { raw.close(); }
});

it.each(['sibling-exit', 'sibling-fence'] as const)('recovers a replayed fence after %s advances the Run, with one durable release and reopen replay', async advance => {
  const f = await fixture(true, true); let terminated = false, observations = 0;
  const app = new LostDispatchApplication(f.store, { async verify() { return custodyPrincipal; } }, { async authorizeIdentity() {} },
    { async observe() { observations++; return { handle: 'worker', result: { kind: 'unknown', reasonCode: 'WORKER_LOST' } }; },
      async termination() { return terminated ? { kind: 'worker-absent', worker: f.worker } : null; } },
    target => new AuditApplication(target, integrity), 'fixture-policy', () => 20);
  const originalInput = await input(f), held = await app.recover(originalInput);
  expect(held.decision).toEqual({ kind: 'hold-manual', reason: 'termination-required' });
  const fenceRevision = held.receipt.snapshot.revision;
  if (advance === 'sibling-exit') await f.store.finishDispatch(f.sibling, { handle: 'sibling', exitCode: 0, interrupted: false });
  else await app.fence({ schemaVersion: 1, identity: f.sibling.request.identity,
    expectedRunRevision: fenceRevision, expectedAttemptRevision: (await f.store.load('s', 'sibling-attempt'))!.revision });
  const current = (await f.store.loadRun('s', 'run'))!, before = (await f.store.readPoolHold('fixture-pool')).occupancy;
  expect(current.revision).toBeGreaterThan(fenceRevision);
  const sibling = current.progress.find(value => value.taskId === 'sibling');
  terminated = true;
  const released = await app.recover(await input(f));
  expect(released.decision.kind).toBe('release');
  expect(released.receipt.snapshot.revision).toBe(current.revision + 1);
  expect(released.receipt.snapshot.progress.find(value => value.taskId === 'sibling')).toEqual(sibling);
  const after = { execution: before.execution - 1, inFlight: before.inFlight - 1 };
  expect((await f.store.readPoolHold('fixture-pool')).occupancy).toEqual(after);
  expect(await app.recover(originalInput)).toEqual(released);
  expect(observations).toBe(advance === 'sibling-fence' ? 2 : 1);
  f.store.close(); stores.splice(stores.indexOf(f.store), 1); const reopened = await open(f.path);
  expect(await application(f, async () => { throw new Error('release replay must not observe'); }, reopened).recover(await input(f, reopened))).toEqual(released);
  expect((await reopened.readPoolHold('fixture-pool')).occupancy).toEqual(after);
  const raw = new DatabaseSync(f.path);
  try { expect(raw.prepare('SELECT count(*) AS n FROM run_receipts WHERE scope_id=? AND command_id=?').get('s', dispatchReleaseReceiptId(f.write.identity, f.claim.owner))?.n).toBe(1); }
  finally { raw.close(); }
  console.log(JSON.stringify({ advance, fenceRevision, currentRevision: current.revision, releaseRevision: released.receipt.snapshot.revision, before, after, reopen: after }));
});

it('preserves a typed CAS refusal when a sibling advances after the fresh read but before release', async () => {
  const f = await fixture(true, true); await f.store.fenceLostDispatch(f.write, f.audit);
  const store = new Proxy(f.store, { get(target, key) {
    if (key === 'releaseLostDispatch') return async (...args: Parameters<typeof target.releaseLostDispatch>) => {
      await target.finishDispatch(f.sibling, { handle: 'sibling', exitCode: 0, interrupted: false });
      return target.releaseLostDispatch(...args);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(application(f, async () => ({ kind: 'worker-absent', worker: f.worker }), store).recover(await input(f)))
    .rejects.toMatchObject({ code: 'RUN_REVISION_CONFLICT' });
  const current = (await f.store.loadRun('s', 'run'))!;
  expect(current.progress.find(value => value.taskId === 'task')).not.toHaveProperty('workerCustody');
  expect((await f.store.readPoolHold('fixture-pool')).occupancy).toEqual({ execution: 1, inFlight: 2 });
  expect(await f.store.loadRunReceipt('s', dispatchReleaseReceiptId(f.write.identity, f.claim.owner))).toBeNull();
});
