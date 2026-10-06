import { ErrorRegistry } from '#platform/index.js';
import { measureTaskGraph, type TaskGraph, type TaskGraphShape } from '#domain/index.js';
type DockerLimits = { readonly memoryBytes: number; readonly cpus: number; readonly pids: number };
/** Installation limits refuse an oversized immutable profile before admission; never clamp requested resources. */
export function assertDockerResourceCeiling(requested: DockerLimits, ceiling: DockerLimits): void {
  for (const resource of ['memoryBytes', 'cpus', 'pids'] as const) {
    if (requested[resource] > ceiling[resource]) throw ErrorRegistry.createError('EXECUTION_RESOURCE_CEILING', {
      params: { resource, requested: requested[resource], ceiling: ceiling[resource] } });
  }
}
/** Admission graph limits; values come from installation config (`admission.graph`), never from code. */
export type TaskGraphLimits = { readonly maxTasks: number; readonly maxEdges: number; readonly maxDepth: number };
/** The config key a refusal names, so the operator knows exactly what to raise. */
export const taskGraphLimitFields = Object.freeze({ tasks: 'admission.graph.maxTasks', edges: 'admission.graph.maxEdges', depth: 'admission.graph.maxDepth' });
const LIMIT_OF = Object.freeze({ tasks: 'maxTasks', edges: 'maxEdges', depth: 'maxDepth' } as const);
/** PARALLEL-S3: refuse a graph above the configured tasks/edges/depth before any admission write (typed TASK_GRAPH_LIMIT); never trims the graph. */
export function assertTaskGraphLimits(graph: Pick<TaskGraph, 'tasks'>, limits: TaskGraphLimits): TaskGraphShape {
  const shape = measureTaskGraph(graph);
  for (const detail of ['tasks', 'edges', 'depth'] as const) {
    if (shape[detail] > limits[LIMIT_OF[detail]]) throw ErrorRegistry.createError('TASK_GRAPH_LIMIT', {
      params: { detail, observed: shape[detail], limit: limits[LIMIT_OF[detail]], field: taskGraphLimitFields[detail] } });
  }
  return shape;
}
