import { describe, expect, it } from 'vitest';
import { conflictKeys, excludeConflicting, inspectTaskReadiness, reconcileRunLifecycle, resourceKeysIntersect, validateTaskGraph, withConflictEdges,
  type TaskGraph, type TaskProgress } from '#domain/index.js';

// alpha.47 R4 (owner D7a, 2026-10-18): tasks that change the same resource never run at the same time. The system orders them with an
// additive `origin: 'scope-conflict'` edge (graph v5) and the scheduler excludes a ready task that intersects in-flight work. One generic rule:
// hierarchical paths (a work-input scope; a glob stands for its static prefix) and exact business records (ERP/CRM kind + id).
const definition = { id: 'ok', version: 1, description: 'OK', evaluator: { id: 'test', version: 1 }, parameters: {} };
const model = { channelId: 'claude', modelId: 'claude-opus-5-5', auxiliaryModelIds: [] };
const scoped = (paths: string[]) => ({ schemaVersion: 1, task: 'Change it', scope: { paths }, acceptance: 'It is changed', model });
type Spec = { id: string; paths?: string[]; records?: { kind: string; id: string }[]; dependencies?: unknown[] };
const graph = (tasks: Spec[], version = 4): TaskGraph => validateTaskGraph({ schemaVersion: tasks.some(task => task.records) ? 5 : version, revision: 1, criterionDefinitions: [definition],
  tasks: tasks.map(task => ({ id: task.id, kind: 'work', dependencies: task.dependencies ?? [], acceptanceCriteria: ['ok'],
    ...(task.paths ? { workInput: scoped(task.paths) } : {}), ...(task.records ? { resources: task.records } : {}) })) });
const progress = (taskId: string, phase: TaskProgress['phase'], extra: Partial<TaskProgress> = {}) =>
  ({ taskId, phase, unresolvedEffects: false, eligibility: { kind: 'immediate' }, ...extra }) as TaskProgress;
const edge = (taskId: string) => ({ taskId, startFrom: 'accepted-patch', origin: 'scope-conflict' });

describe('conflict keys and the generic intersection rule', () => {
  it('a path conflicts with itself, its ancestors and descendants; never with a sibling sharing a name prefix', () => {
    const key = (path: string) => conflictKeys({ workInput: scoped([path]) as never })[0]!;
    expect(resourceKeysIntersect(key('src/a.ts'), key('src/a.ts'))).toBe(true);
    expect(resourceKeysIntersect(key('src'), key('src/a.ts'))).toBe(true);
    expect(resourceKeysIntersect(key('src/a.ts'), key('src/a.ts.bak'))).toBe(false);
    expect(resourceKeysIntersect(key('src/ab'), key('src/a'))).toBe(false);
  });
  it('a glob is conservative: it intersects everything under its static prefix, and a leading wildcard intersects all', () => {
    expect(conflictKeys({ workInput: scoped(['src/**/*.ts', 'docs/*.md', '**/x']) as never })).toEqual([{ family: 'path', path: 'src' }, { family: 'path', path: 'docs' }, { family: 'path', path: '' }]);
    const keys = (paths: string[]) => conflictKeys({ workInput: scoped(paths) as never });
    expect(keys(['src/**']).some(a => keys(['src/deep/file.ts']).some(b => resourceKeysIntersect(a, b)))).toBe(true);
    expect(keys(['src/**']).some(a => keys(['tests/x.ts']).some(b => resourceKeysIntersect(a, b)))).toBe(false);
    expect(keys(['*.md']).some(a => keys(['anything/at/all']).some(b => resourceKeysIntersect(a, b)))).toBe(true);
  });
  it('business records intersect only by exact kind and id, and never with a path', () => {
    const order = { family: 'record', kind: 'erp.order', id: '42' } as const;
    expect(resourceKeysIntersect(order, { family: 'record', kind: 'erp.order', id: '42' })).toBe(true);
    expect(resourceKeysIntersect(order, { family: 'record', kind: 'erp.order', id: '43' })).toBe(false);
    expect(resourceKeysIntersect(order, { family: 'record', kind: 'crm.account', id: '42' })).toBe(false);
    expect(resourceKeysIntersect(order, { family: 'path', path: '' })).toBe(false);
  });
});

describe('system order edges at admission (graph v5)', () => {
  it('orders intersecting tasks after the nearest earlier one and leaves disjoint work parallel', () => {
    const ordered = withConflictEdges(graph([{ id: 'a', paths: ['src/a.ts'] }, { id: 'b', paths: ['docs/x.md'] }, { id: 'c', paths: ['src/**'] }, { id: 'd', paths: ['src/a.ts'] }]));
    expect(ordered.schemaVersion).toBe(5);
    expect(ordered.tasks.map(task => [task.id, task.dependencies])).toEqual([['a', []], ['b', []], ['c', [edge('a')]], ['d', [edge('c')]]]);
    expect(withConflictEdges(ordered)).toEqual(ordered); // idempotent
  });
  it('ERP/CRM record keys order work with no path, test or repository involved', () => {
    const ordered = withConflictEdges(graph([{ id: 'approve', records: [{ kind: 'erp.order', id: '42' }] }, { id: 'invoice', records: [{ kind: 'erp.order', id: '42' }] },
      { id: 'other', records: [{ kind: 'erp.order', id: '43' }] }]));
    expect(ordered.tasks.map(task => task.dependencies)).toEqual([[], [edge('approve')], []]);
  });
  it('adds nothing and keeps the exact input (version and bytes) when tasks are already ordered or disjoint', () => {
    const chained = graph([{ id: 'a', paths: ['x'] }, { id: 'b', paths: ['x'], dependencies: ['a'] }]), disjoint = graph([{ id: 'a', paths: ['x'] }, { id: 'b', paths: ['y'] }]);
    expect(withConflictEdges(chained)).toBe(chained); expect(withConflictEdges(disjoint)).toBe(disjoint);
    expect(withConflictEdges(chained).schemaVersion).toBe(4);
    const transitive = graph([{ id: 'a', paths: ['x'] }, { id: 'm', dependencies: ['a'] }, { id: 'b', paths: ['x'], dependencies: ['m'] }]);
    expect(withConflictEdges(transitive)).toBe(transitive);
  });
  it('older graph versions and authored v4 graphs refuse system edges and record resources', () => {
    const base = { revision: 1, criterionDefinitions: [definition] };
    expect(() => validateTaskGraph({ ...base, schemaVersion: 4, tasks: [{ id: 'a', kind: 'w', dependencies: [], acceptanceCriteria: ['ok'] },
      { id: 'b', kind: 'w', dependencies: [edge('a')], acceptanceCriteria: [] }] })).toThrow('TASK_GRAPH_INVALID');
    expect(() => validateTaskGraph({ ...base, schemaVersion: 4, tasks: [{ id: 'a', kind: 'w', dependencies: [], acceptanceCriteria: ['ok'], resources: [{ kind: 'erp.order', id: '1' }] }] })).toThrow('TASK_GRAPH_INVALID');
    expect(() => validateTaskGraph({ ...base, schemaVersion: 5, tasks: [{ id: 'a', kind: 'w', dependencies: [], acceptanceCriteria: ['ok'] },
      { id: 'b', kind: 'w', dependencies: [{ taskId: 'a', origin: 'scope-conflict' }], acceptanceCriteria: ['ok'] }] })).toThrow('TASK_GRAPH_INVALID');
    // A scope-conflict edge never carries a data input: inputs name only content dependencies.
    expect(() => validateTaskGraph({ ...base, schemaVersion: 5, tasks: [{ id: 'a', kind: 'w', dependencies: [], acceptanceCriteria: ['ok'] },
      { id: 'b', kind: 'w', dependencies: [edge('a')], acceptanceCriteria: ['ok'], inputs: [{ name: 'in', taskId: 'a' }] }] })).toThrow('TASK_GRAPH_INVALID');
    expect(validateTaskGraph({ ...base, schemaVersion: 3, tasks: [{ id: 'a', kind: 'w', dependencies: [], acceptanceCriteria: ['ok'] }] }).schemaVersion).toBe(3);
  });
});

describe('a conflict edge orders work; it never skips the dependent', () => {
  const ordered = withConflictEdges(graph([{ id: 'a', paths: ['x'] }, { id: 'b', paths: ['x'] }]));
  it('waits while the predecessor runs and becomes ready when it is accepted, failed, cancelled or skipped', () => {
    const at = (phase: TaskProgress['phase']) => inspectTaskReadiness(ordered, { graphRevision: 1, now: 1,
      progress: [progress('a', phase, phase === 'skipped' ? { skippedReason: 'dependency-failed' } : {}), progress('b', 'pending')] })[1]!;
    expect(at('active')).toMatchObject({ disposition: 'waiting', dependencies: ['a'] });
    for (const phase of ['accepted', 'failed', 'cancelled', 'skipped'] as const) expect(at(phase)).toMatchObject({ disposition: 'ready', dependencies: [] });
  });
  it('the Run lifecycle keeps the dependent pending (it starts from base) where a content edge would skip it', () => {
    const run = (input: TaskGraph) => ({ schemaVersion: 4, identity: { runId: 'r', scopeId: 's', layoutRevision: 'l' }, revision: 1, state: { kind: 'running' }, graph: input,
      execution: { schemaVersion: 1, registryRevision: 'r', tasks: input.tasks.map(task => ({ taskId: task.id, profile: { id: 'p', version: 1, adapter: { id: 'a', version: 1 }, parameters: {} } })),
        criteria: [{ criterionId: 'ok', evaluator: { ...definition.evaluator, implementation: { id: 'test', version: 1 } }, fingerprint: 'a'.repeat(64) }] },
      progress: [progress('a', 'failed'), progress('b', 'pending')], bindings: [], cancelRequested: false });
    expect(reconcileRunLifecycle(run(ordered), 1, 10).progress[1]).toMatchObject({ phase: 'pending' });
    const content = validateTaskGraph({ ...ordered, schemaVersion: 4, tasks: [ordered.tasks[0], { ...ordered.tasks[1], dependencies: [{ taskId: 'a', startFrom: 'accepted-patch' }] }] });
    expect(reconcileRunLifecycle(run(content), 1, 10).progress[1]).toMatchObject({ phase: 'skipped', skippedReason: 'dependency-failed' });
  });
});

describe('runtime exclusion (excludedTaskIds)', () => {
  const tasks = graph([{ id: 'a', paths: ['src/a.ts'] }, { id: 'b', paths: ['src/**'] }, { id: 'c', paths: ['docs'] }, { id: 'd', records: [{ kind: 'erp.order', id: '42' }] },
    { id: 'e', records: [{ kind: 'erp.order', id: '42' }] }]);
  it('of two intersecting ready tasks one is selected and one is excluded; disjoint and record-distinct work stays', () => {
    expect(excludeConflicting(tasks, ['a', 'b', 'c', 'd', 'e'].map(id => progress(id, 'pending')), ['a', 'b', 'c', 'd', 'e'])).toEqual(['b', 'e']);
  });
  it('in-flight and uncertain work excludes; accepted or failed work never does (no deadlock on a terminal task)', () => {
    for (const phase of ['active', 'evaluating', 'reconciling'] as const)
      expect(excludeConflicting(tasks, [progress('a', phase), progress('b', 'pending')], ['b'])).toEqual(['b']);
    expect(excludeConflicting(tasks, [progress('a', 'pending', { unresolvedEffects: true } as never), progress('b', 'pending')], ['b'])).toEqual(['b']);
    for (const phase of ['accepted', 'failed', 'awaiting-decision'] as const)
      expect(excludeConflicting(tasks, [progress('a', phase), progress('b', 'pending')], ['b'])).toEqual([]);
  });
  it('a task without declared resources is never excluded and excludes nothing', () => {
    const free = graph([{ id: 'a' }, { id: 'b' }]);
    expect(excludeConflicting(free, [progress('a', 'active'), progress('b', 'pending')], ['b'])).toEqual([]);
  });
});
