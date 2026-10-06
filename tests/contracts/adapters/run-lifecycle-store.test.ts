import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { AuditApplication, type AuditStore, type RunLifecycleWrite } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { type RunSnapshot, runSnapshotSchema } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = { id: 'human', issuer: 'local-os', subject: '1000', assurance: 'os-user' as const };
const capacity = { executionSlots: 1, inFlightSlots: 1 };
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 'task', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dn-run-lifecycle-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }); stores.push(store);
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity });
  await store.createRun({ commandId: 'create', actor: { id: actor.id, issuer: actor.issuer, subject: actor.subject },
    identity: { scopeId: 's', runId: 'r', layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph), now: 1,
    policy: { schemaVersion: 2, poolId: 'pool', capacity, ordering: ['task'] } });
  const run = (await store.loadRun('s', 'r'))!, identity = { ...run.identity, taskId: 'task', attemptId: 'attempt', generation: 1 };
  const evaluating = runSnapshotSchema.parse({ ...run, progress: run.progress.map(task => ({ ...task, phase: 'evaluating' })),
    bindings: [{ identity, observedRevision: 1, observedKind: 'exited' }] });
  const raw = new DatabaseSync(path); raw.prepare('UPDATE runs SET snapshot=?').run(JSON.stringify(evaluating)); raw.close();
  const write = (action: RunLifecycleWrite['action'], extra: object = {}): RunLifecycleWrite => ({ schemaVersion: 1, commandId: action,
    scopeId: 's', runId: 'r', expectedRevision: 0, action, actor, now: 10, timeoutMs: 100, ...extra });
  const lookup = { actor: { id: actor.id, issuer: actor.issuer, subject: actor.subject }, after: null, limit: 1 };
  const park = () => store.commitRunLifecycle(write('park-task', { taskId: 'task', reason: 'evaluation-unknown' }));
  return { path, store, run, write, lookup, park };
}

it('removes parked work from discovery and reservation, exposes only its due deadline, and expires once', async () => {
  const f = await fixture(); expect((await f.store.listRunProgression(f.lookup)).items).toHaveLength(1);
  const parked = await f.park(); expect(parked.snapshot.state).toEqual({ kind: 'parked', reason: 'awaiting-decision', since: 10, deadline: 110 });
  expect((await f.store.listRunProgression(f.lookup)).items).toEqual([]);
  expect((await f.store.listRunLifecycleDue({ ...f.lookup, now: 109 })).items).toEqual([]);
  expect((await f.store.listRunLifecycleDue({ ...f.lookup, now: 110 })).items).toEqual([{ scopeId: 's', runId: 'r' }]);
  expect((await f.store.listRunLifecycleDue({ ...f.lookup, actor: { ...f.lookup.actor, subject: 'other' }, now: 110 })).items).toEqual([]);
  await expect(f.store.reserveRunTasks({ actor: f.lookup.actor, scopeId: 's', runId: 'r', commandId: 'reserve', expectedRevision: 1, now: 20,
    identities: [{ ...f.run.identity, taskId: 'task', attemptId: 'next', generation: 2 }] })).rejects.toMatchObject({ code: 'RUN_TASK_NOT_READY' });
  const expire = f.write('expire', { expectedRevision: 1, now: 110 }); const result = await f.store.commitRunLifecycle(expire);
  expect(result.snapshot.state).toEqual({ kind: 'terminal', outcome: 'failed', reason: 'park-timeout' });
  expect(result.snapshot.progress[0].phase).toBe('failed');
  expect(await f.store.commitRunLifecycle(expire)).toEqual(result);
  expect((await f.store.listRunLifecycleDue({ ...f.lookup, now: 200 })).items).toEqual([]);
});

it('does not persist empty deadline polls, and records a human resume even when dependencies still block it', async () => {
  const f = await fixture(); const parked = await f.park(); let auditCalls = 0;
  const early = f.write('expire', { expectedRevision: 1, now: 109 });
  expect((await f.store.commitRunLifecycle(early)).snapshot).toEqual(parked.snapshot);
  expect(await f.store.loadRunReceipt('s', 'expire')).toBeNull();
  const resume = f.write('resume', { expectedRevision: 1, now: 20 });
  const receipt = await f.store.commitRunLifecycle(resume, () => { auditCalls++; });
  expect(receipt.snapshot.state).toEqual(parked.snapshot.state); expect(auditCalls).toBe(1);
  expect(await f.store.loadRunReceipt('s', 'resume')).toEqual(receipt);
});

it('releases the waiting decision slot while preserving occupancy for genuinely evaluating work in another Run', async () => {
  const f = await fixture(); expect((await f.store.readPoolHold('pool')).occupancy).toEqual({ execution: 0, inFlight: 1 });
  await f.park(); expect((await f.store.readPoolHold('pool')).occupancy).toEqual({ execution: 0, inFlight: 0 });
  await f.store.createRun({ commandId: 'create-other', actor: f.lookup.actor, identity: { ...f.run.identity, runId: 'other' },
    graph, execution: fixtureExecution(graph), now: 20, policy: { schemaVersion: 2, poolId: 'pool', capacity, ordering: ['task'] } });
  const reserved = await f.store.reserveRunTasks({ commandId: 'reserve-other', actor: f.lookup.actor, scopeId: 's', runId: 'other', expectedRevision: 0, now: 20,
    identities: [{ ...f.run.identity, runId: 'other', taskId: 'task', attemptId: 'other-attempt', generation: 1 }] });
  expect(reserved.snapshot.progress[0].phase).toBe('active');
  expect((await f.store.readPoolHold('pool')).occupancy).toEqual({ execution: 1, inFlight: 1 });
});

it('commits the human principal audit and unverified acceptance atomically, with exact replay and stale fencing', async () => {
  const f = await fixture(); await f.park();
  const integrity = createHmacIntegrity('audit', new Uint8Array(32).fill(1)); let auditCalls = 0;
  const audit = (store: AuditStore, snapshot: RunSnapshot) => {
    auditCalls++;
    new AuditApplication(store, integrity).record({ schemaVersion: 1, eventId: 'decision', scopeId: 's', principal: { issuer: actor.issuer, subject: actor.subject },
      policyRevision: 'policy', atMs: 20, subject: { kind: 'run-lifecycle', action: 'accept', runId: 'r', commandId: 'accept',
        taskId: 'task', revision: snapshot.revision, evidence: 'model-unverified' } });
  };
  const write = f.write('accept', { taskId: 'task', expectedRevision: 1, now: 20 });
  await expect(f.store.commitRunLifecycle(write, () => { throw new Error('AUDIT_UNAVAILABLE'); })).rejects.toThrow('AUDIT_UNAVAILABLE');
  expect((await f.store.loadRun('s', 'r'))!.revision).toBe(1); expect(await f.store.loadRunReceipt('s', 'accept')).toBeNull();
  const accepted = await f.store.commitRunLifecycle(write, audit);
  expect(accepted.snapshot.progress[0]).toMatchObject({ phase: 'accepted', acceptedEvidence: 'model-unverified' });
  expect(await f.store.commitRunLifecycle(write, audit)).toEqual(accepted); expect(auditCalls).toBe(1);
  const db = new DatabaseSync(f.path, { readOnly: true });
  const recorded = JSON.parse(String(db.prepare('SELECT record FROM audit_events').get()?.record));
  expect(recorded.event.principal).toEqual({ issuer: actor.issuer, subject: actor.subject }); db.close();
  await expect(f.store.commitRunLifecycle({ ...write, commandId: 'stale' }, audit)).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
  expect(await f.store.commitRunLifecycle({ ...write, now: 21, timeoutMs: 200 }, audit)).toEqual(accepted);
  await expect(f.store.commitRunLifecycle({ ...write, actor: { ...actor, subject: 'someone-else' } }, audit))
    .rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
});

it('refuses agent/workload decisions and unaudited acceptance at the durable boundary', async () => {
  const f = await fixture(); await f.park(); const write = f.write('accept', { taskId: 'task', expectedRevision: 1 });
  await expect(f.store.commitRunLifecycle({ ...write, actor: { ...actor, assurance: 'workload-verified' } }, () => undefined))
    .rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
  await expect(f.store.commitRunLifecycle(write)).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
  expect((await f.store.loadRun('s', 'r'))!.progress[0].phase).toBe('awaiting-decision');
});


it('reads empty deadline polls without requesting a SQLite write lock', async () => {
  const f = await fixture(); const parked = await f.park();
  const writer = new DatabaseSync(f.path); writer.exec('BEGIN IMMEDIATE');
  try {
    const early = f.write('expire', { expectedRevision: 1, now: 109 });
    expect((await f.store.commitRunLifecycle(early)).snapshot).toEqual(parked.snapshot);
    expect(await f.store.loadRunReceipt('s', 'expire')).toBeNull();
  } finally { writer.exec('ROLLBACK'); writer.close(); }
});

it('lists only scopes registered to the installation company; foreign and unregistered scopes are skipped and surveyed with their reason', async () => {
  const f = await fixture(), own = { ...f.lookup, companyId: 'acme' };
  const raw = new DatabaseSync(f.path);
  try {
    const registered = raw.prepare('SELECT company_id FROM scope_registry WHERE scope_id=?').get('s') as { company_id: string } | undefined;
    if (registered) raw.prepare('DELETE FROM scope_registry WHERE scope_id=?').run('s');
    expect((await f.store.listRunProgression(own)).items).toEqual([]);
    expect((await f.store.listRunLifecycleDue({ ...own, now: 1 })).items).toEqual([]);
    expect(await f.store.listForeignProgressionScopes({ actor: f.lookup.actor, companyId: 'acme', limit: 8 })).toEqual([{ scopeId: 's', reason: 'unregistered' }]);
    raw.prepare('INSERT OR IGNORE INTO companies(company_id) VALUES(?)').run('other');
    raw.prepare("INSERT INTO scope_registry(scope_id,company_id,origin) VALUES('s','other','admission')").run();
    expect((await f.store.listRunProgression(own)).items).toEqual([]);
    expect(await f.store.listForeignProgressionScopes({ actor: f.lookup.actor, companyId: 'acme', limit: 8 })).toEqual([{ scopeId: 's', reason: 'foreign' }]);
    raw.prepare('INSERT OR IGNORE INTO companies(company_id) VALUES(?)').run('acme');
    raw.prepare("UPDATE scope_registry SET company_id='acme' WHERE scope_id='s'").run();
  } finally { raw.close(); }
  expect((await f.store.listRunProgression(own)).items).toEqual([{ scopeId: 's', runId: 'r' }]);
  expect(await f.store.listForeignProgressionScopes({ actor: f.lookup.actor, companyId: 'acme', limit: 8 })).toEqual([]);
  // Without a company filter discovery is unchanged.
  expect((await f.store.listRunProgression(f.lookup)).items).toHaveLength(1);
});
