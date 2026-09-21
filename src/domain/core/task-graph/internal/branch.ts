import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { taskGraphSchema, TaskGraphError } from './contract.js';
import { validateTaskGraph } from './graph.js';

/** Admission-time choice only. The authenticated caller supplies a versioned boolean fact;
 * this is not verification of an external ERP fact or an executable expression language. */
export const branchInputSchema = z.object({ schemaVersion: z.literal(1),
  input: z.object({ id: identitySchema, revision: identitySchema, value: z.boolean() }).strict().readonly(),
  whenTrue: identitySchema, whenFalse: identitySchema, join: identitySchema,
}).strict().readonly();
export const branchDecisionSchema = z.object({ schemaVersion: z.literal(1),
  request: branchInputSchema, sourceGraph: taskGraphSchema,
  selectedTaskId: identitySchema, notSelectedTaskId: identitySchema,
}).strict().readonly();
export type BranchDecision = z.infer<typeof branchDecisionSchema>;

/** Compile one exclusive diamond into the ordinary DAG. Nonselected work is retained in the
 * decision evidence, never forged as an accepted Task. Other consumers are rejected, not rewired. */
export function resolveAdmissionBranch(graphInput: unknown, input: unknown) {
  const sourceGraph = validateTaskGraph(graphInput); const request = branchInputSchema.parse(input);
  const { whenTrue, whenFalse, join } = request;
  const invalid = (): never => { throw new TaskGraphError('TASK_GRAPH_INVALID'); };
  if (new Set([whenTrue, whenFalse, join]).size !== 3) invalid();
  const tasks = new Map(sourceGraph.tasks.map(task => [task.id, task]));
  const yes = tasks.get(whenTrue), no = tasks.get(whenFalse), merge = tasks.get(join);
  if (!yes || !no || !merge) return invalid();
  if (!merge.dependencies.includes(whenTrue) || !merge.dependencies.includes(whenFalse)) invalid();
  // First contract is a single diamond: both alternatives share prerequisites.
  if (JSON.stringify([...yes.dependencies].sort()) !== JSON.stringify([...no.dependencies].sort())) invalid();
  for (const task of sourceGraph.tasks) {
    if (task.id !== join && task.dependencies.some(id => id === whenTrue || id === whenFalse)) invalid();
  }
  const selectedTaskId = request.input.value ? whenTrue : whenFalse;
  const notSelectedTaskId = request.input.value ? whenFalse : whenTrue;
  const active = sourceGraph.tasks.filter(task => task.id !== notSelectedTaskId)
    .map(task => ({ ...task, dependencies: task.dependencies.filter(id => id !== notSelectedTaskId) }));
  const criteria = new Set(active.flatMap(task => task.acceptanceCriteria));
  const graph = validateTaskGraph({ ...sourceGraph, tasks: active,
    criterionDefinitions: sourceGraph.criterionDefinitions.filter(item => criteria.has(item.id)) });
  const decision = branchDecisionSchema.parse({ schemaVersion: 1, request, sourceGraph, selectedTaskId, notSelectedTaskId });
  return Object.freeze({ graph, decision });
}
export function assertAdmissionBranch(graph: unknown, input: unknown): void {
  const decision = branchDecisionSchema.parse(input);
  const expected = resolveAdmissionBranch(decision.sourceGraph, decision.request);
  if (JSON.stringify(expected.graph) !== JSON.stringify(taskGraphSchema.parse(graph)) ||
    JSON.stringify(expected.decision) !== JSON.stringify(decision)) throw new TaskGraphError('TASK_GRAPH_INVALID');
}
