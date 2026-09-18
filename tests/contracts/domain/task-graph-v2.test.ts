import { expect, it } from 'vitest';
import { validateTaskGraphV2, taskGraphV2Schema, taskGraphSchema } from '#domain/index.js';
const criterion = { id: 'verified', version: 1, description: 'Verify output evidence', evaluator: { id: 'registered-evaluator', version: 1 }, parameters: { expected: { value: 'before-execution' } } };
const task = { id: 'a', kind: 'purchase', dependencies: [] as string[], acceptanceCriteria: ['verified'] };
const graph = { schemaVersion: 2, revision: 1, tasks: [task, { ...task, id: 'b', dependencies: ['a'] }], criterionDefinitions: [criterion] };
it('binds reusable versioned definitions to graph-scoped references and freezes the admission copy', () => {
  const input = structuredClone(graph); const accepted = validateTaskGraphV2(input);
  input.criterionDefinitions[0]!.parameters.expected.value = 'after-execution'; input.tasks[0]!.acceptanceCriteria.push('invented');
  expect(accepted.criterionDefinitions[0]!.parameters.expected).toEqual({ value: 'before-execution' });
  expect(accepted.tasks[0]!.acceptanceCriteria).toEqual(['verified']);
  expect(Object.isFrozen(accepted.criterionDefinitions)).toBe(true); expect(Object.isFrozen(accepted.tasks)).toBe(true);
});
it('rejects missing, unused, duplicate and ambiguously redefined criteria', () => {
  for (const criterionDefinitions of [[], [{ ...criterion, id: 'other' }], [criterion, { ...criterion, id: 'unused' }], [criterion, criterion], [criterion, { ...criterion, version: 2 }]]) {
    expect(taskGraphV2Schema.safeParse({ ...graph, criterionDefinitions }).success).toBe(false);
  }
  expect(() => validateTaskGraphV2({ ...graph, tasks: [{ ...task, acceptanceCriteria: ['verified', 'verified'] }] })).toThrow('TASK_ACCEPTANCE_DUPLICATE');
});
it('retains dependency validation and rejects cross-version input without implicit conversion', () => {
  expect(() => validateTaskGraphV2({ ...graph, tasks: [{ ...task, dependencies: ['missing'] }] })).toThrow('TASK_DEPENDENCY_MISSING');
  expect(() => validateTaskGraphV2({ ...graph, tasks: [{ ...task, dependencies: ['a'] }] })).toThrow('TASK_GRAPH_CYCLE');
  expect(() => validateTaskGraphV2({ ...graph, tasks: [task, task] })).toThrow('TASK_DUPLICATE');
  expect(taskGraphV2Schema.safeParse({ schemaVersion: 1, revision: 1, tasks: [task] }).success).toBe(false);
  expect(taskGraphSchema.safeParse(graph).success).toBe(false);
});
