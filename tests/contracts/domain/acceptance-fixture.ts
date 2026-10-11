import { applyAttemptObservation, createAttempt, createRun, observeRunAttempt, reserveRunTasks,
  workClassAcceptanceProfileSchema, workClassRegistrySchema, type TaskEvaluation } from '#domain/index.js';
import { resolveExecutionRegistry } from '#engine/index.js';
export const identity = { scopeId: 'scope', runId: 'run', layoutRevision: 'layout', taskId: 'task', attemptId: 'attempt', generation: 1 };
export const profile = workClassAcceptanceProfileSchema.parse({ schemaVersion: 1, version: 1,
  criterionTypes: ['completion'], evidenceTypes: ['verification-result'],
  rubric: [{ criterionType: 'completion', evidenceTypes: ['verification-result'], weight: 1 }],
  ceilingRules: [{ when: 'missing-evidence', maxScore: 0 }, { when: 'unsettled-effect', maxScore: 0 }],
  decisionThresholds: { rejectBelow: 0.4, acceptAt: 0.9 } });
export const overlay = workClassRegistrySchema.parse({ schemaVersion: 2, revision: 'business-r1',
  classes: [{ id: 'business', defaultEffort: 'high', acceptanceProfile: profile }], bindings: [{ kind: 'business', classId: 'business' }] });
export const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 'task', kind: 'business', dependencies: [], acceptanceCriteria: ['criterion'] }],
  criterionDefinitions: [{ id: 'criterion', version: 1, description: 'Verify durable business evidence', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
export function execution(input: unknown = graph, policy: unknown = overlay) {
  return resolveExecutionRegistry(input, { schemaVersion: 1, revision: 'execution-r1', workClasses: policy,
    profiles: [{ id: 'profile', version: 1, adapter: { id: 'test', version: 1 }, parameters: {} }],
    kinds: [{ kind: 'business', profile: { id: 'profile', version: 1 } }],
    evaluators: [{ id: 'test-evaluator', version: 1, implementation: { id: 'test-evaluator', version: 1 } }] },
  { profile() { return undefined; }, criterion() { return undefined; } });
}
export function evaluating() {
  const run = reserveRunTasks(createRun({ scopeId: identity.scopeId, runId: identity.runId, layoutRevision: identity.layoutRevision }, graph, 0, execution()), 0, [identity], 0);
  const attempt = applyAttemptObservation(createAttempt(identity), { protocolVersion: 1, identity, sequence: 1, eventId: 'exit', result: { kind: 'exited', exitCode: 0 } }, 0);
  return { run: observeRunAttempt(run, 1, attempt), attempt };
}
export function evidence(verdict: 'pass' | 'fail' | 'unknown' = 'pass'): TaskEvaluation {
  return { schemaVersion: 1, evaluationId: 'evaluation', identity, graphRevision: 1, attemptRevision: 1,
    criteria: [{ criterionId: 'criterion', verdict, evidenceIds: ['output'], evidenceTypes: ['verification-result'] }] };
}
