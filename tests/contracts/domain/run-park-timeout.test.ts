import { expect, it } from 'vitest';
import * as domain from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const identity = { runId: 'r', scopeId: 's', layoutRevision: 'l', taskId: 'a', attemptId: 'attempt', generation: 1 };
const graph = { schemaVersion: 2, revision: 1, tasks: ['a', 'b', 'c'].map((id, i) => ({ id, kind: 'custom', dependencies: i ? [String.fromCharCode(96 + i)] : [], acceptanceCriteria: ['verified'] })), criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
function evaluated(verdict: 'pass'|'fail'|'unknown') {
  const reserved = domain.reserveRunTasks(domain.createRun({runId: identity.runId, scopeId: identity.scopeId, layoutRevision: identity.layoutRevision}, graph, 10, fixtureExecution(graph)), 0, [identity], 10);
  const attempt = domain.applyAttemptObservation(domain.createAttempt(identity), { protocolVersion: 1, identity, sequence: 1, eventId: 'exit', result: { kind: 'exited', exitCode: 137 } }, 0);
  const run = domain.observeRunAttempt(reserved, 1, attempt);
  return domain.applyTaskEvaluation(run, run.revision, { schemaVersion: 1, evaluationId: 'e', identity, graphRevision: 1, attemptRevision: 1, criteria: [{ criterionId: 'verified', verdict, evidenceIds: verdict === 'unknown' ? [] : ['proof'] }] }, { now: 10, timeoutMs: 100 }).snapshot;
}
it('closes transitive never-run dependencies as skipped in one transition and parks visibly', () => {
  const run = evaluated('fail');
  expect(run.progress.map(t => t.phase)).toEqual(['failed', 'skipped', 'skipped']);
  expect(run.progress.slice(1).every(t => t.skippedReason === 'dependency-failed')).toBe(true);
  expect(run.state).toEqual({ kind: 'parked', reason: 'dependency-failed', since: 10, deadline: 110 });
});
it('parks unknown task with its own deadline and prevents evidence-less reevaluation', () => {
  const run = evaluated('unknown');
  expect(run.progress[0]).toMatchObject({ phase: 'awaiting-decision', decision: { reason: 'evaluation-unknown', since: 10, deadline: 110, evaluationId: 'e' } });
  expect(run.state.kind).toBe('parked');
  const f = { schemaVersion: 1, evaluationId: 'another', identity, graphRevision: 1, attemptRevision: 1, criteria: [{ criterionId: 'verified', verdict: 'pass', evidenceIds: ['proof'] }] };
  expect(() => domain.applyTaskEvaluation(run, run.revision, f)).toThrow('TASK_EVALUATION_NOT_READY');
});
it('expires at deadline, keeps unexpired identity stable, and never defaults an incomplete outcome to success', () => {
  const run = evaluated('fail');
  expect(domain.expireParkedRun(run, run.revision, 109, 100)).toEqual(run);
  const expired = domain.expireParkedRun(run, run.revision, 110, 100);
  expect(expired.state).toEqual({ kind: 'terminal', outcome: 'failed', reason: 'park-timeout' });
  const partial = { ...run, progress: run.progress.map(t => t.taskId === 'a' ? { ...t, phase: 'accepted' } : t) };
  expect(domain.closeParkedRun(partial, partial.revision, 20).state).toMatchObject({ outcome: 'incomplete' });
});
it('resume rechecks dependencies and cannot cause empty reservations or reset a parked deadline', () => {
  const run = evaluated('fail'); const resumed = domain.resumeParkedRun(run, run.revision, 30, 100);
  expect(resumed.state).toEqual(run.state);
  expect(() => domain.reserveRunTasks(resumed, resumed.revision, [{ ...identity, taskId: 'c', attemptId: 'c' }], 30)).toThrow('RUN_PARKED');
});
it('operator acceptance remains explicitly unverified, opens eligible dependants and does not forge evidence', () => {
  const run = evaluated('unknown');
  const accepted = domain.resolveTaskDecision(run, run.revision, 'a', 'accept', 20, 100);
  expect(accepted.progress[0]).toMatchObject({ phase: 'accepted', acceptedEvidence: 'model-unverified' });
  expect(accepted.progress[0]!.decision).toBeUndefined();
  expect(accepted.state.kind).toBe('running');
  expect(accepted.bindings).toEqual(run.bindings);
  expect(() => domain.resolveTaskDecision(run, run.revision, 'a', 'accept', 110, 100)).toThrow('RUN_DECISION_EXPIRED');
});
it('unknown timeout fails the waiting task, propagates skipped closure and closes its Run', () => {
  const run = evaluated('unknown'); const expired = domain.expireParkedRun(run, run.revision, 110, 100);
  expect(expired.progress.map(t => t.phase)).toEqual(['failed', 'skipped', 'skipped']);
  expect(expired.state).toMatchObject({ kind: 'terminal', outcome: 'failed', reason: 'park-timeout' });
});
it('cancellation prevention propagates a dependency-cancelled reason without fabricating failed tasks', () => {
  const reserved = domain.reserveRunTasks(domain.createRun({runId: identity.runId, scopeId: identity.scopeId, layoutRevision: identity.layoutRevision}, graph, 10, fixtureExecution(graph)), 0, [identity], 10);
  const prevented = domain.preventRunAttempt(reserved, reserved.revision, domain.requestAttemptCancellation(domain.createAttempt(identity), 0), { now: 10, timeoutMs: 100 });
  expect(prevented.progress.map(t => t.phase)).toEqual(['cancelled', 'skipped', 'skipped']);
  expect(prevented.progress[2]!.skippedReason).toBe('dependency-cancelled');
});
it('readiness sees a failed ancestor transitively before closure and never reserves awaiting decisions', () => {
  const run = evaluated('fail');
  const legacy = run.progress.map(t => t.taskId === 'a' ? t : { taskId: t.taskId, phase: 'pending', unresolvedEffects: false, eligibility: { kind: 'immediate' } });
  expect(domain.inspectTaskReadiness(graph, { graphRevision: 1, now: 20, progress: legacy }).map(t => t.disposition)).toEqual(['terminal', 'blocked', 'blocked']);
  const waiting = evaluated('unknown');
  expect(domain.inspectTaskReadiness(graph, { graphRevision: 1, now: 20, progress: waiting.progress })[0]!.disposition).toBe('awaiting-decision');
});
it('missing completed output parks without fabricating failed evidence and permits only reject, never acceptance', () => {
  const reserved = domain.reserveRunTasks(domain.createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 10, fixtureExecution(graph)), 0, [identity], 10);
  const attempt = domain.applyAttemptObservation(domain.createAttempt(identity), { protocolVersion: 1, identity, sequence: 1, eventId: 'exit', result: { kind: 'exited', exitCode: 137 } }, 0);
  const observed = domain.observeRunAttempt(reserved, 1, attempt);
  const parked = domain.parkTaskAwaitingDecision(observed, observed.revision, 'a', 'evaluation-not-ready', 20, 100);
  expect(parked.progress[0]!.phase).toBe('awaiting-decision');
  expect(parked.state).toMatchObject({ kind: 'parked', reason: 'evaluation-not-ready' });
  expect(() => domain.resolveTaskDecision(parked, parked.revision, 'a', 'accept', 30, 100)).toThrow('RUN_DECISION_NOT_READY');
  expect(domain.resolveTaskDecision(parked, parked.revision, 'a', 'reject', 30, 100).progress[0]!.phase).toBe('failed');
  expect(domain.expireParkedRun(parked, parked.revision, 120, 100).state).toMatchObject({ kind: 'terminal', outcome: 'failed' });
});
it('waiting decision does not prevent independent work and task timeout cannot fabricate termination of a live sibling', () => {
  const run = evaluated('unknown');
  const independentGraph = { ...graph, tasks: graph.tasks.map(t => t.id === 'b' ? { ...t, dependencies: [] } : t) };
  const modified = { ...run, graph: independentGraph };
  const advanced = domain.advanceRunLifecycle(modified, modified.revision, 20, 100);
  expect(advanced.state.kind).toBe('running');
  const reserved = domain.reserveRunTasks(advanced, advanced.revision, [{ ...identity, taskId: 'b', attemptId: 'b' }], 20);
  const expired = domain.expireParkedRun(reserved, reserved.revision, 110, 100);
  expect(expired.progress[0]!.phase).toBe('failed');
  expect(expired.progress[1]!.phase).toBe('active');
  expect(expired.state.kind).toBe('running');
});
it('unknown cancellation removes decision barriers without claiming success or unresolved effects settlement', () => {
  const run = evaluated('unknown'); const cancelled = domain.requestRunCancellation(run, run.revision);
  expect(cancelled.progress[0]!.phase).toBe('cancelled');
  expect(cancelled.progress[0]!.decision).toBeUndefined();
  expect(cancelled.state).toMatchObject({ kind: 'terminal', outcome: 'cancelled' });
});
it('transitive skipped closure is independent of task declaration order', () => {
  const reversedGraph = { ...graph, tasks: [...graph.tasks].reverse() };
  const created = domain.createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, reversedGraph, 10, fixtureExecution(reversedGraph));
  const reserved = domain.reserveRunTasks(created, 0, [identity], 10);
  const attempt = domain.applyAttemptObservation(domain.createAttempt(identity), { protocolVersion: 1, identity, sequence: 1, eventId: 'exit', result: { kind: 'exited', exitCode: 1 } }, 0);
  const observed = domain.observeRunAttempt(reserved, 1, attempt);
  const run = domain.applyTaskEvaluation(observed, observed.revision, { schemaVersion: 1, evaluationId: 'e', identity, graphRevision: 1, attemptRevision: 1, criteria: [{ criterionId: 'verified', verdict: 'fail', evidenceIds: ['proof'] }] }, { now: 10, timeoutMs: 100 }).snapshot;
  expect(run.progress.find(t => t.taskId === 'c')).toMatchObject({ phase: 'skipped', skippedReason: 'dependency-failed' });
  expect(run.progress.find(t => t.taskId === 'b')).toMatchObject({ phase: 'skipped', skippedReason: 'dependency-failed' });
});
it('rejecting a parked decision refreshes the visible cause while retaining its original park deadline', () => {
  const waiting = evaluated('unknown');
  const rejected = domain.resolveTaskDecision(waiting, waiting.revision, 'a', 'reject', 30, 100);
  expect(rejected.progress[0]!.phase).toBe('failed');
  expect(rejected.progress.some(task => task.phase === 'awaiting-decision')).toBe(false);
  expect(rejected.state).toEqual({ kind: 'parked', reason: 'dependency-failed', since: 10, deadline: 110 });
});
