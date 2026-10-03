import { expect, it } from 'vitest';
import { assertAdmissionBranch, branchDecisionSchema, branchInputSchema, resolveAdmissionBranch } from '#domain/index.js';

const def = (id: string) => ({ id, version: 1, description: id, evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} });
const task = (id: string, dependencies: string[], acceptanceCriteria = ['shared']) => ({ id, kind: 'custom', dependencies, acceptanceCriteria });
const graph = { schemaVersion: 2 as const, revision: 1,
  tasks: [task('pre', []), task('yes', ['pre'], ['only-yes']), task('no', ['pre'], ['only-no']), task('join', ['yes', 'no'])],
  criterionDefinitions: [def('shared'), def('only-yes'), def('only-no')] };
const branch = { schemaVersion: 1 as const, input: { id: 'flag', revision: 'rev-1', value: true }, whenTrue: 'yes', whenFalse: 'no', join: 'join' };

it('refuses non-boolean values, wrong schemaVersion and unknown keys in the input schema', () => {
  expect(branchInputSchema.safeParse({ ...branch, input: { ...branch.input, value: 1 } }).success).toBe(false);
  expect(branchInputSchema.safeParse({ ...branch, schemaVersion: 2 }).success).toBe(false);
  expect(branchInputSchema.safeParse({ ...branch, extra: 1 }).success).toBe(false);
  expect(branchInputSchema.safeParse({ ...branch, input: { ...branch.input, extra: 1 } }).success).toBe(false);
  expect(branchInputSchema.safeParse(branch).success).toBe(true);
});
it('refuses a missing join or empty identity', () => {
  const noJoin: Record<string, unknown> = { ...branch }; delete noJoin['join'];
  expect(branchInputSchema.safeParse(noJoin).success).toBe(false);
  expect(branchInputSchema.safeParse({ ...branch, whenTrue: '' }).success).toBe(false);
});
it('selects the false arm, drops the true arm and prunes its criterion from the compiled graph only', () => {
  const { graph: g, decision } = resolveAdmissionBranch(graph, { ...branch, input: { ...branch.input, value: false } });
  expect(g.tasks.map(t => t.id)).toEqual(['pre', 'no', 'join']);
  expect(g.tasks.find(t => t.id === 'join')!.dependencies).toEqual(['no']);
  expect(g.criterionDefinitions.map(c => c.id).sort()).toEqual(['only-no', 'shared']);
  expect(decision).toMatchObject({ selectedTaskId: 'no', notSelectedTaskId: 'yes' });
  expect(decision.sourceGraph.tasks).toHaveLength(4);
  expect(decision.sourceGraph.criterionDefinitions).toHaveLength(3);
});
it('does not mutate the input graph and returns a frozen result that re-parses as a decision', () => {
  const before = JSON.stringify(graph);
  const result = resolveAdmissionBranch(graph, branch);
  expect(JSON.stringify(graph)).toBe(before);
  expect(Object.isFrozen(result)).toBe(true);
  expect(branchDecisionSchema.parse(result.decision)).toEqual(result.decision);
});
it.each([
  ['whenTrue equals whenFalse', { whenFalse: 'yes' }],
  ['join equals an arm', { join: 'no' }],
  ['unknown arm id', { whenTrue: 'ghost' }],
  ['unknown join id', { join: 'ghost' }],
])('refuses %s with TASK_GRAPH_INVALID', (_name, patch) => {
  expect(() => resolveAdmissionBranch(graph, { ...branch, ...patch })).toThrow('TASK_GRAPH_INVALID');
});
it('refuses a join that does not depend on both arms', () => {
  const g = { ...graph, tasks: graph.tasks.map(t => t.id === 'join' ? { ...t, dependencies: ['yes'] } : t) };
  expect(() => resolveAdmissionBranch(g, branch)).toThrow('TASK_GRAPH_INVALID');
});
it('refuses arms with different prerequisites (single diamond only)', () => {
  const g = { ...graph, tasks: graph.tasks.map(t => t.id === 'no' ? { ...t, dependencies: [] } : t) };
  expect(() => resolveAdmissionBranch(g, branch)).toThrow('TASK_GRAPH_INVALID');
});
it('refuses a third consumer of the selected arm rather than rewiring it', () => {
  const g = { ...graph, tasks: [...graph.tasks, task('extra', ['yes'])] };
  expect(() => resolveAdmissionBranch(g, branch)).toThrow('TASK_GRAPH_INVALID');
});
it('assertAdmissionBranch accepts the genuine pair and refuses a tampered graph or decision', () => {
  const { graph: g, decision } = resolveAdmissionBranch(graph, branch);
  expect(() => assertAdmissionBranch(g, decision)).not.toThrow();
  expect(() => assertAdmissionBranch(resolveAdmissionBranch(graph, { ...branch, input: { ...branch.input, value: false } }).graph, decision)).toThrow('TASK_GRAPH_INVALID');
  expect(() => assertAdmissionBranch(g, { ...decision, selectedTaskId: 'no', notSelectedTaskId: 'yes' })).toThrow('TASK_GRAPH_INVALID');
});
