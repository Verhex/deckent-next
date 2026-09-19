import { sanitizeIssues } from '#domain/core/primitives/index.js';
import { readinessInputSchema, TaskGraphError, type TaskProgress } from './contract.js';
import { validateTaskGraph } from './graph.js';

export type TaskReadiness = Readonly<{
  taskId: string;
  disposition: 'ready' | 'waiting' | 'blocked' | 'delayed' | 'occupied' | 'terminal' | 'reconciliation';
  dependencies: readonly string[];
}>;

/** Dependency eligibility only: resource, authorization and conflict admission remain application duties.
 * Progress must come from the canonical application snapshot, never worker exit codes or surface state.
 * A fix Task does not impersonate acceptance of its original Task; original acceptance stays explicit.
 */
export function inspectTaskReadiness(graphInput: unknown, snapshotInput: unknown): readonly TaskReadiness[] {
  const graph = validateTaskGraph(graphInput);
  const parsed = readinessInputSchema.safeParse(snapshotInput);
  if (!parsed.success) throw new TaskGraphError('TASK_PROGRESS_INVALID', sanitizeIssues(parsed.error.issues));
  const snapshot = parsed.data;
  if (snapshot.graphRevision !== graph.revision) throw new TaskGraphError('TASK_GRAPH_REVISION_MISMATCH');
  const progress = new Map<string, TaskProgress>();
  for (const state of snapshot.progress) {
    if (progress.has(state.taskId)) throw new TaskGraphError('TASK_PROGRESS_DUPLICATE');
    progress.set(state.taskId, state);
  }
  if (progress.size !== graph.tasks.length || graph.tasks.some(task => !progress.has(task.id))) {
    throw new TaskGraphError('TASK_PROGRESS_INCOMPLETE');
  }
  return Object.freeze(graph.tasks.map(task => {
    const state = progress.get(task.id)!;
    let disposition: TaskReadiness['disposition'];
    const dependencies = task.dependencies.filter(id => progress.get(id)!.phase !== 'accepted');
    if (state.unresolvedEffects || state.phase === 'reconciling') disposition = 'reconciliation';
    else if (['accepted', 'failed', 'cancelled'].includes(state.phase)) disposition = 'terminal';
    else if (state.phase === 'active' || state.phase === 'evaluating') disposition = 'occupied';
    else if (dependencies.some(id => ['failed', 'cancelled'].includes(progress.get(id)!.phase))) disposition = 'blocked';
    else if (dependencies.length) disposition = 'waiting';
    else if (state.eligibility.kind === 'not-before' && state.eligibility.at > snapshot.now) disposition = 'delayed';
    else disposition = 'ready';
    return Object.freeze({ taskId: task.id, disposition, dependencies: Object.freeze(dependencies) });
  }));
}
