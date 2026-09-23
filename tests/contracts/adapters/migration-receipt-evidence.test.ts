import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { applyAttemptObservation, applyTaskEvaluation, createAttempt, createRun, observeRunAttempt,
  requestRunCancellation, reserveRunTasks, type RunSnapshot } from '#domain/index.js';
import { migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const actor = { id: 'operator', issuer: 'local', subject: 'operator' };
const runIdentity = { runId: 'run', scopeId: 'scope', layoutRevision: 'layout' };
const attemptIdentity = { ...runIdentity, taskId: 'task', attemptId: 'attempt', generation: 1 };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'task', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify output', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const execution = fixtureExecution(graph);
const policy = { schemaVersion: 2 as const, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['task'] };
const profile = { schemaVersion: 1 as const, adapterId: 'test-supervisor', adapterVersion: 1, parameters: { fixture: true } };
const dispatch = { schemaVersion: 2 as const, request: { protocolVersion: 1 as const, identity: attemptIdentity, workspace: '/recorded', argv: ['tool'] },
  owner: 'supervisor', profile, launch: 'granted' as const, grant: { generation: 1, grantedAt: 1, principal: actor },
  terminal: { handle: 'process', exitCode: 0, interrupted: false } };
const command = (action: string, payload: object) => JSON.stringify({ action, ...payload });
function legacy(snapshot: RunSnapshot) { return { ...snapshot, schemaVersion: 2, progress: snapshot.progress.map(item => ({
  taskId: item.taskId, phase: item.phase, unresolvedEffects: item.unresolvedEffects, eligibleAt: 1_000,
})) }; }
function creation() { const snapshot = createRun(runIdentity, graph, 1_000, execution); return { id: 'create', snapshot,
  command: command('create-run', { commandId: 'create', actor, identity: runIdentity, graph, now: 1_000, policy, execution }) }; }
type Receipt = ReturnType<typeof creation>;
function database(snapshot: RunSnapshot, receipts: readonly Receipt[]) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE runs(scope_id TEXT,run_id TEXT,revision INTEGER,snapshot TEXT,policy TEXT,PRIMARY KEY(scope_id,run_id));
    CREATE TABLE run_receipts(scope_id TEXT,command_id TEXT,command TEXT,snapshot TEXT,PRIMARY KEY(scope_id,command_id)); DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS effect_intents; DROP TABLE IF EXISTS worker_event_logs; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=11;`);
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('scope', 'run', snapshot.revision, JSON.stringify(legacy(snapshot)), JSON.stringify(policy));
  for (const receipt of receipts) db.prepare('INSERT INTO run_receipts VALUES(?,?,?,?)').run('scope', receipt.id, receipt.command, JSON.stringify(legacy(receipt.snapshot)));
  return db;
}
function migrate(db: DatabaseSync) { db.exec('BEGIN IMMEDIATE'); try { migrateLedger(db, 'allow'); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }
function projected() {
  const reserved = reserveRunTasks(creation().snapshot, 0, [attemptIdentity], 1000);
  const attempt = applyAttemptObservation(createAttempt(attemptIdentity), { protocolVersion: 1, identity: attemptIdentity,
    sequence: 1, eventId: 'exit', result: { kind: 'exited' as const, exitCode: 0 } }, 0);
  return observeRunAttempt(reserved, 1, attempt);
}

it('migrates strict projection and evaluation receipt evidence', () => {
  const create = creation(), observed = projected();
  const project = { id: 'project', snapshot: observed, command: command('project-run-attempt',
    { commandId: 'project', actor, scopeId: 'scope', runId: 'run', expectedRevision: 1, attemptId: 'attempt' }) };
  const evaluation = { schemaVersion: 1 as const, evaluationId: 'evaluation', identity: attemptIdentity, graphRevision: 1,
    attemptRevision: 1, criteria: [{ criterionId: 'verified', verdict: 'unknown' as const, evidenceIds: [] }] };
  const evaluated = applyTaskEvaluation(observed, 2, evaluation).snapshot;
  const evaluate = { id: 'evaluation', snapshot: evaluated, command: command('apply-task-evaluation',
    { commandId: 'evaluation', actor, expectedRevision: 2, evaluation, dispatch }) };
  const db = database(evaluated, [create, project, evaluate]); migrate(db);
  expect(db.prepare('SELECT snapshot FROM run_receipts').all().every(row => JSON.parse(String(row.snapshot)).schemaVersion === 3)).toBe(true); db.close();
});

it('accepts cancellation no-op and rejects a false cancellation postcondition', () => {
  const create = creation(), cancelled = requestRunCancellation(create.snapshot, 0);
  const noOp = { id: 'cancel-again', snapshot: cancelled, command: command('cancel-run',
    { commandId: 'cancel-again', actor, scopeId: 'scope', runId: 'run', expectedRevision: 1 }) };
  const db = database(cancelled, [create, noOp]); migrate(db); db.close();
  const bad = database(create.snapshot, [create, { ...noOp, snapshot: create.snapshot }]);
  expect(() => migrate(bad)).toThrow('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); expect(bad.prepare('PRAGMA user_version').get()?.user_version).toBe(11); bad.close();
});

it('rolls back malformed action identity, revision and duplicate reservation evidence', () => {
  const create = creation(), reserved = reserveRunTasks(create.snapshot, 0, [attemptIdentity], 1000);
  const invalid = [command('invented', { commandId: 'reserve' }),
    command('reserve-run-tasks', { commandId: 'reserve', actor, scopeId: 'other', runId: 'run', expectedRevision: 0, now: 1000, identities: [attemptIdentity] }),
    command('reserve-run-tasks', { commandId: 'reserve', actor, scopeId: 'scope', runId: 'run', expectedRevision: 1, now: 1000, identities: [attemptIdentity] }),
    command('reserve-run-tasks', { commandId: 'reserve', actor, scopeId: 'scope', runId: 'run', expectedRevision: 0, now: 1000, identities: [attemptIdentity, attemptIdentity] })];
  for (const raw of invalid) { const db = database(reserved, [create, { id: 'reserve', command: raw, snapshot: reserved }]);
    expect(() => migrate(db)).toThrow('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(11); db.close(); }
});
