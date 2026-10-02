import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteAttemptStore, readMonitorLedger, type SqliteAttemptStore } from '#adapters/index.js';
import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { AuditApplication, ExecutionPoolHoldApplication, PoolControlPolicyAuthorization } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';
import { DOWNGRADE_TO_V43_LEDGER_SQL as DOWNGRADE_TO_PREVIOUS_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

// MONITOR-DATA: the monitor's ledger reader on real ledgers written by the product store (no synthetic Run snapshots).
const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { stores.splice(0).forEach(store => { try { store.close(); } catch { /* closed by the test */ } }); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 100, journalMode: 'wal' as const, durability: 'full' as const };
const actor = { id: 'operator', issuer: 'test', subject: 'operator' }, principal = { ...actor, assurance: 'os-user', scopeIds: ['s', 's2'] };
const graph = (ids: readonly string[], deps: Record<string, string[]> = {}) => ({ schemaVersion: 2 as const, revision: 1,
  tasks: ids.map(id => ({ id, kind: 'fixture', dependencies: deps[id] ?? [], acceptanceCriteria: ['verified'] })),
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] });
const identity = (scopeId: string, runId: string, taskId: string): AttemptIdentity => ({ scopeId, runId, taskId, attemptId: `${runId}-${taskId}`, layoutRevision: 'layout', generation: 1 });
const claimOf = (id: AttemptIdentity) => ({ request: { protocolVersion: 1 as const, identity: id, workspace: '/w', argv: ['fixture'] }, owner: 'fixture-worker' });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-ledger-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, options, 'allow', custodyProfiles); stores.push(store);
  const capacity = { executionSlots: 2, inFlightSlots: 3 };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity });
  const create = (scopeId: string, runId: string, ids: readonly string[], now: number, deps: Record<string, string[]> = {}) => store.createRun({ commandId: `create-${runId}`, actor,
    identity: { scopeId, runId, layoutRevision: 'layout' }, graph: graph(ids, deps), execution: fixtureExecution(graph(ids, deps)), now,
    policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: [...ids] } });
  // r1 (scope s): `a` reserved at 2000 and launched at 3000; `b` waits for `a`.
  await create('s', 'r1', ['a', 'b'], 1000, { b: ['a'] }); const a = identity('s', 'r1', 'a');
  await store.reserveRunTasks({ commandId: 'reserve-r1', actor, scopeId: 's', runId: 'r1', expectedRevision: 0, now: 2000, identities: [a] });
  await store.claimDispatch(dispatchAdmission(claimOf(a))); await grantTestLaunch(store, claimOf(a), 3000);
  // r3 (scope s): `x` ran, exited with output and was evaluated `unknown` (HOLD keeps it evaluating); its worker log was sealed at 6000.
  await create('s', 'r3', ['x'], 1500); const x = identity('s', 'r3', 'x');
  await store.reserveRunTasks({ commandId: 'reserve-r3', actor, scopeId: 's', runId: 'r3', expectedRevision: 0, now: 2500, identities: [x] });
  await store.claimDispatch(dispatchAdmission(claimOf(x))); await grantTestLaunch(store, claimOf(x), 3500);
  await store.retainDispatchOutput(claimOf(x), { schemaVersion: 1, scopeId: 's', digest: 'a'.repeat(64), byteLength: 10 });
  await store.finishDispatch(claimOf(x), { handle: x.attemptId, exitCode: 0, interrupted: false });
  const dispatch = (await store.readDispatch(claimOf(x).request))!, run3 = (await store.loadRun('s', 'r3'))!;
  await store.commitTaskEvaluation({ commandId: 'evaluate-x', actor, expectedRevision: run3.revision, dispatch, evaluation: { schemaVersion: 1, evaluationId: 'evaluate-x',
    identity: x, graphRevision: 1, attemptRevision: 1, criteria: [{ criterionId: 'verified', verdict: 'unknown', evidenceIds: [] }] } });
  await store.saveWorkerEventLog({ schemaVersion: 1, identity: x, events: { schemaVersion: 1, scopeId: 's', digest: 'b'.repeat(64), byteLength: 0 }, eventCount: 0, sealedAt: 6000 });
  // r2 (scope s2): never reserved or dispatched.
  await create('s2', 'r2', ['only'], 4000);
  const hold = new ExecutionPoolHoldApplication({ async verify() { return principal; } }, new PoolControlPolicyAuthorization({ async load() { return { schemaVersion: 1, revision: 'p1', restrictions: [],
    grants: [{ id: 'pool', effect: 'allow', actions: ['hold', 'resume', 'inspect'], scopes: 'all', principals: [{ issuer: 'test', subject: 'operator' }], resource: { kind: 'pool', ids: ['p'] } }] }; } }),
  store, audit => new AuditApplication(audit, createHmacIntegrity('audit-key', randomBytes(32))), () => 5000, 'p');
  await hold.apply({ schemaVersion: 1, scopeId: 's', commandId: 'hold-1', action: 'hold', reason: 'monitor fixture' });
  return { root, path, store };
}
const files = async (path: string) => Promise.all(['', '-wal'].map(async suffix => {
  try { const info = await stat(path + suffix); return { suffix, mtimeMs: info.mtimeMs, size: info.size, bytes: (await readFile(path + suffix)).toString('base64') }; }
  catch { return { suffix, missing: true }; }
}));
const read = (path: string, maxRuns = 10) => readMonitorLedger(path, { busyTimeoutMs: 100, maxRuns });

describe.skipIf(process.platform === 'win32')('monitor ledger reader', () => {
  it('reads every scope, never-dispatched Runs, attempts, evaluations, pools and holds with ledger-proven times, without changing the ledger', async () => {
    const f = await fixture(); const before = await files(f.path);
    const reading = await read(f.path);
    expect(await files(f.path)).toEqual(before);
    expect(reading).toMatchObject({ ledgerVersion: CURRENT_LEDGER_VERSION, scopeIds: ['s', 's2'], diagnostics: [] });
    const runs = Object.fromEntries(reading.runs.map(run => [run.snapshot.identity.runId, run]));
    expect(runs.r2).toMatchObject({ admitted: true, createdAtMs: 4000, poolId: 'p', attempts: [] }); expect(runs.r2!.snapshot.progress[0]!.phase).toBe('pending');
    expect(runs.r1).toMatchObject({ admitted: true, createdAtMs: 1000, attempts: [{ attemptId: 'r1-a', generation: 1, reservedAtMs: 2000, sealedAtMs: null, evaluationObserved: false,
      dispatch: { launch: 'granted', grantedAtMs: 3000, terminal: null, outputRecorded: false } }] });
    expect(runs.r3).toMatchObject({ createdAtMs: 1500, attempts: [{ attemptId: 'r3-x', observedKind: 'exited', evaluationObserved: true, reservedAtMs: 2500, sealedAtMs: 6000,
      dispatch: { launch: 'granted', grantedAtMs: 3500, outputRecorded: true, terminal: { exitCode: 0, signal: null, interrupted: false } } }] });
    expect(runs.r3!.snapshot.progress[0]!.phase).toBe('evaluating');
    expect(reading.pools).toEqual([{ poolId: 'p', executionSlots: 2, inFlightSlots: 3, execution: 1, inFlight: 2, hold: { state: 'held', changedAtMs: 5000, changedBy: 'operator' } }]);
    expect(reading.approvals).toEqual([]);
  });
  it('orders open Runs first, bounds the set with a typed diagnostic and reports corrupt records without failing the read', async () => {
    const f = await fixture(); f.store.close();
    const writer = new DatabaseSync(f.path);
    writer.exec(`UPDATE runs SET snapshot='{"broken":true}' WHERE run_id='r2'`); writer.close();
    // With no writer open the WAL is checkpointed away; the reader leaves the ledger file byte- and mtime-identical (an empty WAL may appear).
    const closed = await files(f.path); expect(closed[1]).toEqual({ suffix: '-wal', missing: true });
    const bounded = await read(f.path, 1);
    expect((await files(f.path))[0]).toEqual(closed[0]); expect((await files(f.path))[1]).toMatchObject({ suffix: '-wal' });
    expect((await stat(f.path + '-wal').then(info => info.size, () => 0))).toBe(0);
    expect(bounded.runs).toHaveLength(1); expect(bounded.diagnostics).toContain('info:runs-truncated:3');
    expect(bounded.runs[0]!.snapshot.progress.some(task => task.phase !== 'accepted')).toBe(true);
    const all = await read(f.path);
    expect(all.runs.map(run => run.snapshot.identity.runId).sort()).toEqual(['r1', 'r3']); expect(all.diagnostics).toEqual(['run-corrupt:s2/r2', 'pool-occupancy-corrupt:p']);
  });
  it('is version-aware: an older ledger reads without newer tables, an unknown version is a diagnostic, a missing file is never created', async () => {
    const f = await fixture(); f.store.close();
    const writer = new DatabaseSync(f.path); writer.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL); writer.close();
    const older = await read(f.path);
    expect(older.ledgerVersion).toBe(43); expect(older.diagnostics).toEqual(['info:ledger-version-older:43']);
    expect(older.pools[0]!.hold).toBeNull(); expect(older.runs).toHaveLength(3);
    const newer = new DatabaseSync(f.path); newer.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1}`); newer.close();
    expect(await read(f.path)).toMatchObject({ ledgerVersion: CURRENT_LEDGER_VERSION + 1, runs: [], diagnostics: [`ledger-version-unsupported:${CURRENT_LEDGER_VERSION + 1}`] });
    const missing = join(f.root, 'absent.db');
    await expect(read(missing)).rejects.toBeTruthy(); await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readMonitorLedger(f.path, { busyTimeoutMs: 100, maxRuns: 0 })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_OPTIONS' });
  });
  it('v1.1: furthest proven delivery step per Run, evaluation model record and profile provider, model catalog (ledger records only)', async () => {
    const f = await fixture(); f.store.close();
    const writer = new DatabaseSync(f.path); const c1 = 'a'.repeat(40), c2 = 'b'.repeat(40);
    const intent = (runId: string, extra: object) => JSON.stringify({ schemaVersion: 1, command: { identity: { runId } }, ...extra });
    writer.prepare('INSERT INTO workspace_integrations(scope_id,command_id,intent,manifest) VALUES(?,?,?,?)').run('s', 'i1', intent('r1', {}), '{}');
    writer.prepare('INSERT INTO workspace_integrations(scope_id,command_id,intent,manifest) VALUES(?,?,?,?)').run('s', 'i3', intent('r3', {}), null);
    writer.prepare('INSERT INTO workspace_deliveries(scope_id,command_id,intent,delivered) VALUES(?,?,?,?)').run('s', 'd1', intent('r1', { plan: { commit: c1 } }), 1);
    writer.prepare('INSERT INTO workspace_adoptions(scope_id,command_id,target_ref,sequence,kind,intent,settled) VALUES(?,?,?,?,?,?,?)').run('s', 'a1', 'refs/heads/x', 1, 'adopt', intent('r1', { toCommit: c2 }), 0);
    writer.prepare('INSERT INTO run_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,?)').run('s', 'eval-model', JSON.stringify({ action: 'apply-task-evaluation',
      evaluation: { identity: { attemptId: 'r3-x' }, model: { provider: 'claude', requested: { channelId: 'ch', modelId: 'm-1', auxiliaryModelIds: [] }, init: 'm-1', usage: ['m-1'],
        verdict: 'verified', unexpected: [], evidence: 'sealed' } } }), '{}');
    writer.close();
    const reading = await read(f.path); const runs = Object.fromEntries(reading.runs.map(run => [run.snapshot.identity.runId, run]));
    expect(runs.r1!.delivery).toEqual({ state: 'adopting', commit: c2 });
    expect(runs.r3!.delivery).toEqual({ state: 'integrating', commit: null }); expect(runs.r2!.delivery).toBeNull();
    expect(runs.r3!.attempts[0]).toMatchObject({ provider: 'claude', model: { usage: ['m-1'], verdict: 'verified', evidence: 'sealed' } });
    expect(runs.r1!.attempts[0]).toMatchObject({ provider: 'test-supervisor', model: null });
    expect(reading.map).toMatchObject({ models: [] });
  });
});
