import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { RunProgressionTurn, RunReservationApplication, RunStoreError, type RunProgressionOperations } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = { id: 'operator', issuer: 'test', subject: 'operator' };
const query = { schemaVersion: 1 as const, scopeId: 's', runId: 'r' };
async function fixture(verdict: 'pass' | 'unknown' = 'pass', dependencies = ['a', 'b']) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-progression-')); roots.push(root);
  const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, 'allow', custodyProfiles); stores.push(store);
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: ['a', 'b', 'c'].map(id => ({ id, kind: 'fixture', dependencies: id === 'c' ? dependencies : [], acceptanceCriteria: ['verified'] })),
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  const capacity = { executionSlots: 2, inFlightSlots: 2 };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity });
  await store.createRun({ commandId: 'create', actor, identity: { scopeId: 's', runId: 'r', layoutRevision: 'layout' },
    graph, execution: fixtureExecution(graph), now: 0, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['a', 'b', 'c'] } });
  let sequence = 0, active = 0, maximum = 0, evaluations = 0;
  const id = () => `id-${++sequence}`;
  const reservation = new RunReservationApplication(store, { async verify() { return { ...actor, assurance: 'os-user', scopeIds: ['s'] }; } },
    { async authorize() {} }, { async authorize() {} }, { now: () => 0, attemptId: id });
  const operations: RunProgressionOperations = {
    async read() { return (await store.loadRun('s', 'r'))!; },
    evaluationRecorded: (identity, revision) => store.hasTaskEvaluation(identity, revision),
    async reserve(command) {
      try { await reservation.reserve(command); return 'reserved'; }
      catch (error) { if (error instanceof RunStoreError && ['RUN_CAPACITY_OR_ORDER', 'RUN_POOL_FULL'].includes(error.code)) return 'waiting'; throw error; }
    },
    async execute(identity) {
      active++; maximum = Math.max(maximum, active);
      const claim = { request: { protocolVersion: 1 as const, identity, workspace: '/fixture', argv: ['fixture'] }, owner: 'worker' };
      await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
      await store.retainDispatchOutput(claim, { schemaVersion: 1, scopeId: 's', digest: 'a'.repeat(64), byteLength: 1 });
      await store.finishDispatch(claim, { handle: identity.attemptId, exitCode: 0, interrupted: false }); active--;
    },
    async evaluate(command) {
      evaluations++;
      const attempt = (await store.load('s', command.identity.attemptId))!;
      await store.commitTaskEvaluation({ commandId: command.commandId, actor, expectedRevision: command.expectedRevision,
        dispatch: (await store.loadBoundDispatch(command.identity))!, evaluation: { schemaVersion: 1, evaluationId: command.commandId,
          identity: command.identity, graphRevision: 1, attemptRevision: attempt.revision, criteria: [{ criterionId: 'verified', verdict, evidenceIds: ['evidence'] }] } });
      return 'recorded';
    },
  };
  return { path, store, operations, turn: new RunProgressionTurn(operations, 2, { commandId: id }), stats: () => ({ maximum, evaluations }) };
}
it('executes in parallel, serializes acceptance against fresh revisions and advances dependencies without a second host turn', async () => {
  const f = await fixture(); const signal = new AbortController().signal;
  const first = await f.turn.advance(query, signal);
  expect(first.run.tasks.map(t => t.phase)).toEqual(['accepted', 'accepted', 'accepted']); expect(f.stats().maximum).toBe(2);
  expect(first.attempted).toBe(3);
  const second = await f.turn.advance(query, signal); expect(second.attempted).toBe(0);
  expect(second.run.tasks.every(t => t.phase === 'accepted')).toBe(true);
  expect((await f.turn.advance(query, signal)).attempted).toBe(0);
});
it('does not repeat unknown evaluations or unlock their dependency on another turn', async () => {
  const f = await fixture('unknown'); const signal = new AbortController().signal;
  await f.turn.advance(query, signal);
  const again = await f.turn.advance(query, signal);
  expect(again.attempted).toBe(0); expect(f.stats().evaluations).toBe(2);
  expect(again.run.tasks.map(t => t.phase)).toEqual(['evaluating', 'evaluating', 'pending']);
});
it('leaves recorded work untouched when stopped or cancelled and propagates policy denial', async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort();
  expect((await f.turn.advance(query, controller.signal)).stopped).toBe(true);
  expect((await f.store.loadRun('s', 'r'))!.bindings).toHaveLength(0);
  const original = f.operations.reserve;
  f.operations.reserve = async () => { throw new Error('POLICY_DENIED'); };
  await expect(f.turn.advance(query, new AbortController().signal)).rejects.toThrow('POLICY_DENIED'); f.operations.reserve = original;
  await f.store.cancelRun({ scopeId: 's', runId: 'r', commandId: 'cancel', actor, expectedRevision: 0 });
  expect((await f.turn.advance(query, new AbortController().signal)).stopped).toBe(true);
});

it('honors cancellation recorded during execution without evaluating or undoing observed work', async () => {
  const f = await fixture(); const execute = f.operations.execute;
  f.operations.execute = async identity => {
    await execute(identity);
    const run = (await f.store.loadRun('s', 'r'))!;
    if (!run.cancelRequested) await f.store.cancelRun({ scopeId: 's', runId: 'r', commandId: 'cancel-during', actor, expectedRevision: run.revision });
  };
  const result = await f.turn.advance(query, new AbortController().signal);
  expect(result.stopped).toBe(true); expect(result.run.cancellationRequested).toBe(true);
  expect(f.stats().evaluations).toBe(0);
  expect(result.run.tasks.find(task => task.id === 'c')?.phase).not.toBe('accepted');
});

it('records intent atomically with admission, deduplicates it and limits discovery to its actor', async () => {
  const f = await fixture(); const lookup = { actor, after: null, limit: 1 };
  expect((await f.store.listRunProgression(lookup)).items).toEqual([{ scopeId: 's', runId: 'r' }]);
  expect((await f.store.listRunProgression({ ...lookup, actor: { ...actor, subject: 'other' } })).items).toEqual([]);
  const run = (await f.store.loadRun('s', 'r'))!;
  const create = { commandId: 'create-second', actor, identity: { ...run.identity, runId: 'second' }, graph: run.graph,
    execution: run.execution, now: 0, policy: { schemaVersion: 2 as const, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['a', 'b', 'c'] } };
  const db = new DatabaseSync(f.path);
  try {
    db.exec("CREATE TRIGGER reject_intent BEFORE INSERT ON run_execution_intents WHEN NEW.run_id='second' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    await expect(f.store.createRun(create)).rejects.toThrow();
    expect(await f.store.loadRun('s', 'second')).toBeNull(); expect(await f.store.loadRunReceipt('s', 'create-second')).toBeNull();
    db.exec('DROP TRIGGER reject_intent');
    await f.store.createRun(create); await f.store.createRun(create);
    const first = await f.store.listRunProgression(lookup);
    const second = await f.store.listRunProgression({ ...lookup, after: first.next });
    expect(second.items).toEqual([{ scopeId: 's', runId: 'second' }]); expect(second.next).toBeNull();
    expect(db.prepare('SELECT COUNT(*) n FROM run_execution_intents').get()?.n).toBe(2);
  } finally { db.close(); }
});
it('migrates prior evaluation evidence without retrospectively opting old Runs into automatic execution', async () => {
  const f = await fixture('unknown'); await f.turn.advance(query, new AbortController().signal);
  const run = (await f.store.loadRun('s', 'r'))!;
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const db = new DatabaseSync(f.path);
  db.exec('DROP TABLE run_execution_intents; DROP TABLE task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=24'); db.close();
  const reopened = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }); stores.push(reopened);
  expect((await reopened.listRunProgression({ actor, after: null, limit: 8 })).items).toEqual([]);
  for (const binding of run.bindings) expect(await reopened.hasTaskEvaluation(binding.identity, binding.observedRevision!)).toBe(true);
});

it('starts the fast task dependency before an unrelated slow worker finishes', async () => {
  const f = await fixture('pass', ['a']); const execute = f.operations.execute;
  let releaseSlow!: () => void, markNext!: () => void;
  const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
  const next = new Promise<void>(resolve => { markNext = resolve; });
  let slowFinished = false;
  f.operations.execute = async identity => {
    if (identity.taskId === 'b') { await slow; await execute(identity); slowFinished = true; return; }
    if (identity.taskId === 'c') { expect(slowFinished).toBe(false); markNext(); }
    await execute(identity);
  };
  let command = 0;
  const bounded = new RunProgressionTurn(f.operations, 2, { commandId: () => `refill-${++command}` }, 2);
  const work = bounded.advance(query, new AbortController().signal);
  void work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([next, work.then(() => { throw new Error('DEPENDENCY_NOT_STARTED'); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('WAVE_BARRIER')), 2000); })]);
    expect(slowFinished).toBe(false);
  } finally { clearTimeout(timer); releaseSlow(); }
  const result = await work; expect(result.attempted).toBe(3);
  expect(result.run.tasks.every(task => task.phase === 'accepted')).toBe(true);
});

it('revisits a changed evaluation fence on a subsequent completion without a tight retry loop', async () => {
  const f = await fixture(); const evaluate = f.operations.evaluate; let changed = false;
  f.operations.evaluate = async command => {
    if (!changed) { changed = true; return 'changed'; }
    return evaluate(command);
  };
  const result = await f.turn.advance(query, new AbortController().signal);
  expect(changed).toBe(true); expect(result.run.tasks.every(task => task.phase === 'accepted')).toBe(true);
  expect(f.stats().evaluations).toBe(3);
});
it('latches a failed execution, drains admitted work and does not dispatch the next dependency', async () => {
  const f = await fixture('pass', ['a']); const execute = f.operations.execute; let drained = false;
  f.operations.execute = async identity => {
    if (identity.taskId === 'b') throw new Error('POLICY_DENIED');
    await execute(identity); drained = true;
  };
  await expect(f.turn.advance(query, new AbortController().signal)).rejects.toThrow('POLICY_DENIED');
  expect(drained).toBe(true);
  const run = (await f.store.loadRun('s', 'r'))!;
  expect(run.bindings.some(binding => binding.identity.taskId === 'c')).toBe(false);
});

it('yields after a reservation budget, drains/evaluates existing work and resumes without new identities for completed tasks', async () => {
  const f = await fixture('pass', ['a']); let sequence = 0;
  const turn = new RunProgressionTurn(f.operations, 2, { commandId: () => `quantum-${++sequence}` }, 1);
  const first = await turn.advance(query, new AbortController().signal);
  expect(first.attempted).toBe(2);
  expect(first.run.tasks.map(task => task.phase)).toEqual(['accepted', 'accepted', 'pending']);
  const identities = (await f.store.loadRun('s', 'r'))!.bindings.map(binding => binding.identity.attemptId);
  const second = await turn.advance(query, new AbortController().signal);
  expect(second.attempted).toBe(1); expect(second.run.tasks.every(task => task.phase === 'accepted')).toBe(true);
  expect((await f.store.loadRun('s', 'r'))!.bindings.slice(0, 2).map(binding => binding.identity.attemptId)).toEqual(identities);
});
