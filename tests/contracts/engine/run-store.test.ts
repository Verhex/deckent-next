import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteInventoryReader, type SqliteAttemptStore } from '#adapters/index.js';
import { createAttempt, applyAttemptObservation } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' } as const;
const actor = { id: 'user', issuer: 'host', subject: '1000' };
const identity = { runId: 'r', scopeId: 's', layoutRevision: 'l' };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: ['a', 'b', 'c'].map(id => ({ id, kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] })),
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify task result', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const create = { commandId: 'create', actor, identity, graph, execution: fixtureExecution(graph), now: 0, policy: { schemaVersion: 2 as const, poolId: 'shared', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['a', 'b', 'c'] } };
const attempt = (taskId: string) => ({ ...identity, taskId, attemptId: 'attempt-' + taskId, generation: 1 });
const reservation = (ids: string[], commandId = 'claim') => ({ commandId, actor, scopeId: 's', runId: 'r', expectedRevision: 0, now: 0, identities: ids.map(attempt) });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-store-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, options); stores.push(store); await store.createExecutionPool({ schemaVersion: 1, poolId: 'shared', capacity: { executionSlots: 2, inFlightSlots: 2 } }); return { path, store };
}
it('atomically persists Run progress and attempts, with exact replay across independent connections and reopen', async () => {
  const f = await fixture(); await f.store.createRun(create);
  const second = await openSqliteAttemptStore(f.path, options); stores.push(second);
  const results = await Promise.allSettled([f.store.reserveRunTasks(reservation(['a', 'b'])), second.reserveRunTasks(reservation(['a', 'b'], 'other-command'))]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect((await second.loadRun('s', 'r'))!.revision).toBe(1); expect((await second.load('s', 'attempt-a'))!.identity).toEqual(attempt('a'));
  expect(await second.reserveRunTasks(reservation(['a', 'b']))).toEqual(results[0].status === 'fulfilled' ? results[0].value : null);
  await expect(second.reserveRunTasks({ ...reservation(['a']), actor: { ...actor, subject: 'foreign' } })).rejects.toThrow('RUN_COMMAND_CONFLICT');
  await expect(second.loadRun('other', 'r')).resolves.toBeNull();
  second.close(); stores.splice(stores.indexOf(second), 1);
  const reopened = await openSqliteAttemptStore(f.path, options); stores.push(reopened);
  expect((await reopened.loadRun('s', 'r'))!.progress.filter(p => p.phase === 'active')).toHaveLength(2);
  await expect(reopened.reserveRunTasks({ ...reservation(['c'], 'full'), expectedRevision: 1 })).rejects.toThrow('RUN_CAPACITY_OR_ORDER');
});
it('rolls back every inserted attempt and Run change if any attempt identity conflicts', async () => {
  const { store } = await fixture(); await store.createRun(create);
  await store.commit({ commandId: 'existing', command: 'existing', expectedRevision: null, snapshot: createAttempt(attempt('b')) });
  await expect(store.reserveRunTasks(reservation(['a', 'b']))).rejects.toThrow('RUN_STORE_CONFLICT');
  expect(await store.load('s', 'attempt-a')).toBeNull(); expect((await store.loadRun('s', 'r'))!.revision).toBe(0);
  expect((await store.reserveRunTasks(reservation(['a'], 'after-rollback'))).snapshot.revision).toBe(1);
});
it('enforces persisted ordering, scope binding, revision and conflict-safe command identities', async () => {
  const { store } = await fixture(); const receipt = await store.createRun(create);
  expect(await store.createRun(create)).toEqual(receipt);
  await expect(store.createRun({ ...create, policy: { ...create.policy, capacity: { executionSlots: 10, inFlightSlots: 10 } } })).rejects.toThrow('RUN_COMMAND_CONFLICT');
  await expect(store.reserveRunTasks(reservation(['b']))).rejects.toThrow('RUN_CAPACITY_OR_ORDER');
  await expect(store.reserveRunTasks({ ...reservation(['a']), identities: [{ ...attempt('a'), scopeId: 'foreign' }] })).rejects.toThrow('RUN_ATTEMPT_CONFLICT');
  expect((await store.loadRun('s', 'r'))!.revision).toBe(0);
});
it('rejects opening a schema-2 reader, then migrates prior attempt data for a current-only reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-migrate-')); roots.push(root); const path = join(root, 'ledger.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE attempts(scope_id TEXT,attempt_id TEXT,revision INTEGER,snapshot TEXT,PRIMARY KEY(scope_id,attempt_id)); CREATE TABLE attempt_receipts(scope_id TEXT,command_id TEXT,command TEXT,snapshot TEXT,PRIMARY KEY(scope_id,command_id)); CREATE TABLE dispatches(scope_id TEXT,attempt_id TEXT,record TEXT,PRIMARY KEY(scope_id,attempt_id)); DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=2;');
  const snapshot = createAttempt(attempt('old')); db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run('s', 'attempt-old', 0, JSON.stringify(snapshot)); db.close();
  const before = await readFile(path);
  await expect(openSqliteInventoryReader(path, { busyTimeoutMs: 20 })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  expect(await readFile(path)).toEqual(before);
  const store = await openSqliteAttemptStore(path, options); stores.push(store);
  expect(await store.load('s', 'attempt-old')).toEqual(snapshot); await store.createExecutionPool({ schemaVersion: 1, poolId: 'shared', capacity: { executionSlots: 2, inFlightSlots: 2 } }); await store.createRun(create);
  const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: 20 });
  try { expect((await reader.listDispatches({ schemaVersion: 1, scopeId: 's', after: null, limit: 1 })).entries).toEqual([]); } finally { reader.close(); }
  const check = new DatabaseSync(path, { readOnly: true }); try { expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION); } finally { check.close(); }
});

it('returns bounded busy under a separate process transaction, without partial reservation', async () => {
  const { store, path } = await fixture(); await store.createRun(create);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked'); process.stdin.once('data', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
  `, path], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('exit', () => reject(new Error('lock-holder-exited')));
      child.stdout.once('data', value => String(value) === 'locked' ? resolve() : reject(new Error('lock-protocol-invalid')));
    });
    await expect(store.reserveRunTasks(reservation(['a']))).rejects.toMatchObject({ code: 'ATTEMPT_STORE_BUSY' });
    expect(await store.load('s', 'attempt-a')).toBeNull(); expect((await store.loadRun('s', 'r'))!.revision).toBe(0);
    const exited = once(child, 'close'); child.stdin.write('release'); await exited;
    expect((await store.reserveRunTasks(reservation(['a']))).snapshot.revision).toBe(1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'close'); child.kill(); await exited; }
  }
});

it('projects only stored attempt evidence, frees execution capacity but retains evaluation backpressure', async () => {
  const { store } = await fixture(); await store.createRun({ ...create, policy: { ...create.policy, capacity: { executionSlots: 1, inFlightSlots: 2 } } });
  await store.reserveRunTasks(reservation(['a']));
  const finish = async (taskId: string) => {
    const id = attempt(taskId); const current = (await store.load('s', id.attemptId))!;
    const snapshot = applyAttemptObservation(current, { protocolVersion: 1, identity: id, sequence: 1, eventId: 'exit-' + taskId, result: { kind: 'exited', exitCode: 0 } }, current.revision);
    await store.commit({ commandId: 'exit-' + taskId, command: 'verified-exit', expectedRevision: current.revision, snapshot });
  };
  await finish('a');
  await expect(store.reserveRunTasks({ ...reservation(['b'], 'before-projection'), expectedRevision: 1 })).rejects.toThrow('RUN_CAPACITY_OR_ORDER');
  const projectA = { commandId: 'project-a', actor, scopeId: 's', runId: 'r', expectedRevision: 1, attemptId: 'attempt-a' };
  const receipt = await store.projectRunAttempt(projectA); expect(receipt.snapshot.progress[0]!.phase).toBe('evaluating');
  await store.reserveRunTasks({ ...reservation(['b'], 'claim-b'), expectedRevision: 2 }); await finish('b');
  const projected = await store.projectRunAttempt({ ...projectA, commandId: 'project-b', attemptId: 'attempt-b', expectedRevision: 3 });
  expect(projected.snapshot.progress.filter(p => p.phase === 'evaluating')).toHaveLength(2);
  await expect(store.reserveRunTasks({ ...reservation(['c'], 'evaluation-full'), expectedRevision: 4 })).rejects.toThrow('RUN_CAPACITY_OR_ORDER');
  expect(await store.projectRunAttempt(projectA)).toEqual(receipt);
});
it('rejects caller-supplied observations and unrelated stored attempts without changing Run state', async () => {
  const { store } = await fixture(); await store.createRun(create); await store.reserveRunTasks(reservation(['a']));
  const project = { commandId: 'project', actor, scopeId: 's', runId: 'r', expectedRevision: 1, attemptId: 'attempt-a' };
  await expect(store.projectRunAttempt({ ...project, observation: { result: 'exited' } } as typeof project)).rejects.toThrow();
  await expect(store.projectRunAttempt(project)).rejects.toThrow('RUN_OBSERVATION_STALE');
  const foreign = { ...attempt('foreign'), runId: 'other-run' };
  const snapshot = applyAttemptObservation(createAttempt(foreign), { protocolVersion: 1, identity: foreign, sequence: 1, eventId: 'foreign-exit', result: { kind: 'exited', exitCode: 0 } }, 0);
  await store.commit({ commandId: 'foreign', command: 'foreign', expectedRevision: null, snapshot: createAttempt(foreign) });
  await store.commit({ commandId: 'foreign-exit', command: 'foreign-exit', expectedRevision: 0, snapshot });
  await expect(store.projectRunAttempt({ ...project, attemptId: foreign.attemptId })).rejects.toThrow('RUN_ATTEMPT_CONFLICT');
  expect((await store.loadRun('s', 'r'))!.revision).toBe(1);
});
