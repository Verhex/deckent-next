import { expect, it } from 'vitest';
import { applyAttemptObservation, bindTaskAcceptance, createAttempt, createRun, CORE_WORK_CLASSES, inspectTaskEvaluation, observeRunAttempt,
  reserveRunTasks, type TaskEvaluation } from '#domain/index.js';
import { resolveExecutionRegistry } from '#engine/index.js';

// ATAMA-0 seed revision: every Core class carries an acceptance profile and the A8 proposal-admission data. Standing admission stays off
// until the N1 class-consistency measurement (owner A8, O6); the gate itself is unchanged. Expected values are the owner decisions as literals.
// ATAMA-1 (registry v4) added the worker candidate lists; M3 (seed revision atama-m3, registry v5) adds selector tails (work-class-assignment.test.ts).
it('the Core seed is a v5 registry: each class has an acceptance profile and a declared proposal risk, none admits standing', () => {
  expect(CORE_WORK_CLASSES.schemaVersion).toBe(5);
  expect(CORE_WORK_CLASSES.revision).toBe('atama-m3-2026-10-23');
  const risks = Object.fromEntries(CORE_WORK_CLASSES.classes.map(row => [row.id, 'proposalAdmission' in row ? row.proposalAdmission : undefined]));
  expect(risks).toEqual({ small: { risk: 'low', standingAdmission: false }, test: { risk: 'normal', standingAdmission: false },
    feature: { risk: 'normal', standingAdmission: false }, design: { risk: 'high', standingAdmission: false },
    architecture: { risk: 'high', standingAdmission: false }, 'security-critical': { risk: 'high', standingAdmission: false } });
  for (const row of CORE_WORK_CLASSES.classes) expect('acceptanceProfile' in row && row.acceptanceProfile).toMatchObject({ criterionTypes: ['completion'],
    evidenceTypes: ['retained-artifact'], decisionThresholds: { rejectBelow: 0.5, acceptAt: 1 } });
  // Pinned-model effort targets are unchanged (A1 applies to the system assignment: candidate deviation or catalog vendor default).
  expect(Object.fromEntries(CORE_WORK_CLASSES.classes.map(row => [row.id, row.defaultEffort]))).toEqual({ small: 'high', test: 'high', feature: 'xhigh',
    design: 'max', architecture: 'max', 'security-critical': 'max' });
  expect(CORE_WORK_CLASSES.bindings).toContainEqual({ kind: 'coding', classId: 'feature' });
});

const identity = { scopeId: 's', runId: 'r', layoutRevision: 'l', taskId: 't', attemptId: 'a', generation: 1 };
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'small', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'The worker exits cleanly', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
function seedExecution(input: unknown = graph) {
  return resolveExecutionRegistry(input, { schemaVersion: 1, revision: 'execution-r1',
    profiles: [{ id: 'profile', version: 1, adapter: { id: 'test', version: 1 }, parameters: {} }], kinds: [{ kind: 'small', profile: { id: 'profile', version: 1 } }],
    evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] }, { profile() { return undefined; }, criterion() { return undefined; } });
}
function evaluatingSeedTask() {
  const execution = seedExecution();
  const run = reserveRunTasks(createRun({ scopeId: 's', runId: 'r', layoutRevision: 'l' }, graph, 0, execution), 0, [identity], 0);
  const attempt = applyAttemptObservation(createAttempt(identity), { protocolVersion: 1, identity, sequence: 1, eventId: 'exit', result: { kind: 'exited', exitCode: 0 } }, 0);
  return observeRunAttempt(run, 1, attempt);
}
const evaluation = (verdict: 'pass' | 'fail', evidenceTypes?: string[]): TaskEvaluation => ({ schemaVersion: 1, evaluationId: 'e', identity, graphRevision: 1, attemptRevision: 1,
  criteria: [{ criterionId: 'exit', verdict, evidenceIds: ['dispatch-output'], ...(evidenceTypes ? { evidenceTypes } : {}) }] });
it('a seed-bound task freezes the seed profile and keeps today\'s conclusions for a retained-artifact verdict', () => {
  const run = evaluatingSeedTask();
  expect(run.execution.tasks[0]!.acceptance).toMatchObject({ workClass: 'small', policyRevision: 'atama-m3-2026-10-23', profileVersion: 1 });
  const passed = inspectTaskEvaluation(run, bindTaskAcceptance(run, evaluation('pass', ['retained-artifact'])));
  expect(passed.conclusion).toBe('pass'); expect(passed.evaluation.acceptance).toMatchObject({ score: 1, ceilingReasons: [] });
  expect(inspectTaskEvaluation(run, bindTaskAcceptance(run, evaluation('fail'))).conclusion).toBe('fail');
  // Negative: a verdict that names no evidence type is missing evidence under the profile and never passes silently.
  const untyped = inspectTaskEvaluation(run, bindTaskAcceptance(run, evaluation('pass')));
  expect(untyped.conclusion).toBe('unknown'); expect(untyped.evaluation.acceptance).toMatchObject({ score: 0, ceilingReasons: ['missing-evidence'] });
});
it('a declared criterion acceptance on a Core class must fit the seed profile: a mismatch is a typed admission refusal (behavior change)', () => {
  const declared = (acceptance: unknown) => ({ ...graph, criterionDefinitions: [{ ...graph.criterionDefinitions[0]!, acceptance }] });
  expect(seedExecution(declared({ criterionType: 'completion', evidenceTypes: ['retained-artifact'] })).tasks[0]!.acceptance).toMatchObject({ workClass: 'small' });
  expect(() => seedExecution(declared({ criterionType: 'correctness', evidenceTypes: ['verification-result'] }))).toThrow('TASK_EVALUATION_PROFILE_MISMATCH');
});
