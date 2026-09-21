import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { RunReservationApplication, planSchedulingWave } from '#engine/index.js';
import { applyAttemptObservation, type AttemptIdentity } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' } as const;
const actor = { id: 'scheduler-proof', issuer: 'test', subject: 'operator' };
const capacity = { executionSlots: 8, inFlightSlots: 8 };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: Array.from({ length: 30 }, (_, i) => ({
  id: `task-${i}`, kind: 'fixture', dependencies: i < 10 ? [] : i < 20 ? [`task-${i - 10}`]
    : [`task-${i - 10}`, `task-${10 + (i - 19) % 10}`], acceptanceCriteria: ['verified'],
})), criterionDefinitions: [{ id: 'verified', version: 1, description: 'Fixture acceptance', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-parallel-dag-')); roots.push(root);
  const path = join(root, 'ledger.db');
  const open = async () => { const store = await openSqliteAttemptStore(path, options, 'allow', custodyProfiles); stores.push(store); return store; };
  const store = await open(); await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity });
  let sequence = 0;
  const app = (connection: SqliteAttemptStore) => new RunReservationApplication(connection,
    { async verify() { return { ...actor, assurance: 'os-user', scopeIds: ['s'] }; } },
    { async authorize() {} }, { async authorize() {} }, { now: () => 0, attemptId: () => `attempt-${++sequence}` });
  const create = (runId: string) => store.createRun({ commandId: `create-${runId}`, actor,
    identity: { scopeId: 's', runId, layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph), now: 0,
    policy: { schemaVersion: 2, poolId: 'pool', capacity, ordering: graph.tasks.map(task => task.id) } });
  const reserve = async (connection: SqliteAttemptStore, runId: string, commandId: string) => {
    const run = (await connection.loadRun('s', runId))!;
    return app(connection).reserve({ schemaVersion: 1, commandId, scopeId: 's', runId, expectedRevision: run.revision });
  };
  const reopen = async (connection: SqliteAttemptStore) => { connection.close(); stores.splice(stores.indexOf(connection), 1); return open(); };
  return { path, store, open, create, reserve, reopen };
}
async function finish(store: SqliteAttemptStore, identity: AttemptIdentity) {
  const claim = { request: { protocolVersion: 1 as const, identity, workspace: '/fixture-workspace', argv: ['fixture-task'] }, owner: 'fixture-worker' };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  await store.retainDispatchOutput(claim, { schemaVersion: 1, scopeId: 's', digest: 'a'.repeat(64), byteLength: 10 });
  await store.finishDispatch(claim, { handle: identity.attemptId, exitCode: 0, interrupted: false });
  return (await store.readDispatch(claim.request))!;
}
async function accept(store: SqliteAttemptStore, identity: AttemptIdentity, dispatch: Awaited<ReturnType<typeof finish>>, verdict: 'pass' | 'fail' = 'pass') {
  const run = (await store.loadRun('s', identity.runId))!;
  await store.commitTaskEvaluation({ commandId: `accept-${identity.attemptId}`, actor, expectedRevision: run.revision, dispatch,
    evaluation: { schemaVersion: 1, evaluationId: `accept-${identity.attemptId}`, identity, graphRevision: 1,
      attemptRevision: 1, criteria: [{ criterionId: 'verified', verdict, evidenceIds: ['fixture-evidence'] }] } });
}
it('drains a30-task fan-out/fan-in DAG through accepted results and reopened durable reservations, capped at8', async () => {
  const f = await fixture(); await f.create('run'); let store = f.store;
  const seen = new Set<string>(); let wave = 0;
  while (seen.size < graph.tasks.length) {
    const before = (await store.loadRun('s', 'run'))!;
    const result = await f.reserve(store, 'run', `wave-${++wave}`);
    expect(result.identities.length).toBeGreaterThan(0); expect(result.identities.length).toBeLessThanOrEqual(capacity.executionSlots);
    for (const identity of result.identities) {
      expect(seen.has(identity.taskId)).toBe(false); seen.add(identity.taskId);
      for (const dep of graph.tasks.find(task => task.id === identity.taskId)!.dependencies) {
        expect(before.progress.find(task => task.taskId === dep)!.phase).toBe('accepted');
      }
    }
    const outputs = [];
    for (const identity of result.identities) outputs.push(await finish(store, identity));
    const evaluating = (await store.loadRun('s', 'run'))!;
    expect(evaluating.progress.filter(task => task.phase === 'evaluating')).toHaveLength(result.identities.length);
    if (wave === 1) await expect(f.reserve(store, 'run', 'evaluation-pressure')).rejects.toMatchObject({ code: 'RUN_CAPACITY_OR_ORDER' });
    store = await f.reopen(store);
    expect(await store.loadRun('s', 'run')).toEqual(evaluating);
    for (let i = 0; i < result.identities.length; i++) await accept(store, result.identities[i]!, outputs[i]!);
  }
  expect(seen.size).toBe(30); expect((await store.loadRun('s', 'run'))!.progress.every(task => task.phase === 'accepted')).toBe(true);
});
it('atomically bounds two Runs across independent connections, fills remaining pool capacity without expanding replay', async () => {
  const f = await fixture(); await f.create('one'); await f.create('two'); const other = await f.open();
  const outcomes = await Promise.allSettled([f.reserve(f.store, 'one', 'race-one'), f.reserve(other, 'two', 'race-two')]);
  const winner = outcomes.find(result => result.status === 'fulfilled');
  expect(winner?.status).toBe('fulfilled'); expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
  if (!winner || winner.status !== 'fulfilled') throw new Error('NO_WINNER');
  const identities = winner.value.identities; expect(identities).toHaveLength(8);
  const loserId = identities[0]!.runId === 'one' ? 'two' : 'one';
  for (const identity of identities.slice(0, 4)) await accept(f.store, identity, await finish(f.store, identity));
  const reopened = await f.reopen(other);
  const runBefore = (await reopened.loadRun('s', loserId))!;
  const candidates = graph.tasks.slice(0, 8).map(task => ({ ...runBefore.identity, taskId: task.id,
    attemptId: `invalid-candidate-${task.id}`, generation: 1 }));
  candidates[7] = { ...candidates[7]!, scopeId: 'foreign' };
  await expect(reopened.reserveRunTasks({ commandId: 'invalid-suffix', actor, scopeId: 's', runId: loserId,
    expectedRevision: runBefore.revision, now: 0, identities: candidates })).rejects.toThrow('RUN_ATTEMPT_CONFLICT');
  expect(await reopened.loadRun('s', loserId)).toEqual(runBefore);
  const db = new DatabaseSync(f.path);
  try {
    db.exec("CREATE TRIGGER deny_partial BEFORE INSERT ON run_receipts BEGIN SELECT RAISE(ABORT, 'partial-proof-rollback'); END");
    await expect(f.reserve(reopened, loserId, 'rollback-wave')).rejects.toThrow('partial-proof-rollback');
    expect(await reopened.loadRun('s', loserId)).toEqual(runBefore);
    expect(await reopened.loadRunReceipt('s', 'rollback-wave')).toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM attempts WHERE json_extract(snapshot,'$.identity.runId')=?").get(loserId)?.n).toBe(0);
    db.exec('DROP TRIGGER deny_partial');
  } finally { db.close(); }
  const partial = await f.reserve(reopened, loserId, 'partial-free');
  expect(partial.identities).toHaveLength(4);
  const recorded = JSON.parse((await reopened.loadRunReceipt('s', 'partial-free'))!.command);
  expect(recorded.identities).toHaveLength(8);
  for (const unused of recorded.identities.slice(4)) expect(await reopened.load('s', unused.attemptId)).toBeNull();
  for (const identity of identities.slice(4)) await accept(f.store, identity, await finish(f.store, identity));
  const replayStore = await f.reopen(reopened);
  const app = new RunReservationApplication(replayStore,
    { async verify() { return { ...actor, assurance: 'os-user', scopeIds: ['s'] }; } },
    { async authorize() {} }, { async authorize() {} }, { now: () => 999, attemptId() { throw new Error('REPLAY_GENERATED_ID'); } });
  expect(await app.reserve({ schemaVersion: 1, commandId: 'partial-free', scopeId: 's', runId: loserId,
    expectedRevision: runBefore.revision })).toEqual(partial);
  expect((await f.reserve(replayStore, loserId, 'next-wave')).identities).toHaveLength(4);
});
it('preserves failed and unknown dependency gates and unknown occupancy after reopen', async () => {
  const f = await fixture(); await f.create('run'); const first = await f.reserve(f.store, 'run', 'initial');
  for (const [i, kind] of ['failed', 'unknown'].entries()) {
    const identity = first.identities[i]!;
    if (kind === 'failed') { await accept(f.store, identity, await finish(f.store, identity), 'fail'); continue; }
    const current = (await f.store.load('s', identity.attemptId))!;
    const snapshot = applyAttemptObservation(current, { protocolVersion: 1, identity, sequence: 1, eventId: `event-${i}`,
      result: { kind: 'unknown', reasonCode: 'fixture-disconnect' } }, current.revision);
    await f.store.commit({ commandId: `observe-${i}`, command: `fixture-${i}`, expectedRevision: current.revision, snapshot });
    const run = (await f.store.loadRun('s', 'run'))!;
    await f.store.projectRunAttempt({ commandId: `project-${i}`, actor, scopeId: 's', runId: 'run', expectedRevision: run.revision, attemptId: identity.attemptId });
  }
  const saved = (await f.store.loadRun('s', 'run'))!, reopened = await f.reopen(f.store);
  expect(await reopened.loadRun('s', 'run')).toEqual(saved);
  const wave = planSchedulingWave(saved.graph, { schemaVersion: 2, capacity, ordering: graph.tasks.map(task => task.id),
    snapshot: { graphRevision: 1, now: 1_000_000, progress: saved.progress } });
  expect(wave.selectedTaskIds).not.toContain('task-10'); expect(wave.selectedTaskIds).not.toContain('task-11');
  expect(wave.occupancy.execution).toBe(7); expect(wave.occupancy.inFlight).toBe(7);
  expect(saved.progress.find(task => task.taskId === 'task-0')!.phase).toBe('failed');
  expect(wave.selectedTaskIds).toEqual(['task-8']);
});
it('upgrades the reservation semantics gate without rewriting prior full-wave receipts', async () => {
  const f = await fixture(); await f.create('run'); await f.reserve(f.store, 'run', 'full-wave');
  const before = await f.store.loadRunReceipt('s', 'full-wave');
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const db = new DatabaseSync(f.path); db.exec('DROP TABLE run_execution_intents; DROP TABLE task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=23'); db.close();
  await expect(openSqliteAttemptStore(f.path, options, 'forbid', custodyProfiles)).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  const reopened = await f.open(); expect(await reopened.loadRunReceipt('s', 'full-wave')).toEqual(before);
  const check = new DatabaseSync(f.path); try { expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION); } finally { check.close(); }
});

// Real separate processes import the built product; the parent only supplies the start barrier.
function reservationProcess(path: string, runId: string, commandId: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { openSqliteAttemptStore } = await import(process.argv[1]);
    const { RunReservationApplication } = await import(process.argv[2]);
    const store = await openSqliteAttemptStore(process.argv[3], JSON.parse(process.argv[4]));
    let generated = 0;
    const app = new RunReservationApplication(store,
      { async verify() { return { id: 'scheduler-proof', issuer: 'test', subject: 'operator', assurance: 'os-user', scopeIds: ['s'] }; } },
      { async authorize() {} }, { async authorize() {} },
      { now: () => 0, attemptId: () => process.argv[5] + '-child-' + (++generated) });
    process.once('message', async () => {
      try {
        const result = await app.reserve({ schemaVersion: 1, scopeId: 's', runId: process.argv[5], commandId: process.argv[6], expectedRevision: 0 });
        process.stdout.write(JSON.stringify({ ok: true, generated, result }) + '\\n');
      } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code }) + '\\n'); }
      finally { store.close(); process.disconnect(); }
    });
    process.send('ready');
  `, pathToFileURL(join(process.cwd(), 'dist/adapters/index.js')).href,
  pathToFileURL(join(process.cwd(), 'dist/engine/index.js')).href, path, JSON.stringify(options), runId, commandId],
  { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 65536) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', value => value === 'ready' ? resolve() : reject(new Error('CHILD_PROTOCOL')));
    child.once('error', reject); child.once('exit', () => reject(new Error(`CHILD_EXITED_BEFORE_READY: ${stderr}`)));
  });
  const done = new Promise<{ ok: boolean; code?: string; generated?: number;
    result?: Awaited<ReturnType<RunReservationApplication['reserve']>> }>((resolve, reject) => {
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`RESERVATION_CHILD_${code}: ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  // Attach rejection handlers immediately; assertions below still observe the original promises.
  void ready.catch(() => undefined); void done.catch(() => undefined);
  return { ready, done, start: () => child.send('go'), stop: () => child.kill('SIGKILL') };
}

it.each([1, 2, 3])('keeps partial capacity and replay exact across competing OS processes (round %i)', async () => {
  const f = await fixture(); for (const runId of ['occupied', 'one', 'two']) await f.create(runId);
  const occupied = graph.tasks.slice(0, 4).map(task => ({ scopeId: 's', runId: 'occupied', layoutRevision: 'layout',
    taskId: task.id, attemptId: `occupied-${task.id}`, generation: 1 }));
  await f.store.reserveRunTasks({ commandId: 'occupy', actor, scopeId: 's', runId: 'occupied', expectedRevision: 0, now: 0, identities: occupied });
  const children = ['one', 'two'].map(runId => reservationProcess(f.path, runId, `race-${runId}`));
  try {
    await Promise.all(children.map(child => child.ready)); children.forEach(child => child.start());
    const results = await Promise.all(children.map(child => child.done));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toMatchObject({ code: 'RUN_POOL_FULL' });
    const winner = results.find(result => result.ok)!;
    expect(winner.result!.identities).toHaveLength(4);
    const winnerId = winner.result!.identities[0]!.runId, loserId = winnerId === 'one' ? 'two' : 'one';
    const reopened = await f.reopen(f.store);
    const runs = await Promise.all(['occupied', 'one', 'two'].map(runId => reopened.loadRun('s', runId)));
    expect(runs.reduce((n, run) => n + run!.progress.filter(task => task.phase === 'active').length, 0)).toBe(8);
    expect(await reopened.loadRunReceipt('s', `race-${loserId}`)).toBeNull();
    expect((await reopened.loadRun('s', loserId))!.bindings).toHaveLength(0);
    for (const identity of occupied) await accept(reopened, identity, await finish(reopened, identity));
    const replay = reservationProcess(f.path, winnerId, `race-${winnerId}`); children.push(replay);
    await replay.ready; replay.start();
    expect(await replay.done).toEqual({ ok: true, generated: 0, result: winner.result });
  } finally { children.forEach(child => child.stop()); await Promise.allSettled(children.map(child => child.done)); }
});
