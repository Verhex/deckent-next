import { taskGraphSchema, TaskGraphError, type TaskGraph } from './contract.js';

/** Validate once at admission. Iterative Kahn traversal avoids stack limits on deep plans. */
export function validateTaskGraph(input: unknown): TaskGraph {
  const parsed = taskGraphSchema.safeParse(input);
  if (!parsed.success) throw new TaskGraphError('TASK_GRAPH_INVALID');
  const graph = parsed.data;
  const tasks = new Map(graph.tasks.map(task => [task.id, task]));
  if (tasks.size !== graph.tasks.length) throw new TaskGraphError('TASK_DUPLICATE');
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const ready: string[] = [];
  for (const task of graph.tasks) {
    if (new Set(task.acceptanceCriteria).size !== task.acceptanceCriteria.length) throw new TaskGraphError('TASK_ACCEPTANCE_DUPLICATE');
    if (new Set(task.dependencies).size !== task.dependencies.length) throw new TaskGraphError('TASK_DEPENDENCY_DUPLICATE');
    remaining.set(task.id, task.dependencies.length);
    if (!task.dependencies.length) ready.push(task.id);
    for (const dependency of task.dependencies) {
      if (!tasks.has(dependency)) throw new TaskGraphError('TASK_DEPENDENCY_MISSING');
      const children = dependents.get(dependency) ?? [];
      children.push(task.id);
      dependents.set(dependency, children);
    }
  }
  for (let index = 0; index < ready.length; index++) {
    for (const child of dependents.get(ready[index]!) ?? []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (!count) ready.push(child);
    }
  }
  if (ready.length !== tasks.size) throw new TaskGraphError('TASK_GRAPH_CYCLE');
  return graph;
}
