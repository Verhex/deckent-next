import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { taskDependencyIds, TaskGraphError, type TaskGraph, type TaskProgress } from './contract.js';
import { validateTaskGraphStructure } from './graph.js';

/** Measured size of a task graph: tasks, dependency edges (inputs are not edges) and depth (tasks on the longest dependency chain). */
export const taskGraphShapeSchema = z.object({ tasks: counterSchema, edges: counterSchema, depth: counterSchema }).strict().readonly();
export type TaskGraphShape = z.infer<typeof taskGraphShapeSchema>;
/** PARALLEL-S3: one typed DAG summary for every surface (run inspect, monitor). `pending` = pending; `running` = active + evaluating;
 * `attention` = awaiting-decision + reconciling; `stopped` = cancelled + skipped. The buckets always add up to `total`.
 * `criticalPath` is the longest dependency chain of still-open Tasks (root first), ties broken by graph order; empty when none is open.
 * Observation only: it never orders, admits or accepts work. */
export const taskGraphSummarySchema = z.object({ schemaVersion: z.literal(1), shape: taskGraphShapeSchema,
  counts: z.object({ pending: counterSchema, running: counterSchema, attention: counterSchema, accepted: counterSchema, failed: counterSchema,
    stopped: counterSchema, total: counterSchema }).strict().readonly(),
  criticalPath: z.array(identitySchema).readonly(),
}).strict().readonly();
export type TaskGraphSummary = z.infer<typeof taskGraphSummarySchema>;
type Bucket = Exclude<keyof TaskGraphSummary['counts'], 'total'>;
const BUCKET: Readonly<Record<TaskProgress['phase'], Bucket>> = Object.freeze({ pending: 'pending', active: 'running', evaluating: 'running',
  'awaiting-decision': 'attention', reconciling: 'attention', accepted: 'accepted', failed: 'failed', cancelled: 'stopped', skipped: 'stopped' });
const OPEN: ReadonlySet<TaskProgress['phase']> = new Set(['pending', 'active', 'evaluating', 'awaiting-decision', 'reconciling']);

/** Deterministic Kahn order (ready Tasks in graph order); the structure is validated first, so the order is complete. */
function topologicalOrder(graph: Pick<TaskGraph, 'tasks'>): readonly TaskGraph['tasks'][number][] {
  validateTaskGraphStructure(graph);
  const remaining = new Map(graph.tasks.map(task => [task.id, task.dependencies.length]));
  const dependents = new Map<string, TaskGraph['tasks'][number][]>();
  for (const task of graph.tasks) for (const id of taskDependencyIds(task)) {
    const children = dependents.get(id); if (children) children.push(task); else dependents.set(id, [task]);
  }
  const order = graph.tasks.filter(task => !task.dependencies.length);
  for (let index = 0; index < order.length; index++) {
    for (const child of dependents.get(order[index]!.id) ?? []) {
      const count = remaining.get(child.id)! - 1; remaining.set(child.id, count);
      if (!count) order.push(child);
    }
  }
  return order;
}
/** Pure measurement used by admission limits and the DAG summary; it throws the ordinary structural TaskGraphError for an invalid graph. */
export function measureTaskGraph(graph: Pick<TaskGraph, 'tasks'>): TaskGraphShape { return shapeOf(graph, topologicalOrder(graph)); }
function shapeOf(graph: Pick<TaskGraph, 'tasks'>, order: ReturnType<typeof topologicalOrder>): TaskGraphShape {
  const level = new Map<string, number>(); let depth = 0, edges = 0;
  for (const task of order) {
    let longest = 0;
    for (const id of taskDependencyIds(task)) { edges++; longest = Math.max(longest, level.get(id)!); }
    level.set(task.id, longest + 1); depth = Math.max(depth, longest + 1);
  }
  return Object.freeze({ tasks: graph.tasks.length, edges, depth });
}
/** Summary of one Run graph from its canonical progress; a missing or foreign progress entry is refused, never guessed. */
export function summarizeTaskGraph(graph: Pick<TaskGraph, 'tasks'>, progress: readonly Pick<TaskProgress, 'taskId' | 'phase'>[]): TaskGraphSummary {
  const phases = new Map(progress.map(entry => [entry.taskId, entry.phase]));
  if (phases.size !== progress.length || phases.size !== graph.tasks.length || graph.tasks.some(task => !phases.has(task.id))) throw new TaskGraphError('TASK_PROGRESS_INCOMPLETE');
  const counts = { pending: 0, running: 0, attention: 0, accepted: 0, failed: 0, stopped: 0, total: graph.tasks.length };
  for (const phase of phases.values()) counts[BUCKET[phase]]++;
  const rank = new Map(graph.tasks.map((task, index) => [task.id, index]));
  const chain = new Map<string, { readonly length: number; readonly previous: string | null }>();
  let best: string | null = null; const order = topologicalOrder(graph);
  for (const task of order) {
    if (!OPEN.has(phases.get(task.id)!)) continue;
    let previous: string | null = null, length = 0;
    for (const id of taskDependencyIds(task)) {
      const entry = chain.get(id); if (!entry) continue;
      if (entry.length > length || (entry.length === length && rank.get(id)! < rank.get(previous!)!)) { previous = id; length = entry.length; }
    }
    chain.set(task.id, { length: length + 1, previous });
    const top = best === null ? null : chain.get(best)!;
    if (!top || length + 1 > top.length || (length + 1 === top.length && rank.get(task.id)! < rank.get(best!)!)) best = task.id;
  }
  const criticalPath: string[] = [];
  for (let id = best; id !== null; id = chain.get(id)!.previous) criticalPath.unshift(id);
  return taskGraphSummarySchema.parse({ schemaVersion: 1, shape: shapeOf(graph, order), counts, criticalPath });
}
