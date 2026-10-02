import { sanitizeIssues } from '#domain/core/primitives/index.js';
import { readinessInputSchema, TaskGraphError, type TaskProgress } from './contract.js';
import { validateTaskGraph } from './graph.js';

export type TaskReadiness = Readonly<{
  taskId: string;
  disposition: 'ready' | 'waiting' | 'blocked' | 'delayed' | 'occupied' | 'terminal' | 'reconciliation' | 'awaiting-decision';
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
  const blockedMemo = new Map<string, boolean>();
  const blocked = (id: string): boolean => {
    const cached = blockedMemo.get(id); if (cached !== undefined) return cached;
    const state = progress.get(id)!;
    const value = state.phase !== 'accepted' && (['failed', 'cancelled', 'skipped'].includes(state.phase) || graph.tasks.find(task => task.id === id)!.dependencies.some(blocked));
    blockedMemo.set(id, value); return value;
  };
  return Object.freeze(graph.tasks.map(task => {
    const state = progress.get(task.id)!;
    let disposition: TaskReadiness['disposition'];
    const dependencies = task.dependencies.filter(id => progress.get(id)!.phase !== 'accepted');
    if (state.unresolvedEffects || state.phase === 'reconciling') disposition = 'reconciliation';
    else if (['accepted', 'failed', 'cancelled', 'skipped'].includes(state.phase)) disposition = 'terminal';
    else if (state.phase === 'awaiting-decision') disposition = 'awaiting-decision';
    else if (state.phase === 'active' || state.phase === 'evaluating') disposition = 'occupied';
    else if (dependencies.some(blocked)) disposition = 'blocked';
    else if (dependencies.length) disposition = 'waiting';
    else if (state.eligibility.kind === 'not-before' && state.eligibility.at > snapshot.now) disposition = 'delayed';
    else disposition = 'ready';
    return Object.freeze({ taskId: task.id, disposition, dependencies: Object.freeze(dependencies) });
  }));
}
