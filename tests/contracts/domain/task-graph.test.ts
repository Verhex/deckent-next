import { describe, expect, it } from 'vitest';
import { inspectTaskReadiness, validateTaskGraph } from '../../../src/domain/index.js';

const task = (id: string, dependencies: string[] = []) => ({ id, kind: 'customer.purchase', dependencies, acceptanceCriteria: ['verified-result'] });
const graph = (tasks = [task('a'), task('b', ['a'])]) => ({ schemaVersion: 1, revision: 1, tasks });
const progress = (taskId: string, phase = 'pending', unresolvedEffects = false, eligibleAt = 0) => ({ taskId, phase, unresolvedEffects, eligibleAt });
const inspect = (states: ReturnType<typeof progress>[], tasks = graph()) => inspectTaskReadiness(tasks, { graphRevision: 1, now: 100, progress: states });

describe('task graph admission and dependency eligibility', () => {
  it('rejects duplicate identities, missing edges, cycles and ambiguous criteria', () => {
    for (const [tasks, error] of [
      [[task('a'), task('a')], 'TASK_DUPLICATE'],
      [[task('a', ['missing'])], 'TASK_DEPENDENCY_MISSING'],
      [[task('a', ['a'])], 'TASK_GRAPH_CYCLE'],
      [[task('a', ['b']), task('b', ['a'])], 'TASK_GRAPH_CYCLE'],
      [[task('a'), task('b', ['a', 'a'])], 'TASK_DEPENDENCY_DUPLICATE'],
      [[{ ...task('a'), acceptanceCriteria: ['x', 'x'] }], 'TASK_ACCEPTANCE_DUPLICATE'],
    ] as const) expect(() => validateTaskGraph(graph([...tasks]))).toThrow(error);
  });
  it('accepts extensible kinds, freezes admitted input and avoids recursive traversal at 10k depth', () => {
    const input = graph(Array.from({ length: 10_000 }, (_, i) => task(String(i), i ? [String(i - 1)] : [])));
    const accepted = validateTaskGraph(input);
    input.tasks[0]!.kind = 'changed';
    expect(accepted.tasks[0]!.kind).toBe('customer.purchase');
    expect(Object.isFrozen(accepted.tasks[0]!.dependencies)).toBe(true);
    expect(Object.isFrozen(accepted.tasks)).toBe(true);
    expect(accepted.tasks).toHaveLength(10_000);
  });
  it('unlocks dependencies only after application acceptance, never merely worker completion', () => {
    expect(inspect([progress('a', 'evaluating'), progress('b')]).map(x => x.disposition)).toEqual(['occupied', 'waiting']);
    expect(inspect([progress('a', 'accepted'), progress('b')]).map(x => x.disposition)).toEqual(['terminal', 'ready']);
  });
  it('keeps retry timing, failed dependencies and unresolved effects distinct', () => {
    expect(inspect([progress('a', 'pending', false, 101), progress('b')]).map(x => x.disposition)).toEqual(['delayed', 'waiting']);
    expect(inspect([progress('a', 'failed'), progress('b')])[1]!.disposition).toBe('blocked');
    expect(inspect([progress('a', 'pending', true), progress('b')])[0]!.disposition).toBe('reconciliation');
    expect(() => inspect([progress('a', 'accepted', true), progress('b')])).toThrow('TASK_PROGRESS_INVALID');
  });
  it('fails closed for incomplete, duplicate, foreign and stale progress snapshots', () => {
    expect(() => inspect([progress('a')])).toThrow('TASK_PROGRESS_INCOMPLETE');
    expect(() => inspect([progress('a'), progress('a')])).toThrow('TASK_PROGRESS_DUPLICATE');
    expect(() => inspect([progress('a'), progress('foreign')])).toThrow('TASK_PROGRESS_INCOMPLETE');
    expect(() => inspectTaskReadiness(graph(), { graphRevision: 2, now: 0, progress: [] })).toThrow('TASK_GRAPH_REVISION_MISMATCH');
  });
  it('never aliases acceptance of a fix to acceptance of the original responsibility', () => {
    const tasks = graph([task('original'), task('fix'), task('consumer', ['original'])]);
    expect(inspect([progress('original', 'evaluating'), progress('fix', 'accepted'), progress('consumer')], tasks)[2]!.disposition).toBe('waiting');
    expect(inspect([progress('original', 'accepted'), progress('fix', 'accepted'), progress('consumer')], tasks)[2]!.disposition).toBe('ready');
  });
});

describe('task schema diagnostics', () => {
  it('rejects invalid version, kind and acceptance with sanitized field paths', () => {
    for (const [input, path] of [
      [{ ...graph(), schemaVersion: 2 }, ['schemaVersion']],
      [graph([{ ...task('a'), kind: '' }]), ['tasks', 0, 'kind']],
      [graph([{ ...task('a'), acceptanceCriteria: [] }]), ['tasks', 0, 'acceptanceCriteria']],
      [graph([{ ...task('a'), id: 'x'.repeat(257) }]), ['tasks', 0, 'id']],
    ] as const) {
      try { validateTaskGraph(input); expect.fail('must reject'); }
      catch (error) { expect(error).toMatchObject({ code: 'TASK_GRAPH_INVALID', issues: expect.arrayContaining([expect.objectContaining({ path })]) }); }
    }
  });
  it('documents direct blockers without silently cascading terminal state to descendants', () => {
    const tasks = graph([task('a'), task('b', ['a']), task('c', ['b'])]);
    expect(inspect([progress('a', 'failed'), progress('b'), progress('c')], tasks).map(x => x.disposition)).toEqual(['terminal', 'blocked', 'waiting']);
  });
});
