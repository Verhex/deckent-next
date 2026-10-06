import { describe, expect, it } from 'vitest';
import { createRun, type RunSnapshot } from '#domain/index.js';
import { extractFailedTests, projectMonitorRun, resultBriefSchema, projectResultBrief, type MonitorLedgerAttempt, type MonitorRunEvidence } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

/** M2/M3 producer side: the pure failed-test extractor, the close reason / turns / delivery outlook derivation. */
const line = (value: unknown) => `verify-failed-test: ${JSON.stringify(value)}`;

describe('extractFailedTests (M3)', () => {
  it('counts every reporter failure line and keeps only the first N names, bounded and cleaned', () => {
    const out = ['noise', ...Array.from({ length: 22 }, (_, i) => line({ file: `tests/f${i}.test.ts`, test: `suite > case ${i}`, state: 'failed' })), 'verify-evidence: {}'].join('\n');
    const found = extractFailedTests(out, 5)!;
    expect(found.count).toBe(22); expect(found.names).toEqual([0, 1, 2, 3, 4].map(i => `tests/f${i}.test.ts > suite > case ${i}`)); expect(found.truncated).toBe(true);
    expect(extractFailedTests(out, 50)).toMatchObject({ count: 22, truncated: false });
    expect(extractFailedTests(out, 50, false)).toMatchObject({ truncated: true });
  });
  it('names collection and unhandled errors, strips escapes and redacts, bounds a long name', () => {
    const found = extractFailedTests([line({ file: 'tests/x.test.ts', test: null, state: 'collection-error', reason: 'SyntaxError' }), line({ file: null, test: null, state: 'unhandled-error', reason: 'Error' }),
      line({ file: 'a.test.ts', test: `\u001b[31mred\u001b[0m ${'x'.repeat(400)}`, state: 'failed' })].join('\n'), 10)!;
    expect(found.names[0]).toBe('tests/x.test.ts (SyntaxError)'); expect(found.names[1]).toBe('— (Error)');
    expect(found.names[2]).not.toContain('\u001b'); expect(found.names[2]!.length).toBeLessThanOrEqual(200);
  });
  it('negative: no reporter lines, forged non-JSON or non-object lines yield nothing', () => {
    expect(extractFailedTests('FAIL tests/a.test.ts\n# fail 3', 5)).toBeNull();
    expect(extractFailedTests(`${'verify-failed-test: '}not json\n${'verify-failed-test: '}"str"\n${'verify-failed-test: '}null`, 5)).toBeNull();
    expect(extractFailedTests('  verify-failed-test: {"file":"a"}', 5)).toBeNull();
  });
});

const identity = (taskId: string) => ({ runId: 'r', taskId, attemptId: 'a-' + taskId, scopeId: 's', layoutRevision: 'l', generation: 1 });
const input = { schemaVersion: 1 as const, task: 'work', acceptance: 'ok', scope: { paths: ['a.txt'] }, model: { channelId: 'c', modelId: 'm', auxiliaryModelIds: [] } };
function accepted(tasks: readonly { id: string; work: boolean }[]): RunSnapshot {
  const plain = { schemaVersion: 2 as const, revision: 1, tasks: tasks.map(task => ({ id: task.id, kind: 'coding', dependencies: [], acceptanceCriteria: ['ok'] })),
    criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'process-exit', version: 1 }, parameters: {} }] };
  const created = createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, plain, 0, fixtureExecution(plain));
  // Work input is attached after admission, like the existing H1 fixture (the registry would demand a work-input template at creation).
  const base = { ...created, graph: { ...created.graph, schemaVersion: 3 as const, tasks: created.graph.tasks.map(task => tasks.find(value => value.id === task.id)!.work ? { ...task, workInput: input } : task) } };
  return { ...base, state: { kind: 'terminal', outcome: 'completed' }, bindings: tasks.map(task => ({ identity: identity(task.id), observedRevision: 3, observedKind: 'exited' as const })),
    progress: tasks.map(task => ({ taskId: task.id, phase: 'accepted' as const, unresolvedEffects: false, eligibility: { kind: 'immediate' as const } })) } as unknown as RunSnapshot;
}
const done = (taskId: string, over: Partial<MonitorLedgerAttempt> = {}, dispatch: Partial<NonNullable<MonitorLedgerAttempt['dispatch']>> = {}): MonitorLedgerAttempt => ({ attemptId: 'a-' + taskId, generation: 1, observedKind: 'exited',
  observedRevision: 3, evaluationObserved: true, reservedAtMs: 100, sealedAtMs: 900, dispatch: { launch: 'granted', grantedAtMs: 200, outputRecorded: true,
    terminal: { exitCode: 0, signal: null, interrupted: false }, ...dispatch }, ...over });
const evidence = (run: RunSnapshot, attempts: MonitorLedgerAttempt[], delivery?: MonitorRunEvidence['run']['delivery']): MonitorRunEvidence => ({
  run: { snapshot: run, poolId: 'p', admitted: true, createdAtMs: 50, attempts, ...(delivery !== undefined ? { delivery } : {}) }, approvals: [], pool: null, workers: new Map(), observedAt: 1_000_000 });
const project = (value: MonitorRunEvidence) => projectMonitorRun(value);

describe('delivery outlook of an accepted Run (M2)', () => {
  it('DT-1 shape: accepted work with no retained patch is patch-not-prepared; a retained patch awaits delivery; no work input has nothing to deliver', () => {
    const work = accepted([{ id: 'w', work: true }]);
    expect(project(evidence(work, [done('w', {}, { patchRecorded: false })])).deliveryOutlook).toBe('patch-not-prepared');
    expect(project(evidence(work, [done('w', {}, { patchRecorded: true })])).deliveryOutlook).toBe('awaiting-delivery');
    expect(project(evidence(accepted([{ id: 'v', work: false }]), [done('v', {}, { patchRecorded: false })])).deliveryOutlook).toBe('none');
  });
  it('negative: a missing patch on any accepted work task wins, a receipt suppresses the outlook, unknown evidence and unaccepted Runs give none', () => {
    const two = accepted([{ id: 'w', work: true }, { id: 'x', work: true }]);
    expect(project(evidence(two, [done('w', {}, { patchRecorded: true }), done('x', {}, { patchRecorded: false })])).deliveryOutlook).toBe('patch-not-prepared');
    expect(project(evidence(accepted([{ id: 'w', work: true }]), [done('w', {}, { patchRecorded: false })], { state: 'adopted', commit: null })).deliveryOutlook).toBeUndefined();
    expect(project(evidence(accepted([{ id: 'w', work: true }]), [done('w')])).deliveryOutlook).toBeUndefined();
    const failed = { ...accepted([{ id: 'w', work: true }]), state: { kind: 'terminal', outcome: 'failed' }, progress: [{ taskId: 'w', phase: 'failed', unresolvedEffects: false, eligibility: { kind: 'immediate' } }] } as unknown as RunSnapshot;
    expect(project(evidence(failed, [done('w', {}, { patchRecorded: false })])).deliveryOutlook).toBeUndefined();
  });
  it('the shared result brief carries the outlook and failed tests and stays strict', () => {
    const brief = projectResultBrief('a', { verdict: 'accepted' }, null, null, { deliveryOutlook: 'patch-not-prepared', failedTests: { count: 2, names: ['t\u001b[31m > x'], truncated: false } });
    expect(brief).toMatchObject({ deliveryOutlook: 'patch-not-prepared', failedTests: { count: 2, names: ['t > x'] } });
    expect(resultBriefSchema.safeParse({ ...brief, deliveryOutlook: 'invented' }).success).toBe(false);
    expect(projectResultBrief('a', { verdict: 'accepted' })).not.toHaveProperty('deliveryOutlook');
  });
});

describe('worker close narrative (M2)', () => {
  const run = accepted([{ id: 'w', work: false }]);
  const reason = (attempt: MonitorLedgerAttempt) => project(evidence(run, [attempt])).tasks[0]!.lastAttempt!;
  it('derives the close reason from the dispatch terminal and the observation, and turns/outcome from sealed events only', () => {
    expect(reason(done('w')).closeReason).toBe('exit-ok');
    expect(reason(done('w', {}, { terminal: { exitCode: 3, signal: null, interrupted: false } })).closeReason).toBe('exit-error');
    expect(reason(done('w', {}, { terminal: { exitCode: null, signal: 'SIGKILL', interrupted: false } })).closeReason).toBe('signal');
    expect(reason(done('w', {}, { terminal: { exitCode: 0, signal: null, interrupted: true } })).closeReason).toBe('interrupted');
    expect(reason(done('w', { observedKind: 'cancelled' })).closeReason).toBe('cancelled');
    const events = { provider: 'p', model: 'm', outcome: 'success', turns: 8, durationMs: 1, apiDurationMs: null, tokenUsageRecorded: false } as never;
    expect(reason(done('w', { content: { usage: events, transcript: { state: 'sealed', excerpt: [], truncated: false }, patch: { state: 'missing', files: [], fileCount: null, truncated: false, baseCommit: null }, finalReport: null } }))).toMatchObject({ turns: 8, sessionOutcome: 'success' });
  });
  it('negative: a running attempt has no close reason and no events means no turns or outcome', () => {
    const open = reason(done('w', {}, { terminal: null }));
    expect(open).not.toHaveProperty('closeReason'); expect(open).not.toHaveProperty('turns'); expect(open).not.toHaveProperty('sessionOutcome');
  });
});

describe('exited work awaiting evaluation without a retained patch (M2)', () => {
  const waiting = (work: boolean, patchRecorded: boolean | undefined) => {
    const run = accepted([{ id: 'w', work }]);
    const evaluating = { ...run, state: { kind: 'running' }, progress: [{ taskId: 'w', phase: 'evaluating', unresolvedEffects: false, eligibility: { kind: 'immediate' } }] } as unknown as RunSnapshot;
    return project(evidence(evaluating, [done('w', { evaluationObserved: false }, { patchRecorded })])).blocker;
  };
  it('names a missing patch on a work task; a recorded patch, an unknown record or a task without work input add no detail', () => {
    expect(waiting(true, false)).toMatchObject({ code: 'worker-exited-unevaluated', taskId: 'w', detail: 'patch-missing' });
    expect(waiting(true, true)).toMatchObject({ code: 'worker-exited-unevaluated', detail: null });
    expect(waiting(true, undefined)).toMatchObject({ detail: null }); expect(waiting(false, false)).toMatchObject({ detail: null });
  });
});
