import { validateTaskGraph } from './graph.js';
import { TASK_GRAPH_RESOURCE_SCHEMA_VERSION, isConflictEdge, taskDependencyIds, type TaskDefinition, type TaskGraph, type TaskProgress } from './contract.js';

/** R4 (owner D7a, alpha.47): a resource a task declares it changes. Family `path` is a hierarchical resource path (work-input scope; for a
 * file-tree target a repository path, for a document store a folder path); family `record` is one business record (ERP/CRM `kind` + `id`).
 * Keys only order work. They grant nothing and are not enforced at execution here; the target adapter still refuses a stale write. */
export type ResourceKey = Readonly<{ family: 'path'; path: string }> | Readonly<{ family: 'record'; kind: string; id: string }>;
/** A glob is conservative: it stands for everything under its static prefix (the segments before the first `*`/`?` segment, the
 * workspace deny grammar's only wildcards). A glob without a static prefix is the root and intersects every path. */
const staticPrefix = (pattern: string) => {
  const segments = pattern.split('/'), wildcard = segments.findIndex(segment => /[*?]/u.test(segment));
  return (wildcard < 0 ? segments : segments.slice(0, wildcard)).join('/');
};
export function conflictKeys(task: Pick<TaskDefinition, 'workInput' | 'resources'>): readonly ResourceKey[] {
  return Object.freeze([...(task.workInput?.scope.paths ?? []).map(path => Object.freeze({ family: 'path' as const, path: staticPrefix(path) })),
    ...(task.resources ?? []).map(ref => Object.freeze({ family: 'record' as const, kind: ref.kind, id: ref.id }))]);
}
/** The path family's one rule (also the delivery revalidation rule): equal, or one is a whole-segment ancestor of the other; the root
 * (empty) path intersects all. Directory/file replacement and rename endpoints conflict; textual mergeability is irrelevant. */
export function resourcePathsIntersect(a: string, b: string): boolean {
  return a === '' || b === '' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
/** Records intersect only by exact key; different families never intersect. */
export function resourceKeysIntersect(a: ResourceKey, b: ResourceKey): boolean {
  if (a.family === 'path' && b.family === 'path') return resourcePathsIntersect(a.path, b.path);
  return a.family === 'record' && b.family === 'record' && a.kind === b.kind && a.id === b.id;
}
const intersect = (a: readonly ResourceKey[], b: readonly ResourceKey[]) => a.some(key => b.some(other => resourceKeysIntersect(key, other)));
/** Stable Kahn order: the earliest-declared ready task first. */
function stableOrder(graph: TaskGraph): readonly TaskDefinition[] {
  const placed = new Set<string>(), order: TaskDefinition[] = [];
  while (order.length < graph.tasks.length) {
    const next = graph.tasks.find(task => !placed.has(task.id) && taskDependencyIds(task).every(id => placed.has(id)))!;
    placed.add(next.id); order.push(next);
  }
  return order;
}
/** D7a: the system orders every pair of tasks whose keys intersect and that no edge orders yet. The later task (stable topological order)
 * waits for the nearest earlier one through an additive `accepted-patch` edge marked `origin: 'scope-conflict'` (graph v5). Pure and
 * idempotent; returns the input unchanged (same version and bytes) when nothing is added and an invalid graph unchanged for its validator. */
export function withConflictEdges(input: TaskGraph): TaskGraph {
  let graph: TaskGraph;
  try { graph = validateTaskGraph(input); } catch { return input; }
  const order = stableOrder(graph), ancestors = new Map<string, Set<string>>(), added = new Map<string, string[]>();
  order.forEach((task, index) => {
    const reach = new Set<string>();
    for (const id of taskDependencyIds(task)) { reach.add(id); for (const above of ancestors.get(id)!) reach.add(above); }
    const keys = conflictKeys(task);
    for (let earlier = index - 1; keys.length && earlier >= 0; earlier--) {
      const other = order[earlier]!;
      if (reach.has(other.id) || !intersect(keys, conflictKeys(other))) continue;
      added.set(task.id, [...added.get(task.id) ?? [], other.id]);
      reach.add(other.id); for (const above of ancestors.get(other.id)!) reach.add(above);
    }
    ancestors.set(task.id, reach);
  });
  if (!added.size) return input;
  return validateTaskGraph({ ...graph, schemaVersion: TASK_GRAPH_RESOURCE_SCHEMA_VERSION, tasks: graph.tasks.map(task => ({ ...task, dependencies: [...task.dependencies,
    ...(added.get(task.id) ?? []).map(taskId => ({ taskId, startFrom: 'accepted-patch' as const, origin: 'scope-conflict' as const }))] })) });
}
/** System edges are never authored: a proposer or caller cannot forge an ordering the card would show as the system's. */
export function hasConflictEdges(graph: Pick<TaskGraph, 'tasks'>): boolean { return graph.tasks.some(task => task.dependencies.some(isConflictEdge)); }
const IN_FLIGHT = new Set<TaskProgress['phase']>(['active', 'evaluating', 'reconciling']);
/** D7a runtime exclusion, pure: of the ready `candidates` (in scheduling order) drop each whose keys intersect an in-flight task of the
 * Run or an earlier kept candidate. Accepted work never excludes (edges order it), so a terminal predecessor cannot deadlock a Run. */
export function excludeConflicting(graph: Pick<TaskGraph, 'tasks'>, progress: readonly TaskProgress[], candidates: readonly string[]): readonly string[] {
  const keys = new Map(graph.tasks.map(task => [task.id, conflictKeys(task)]));
  const held = progress.filter(task => task.unresolvedEffects || IN_FLIGHT.has(task.phase)).map(task => keys.get(task.taskId) ?? []);
  const excluded: string[] = [];
  for (const id of candidates) {
    const own = keys.get(id) ?? [];
    if (own.length && held.some(other => intersect(own, other))) excluded.push(id); else held.push(own);
  }
  return Object.freeze(excluded);
}
