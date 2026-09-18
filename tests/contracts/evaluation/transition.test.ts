import { expect, it } from 'vitest';
import { applyAttemptObservation, createAttempt, createRun, observeRunAttempt, reserveRunTasks } from '#domain/index.js';
import { proposeTaskEvaluationCommit } from '#engine/core/task-evaluation/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const identity = Object.freeze({ runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 });
const graph = Object.freeze({ schemaVersion: 2 as const, revision: 1, tasks: Object.freeze([{ id: 't', kind: 'fixture', dependencies: Object.freeze([]), acceptanceCriteria: Object.freeze(['verified']) }]),
  criterionDefinitions: Object.freeze([{ id: 'verified', version: 1, description: 'Verify fixture task', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }]) });

function fixture() {
  const reserved = reserveRunTasks(createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph)), 0, [identity], 0);
  const attempt = applyAttemptObservation(createAttempt(identity), { protocolVersion: 1 as const, identity, sequence: 1, eventId: 'exit', result: { kind: 'exited' as const, exitCode: 0 } }, 0);
  const run = observeRunAttempt(reserved, 1, attempt);
  const dispatch = { schemaVersion: 2 as const, request: { protocolVersion: 1 as const, identity, workspace: '/recorded/workspace', argv: ['tool'] }, owner: 'supervisor',
    profile: { schemaVersion: 1 as const, adapterId: 'test-supervisor', adapterVersion: 1, parameters: { fixture: 'strict-custody-profile' } }, launch: 'granted' as const,
    grant: { generation: 1, grantedAt: 1, principal: { id: 'launcher', issuer: 'test', subject: 'fixture' } }, terminal: { handle: 'handle', exitCode: 0, interrupted: false },
    output: { schemaVersion: 1 as const, scopeId: 's', digest: 'a'.repeat(64), byteLength: 1 } };
  return { run, attempt, dispatch };
}

function evaluation(verdict: 'pass' | 'fail') {
  return { schemaVersion: 1 as const, evaluationId: 'evaluation', identity, graphRevision: 1, attemptRevision: 1,
    criteria: [{ criterionId: 'verified', verdict, evidenceIds: ['proof'] }] };
}

it.each([['pass', 'pass', 'accepted'], ['fail', 'fail', 'failed']] as const)('derives immutable %s acceptance from exact persisted custody', (_name, verdict, phase) => {
  const f = fixture(); const before = JSON.stringify(f);
  const result = proposeTaskEvaluationCommit(f.run, f.attempt, f.dispatch, f.run.revision, evaluation(verdict));
  expect(result).toMatchObject({ conclusion: verdict, output: f.dispatch.output, snapshot: { revision: f.run.revision + 1 } });
  expect(result.snapshot.progress[0]!.phase).toBe(phase); expect(result.evaluation.criteria[0]!.evidenceIds).toEqual(['proof']);
  expect(JSON.stringify(f)).toBe(before);
});

it.each(['runId', 'taskId', 'attemptId', 'scopeId', 'layoutRevision', 'generation'] as const)('rejects %s identity substitution', axis => {
  const f = fixture(); const changed = { ...identity, [axis]: axis === 'generation' ? 2 : 'other' };
  expect(() => proposeTaskEvaluationCommit(f.run, f.attempt, f.dispatch, f.run.revision, { ...evaluation('pass'), identity: changed })).toThrow('TASK_EVALUATION_STALE');
});

it('rejects stale attempt evidence, cancellation, nonterminal custody, and interrupted execution', () => {
  const f = fixture();
  expect(() => proposeTaskEvaluationCommit(f.run, { ...f.attempt, revision: 2 }, f.dispatch, f.run.revision, evaluation('pass'))).toThrow('TASK_EVALUATION_STALE');
  expect(() => proposeTaskEvaluationCommit(f.run, { ...f.attempt, cancelRequested: true }, f.dispatch, f.run.revision, evaluation('pass'))).toThrow('TASK_EVALUATION_NOT_READY');
  expect(() => proposeTaskEvaluationCommit(f.run, f.attempt, { ...f.dispatch, output: undefined }, f.run.revision, evaluation('pass'))).toThrow('TASK_EVALUATION_NOT_READY');
  expect(() => proposeTaskEvaluationCommit(f.run, f.attempt, { ...f.dispatch, terminal: { ...f.dispatch.terminal, interrupted: true } }, f.run.revision, evaluation('pass'))).toThrow('TASK_EVALUATION_NOT_READY');
});

it('rejects terminal disagreement and invalid stored execution fingerprints', () => {
  const f = fixture();
  expect(() => proposeTaskEvaluationCommit(f.run, f.attempt, { ...f.dispatch, terminal: { ...f.dispatch.terminal, exitCode: 1 } }, f.run.revision, evaluation('pass'))).toThrow('TASK_EVALUATION_STALE');
  const run = { ...f.run, execution: { ...f.run.execution, criteria: f.run.execution.criteria.map(value => ({ ...value, fingerprint: 'f'.repeat(64) })) } };
  expect(() => proposeTaskEvaluationCommit(run, f.attempt, f.dispatch, f.run.revision, evaluation('pass'))).toThrow('TASK_EVALUATION_INVALID');
});
