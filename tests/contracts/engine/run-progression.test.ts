import { runProgressionMissingPermissions, RunSessionRegistry, runSessionRegistryData, selectProgressionActor, selectRunProgression, mergeProgressionPages, progressionCustodyActor, sealApproval, approvalRequestDigest, type RunSessionState } from '#engine/index.js';
import { createHmacIntegrity, ErrorRegistry, clearConfigCache, loadConfig, productResourcePath, sha256 } from '#platform/index.js';
import { policySchema, type VerifiedPrincipal } from '#domain/index.js';
import type { ApprovalRecord, RunSnapshot } from '#domain/index.js';
import { DOWNGRADE_TO_V51_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openSqliteApprovalStore, openSqliteAttemptStore, readLocalOsIdentity, withMcpPrincipal, type SqliteAttemptStore } from '#adapters/index.js';
import { prepareConfiguredRunRuntime } from '#composition/core/run-progression/index.js';
import { ensureConfiguredTerminalIdentity } from '#composition/core/scoped-request/index.js';
import { openConfiguredAttemptStore } from '../support/configured-open.js';
import { RunLifecycleApplication, RunPolicyAuthorization, RunLifecycleRuntimeLoop, RunProgressionTurn, RunReservationApplication, RunStoreError, type RunProgressionOperations } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = { id: 'operator', issuer: 'test', subject: 'operator' };
const query = { schemaVersion: 1 as const, scopeId: 's', runId: 'r' };
async function fixture(verdict: 'pass' | 'unknown' = 'pass', dependencies = ['a', 'b'], tasks = ['a', 'b', 'c'], capacitySlots = 2) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-progression-')); roots.push(root);
  const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles); stores.push(store);
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: tasks.map(id => ({ id, kind: 'fixture', dependencies: id === 'c' ? dependencies : [], acceptanceCriteria: ['verified'] })),
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  const capacity = { executionSlots: capacitySlots, inFlightSlots: capacitySlots };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity });
  await store.createRun({ commandId: 'create', actor, identity: { scopeId: 's', runId: 'r', layoutRevision: 'layout' },
    graph, execution: fixtureExecution(graph), now: 0, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: tasks } });
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
  expect(first.attempted).toBe(3); expect(first.run.state).toEqual({ kind: 'terminal', outcome: 'completed', reason: 'completed' });
  const second = await f.turn.advance(query, signal); expect(second.attempted).toBe(0);
  expect(second.run.tasks.every(t => t.phase === 'accepted')).toBe(true);
  expect((await f.turn.advance(query, signal)).attempted).toBe(0);
});
it('does not repeat unknown evaluations or unlock their dependency on another turn', async () => {
  const f = await fixture('unknown'); const signal = new AbortController().signal;
  await f.turn.advance(query, signal);
  const reserve = vi.spyOn(f.operations, 'reserve');
  const again = await f.turn.advance(query, signal);
  expect(reserve).not.toHaveBeenCalled();
  expect(again.attempted).toBe(0); expect(f.stats().evaluations).toBe(2);
  expect(again.run.tasks.map(t => t.phase)).toEqual(['awaiting-decision', 'awaiting-decision', 'pending']);
});
it('leaves recorded work untouched when stopped or cancelled and propagates policy denial', async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort();
  expect((await f.turn.advance(query, controller.signal)).stopped).toBe(true);
  expect((await f.store.loadRun('s', 'r'))!.bindings).toHaveLength(0);
  const original = f.operations.reserve;
  f.operations.reserve = async () => { throw new Error('POLICY_DENIED'); };
  await expect(f.turn.advance(query, new AbortController().signal)).rejects.toThrow('POLICY_DENIED'); f.operations.reserve = original;
  await f.store.cancelRun({ scopeId: 's', runId: 'r', commandId: 'cancel', actor, expectedRevision: 0 });
  const execute = vi.spyOn(f.operations, 'execute'), reserve = vi.spyOn(f.operations, 'reserve');
  const cancelled = await f.turn.advance(query, new AbortController().signal);
  expect(cancelled.stopped).toBe(true); expect(cancelled.attempted).toBe(0);
  expect(execute).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
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
  const fresh = await fixture();
  await fresh.operations.reserve({ ...query, commandId: 'reserve-fresh', expectedRevision: 0 });
  for (const binding of (await fresh.store.loadRun('s', 'r'))!.bindings) await fresh.operations.execute(binding.identity);
  const recorded = vi.fn(async () => {
    const run = (await fresh.store.loadRun('s', 'r'))!;
    if (!run.cancelRequested) await fresh.store.cancelRun({ scopeId: 's', runId: 'r', commandId: 'between-bindings', actor, expectedRevision: run.revision });
    return true;
  });
  fresh.operations.evaluationRecorded = recorded;
  const stopped = await fresh.turn.advance(query, new AbortController().signal);
  expect(recorded).toHaveBeenCalledTimes(1); expect(fresh.stats().evaluations).toBe(0);
  expect(stopped.stopped).toBe(true);
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
  db.exec(`${DOWNGRADE_TO_V51_LEDGER_SQL} DROP INDEX IF EXISTS model_invocation_spend_unreconciled_holds; DROP TABLE IF EXISTS provider_spend_management;  DROP TABLE IF EXISTS acceptance_metrics; DROP TABLE run_execution_intents; DROP TABLE task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS effect_intents; DROP TABLE IF EXISTS agent_turn_tool_calls; DROP TABLE IF EXISTS agent_turns; DROP TABLE IF EXISTS worker_event_logs; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=24`); db.close();
  const reopened = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }); stores.push(reopened);
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

it('lost completion publication leaves the accepted Run COMPLETED on the next maintenance turn', async () => {
  const f = await fixture(), controller = new AbortController();
  const loop = new RunLifecycleRuntimeLoop({
    async discover() { return { page: { items: [{ scopeId: 's', runId: 'r' }], next: null }, due: { items: [], next: null } }; },
    async expire() {}, advance: () => f.turn.advance(query, controller.signal),
  }, { onRun() { throw new Error('COMPLETION_PUBLISH_LOST'); }, onError(_query, error) { expect(String(error)).toContain('COMPLETION_PUBLISH_LOST'); controller.abort(); } },
  { pollIntervalMs: 1, failureBackoffMs: 1 });
  await loop.run(controller.signal);
  expect((await f.store.loadRun('s', 'r'))!.state).toEqual({ kind: 'terminal', outcome: 'completed', reason: 'completed' });
  expect((await f.turn.advance(query, new AbortController().signal)).run.state).toEqual({ kind: 'terminal', outcome: 'completed', reason: 'completed' });
});

it('reserves and executes without cancel authority, then keeps no-due maintenance quiet', async () => {
  const f = await fixture(), principal = { ...actor, assurance: 'os-user' as const, scopeIds: ['s'] };
  const authorization = new RunPolicyAuthorization({ async load() { return { schemaVersion: 1, revision: 'no-cancel', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals: [{ issuer: actor.issuer, subject: actor.subject }],
      resource: { kind: 'run', ids: 'all' } },
  ] }; } });
  const app = new RunLifecycleApplication(f.store, { async verify() { return principal; } }, authorization,
    { async authorize() {} }, () => ({ record() {} }), () => 0, 1000, 'no-cancel');
  f.operations.advanceLifecycle = async request => { await app.advance(request); };
  const commits = vi.spyOn(f.store, 'commitRunLifecycle');
  const result = await f.turn.advance(query, new AbortController().signal);
  expect(result.attempted).toBe(3); expect(result.run.tasks.every(task => task.phase === 'accepted')).toBe(true);
  const revision = result.run.revision;
  expect((await f.turn.advance(query, new AbortController().signal)).attempted).toBe(0);
  expect((await f.store.loadRun('s', 'r'))?.revision).toBe(revision);
  expect(commits).not.toHaveBeenCalled();
});

it('reports a due expiry denial for one Run while another Run reserves and executes in the same ledger', async () => {
  const f = await fixture('unknown'), controller = new AbortController(), errors: unknown[] = [];
  await f.turn.advance(query, controller.signal);
  const due = (await f.store.loadRun('s', 'r'))!;
  if (due.state.kind !== 'parked') throw new Error('FIXTURE_NOT_PARKED');
  const deadline = due.state.deadline;
  await f.store.createRun({ commandId: 'create-ready', actor, identity: { ...due.identity, runId: 'ready' }, graph: due.graph,
    execution: due.execution, now: 0, policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['a', 'b', 'c'] } });
  const principal = { ...actor, assurance: 'os-user' as const, scopeIds: ['s'] };
  const authorization = new RunPolicyAuthorization({ async load() { return { schemaVersion: 1, revision: 'no-cancel', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals: [{ issuer: actor.issuer, subject: actor.subject }],
      resource: { kind: 'run', ids: 'all' } },
  ] }; } });
  const app = new RunLifecycleApplication(f.store, { async verify() { return principal; } }, authorization,
    { async authorize() {} }, () => ({ record() {} }), () => deadline, 1000, 'no-cancel');
  f.operations.read = async request => (await f.store.loadRun(request.scopeId, request.runId))!;
  f.operations.advanceLifecycle = async request => { await app.advance(request); };
  const loop = new RunLifecycleRuntimeLoop({
    async discover() { return { due: { items: [{ scopeId: 's', runId: 'r' }], next: null },
      page: { items: [{ scopeId: 's', runId: 'ready' }], next: null } }; },
    async expire(request) { await app.advance({ schemaVersion: 1, ...request }); },
    advance: (request, signal) => f.turn.advance({ schemaVersion: 1, ...request }, signal),
  }, {
    onError(request, error) { errors.push({ request, error }); },
    onRun(request, result) { expect(request.runId).toBe('ready'); expect(result.attempted).toBe(2); controller.abort(); },
  }, { pollIntervalMs: 1, failureBackoffMs: 1 }, () => deadline);
  await loop.run(controller.signal);
  expect(errors).toEqual([{ request: { scopeId: 's', runId: 'r' }, error: expect.objectContaining({ code: 'POLICY_DENIED' }) }]);
  expect(await f.store.loadRun('s', 'r')).toEqual(due);
  expect((await f.store.loadRun('s', 'ready'))?.bindings).toHaveLength(2);
});


it.each([1, 2])('overlaps two real single-task Run executions only up to maxConcurrentRuns=%s', async bound => {
  vi.useFakeTimers();
  const f = await fixture('pass', [], ['a']), controller = new AbortController();
  const initial = (await f.store.loadRun('s', 'r'))!;
  await f.store.createRun({ commandId: 'create-concurrent', actor, identity: { ...initial.identity, runId: 'second' },
    graph: initial.graph, execution: initial.execution, now: 0, policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['a'] } });
  f.operations.read = async request => (await f.store.loadRun(request.scopeId, request.runId))!;
  const execute = f.operations.execute, releases = new Map<string, () => void>(), starts: string[] = [], completions: string[] = [];
  let active = 0, maximum = 0;
  f.operations.execute = async identity => {
    starts.push(identity.runId); active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => releases.set(identity.runId, resolve));
    await execute(identity); active--;
  };
  const loop = new RunLifecycleRuntimeLoop({
    async discover(after) { return { page: await f.store.listRunProgression({ actor, after, limit: 8 }), due: { items: [], next: null } }; },
    async expire() {}, advance: (request, signal) => f.turn.advance({ schemaVersion: 1, ...request }, signal),
  }, { onRun(request) { completions.push(request.runId); if (completions.length === 2) controller.abort(); } },
  { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: bound });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(starts).toEqual(bound === 2 ? ['r', 'second'] : ['r']);
    expect(maximum).toBe(bound);
    releases.get('r')!();
    await vi.advanceTimersByTimeAsync(10);
    expect(starts).toEqual(['r', 'second']);
    releases.get('second')!();
    await vi.advanceTimersByTimeAsync(10);
    await work;
    expect(completions).toEqual(['r', 'second']);
    expect((await f.store.loadRun('s', 'r'))!.progress[0]!.phase).toBe('accepted');
    expect((await f.store.loadRun('s', 'second'))!.progress[0]!.phase).toBe('accepted');
  } finally { controller.abort(); releases.forEach(release => release()); await work; vi.useRealTimers(); }
});


it('fills all eight free pool slots with eight independent single-task Run executions', async () => {
  vi.useFakeTimers(); const f = await fixture('pass', [], ['a'], 8), controller = new AbortController();
  const initial = (await f.store.loadRun('s', 'r'))!, ids = ['r', ...Array.from({ length: 7 }, (_, index) => `r-${index}`)];
  for (const runId of ids.slice(1)) await f.store.createRun({ commandId: `create-${runId}`, actor, identity: { ...initial.identity, runId },
    graph: initial.graph, execution: initial.execution, now: 0,
    policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 8, inFlightSlots: 8 }, ordering: ['a'] } });
  f.operations.read = async request => (await f.store.loadRun(request.scopeId, request.runId))!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), execute = f.operations.execute;
  const started: string[] = [], observed: string[] = [];
  f.operations.execute = async identity => { started.push(identity.runId); await gate; await execute(identity); };
  const loop = new RunLifecycleRuntimeLoop({
    async discover(after) { return { page: await f.store.listRunProgression({ actor, after, limit: 8 }), due: { items: [], next: null } }; },
    async expire() {}, advance: (request, signal) => f.turn.advance({ schemaVersion: 1, ...request }, signal),
  }, { onRun(request) { observed.push(request.runId); if (observed.length === 8) controller.abort(); } },
  { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: 8 });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(10); expect([...started].sort()).toEqual([...ids].sort());
    expect((await f.store.readPoolHold('p')).occupancy).toEqual({ execution: 8, inFlight: 8 });
    release(); await vi.advanceTimersByTimeAsync(10); await work;
    expect([...observed].sort()).toEqual([...ids].sort());
    for (const runId of ids) expect((await f.store.loadRun('s', runId))!.progress[0]!.phase).toBe('accepted');
  } finally { controller.abort(); release(); await work; vi.useRealTimers(); }
});

// 119-C1: the registry is service-owned provenance; these controlled reads exercise its concurrency contract.
const sessionActor = { id: 'ai/mcp', issuer: 'local/mcp', subject: 'person' };
const sessionKey = (commandId = 'session-command') => ({ ledger: 'fixture-ledger', companyId: 'company', scopeId: 's', runId: 'r', commandId, actor: sessionActor });
const sessionIntegrity = createHmacIntegrity('session-fixture', new Uint8Array(32).fill(7));
function sessionCard(commandId = 'session-command', approvalId = 'card'): ApprovalRecord {
  return sealApproval({ request: { schemaVersion: 3, approvalId, scopeId: 's',
    requester: sessionActor, subject: { kind: 'run-create', commandId, runId: 'r', inputDigest: 'a'.repeat(64), admissionDigest: 'b'.repeat(64), decisionRecordId: 'authority' },
    policyRevision: 'policy', actionDigest: 'c'.repeat(64), summary: 'fixture', createdAt: 10, expiresAt: 100,
    facts: { risk: { source: 'effect-class', effectClass: 'write', authority: true }, reversibility: null, onExpiry: 'nothing-runs', requiredAssurance: 'peer-session' } },
    revision: 0, status: 'pending', decision: null }, sessionIntegrity);
}
function allowSessionCard(card: ApprovalRecord): ApprovalRecord {
  return sealApproval({ request: card.request, revision: 1, status: 'decided', decision: { schemaVersion: 4, commandId: 'allow-card', decision: 'allow',
    actor, sessionId: 'person-session', channel: 'local-terminal-card', reason: 'yes', decidedAt: 20, requestDigest: approvalRequestDigest(card.request),
    commandDigest: 'd'.repeat(64), idempotencyKeyHash: 'e'.repeat(64), assurance: 'terminal-attested', deciderClass: 'human-tty' } }, sessionIntegrity);
}
const emptySessionState = (): RunSessionState => ({ run: null, intent: null, approval: null, now: 30, admissionWindowMs: 100 });
function admittedSessionRun(run: RunSnapshot, card?: ApprovalRecord): RunSnapshot {
  return { ...run, authority: { decision: { eventId: 'authority', sequence: 1 }, ...(card ? { approval: {
    approvalId: card.request.approvalId, actionDigest: card.request.actionDigest, requestDigest: approvalRequestDigest(card.request), commandId: card.decision!.commandId } } : {}) } };
}
it('119-C1 slot race: one failed producer cannot release the other producer or its committed Q/A', async () => {
  const f = await fixture(), state = emptySessionState(), registry = new RunSessionRegistry(async () => state);
  const a = await registry.reserve(sessionKey()), b = await registry.reserve(sessionKey());
  await registry.finish(a); expect(registry.count).toBe(1);
  const card = allowSessionCard(sessionCard()), run = admittedSessionRun((await f.store.loadRun('s', 'r'))!, card);
  registry.request(b, card); registry.admission(b, run, sessionActor, sessionKey().commandId);
  Object.assign(state, { run, intent: { actor: sessionActor, commandId: sessionKey().commandId }, approval: card });
  await registry.finish(b); expect(registry.eligible(sessionKey(), run)).toBe(true); expect(registry.count).toBe(1);
});
it('119-C1 slot race: a stale sweep cannot delete a superseded request generation', async () => {
  let state = emptySessionState(), release!: (value: RunSessionState) => void, blocked = false;
  const registry = new RunSessionRegistry(async () => blocked ? new Promise(resolve => { release = resolve; }) : state);
  const pin = await registry.reserve(sessionKey()), old = sessionCard(); registry.request(pin, old); state = { ...state, approval: old };
  await registry.finish(pin); blocked = true; const sweep = registry.sweep();
  const next = await registry.reserve(sessionKey()), successor = sessionCard('session-command', 'successor'); registry.request(next, successor);
  release({ ...state, now: 200 }); await sweep; expect(registry.count).toBe(1);
  blocked = false; state = { ...state, approval: successor }; await registry.finish(next); expect(registry.count).toBe(1);
});
it('119-C1 slot race: unused Q expiry loses to a pinned fresh allow and does not erase the admitted basis', async () => {
  const f = await fixture(); let state = emptySessionState(), release!: (value: RunSessionState) => void, blocked = false;
  const registry = new RunSessionRegistry(async () => blocked ? new Promise(resolve => { release = resolve; }) : state);
  const q = await registry.reserve(sessionKey()), card = sessionCard(); registry.request(q, card); state = { ...state, approval: card }; await registry.finish(q);
  blocked = true; const sweep = registry.sweep(), d = await registry.reserve(sessionKey()), allowed = allowSessionCard(card);
  registry.decision(d, allowed); release({ ...state, now: 200 }); await sweep;
  const run = admittedSessionRun((await f.store.loadRun('s', 'r'))!, allowed); registry.admission(d, run, sessionActor, sessionKey().commandId);
  blocked = false; state = { ...state, run, intent: { actor: sessionActor, commandId: sessionKey().commandId }, approval: allowed, now: 1000 };
  await registry.finish(d); expect(registry.count).toBe(1); expect(registry.eligible(sessionKey(), run)).toBe(true);
});
it('119-C1 capacity: full registry admits existing command pins and refuses a new producer before it writes', async () => {
  const registry = new RunSessionRegistry(async () => emptySessionState());
  const pins = [];
  for (let i = 0; i < runSessionRegistryData.maxEntries; i++) pins.push(await registry.reserve(sessionKey(`command-${i}`)));
  const existing = await registry.reserve(sessionKey('command-0')); expect(registry.count).toBe(runSessionRegistryData.maxEntries);
  const write = vi.fn();
  await expect(registry.reserve(sessionKey('overflow')).then(write)).rejects.toMatchObject({ code: 'AI_RUN_SESSION_CAPACITY', params: { count: runSessionRegistryData.maxEntries, limit: runSessionRegistryData.maxEntries } });
  expect(write).not.toHaveBeenCalled(); await registry.finish(existing); expect(registry.count).toBe(runSessionRegistryData.maxEntries);
  const params = { count: registry.count, limit: registry.limit };
  expect(ErrorRegistry.get('AI_RUN_SESSION_CAPACITY', 'en', { ...params, operation: 'proposal' })!.message).toContain('Try the proposal again after capacity becomes available.');
  expect(ErrorRegistry.get('AI_RUN_SESSION_CAPACITY', 'en', { ...params, operation: 'approval' })!.message).toContain('Answer the same card again if it is still valid; if it expired, propose again.');
  expect(ErrorRegistry.get('AI_RUN_SESSION_CAPACITY', 'tr', { ...params, operation: 'approval' })!.message).toContain('Kart hâlâ geçerliyse aynı kartı yeniden cevaplayın; süresi dolduysa yeniden önerin.');
});
it('119-C1 cleanup: terminal work retires its slot; active A keeps Q after its approval window', async () => {
  const f = await fixture(), card = allowSessionCard(sessionCard()), run = admittedSessionRun((await f.store.loadRun('s', 'r'))!, card);
  let state: RunSessionState = { ...emptySessionState(), run, intent: { actor: sessionActor, commandId: sessionKey().commandId }, approval: card, now: 1000 };
  const registry = new RunSessionRegistry(async () => state), pin = await registry.reserve(sessionKey());
  registry.request(pin, card); registry.admission(pin, run, sessionActor, sessionKey().commandId); await registry.finish(pin);
  await registry.sweep(); expect(registry.eligible(sessionKey(), run)).toBe(true);
  state = { ...state, run: { ...run, state: { kind: 'terminal', outcome: 'completed', reason: 'completed' } } };
  await registry.sweep(); expect(registry.count).toBe(0);
});
it('119-C1 cleanup: unknown reads preserve entries and concurrent sweeps share a single execution', async () => {
  let fail = false, block = false, release!: () => void;
  const read = vi.fn(async () => { if (fail) throw Error('READ_UNAVAILABLE'); if (block) await new Promise<void>(resolve => { release = resolve; }); return { ...emptySessionState(), approval: sessionCard() }; });
  const registry = new RunSessionRegistry(read), pin = await registry.reserve(sessionKey()); registry.request(pin, sessionCard()); await registry.finish(pin);
  fail = true; await expect(registry.sweep()).resolves.toEqual({ failed: 1, codes: ['QUERY_UNEXPECTED_FAILURE'] }); expect(registry.count).toBe(1);
  fail = false; block = true; const before = read.mock.calls.length, first = registry.sweep(), second = registry.sweep();
  expect(first).toBe(second); expect(read.mock.calls.length - before).toBe(1); release(); await first; expect(registry.count).toBe(1);
});
it('119-C1 secfix: a poisoned slot does not stop later reconciliation or the next page frontier', async () => {
  let fail = false;
  const read = vi.fn(async (identity: ReturnType<typeof sessionKey>) => {
    if (fail && identity.commandId === 'first') throw ErrorRegistry.createError('APPROVAL_CONFLICT');
    return { ...emptySessionState(), approval: sessionCard(identity.commandId, identity.commandId) };
  });
  const registry = new RunSessionRegistry(read);
  for (const command of ['first', 'second', 'third']) {
    const pin = await registry.reserve(sessionKey(command)); registry.request(pin, sessionCard(command, command)); await registry.finish(pin);
  }
  fail = true; read.mockClear();
  await expect(registry.sweep(2)).resolves.toEqual({ failed: 1, codes: ['APPROVAL_CONFLICT'] });
  expect(read.mock.calls.map(([identity]) => identity.commandId)).toEqual(['first', 'second']);
  read.mockClear();
  await expect(registry.sweep(1)).resolves.toEqual({ failed: 0, codes: [] });
  expect(read.mock.calls.map(([identity]) => identity.commandId)).toEqual(['third']); expect(registry.count).toBe(3);
});
it('119-C1 secfix: unknown capacity is distinguished without writes and unknown admission cannot start', async () => {
  const f = await fixture(), run = admittedSessionRun((await f.store.loadRun('s', 'r'))!);
  let fail = false, mismatch = false;
  const registry = new RunSessionRegistry(async () => {
    if (fail) throw ErrorRegistry.createError('RUN_STORE_CORRUPT');
    return { ...emptySessionState(), run, intent: { actor: mismatch ? actor : sessionActor, commandId: sessionKey().commandId } };
  }, 1);
  const pin = await registry.reserve(sessionKey()); registry.admission(pin, run, sessionActor, sessionKey().commandId); await registry.finish(pin);
  expect(registry.eligible(sessionKey(), run)).toBe(true);
  fail = true;
  await expect(registry.sweep()).resolves.toEqual({ failed: 1, codes: ['RUN_STORE_CORRUPT'] });
  expect(registry.eligible(sessionKey(), run)).toBe(false);
  expect(registry.admissionState(sessionKey(), run)).toBe('unknown');
  expect(registry.admissionState(sessionKey('no-admission'), run)).toBe('ineligible');
  expect(registry.admissionState(sessionKey(), { ...run, authority: { decision: { eventId: 'changed-authority', sequence: 2 } } })).toBe('ineligible');
  const write = vi.fn();
  await expect(registry.reserve(sessionKey('overflow')).then(write)).rejects.toMatchObject({ code: 'AI_RUN_SESSION_CAPACITY', params: { count: 1, limit: 1, unknown: 1, operation: 'proposal' } });
  expect(write).not.toHaveBeenCalled(); expect(registry.count).toBe(1);
  const params = { count: 1, limit: 1, unknown: 1, operation: 'proposal' };
  expect(ErrorRegistry.get('AI_RUN_SESSION_CAPACITY', 'en', params)!.message).toBe('AI work capacity reached (1/1). The state of 1 entries could not be verified. Resolve the reported read or reconciliation errors.');
  expect(ErrorRegistry.get('AI_RUN_SESSION_CAPACITY', 'tr', params)!.message).toBe('Yapay zekâ iş kapasitesi dolu (1/1). 1 kaydın durumu doğrulanamadı. Bildirilen okuma veya uzlaştırma hatalarını giderin.');
  fail = false;
  await expect(registry.sweep()).resolves.toEqual({ failed: 0, codes: [] });
  expect(registry.eligible(sessionKey(), run)).toBe(true); expect(registry.count).toBe(1);
  mismatch = true;
  await expect(registry.sweep()).resolves.toEqual({ failed: 1, codes: ['RUN_STORE_CORRUPT'] });
  await expect(registry.sweep()).resolves.toEqual({ failed: 1, codes: ['RUN_STORE_CORRUPT'] });
  expect(registry.eligible(sessionKey(), run)).toBe(false); expect(registry.count).toBe(1);
});
it.skipIf(process.platform === 'win32')('119-C1 secfix: configured discovery advances person and healthy AI despite poisoned cleanup and a failing diagnostic observer', async () => {
  const project = await mkdtemp(join(tmpdir(), 'deckent-progression-cleanup-')); roots.push(project);
  await mkdir(join(project, '.deckent'), { mode: 0o700 });
  const home = join(project, 'home'), env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(project, 'data') },
    runRuntime: { pollIntervalMs: 1, failureBackoffMs: 10, pageSize: 2, maxConcurrentRuns: 2, maxReservationsPerTurn: 1 } }));
  const opened = await openConfiguredAttemptStore(project, { env }); stores.push(opened.store);
  const ref = ({ id, issuer, subject }: ReturnType<typeof readLocalOsIdentity>) => ({ id, issuer, subject });
  const person = ref(readLocalOsIdentity()), ai = ref(withMcpPrincipal(readLocalOsIdentity));
  const principals = [person, ai].map(({ issuer, subject }) => ({ issuer, subject }));
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'cleanup-fixture', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['inspect', 'reserve', 'cancel'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
  ] }), { mode: 0o600 });
  await ensureConfiguredTerminalIdentity(project, 's', { env });
  const config = await loadConfig(project, { env, heal: false }), capacity = { executionSlots: 2, inFlightSlots: 2 };
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'a', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity });
  for (const [runId, owner] of [['person', person], ['ai', ai]] as const) await opened.store.createRun({ commandId: runId, actor: owner,
    identity: { scopeId: 's', runId, layoutRevision: opened.layout.revision }, graph, execution: fixtureExecution(graph), now: 0,
    policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['a'] } });
  // Held capacity makes the real turn publish without starting a worker; both discoveries must still reach it.
  await opened.store.applyPoolHold({ command: { scopeId: 's', commandId: 'hold', poolId: 'p', action: 'hold', reason: 'discovery fixture' }, actor: { issuer: person.issuer, subject: person.subject }, atMs: 0 }, () => {});
  const run = (await opened.store.loadRun('s', 'ai'))!, identity = { ...sessionKey('ai'), ledger: sha256(opened.path), companyId: config.company.id, runId: 'ai', actor: ai };
  const registry = new RunSessionRegistry(async key => {
    if (key.commandId === 'poison') throw ErrorRegistry.createError('APPROVAL_CONFLICT', { params: { private: 'must never be reported' } });
    return { ...emptySessionState(), run, intent: { actor: ai, commandId: 'ai' } };
  });
  const poison = await registry.reserve({ ...identity, commandId: 'poison', runId: 'poison' }, null);
  await expect(registry.finish(poison)).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
  const pin = await registry.reserve(identity); registry.admission(pin, run, ai, 'ai'); await registry.finish(pin);
  const controller = new AbortController(), seen = new Set<string>(), diagnostics: unknown[] = [];
  const loop = await prepareConfiguredRunRuntime(project, {
    onRun(cursor) { seen.add(cursor.runId); if (seen.size === 2) controller.abort(); },
    onError(cursor, error) { diagnostics.push({ cursor, code: error.code, params: error.params }); throw Error('OBSERVER_UNAVAILABLE'); },
  }, work => work(), { env }, registry);
  const work = loop.run(controller.signal);
  try {
    await expect.poll(() => [...seen].sort(), { timeout: 5000 }).toEqual(['ai', 'person']);
    expect(diagnostics).toContainEqual({ cursor: null, code: 'APPROVAL_CONFLICT', params: { count: 1 } });
    expect(diagnostics.every(value => JSON.stringify(value) === JSON.stringify({ cursor: null, code: 'APPROVAL_CONFLICT', params: { count: 1 } }))).toBe(true);
    expect(registry.count).toBe(2); expect(registry.eligible(identity, run)).toBe(true);
    for (const runId of ['person', 'ai']) expect((await opened.store.loadRun('s', runId))!.bindings).toHaveLength(0);
  } finally { controller.abort(); await work; clearConfigCache(); }
});
it('119-C1 capacity coalesces with a partial sweep and completes the full tracked pass before refusing a new slot', async () => {
  let now = 30, blocked = false, release!: () => void;
  const registry = new RunSessionRegistry(async identity => {
    if (blocked) { blocked = false; await new Promise<void>(resolve => { release = resolve; }); }
    return { ...emptySessionState(), now, approval: identity.commandId === 'third' ? null : sessionCard(identity.commandId, identity.commandId) };
  }, 2);
  for (const command of ['first', 'second']) { const pin = await registry.reserve(sessionKey(command)); registry.request(pin, sessionCard(command, command)); await registry.finish(pin); }
  now = 200; blocked = true; const partial = registry.sweep(1), next = registry.reserve(sessionKey('third'));
  release(); await partial; const pin = await next;
  expect(registry.count).toBe(1); await registry.finish(pin); expect(registry.count).toBe(0);
});
it('119-C1 cleanup: verified rollback, deny and unused approval expiry release; unknown committed Q does not', async () => {
  let state = emptySessionState(); const registry = new RunSessionRegistry(async () => state);
  await registry.finish(await registry.reserve(sessionKey())); expect(registry.count).toBe(0);
  const pin = await registry.reserve(sessionKey()), card = sessionCard(); registry.request(pin, card); state = { ...state, approval: card }; await registry.finish(pin);
  state = { ...state, now: 100 }; await registry.sweep(); expect(registry.count).toBe(0);
  const unknown = await registry.reserve(sessionKey(), null); state = { ...state, now: 30 };
  await expect(registry.finish(unknown)).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' }); expect(registry.count).toBe(1);
});
it('119-C1 F2: a changed or newly committed approval after the verified baseline stays unknown, including after expiry', async () => {
  let state: RunSessionState = { ...emptySessionState(), approval: sessionCard() };
  const registry = new RunSessionRegistry(async () => state, 1), pin = await registry.reserve(sessionKey());
  state = { ...state, approval: allowSessionCard(state.approval!) };
  await expect(registry.finish(pin)).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
  state = { ...state, now: 1000 };
  await expect(registry.sweep()).resolves.toEqual({ failed: 1, codes: ['APPROVAL_CONFLICT'] });
  await expect(registry.reserve(sessionKey('other'))).rejects.toMatchObject({ code: 'AI_RUN_SESSION_CAPACITY', params: { unknown: 1 } });
  expect(registry.count).toBe(1);
  const other = new RunSessionRegistry(async () => state, 1);
  state = { ...state, approval: null };
  const external = await other.reserve(sessionKey()); state = { ...state, approval: sessionCard() };
  await expect(other.finish(external)).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
  expect(other.count).toBe(1);
});
it('119-C1 maintenance never calls either start branch or reserves, but evaluates proven exited work', async () => {
  const f = await fixture('pass', [], ['a', 'b'], 1);
  await f.operations.reserve({ ...query, commandId: 'reserved-before-restart', expectedRevision: 0 });
  const canExecute = vi.fn(async () => true); f.operations.canExecute = canExecute;
  const execute = vi.spyOn(f.operations, 'execute'), reserve = vi.spyOn(f.operations, 'reserve');
  await f.turn.advance(query, new AbortController().signal, true);
  expect(canExecute).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  const binding = (await f.store.loadRun('s', 'r'))!.bindings[0]!; await f.operations.execute(binding.identity); execute.mockClear();
  const maintained = await f.turn.advance(query, new AbortController().signal, true);
  expect(maintained.attempted).toBe(0); expect(f.stats().evaluations).toBe(1); expect(execute).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  expect(maintained.run.tasks.map(task => task.phase)).toEqual(['accepted', 'pending']);
});
it('119-C1 actor selection refuses a partial or unknown actor and merged pages retain a single fair frontier', () => {
  const read = (channel: 'mcp' | undefined) => channel === 'mcp' ? sessionActor : actor;
  expect(selectProgressionActor(sessionActor, read)).toBe('mcp'); expect(selectProgressionActor(actor, read)).toBeUndefined();
  expect(() => selectProgressionActor({ ...sessionActor, id: 'unknown' }, read)).toThrowError(expect.objectContaining({ code: 'RUN_PROGRESSION_AUTHORITY_REQUIRED' }));
  const a = { scopeId: 's', runId: 'a' }, b = { scopeId: 's', runId: 'b' }, c = { scopeId: 's', runId: 'c' };
  expect(mergeProgressionPages([{ items: [a, c], next: null }, { items: [b], next: null }], 2)).toEqual({ items: [a, b], next: b });
  expect(mergeProgressionPages([{ items: [c], next: null }, { items: [], next: null }], 2)).toEqual({ items: [c], next: null });
});
it('119-C1 producer metadata is post-commit: request rollback/replay are not fresh and a lost response keeps the fresh commit', async () => {
  const f = await fixture(), committed = vi.fn(), journal = openSqliteApprovalStore(f.path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, 'forbid', committed);
  const db = new DatabaseSync(f.path), card = sessionCard();
  try {
    db.exec("CREATE TRIGGER reject_session_card BEFORE INSERT ON approval_outbox BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
    expect(() => journal.store.create(card)).toThrow(); expect(committed).not.toHaveBeenCalled(); expect(journal.store.load('s', 'card')).toBeNull();
    db.exec('DROP TRIGGER reject_session_card');
    journal.store.create(card); journal.store.create(card); expect(committed).toHaveBeenCalledTimes(1); expect(committed).toHaveBeenLastCalledWith(card, 'create');
    const allowed = allowSessionCard(card), receipt = { operation: 'decide' as const, scopeId: 's', commandId: allowed.decision!.commandId, fingerprint: allowed.decision!.commandDigest, record: allowed };
    committed.mockImplementationOnce(() => { throw Error('RESPONSE_LOST_AFTER_COMMIT'); });
    expect(() => journal.store.transitionWithSettlement(card, allowed, receipt)).toThrow('RESPONSE_LOST_AFTER_COMMIT');
    expect(journal.store.load('s', 'card')).toEqual(allowed);
    expect(journal.store.transitionWithSettlement(card, allowed, receipt).commit).toBe('replay'); expect(committed).toHaveBeenCalledTimes(2);
    const successor = sessionCard('session-command', 'successor');
    db.exec("CREATE TRIGGER reject_session_supersede BEFORE INSERT ON approval_outbox BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
    expect(() => journal.store.supersedeRunCreate(allowed, successor)).toThrow(); expect(committed).toHaveBeenCalledTimes(2);
    expect(journal.store.findRunCreate('s', 'session-command')).toEqual(allowed);
    db.exec('DROP TRIGGER reject_session_supersede');
    journal.store.supersedeRunCreate(allowed, successor); expect(committed).toHaveBeenLastCalledWith(successor, 'supersede');
    expect(() => journal.store.supersedeRunCreate(allowed, successor)).toThrow(); expect(committed).toHaveBeenCalledTimes(3);
  } finally { db.close(); journal.close(); }
});

it('119-C1 Run producer rollback publishes nothing; lost-response and transaction replay retain one fresh admission', async () => {
  const f = await fixture(), run = (await f.store.loadRun('s', 'r'))!, committed = vi.fn();
  const input = { commandId: 'producer-command', actor: sessionActor, identity: { ...run.identity, runId: 'producer-run' },
    graph: run.graph, execution: run.execution, now: 10, policy: { schemaVersion: 2 as const, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: run.graph.tasks.map(task => task.id) } };
  await expect(f.store.createRun(input, undefined, () => { throw Error('ROLLBACK'); }, undefined, committed)).rejects.toThrow('ROLLBACK');
  expect(committed).not.toHaveBeenCalled(); expect(await f.store.loadRun('s', 'producer-run')).toBeNull();
  const db = new DatabaseSync(f.path);
  try { expect(db.prepare("SELECT * FROM run_execution_intents WHERE run_id='producer-run'").all()).toEqual([]); } finally { db.close(); }
  committed.mockImplementationOnce(() => { throw Error('RESPONSE_LOST'); });
  await expect(f.store.createRun(input, undefined, undefined, undefined, committed)).rejects.toThrow('RESPONSE_LOST');
  expect(await f.store.loadRun('s', 'producer-run')).not.toBeNull(); expect(committed).toHaveBeenLastCalledWith(expect.anything(), 'fresh');
  await f.store.createRun(input, undefined, undefined, undefined, committed);
  expect(committed).toHaveBeenCalledTimes(2); expect(committed).toHaveBeenLastCalledWith(expect.anything(), 'replay');
});

it('119-C1 custody selection: unlaunched binding is not maintenance; proven started grant actor survives; unknown custody holds', async () => {
  const f = await fixture('pass', [], ['a'], 1);
  await f.operations.reserve({ ...query, commandId: 'custody-reserve', expectedRevision: 0 });
  const run = (await f.store.loadRun('s', 'r'))!, binding = run.bindings[0]!;
  expect(progressionCustodyActor(run, [null])).toBeNull();
  await f.operations.execute(binding.identity);
  const dispatch = (await f.store.loadBoundDispatch(binding.identity))!;
  expect(progressionCustodyActor((await f.store.loadRun('s', 'r'))!, [dispatch])).toEqual(dispatch.grant!.principal);
  expect(progressionCustodyActor(run, [{ ...dispatch, launch: 'pending', grant: null }])).toBeNull();
  expect(() => progressionCustodyActor(run, [{ ...dispatch, worker: null, terminal: null }])).toThrowError(expect.objectContaining({ code: 'DISPATCH_NOT_ADMITTED' }));
  const exited = (await f.store.loadRun('s', 'r'))!;
  const source = { readRunProgressionIntent: () => ({ actor: sessionActor, commandId: 'session-command' }), loadRun: async () => exited,
    loadBoundDispatch: vi.fn(async () => dispatch) };
  const read = (channel: 'mcp' | undefined) => channel === 'mcp' ? sessionActor : dispatch.grant!.principal;
  await expect(selectRunProgression(query, 'fixture-ledger', 'company', source, read, undefined, 'maintenance')).resolves.toEqual({ channel: undefined, maintenance: true });
  source.loadBoundDispatch.mockResolvedValue({ ...dispatch, grant: { ...dispatch.grant!, principal: { ...actor, id: 'foreign' } } });
  await expect(selectRunProgression(query, 'fixture-ledger', 'company', source, read, undefined, 'maintenance')).rejects.toMatchObject({ code: 'RUN_PROGRESSION_AUTHORITY_REQUIRED' });
  expect(() => progressionCustodyActor(exited, [null])).toThrowError(expect.objectContaining({ code: 'DISPATCH_NOT_ADMITTED' }));
  expect(() => progressionCustodyActor({ ...exited, bindings: [binding, binding] }, [dispatch, { ...dispatch, grant: { ...dispatch.grant!, principal: actor } }]))
    .toThrowError(expect.objectContaining({ code: 'DISPATCH_NOT_ADMITTED' }));
});

it('119-C4: diagnosis keeps exact current cells, restrictions and approval apart; maintenance never asks for a new start cell', async () => {
  const f = await fixture(), run = (await f.store.loadRun('s', 'r'))!;
  const ai: VerifiedPrincipal = { id: 'ai', issuer: 'host/mcp', subject: 'ai', assurance: 'workload-verified', scopeIds: ['s'] };
  const principals = [{ issuer: ai.issuer, subject: ai.subject }];
  const empty = policySchema.parse({ schemaVersion: 1, revision: 'v20', grants: [], restrictions: [] });
  const missing = runProgressionMissingPermissions(run, ai, empty, false);
  expect(missing).toContainEqual({ kind: 'run', id: 'r', action: 'reserve', scope: 's', reason: 'NO_GRANT', code: 'POLICY_DENIED' });
  expect(missing).toContainEqual({ kind: 'run', id: 'r', action: 'cancel', scope: 's', reason: 'NO_GRANT', code: 'POLICY_DENIED' });
  expect(missing).toContainEqual({ kind: 'attempt', id: 'all', action: 'execute', scope: 's', reason: 'NO_GRANT', code: 'POLICY_DENIED' });
  const policy = policySchema.parse({ ...empty, grants: [{ id: 'start', effect: 'allow', actions: ['inspect', 'reserve', 'cancel'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'evaluate', 'read-output', 'recover-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } }] });
  expect(runProgressionMissingPermissions(run, ai, policy, false)).toEqual([]);
  const denied = policySchema.parse({ ...policy, restrictions: [{ id: 'company', actions: ['reserve'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } }] });
  expect(runProgressionMissingPermissions(run, ai, denied, false)).toEqual([{ kind: 'run', id: 'r', action: 'reserve', scope: 's', reason: 'DENIED', code: 'POLICY_DENIED' }]);
  const asks = policySchema.parse({ ...policy, grants: [...policy.grants, { id: 'ask', effect: 'require-approval', actions: ['cancel'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } }] });
  expect(runProgressionMissingPermissions(run, ai, asks, false)).toEqual([{ kind: 'run', id: 'r', action: 'cancel', scope: 's', reason: 'APPROVAL_REQUIRED', code: 'POLICY_APPROVAL_UNSUPPORTED' }]);
  expect(runProgressionMissingPermissions(run, ai, empty, true)).toEqual([]);
});
