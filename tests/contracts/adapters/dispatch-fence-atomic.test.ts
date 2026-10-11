import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { RunApplication, RunLifecycleApplication, AuditApplication, LostDispatchApplication, encodeLostDispatchWrite, type LostDispatchWrite, type LostDispatchAudit } from '#engine/index.js';
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
async function fixture(granted = true) {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-fence-atomic-')); roots.push(root);
  const path = join(root, 'ledger.db'), store = await open(path);
  const identity = { scopeId: 's', runId: 'run', taskId: 'task', attemptId: 'attempt', layoutRevision: 'layout', generation: 1 };
  await admitRunAttempts(store, [identity]);
  const claim = { request: { protocolVersion: 1 as const, identity, workspace: root, argv: ['fixture'] }, owner: 'owner' };
  await store.claimDispatch(dispatchAdmission(claim)); if (granted) await grantTestLaunch(store, claim);
  const attempt = (await store.load('s', 'attempt'))!, run = (await store.loadRun('s', 'run'))!;
  const { write, commandId, command } = encodeLostDispatchWrite({ schemaVersion: 1, identity, owner: claim.owner,
    actor: custodyPrincipal, reasonCode: 'WORKER_LOST', now: 10,
    expectedRunRevision: run.revision, expectedAttemptRevision: attempt.revision });
  const audit: LostDispatchAudit = (target, snapshot) => new AuditApplication(target, integrity).record({ schemaVersion: 1,
    eventId: commandId, scopeId: 's', principal: { issuer: write.actor.issuer, subject: write.actor.subject },
    policyRevision: 'fixture-policy', atMs: write.now, subject: { kind: 'run-lifecycle', action: 'hold',
      runId: 'run', taskId: 'task', commandId, revision: snapshot.revision, evidence: null,
      inputDigest: createHash('sha256').update(command).digest('hex') } });
  return { path, store, claim, attempt, run, write, commandId, audit };
}
async function unchanged(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.store.load('s', 'attempt')).toEqual(f.attempt);
  expect(await f.store.loadRun('s', 'run')).toEqual(f.run);
  expect(await f.store.receipt('s', f.commandId)).toBeNull();
  expect(await f.store.loadRunReceipt('s', f.commandId)).toBeNull();
  const raw = new DatabaseSync(f.path);
  try { expect(raw.prepare('SELECT count(*) AS n FROM audit_events').get()?.n).toBe(0); } finally { raw.close(); }
}

it('commits both revisions, both immutable receipts and a verifiable audit together, including restart', async () => {
  const f = await fixture();
  const receipt = await f.store.fenceLostDispatch(f.write, f.audit);
  const attempt = (await f.store.load('s', 'attempt'))!;
  expect(attempt.revision).toBe(f.attempt.revision + 1);
  expect(attempt.lastObservation).toMatchObject({ eventId: f.commandId, result: { kind: 'unknown' } });
  expect(receipt.snapshot.revision).toBe(f.run.revision + 1);
  expect(receipt.snapshot.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  expect((await f.store.receipt('s', f.commandId))?.command).toBe(receipt.command);
  expect((await f.store.readPoolHold('fixture-pool')).occupancy).toEqual({ execution: 1, inFlight: 1 });
  const raw = new DatabaseSync(f.path);
  try {
    const sealed = JSON.parse(String(raw.prepare('SELECT record FROM audit_events').get()?.record));
    expect(verifyAuditRecord(sealed, integrity)).toEqual(sealed);
    expect(sealed.event.subject).toMatchObject({ taskId: 'task', commandId: f.commandId, revision: receipt.snapshot.revision });
  } finally { raw.close(); }
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = await open(f.path);
  expect(await reopened.load('s', 'attempt')).toEqual(attempt);
  expect(await reopened.loadRun('s', 'run')).toEqual(receipt.snapshot);
  expect(await reopened.fenceLostDispatch({ ...f.write, now: 99 }, () => { throw new Error('replay must not audit'); })).toEqual(receipt);
  expect((await reopened.readPoolHold('fixture-pool')).occupancy).toEqual({ execution: 1, inFlight: 1 });
});

it.each(['expectedRunRevision', 'expectedAttemptRevision', 'owner'] as const)('rejects stale %s without partial persistence', async key => {
  const f = await fixture(), write: LostDispatchWrite = { ...f.write, [key]: key === 'owner' ? 'foreign' : f.write[key] + 1 };
  await expect(f.store.fenceLostDispatch(write, f.audit)).rejects.toMatchObject({ code: 'DISPATCH_CONFLICT' });
  await unchanged(f);
});
it.each(['runId', 'taskId', 'attemptId', 'layoutRevision', 'generation'] as const)('rejects foreign Attempt %s without any fence', async key => {
  const f = await fixture(), identity = { ...f.write.identity, [key]: key === 'generation' ? 2 : 'foreign' };
  await expect(f.store.fenceLostDispatch({ ...f.write, identity }, f.audit)).rejects.toThrow();
  await unchanged(f);
});
it('requires actor scope and an admitted launch; missing audit cannot install a fence', async () => {
  const f = await fixture(false);
  await expect(f.store.fenceLostDispatch(f.write, f.audit)).rejects.toMatchObject({ code: 'DISPATCH_CONFLICT' });
  await expect(f.store.fenceLostDispatch({ ...f.write, actor: { ...custodyPrincipal, scopeIds: ['other'] } }, f.audit))
    .rejects.toMatchObject({ code: 'DISPATCH_NOT_ADMITTED' });
  await expect(f.store.fenceLostDispatch(f.write, undefined as unknown as LostDispatchAudit)).rejects.toMatchObject({ code: 'DISPATCH_NOT_ADMITTED' });
  await unchanged(f);
});
it('rejects a definitive terminal instead of turning completed work into unknown', async () => {
  const f = await fixture(); await f.store.finishDispatch(f.claim, { handle: 'worker', exitCode: 0, interrupted: null });
  const attempt = (await f.store.load('s', 'attempt'))!, run = (await f.store.loadRun('s', 'run'))!;
  await expect(f.store.fenceLostDispatch({ ...f.write, expectedRunRevision: run.revision, expectedAttemptRevision: attempt.revision }, f.audit))
    .rejects.toMatchObject({ code: 'DISPATCH_CONFLICT' });
  expect(await f.store.load('s', 'attempt')).toEqual(attempt);
  expect(await f.store.receipt('s', f.commandId)).toBeNull();
});
it.each(['throw', 'wrong-event', 'unpersisted'] as const)('rolls back on %s audit callback failure', async mode => {
  const f = await fixture();
  await expect(f.store.fenceLostDispatch(f.write, (target, snapshot) => {
    if (mode === 'throw') throw new Error('audit unavailable');
    const record = f.audit(target, snapshot);
    if (mode === 'wrong-event') return { ...record, event: { ...record.event, eventId: 'foreign' } };
    // Return a well-formed sealed-looking record whose exact bytes were never persisted.
    return { ...record, mac: '0'.repeat(64) };
  })).rejects.toThrow();
  await unchanged(f);
});
it.each(['attempts', 'runs', 'audit_events', 'attempt_receipts', 'run_receipts'])('rolls back every earlier write if %s persistence fails', async table => {
  const f = await fixture(), raw = new DatabaseSync(f.path);
  try { raw.exec(`CREATE TRIGGER fault BEFORE ${['attempts', 'runs'].includes(table) ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture fault'); END`); }
  finally { raw.close(); }
  await expect(f.store.fenceLostDispatch(f.write, f.audit)).rejects.toThrow();
  await unchanged(f);
});
it('keeps the first receipt immutable and rejects a changed reason on replay', async () => {
  const f = await fixture(), receipt = await f.store.fenceLostDispatch(f.write, f.audit);
  await expect(f.store.fenceLostDispatch({ ...f.write, reasonCode: 'different' }, f.audit)).rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
  expect(await f.store.loadRunReceipt('s', f.commandId)).toEqual(receipt);
});
it('detects a missing Attempt receipt on replay rather than reporting a partial fence as success', async () => {
  const f = await fixture(); await f.store.fenceLostDispatch(f.write, f.audit);
  const raw = new DatabaseSync(f.path);
  try { raw.prepare('DELETE FROM attempt_receipts WHERE command_id=?').run(f.commandId); } finally { raw.close(); }
  await expect(f.store.fenceLostDispatch(f.write, f.audit)).rejects.toMatchObject({ code: 'DISPATCH_CORRUPT' });
});
it('authenticates and authorizes before reading/observing; unknown yields hold-manual and replay never observes twice', async () => {
  const f = await fixture(); let observations = 0, authorizations = 0, clock = 10;
  const application = new LostDispatchApplication(f.store, { async verify() { return custodyPrincipal; } },
    { async authorizeIdentity(action, identity, actor) { authorizations++; expect(action).toBe('reconcile'); expect(identity).toEqual(f.write.identity); expect(actor).toEqual(custodyPrincipal); } },
    { async observe(record) { observations++; expect(record.owner).toBe(f.claim.owner); return { handle: 'worker', result: { kind: 'unknown', reasonCode: 'WORKER_LOST' } }; } },
    target => new AuditApplication(target, integrity), 'fixture-policy', () => clock);
  const input = { schemaVersion: 1, identity: f.write.identity, expectedRunRevision: f.run.revision, expectedAttemptRevision: f.attempt.revision };
  const result = await application.fence(input); expect(result.decision).toEqual({ kind: 'hold-manual', reason: 'termination-required' });
  clock = 99; expect(await application.fence(input)).toEqual(result);
  expect(observations).toBe(1); expect(authorizations).toBe(2);
  expect((await f.store.readPoolHold('fixture-pool')).occupancy).toEqual({ execution: 1, inFlight: 1 });
  expect((await f.store.loadRun('s', 'run'))?.bindings).toHaveLength(1);
});
it('does not read custody after policy refusal or accept caller termination/manual release fields', async () => {
  const f = await fixture(); let reads = 0;
  const application = new LostDispatchApplication({ fenceLostDispatch: f.store.fenceLostDispatch.bind(f.store),
    loadRunReceipt: f.store.loadRunReceipt.bind(f.store), receipt: f.store.receipt.bind(f.store), async loadBoundDispatch() { reads++; return null; } },
  { async verify() { return custodyPrincipal; } }, { async authorizeIdentity() { throw new Error('POLICY_DENIED'); } },
  { async observe() { throw new Error('must not observe'); } }, target => new AuditApplication(target, integrity), 'fixture-policy', () => 10);
  const input = { schemaVersion: 1, identity: f.write.identity, expectedRunRevision: f.run.revision, expectedAttemptRevision: f.attempt.revision };
  await expect(application.fence(input)).rejects.toThrow('POLICY_DENIED'); expect(reads).toBe(0);
  await expect(application.fence({ ...input, proof: { pid: 1 }, action: 'release' })).rejects.toThrow();
  await unchanged(f);
});

it.each(['hold', 'close', 'resume', 'cancel'] as const)('refuses admitted public run %s under the fence namespace before any row write', async action => {
  const f = await fixture();
  // The test principal has the card's run-command authority; the assertion keeps the hostile command unchanged.
  const verifier = { async verify() { return custodyPrincipal; } }, authorization = { async authorize() {} };
  const command = { schemaVersion: 1, commandId: f.commandId, scopeId: 's', runId: 'run', expectedRevision: f.run.revision, action, ...(action === 'hold' ? { holdReason: 'operator hold' } : {}) };
  const operation = action === 'cancel' ? new RunApplication(f.store, verifier, authorization).execute(command)
    : new RunLifecycleApplication(f.store, verifier, authorization, { async authorize() {} }, target => new AuditApplication(target, integrity), () => 10, 1000, 'fixture-policy').execute(command);
  await expect(operation).rejects.toMatchObject({ code: 'COMMAND_ID_RESERVED' });
  await unchanged(f);
});
it.each(['run_receipts', 'attempt_receipts'])('reports a foreign %s fence row as conflict and never fences reader writes', async table => {
  const f = await fixture(), raw = new DatabaseSync(f.path);
  try { raw.prepare(`INSERT INTO ${table}(scope_id,command_id,command,snapshot) VALUES(?,?,?,?)`).run('s', f.commandId,
    JSON.stringify({ operation: 'client-hold', commandId: f.commandId }), JSON.stringify(table === 'run_receipts' ? f.run : f.attempt)); } finally { raw.close(); }
  await expect(f.store.fenceLostDispatch(f.write, f.audit)).rejects.toMatchObject({ code: 'DISPATCH_FENCE_CONFLICT' });
  await expect(f.store.finishDispatch(f.claim, { handle: 'worker', exitCode: 0, interrupted: null })).rejects.toMatchObject({ code: 'DISPATCH_FENCE_CONFLICT' });
  expect(await f.store.loadRun('s', 'run')).toEqual(f.run); expect(await f.store.load('s', 'attempt')).toEqual(f.attempt);
  expect((await f.store.readPoolHold('fixture-pool')).occupancy).toEqual({ execution: 1, inFlight: 1 });
});
it('detects a deleted audit on fence replay and every late writer', async () => {
  const f = await fixture(); await f.store.fenceLostDispatch(f.write, f.audit);
  const raw = new DatabaseSync(f.path); try { raw.exec('DROP TRIGGER audit_events_no_delete'); raw.prepare('DELETE FROM audit_events WHERE event_id=?').run(f.commandId); } finally { raw.close(); }
  await expect(f.store.fenceLostDispatch(f.write, f.audit)).rejects.toMatchObject({ code: 'DISPATCH_CORRUPT' });
  await expect(f.store.finishDispatch(f.claim, { handle: 'worker', exitCode: 0, interrupted: null })).rejects.toMatchObject({ code: 'DISPATCH_CORRUPT' });
});
