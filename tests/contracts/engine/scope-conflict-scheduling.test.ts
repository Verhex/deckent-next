import { describe, expect, it } from 'vitest';
import { createRun, validateTaskGraph, type RunSnapshot, type TaskGraph, type TaskProgress } from '#domain/index.js';
import { deriveRunBlocker, planSchedulingWave, renderRunCreateApprovalSummary, systemOrderedGraph, type BoundRunAdmission, type MonitorRunEvidence } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

// alpha.47 R4 (owner D7a): the scheduler never starts two tasks of one Run that change the same resource together, through the existing
// excludedTaskIds concept; the system inserts order edges at admission (graph v5) and the card shows them. Business records, no Git.
const criterion = { id: 'ok', version: 1, description: 'Business readback', evaluator: { id: 'process-exit', version: 1 }, parameters: {} };
type Spec = { id: string; records?: string[]; paths?: string[]; dependencies?: unknown[] };
const authored = (tasks: Spec[]): TaskGraph => validateTaskGraph({ schemaVersion: tasks.some(task => task.records) ? 5 : 4, revision: 1, criterionDefinitions: [criterion],
  tasks: tasks.map(task => ({ id: task.id, kind: 'coding', dependencies: task.dependencies ?? [], acceptanceCriteria: ['ok'],
    ...(task.records ? { resources: task.records.map(id => ({ kind: 'erp.order', id })) } : {}),
    ...(task.paths ? { workInput: { schemaVersion: 1, task: 'Change it', scope: { paths: task.paths }, acceptance: 'Changed', model: { channelId: 'c', modelId: 'claude-opus-5-5', auxiliaryModelIds: [] } } } : {}) })) });
const progress = (taskId: string, phase: TaskProgress['phase'] = 'pending'): TaskProgress => ({ taskId, phase, unresolvedEffects: false, eligibility: { kind: 'immediate' } });
const wave = (graph: TaskGraph, rows: TaskProgress[], excludedTaskIds?: string[]) => planSchedulingWave(graph, { schemaVersion: 2, capacity: { executionSlots: 4, inFlightSlots: 4 },
  ordering: graph.tasks.map(task => task.id), ...(excludedTaskIds ? { excludedTaskIds } : {}), snapshot: { graphRevision: 1, now: 1, progress: rows } });

describe('scheduler exclusion through excludedTaskIds', () => {
  const graph = authored([{ id: 'approve', records: ['42'] }, { id: 'invoice', records: ['42'] }, { id: 'ship', records: ['43'] }]);
  it('selects one of two intersecting ready tasks and keeps disjoint work parallel', () => {
    expect(wave(graph, graph.tasks.map(task => progress(task.id)))).toMatchObject({ selectedTaskIds: ['approve', 'ship'], conflictTaskIds: ['invoice'] });
  });
  it('holds a ready task while intersecting work is in flight, then selects it once that work is terminal', () => {
    expect(wave(graph, [progress('approve', 'active'), progress('invoice'), progress('ship')]).selectedTaskIds).toEqual(['ship']);
    for (const phase of ['accepted', 'failed'] as const) expect(wave(graph, [progress('approve', phase), progress('invoice'), progress('ship', 'active')]).selectedTaskIds).toEqual(['invoice']);
  });
  it('a policy-excluded task does not hold back an intersecting one, and the result keeps its old shape without conflicts', () => {
    expect(wave(graph, graph.tasks.map(task => progress(task.id)), ['approve']).selectedTaskIds).toEqual(['invoice', 'ship']);
    const disjoint = authored([{ id: 'a', records: ['1'] }, { id: 'b', records: ['2'] }]);
    expect(wave(disjoint, [progress('a'), progress('b')])).not.toHaveProperty('conflictTaskIds');
  });
});

describe('admission inserts the order once; authors cannot', () => {
  it('orders an authored graph and refuses an authored system edge', () => {
    const ordered = systemOrderedGraph(authored([{ id: 'a', paths: ['src/a.ts'] }, { id: 'b', paths: ['src'] }]));
    expect(ordered.tasks[1]!.dependencies).toEqual([{ taskId: 'a', startFrom: 'accepted-patch', origin: 'scope-conflict' }]);
    expect(() => systemOrderedGraph(ordered)).toThrow('TASK_GRAPH_INVALID');
  });
  it('a branch Run keeps its exact compiled diamond (the runtime exclusion still applies)', () => {
    const graph = authored([{ id: 'a', paths: ['x'] }, { id: 'b', paths: ['x'] }]);
    expect(systemOrderedGraph(graph, { schemaVersion: 1 })).toBe(graph);
  });
});

describe('monitor blocker waiting-scope-conflict', () => {
  const evidence = (graph: TaskGraph, rows: TaskProgress[]): MonitorRunEvidence => {
    const run = { ...createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph)), progress: rows } as RunSnapshot;
    return { run: { snapshot: run, poolId: 'p', admitted: true, createdAtMs: 50, attempts: [] }, approvals: [],
      pool: { poolId: 'p', executionSlots: 2, inFlightSlots: 2, execution: 0, inFlight: 0, hold: null }, workers: new Map(), observedAt: 1000 };
  };
  it('names the wait on a system order edge and on a runtime exclusion, ranked above plain reservation progress', () => {
    const ordered = systemOrderedGraph(authored([{ id: 'approve', records: ['42'] }, { id: 'invoice', records: ['42'] }]));
    expect(deriveRunBlocker(evidence(ordered, [progress('approve'), progress('invoice')]))).toMatchObject({ code: 'waiting-scope-conflict', taskId: 'invoice', detail: 'approve' });
    const unordered = authored([{ id: 'a', records: ['7'] }, { id: 'b', records: ['7'] }]); // a Run admitted without edges (e.g. a branch Run)
    expect(deriveRunBlocker(evidence(unordered, [progress('a'), progress('b')]))).toMatchObject({ code: 'waiting-scope-conflict', taskId: 'b' });
    // A content dependency stays a dependency wait.
    const content = authored([{ id: 'a', records: ['42'] }, { id: 'b', records: ['43'], dependencies: ['a'] }]);
    expect(deriveRunBlocker(evidence(content, [progress('a'), progress('b')]))?.code).toBe('none');
  });
});

describe('the Run-create card shows the system order and the delivery intent', () => {
  const graph = systemOrderedGraph(authored([{ id: 'approve', records: ['42'] }, { id: 'invoice', records: ['42'] }, { id: 'ship', records: ['42'] }]));
  const proposal = { schemaVersion: 1 as const, proposalId: 'p', digest: 'a'.repeat(64), budgetCeiling: { currency: 'USD', limitMinorUnits: 100 }, requiredPermissions: [], admission: null };
  const card = (delivery?: object, locale: 'en' | 'tr' = 'en') => renderRunCreateApprovalSummary({ schemaVersion: 1, commandId: 'c', scopeId: 's', runId: 'r', graph,
    proposal: { ...proposal, ...(delivery ? { delivery } : {}) } } as BoundRunAdmission, { graph, execution: fixtureExecution(graph) } as never,
  { decision: 'require-approval', revision: 'p', reason: 'APPROVAL_REQUIRED' }, locale);
  it('lists every order edge (bounded rows, exact count) in English and Turkish', () => {
    expect(card()).toContain('System order (tasks that change the same resource run one after another): 2');
    expect(card()).toContain('• invoice starts after approve'); expect(card()).toContain('• ship starts after invoice');
    expect(card(undefined, 'tr')).toContain('Sistem sırası'); expect(card(undefined, 'tr')).toContain('• ship, invoice bitince başlar');
  });
  it('names the delivery intent target and that publish/adopt cards stay with the human', () => {
    const text = card({ target: { kind: 'git-ref', id: 'refs/heads/main' }, mode: 'enqueue-accepted', grantedBy: { id: 'owner', issuer: 'os', subject: '1000' } });
    expect(text).toContain('Delivery intent'); expect(text).toContain('refs/heads/main'); expect(text).toContain('publish/adopt cards stay required');
    expect(card()).not.toContain('Delivery intent');
  });
});
