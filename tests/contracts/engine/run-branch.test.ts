import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { RunAdmissionApplication, planSchedulingWave } from '#engine/index.js';
import { resolveAdmissionBranch, runSnapshotSchema } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const s of stores.splice(0)) s.close(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const graph = { schemaVersion: 2 as const, revision: 1,
  tasks: ['yes', 'no', 'join'].map(id => ({ id, kind: 'custom', dependencies: id === 'join' ? ['yes', 'no'] : [], acceptanceCriteria: ['verified'] })),
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Check result', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const branch = { schemaVersion: 1 as const, input: { id: 'purchase-authorized', revision: 'evidence-1', value: true }, whenTrue: 'yes', whenFalse: 'no', join: 'join' };
const command = { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph, branch };
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const actor = { id: 'u', issuer: 'test', subject: 'u' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-branch-')); roots.push(root); const path = join(root, 'ledger.db');
  const open = async () => { const s = await openSqliteAttemptStore(path, options, 'allow', custodyProfiles); stores.push(s); return s; };
  const store = await open(); await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 8, inFlightSlots: 8 } });
  const state = { contexts: 0, allowed: true };
  const app = (s: SqliteAttemptStore) => new RunAdmissionApplication(s,
    { async verify() { return { ...actor, assurance: 'os-user', scopeIds: ['s'] }; } },
    { async authorize() { if (!state.allowed) throw new Error('POLICY_DENIED'); } }, { async authorize() {} },
    { async resolve(input) { state.contexts++; return { now: 0, layoutRevision: 'l', execution: fixtureExecution(input.graph),
      policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 8, inFlightSlots: 8 }, ordering: input.graph.tasks.map(t => t.id) } }; } });
  return { store, path, open, app, state };
}
it.each([true, false])('persists choice %s and replays after reopen without context/decision resampling', async value => {
  const f = await fixture(); const input = { ...command, branch: { ...branch, input: { ...branch.input, value } } };
  const first = await f.app(f.store).create(input); const selected = value ? 'yes' : 'no';
  expect(first.run.branch).toMatchObject({ selectedTaskId: selected, notSelectedTaskId: value ? 'no' : 'yes' });
  expect(first.run.tasks.map(t => t.id)).toEqual([selected, 'join']);
  expect(first.run.tasks[1]!.dependencies).toEqual([selected]);
  f.store.close(); stores.splice(stores.indexOf(f.store), 1); const reopened = await f.open();
  expect(await f.app(reopened).create(input)).toEqual(first); expect(f.state.contexts).toBe(1);
  const saved = (await reopened.loadRun('s', 'r'))!;
  const wave = planSchedulingWave(saved.graph, { schemaVersion: 2, capacity: { executionSlots: 8, inFlightSlots: 8 }, ordering: saved.graph.tasks.map(t => t.id),
    snapshot: { graphRevision: 1, now: 0, progress: saved.progress } });
  expect(wave.selectedTaskIds).toEqual([selected]);
  await expect(f.app(reopened).create({ ...input, branch: { ...input.branch, input: { ...input.branch.input, revision: 'changed' } } })).rejects.toThrow('RUN_COMMAND_CONFLICT');
  f.state.allowed = false; await expect(f.app(reopened).create(input)).rejects.toThrow('POLICY_DENIED');
});
it('rejects cross-branch consumers and malformed diamonds instead of silently rewriting dependencies', () => {
  expect(() => resolveAdmissionBranch({ ...graph, tasks: [...graph.tasks, { ...graph.tasks[0]!, id: 'leak', dependencies: ['no'] }] }, branch)).toThrow('TASK_GRAPH_INVALID');
  expect(() => resolveAdmissionBranch(graph, { ...branch, join: 'yes' })).toThrow('TASK_GRAPH_INVALID');
  expect(() => resolveAdmissionBranch(graph, { ...branch, input: { ...branch.input, value: 'true' } })).toThrow();
});
it('rolls choice, Run and receipt back together if persistence fails before commit', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.path);
  try {
    db.exec("CREATE TRIGGER deny_receipt BEFORE INSERT ON run_receipts BEGIN SELECT RAISE(ABORT,'test'); END;");
    await expect(f.app(f.store).create(command)).rejects.toThrow();
    expect(await f.store.loadRun('s', 'r')).toBeNull(); expect(await f.store.loadRunReceipt('s', 'create')).toBeNull();
    db.exec('DROP TRIGGER deny_receipt');
    expect((await f.app(await f.open()).create(command)).run.branch?.selectedTaskId).toBe('yes');
  } finally { db.close(); }
});
it('concurrent conflicting choices yield one durable winner', async () => {
  const f = await fixture(); const other = await f.open();
  const results = await Promise.allSettled([f.app(f.store).create(command), f.app(other).create({ ...command, branch: { ...branch, input: { ...branch.input, value: false } } })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  const saved = (await f.store.loadRun('s', 'r'))!;
  expect(saved.progress).toHaveLength(2); expect(saved.branch).toBeDefined();
});
it('cancellation survives reopen and admission replay cannot reactivate a branch', async () => {
  const f = await fixture(); await f.app(f.store).create(command);
  await f.store.cancelRun({ commandId: 'cancel', actor, scopeId: 's', runId: 'r', expectedRevision: 0 });
  const reopened = await f.open(); await f.app(reopened).create(command);
  expect((await reopened.loadRun('s', 'r'))!.cancelRequested).toBe(true);
  await expect(reopened.reserveRunTasks({ commandId: 'start', actor, scopeId: 's', runId: 'r', expectedRevision: 1, now: 0,
    identities: [{ runId: 'r', scopeId: 's', layoutRevision: 'l', taskId: 'yes', attemptId: 'a', generation: 1 }] })).rejects.toThrow('RUN_CANCEL_REQUESTED');
});
it('unblocks join only after retained selected-attempt evidence is accepted, with no attempt for the unselected task', async () => {
  const f = await fixture(); await f.app(f.store).create(command);
  const identity = { runId: 'r', scopeId: 's', layoutRevision: 'l', taskId: 'yes', attemptId: 'a', generation: 1 };
  await f.store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'r', expectedRevision: 0, now: 0, identities: [identity] });
  const request = { protocolVersion: 1 as const, identity, workspace: '/workspace', argv: ['task'] }; const claim = { request, owner: 'worker' };
  await f.store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(f.store, claim);
  await f.store.retainDispatchOutput(claim, { schemaVersion: 1, scopeId: 's', digest: 'a'.repeat(64), byteLength: 10 });
  await f.store.finishDispatch(claim, { handle: 'h', exitCode: 0, interrupted: false });
  const dispatch = (await f.store.readDispatch(request))!;
  const before = (await f.store.loadRun('s', 'r'))!;
  expect(before.progress.find(t => t.taskId === 'yes')!.phase).toBe('evaluating');
  const wave = (run: typeof before) => planSchedulingWave(run.graph, { schemaVersion: 2, capacity: { executionSlots: 8, inFlightSlots: 8 }, ordering: ['yes', 'join'], snapshot: { graphRevision: 1, now: 0, progress: run.progress } });
  expect(wave(before).selectedTaskIds).toEqual([]);
  await f.store.commitTaskEvaluation({ commandId: 'accept', actor, expectedRevision: before.revision, dispatch,
    evaluation: { schemaVersion: 1, evaluationId: 'accept', identity, graphRevision: 1, attemptRevision: 1,
      criteria: [{ criterionId: 'verified', verdict: 'pass', evidenceIds: ['proof'] }] } });
  const after = (await (await f.open()).loadRun('s', 'r'))!;
  expect(wave(after).selectedTaskIds).toEqual(['join']); expect(after.bindings.map(b => b.identity.taskId)).toEqual(['yes']);
  expect(() => runSnapshotSchema.parse({ ...after, branch: { ...after.branch, selectedTaskId: 'no' } })).toThrow();
});

it.each(['before', 'after'] as const)('survives SIGKILL %s the atomic decision/Run commit', async boundary => {
  const f = await fixture(); const resolved = resolveAdmissionBranch(graph, branch);
  const input = { commandId: 'create', actor, identity: { scopeId: 's', runId: 'r', layoutRevision: 'l' },
    graph: resolved.graph, branch: resolved.decision, execution: fixtureExecution(resolved.graph), now: 0,
    policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 8, inFlightSlots: 8 }, ordering: ['yes', 'join'] } };
  const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/adapters/index.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const { openSqliteAttemptStore } = await import(process.argv[1]);
    const store = await openSqliteAttemptStore(process.argv[2], JSON.parse(process.argv[3]));
    const original = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'COMMIT' && process.argv[4] === 'before') process.kill(process.pid, 'SIGKILL');
      const result = original.call(this, sql);
      if (sql === 'COMMIT' && process.argv[4] === 'after') process.kill(process.pid, 'SIGKILL');
      return result;
    };
    await store.createRun(JSON.parse(process.argv[5]));
    process.exit(17);
  `, moduleUrl, f.path, JSON.stringify(options), boundary, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
  const [code, signal] = await once(child, 'close');
  expect({ code, signal }, stderr).toEqual({ code: null, signal: 'SIGKILL' });
  const reopened = await f.open();
  if (boundary === 'before') {
    expect(await reopened.loadRun('s', 'r')).toBeNull();
    expect(await reopened.loadRunReceipt('s', 'create')).toBeNull();
  } else {
    expect((await reopened.loadRun('s', 'r'))!.branch?.selectedTaskId).toBe('yes');
  }
  const receipt = await reopened.createRun(input);
  expect(receipt.snapshot.branch?.selectedTaskId).toBe('yes');
  expect(await reopened.createRun(input)).toEqual(receipt);
});
it('upgrades ledger22 without fabricating decisions for ordinary Runs or rewriting receipts', async () => {
  const f = await fixture(); const ordinary = { ...command, branch: undefined };
  await f.app(f.store).create(ordinary);
  const before = await f.store.loadRunReceipt('s', 'create');
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const db = new DatabaseSync(f.path); db.exec('DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS effect_intents; DROP TABLE IF EXISTS agent_turn_tool_calls; DROP TABLE IF EXISTS agent_turns; DROP TABLE IF EXISTS worker_event_logs; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=22'); db.close();
  await expect(openSqliteAttemptStore(f.path, options, 'forbid')).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  const reopened = await f.open();
  expect(await reopened.loadRunReceipt('s', 'create')).toEqual(before);
  expect((await reopened.loadRun('s', 'r'))!.branch).toBeUndefined();
});
it('repairs a persisted legacy cancel-requested Run only through a new command at the current revision, never by replay', async () => {
  const f = await fixture(); await f.app(f.store).create(command);
  const cancel = { commandId: 'cancel', actor, scopeId: 's', runId: 'r', expectedRevision: 0 };
  const current = (await f.store.cancelRun(cancel)).snapshot;
  expect(current.progress.map(task => task.phase)).toEqual(['cancelled', 'cancelled']);
  // Pre-change shape: flag set, never-reserved tasks still pending, in both the Run row and the immutable old receipt.
  const legacy = runSnapshotSchema.parse({ ...current, progress: current.progress.map(task => ({ ...task, phase: 'pending' })) });
  const db = new DatabaseSync(f.path);
  try {
    db.prepare('UPDATE runs SET snapshot=? WHERE scope_id=? AND run_id=?').run(JSON.stringify(legacy), 's', 'r');
    db.prepare('UPDATE run_receipts SET snapshot=? WHERE scope_id=? AND command_id=?').run(JSON.stringify(legacy), 's', 'cancel');
  } finally { db.close(); }
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const store = await f.open();
  expect((await store.cancelRun(cancel)).snapshot).toEqual(legacy);
  expect((await store.loadRun('s', 'r'))!.progress.map(task => task.phase)).toEqual(['pending', 'pending']);
  await expect(store.cancelRun({ ...cancel, commandId: 'repair' })).rejects.toThrow('RUN_STORE_CONFLICT');
  const repair = { ...cancel, commandId: 'repair', expectedRevision: legacy.revision };
  const repaired = await store.cancelRun(repair);
  expect(repaired.snapshot.revision).toBe(legacy.revision + 1);
  expect(repaired.snapshot.progress.map(task => task.phase)).toEqual(['cancelled', 'cancelled']);
  expect(await store.cancelRun(repair)).toEqual(repaired);
  expect((await store.cancelRun(cancel)).snapshot).toEqual(legacy);
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = await f.open(); const saved = (await reopened.loadRun('s', 'r'))!;
  expect(saved.revision).toBe(legacy.revision + 1); expect(saved.progress.map(task => task.phase)).toEqual(['cancelled', 'cancelled']);
  await expect(reopened.cancelRun({ ...cancel, commandId: 'late', expectedRevision: legacy.revision })).rejects.toThrow('RUN_STORE_CONFLICT');
});
