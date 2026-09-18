import { expect, it } from 'vitest';
import { assertRunExecution } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const graph = Object.freeze({ schemaVersion: 2 as const, revision: 1, tasks: Object.freeze([{ id: 't', kind: 'fixture', dependencies: Object.freeze([]), acceptanceCriteria: Object.freeze(['verified']) }]),
  criterionDefinitions: Object.freeze([{ id: 'verified', version: 1, description: 'Verify fixture task', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }]) });

it('accepts the exact profile, evaluator, and criterion fingerprint selected at admission', () => {
  const execution = fixtureExecution(graph);
  expect(assertRunExecution(graph, execution)).toEqual(execution);
});

it.each([
  ['task selection', (execution: ReturnType<typeof fixtureExecution>) => ({ ...execution, tasks: [{ ...execution.tasks[0]!, taskId: 'other' }] })],
  ['evaluator reference', (execution: ReturnType<typeof fixtureExecution>) => ({ ...execution, criteria: [{ ...execution.criteria[0]!, evaluator: { ...execution.criteria[0]!.evaluator, version: 2 } }] })],
  ['criterion fingerprint', (execution: ReturnType<typeof fixtureExecution>) => ({ ...execution, criteria: [{ ...execution.criteria[0]!, fingerprint: 'f'.repeat(64) }] })],
])('rejects a changed %s', (_name, tamper) => {
  expect(() => assertRunExecution(graph, tamper(fixtureExecution(graph)))).toThrow('RUN_EXECUTION_INTEGRITY');
});
