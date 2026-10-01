import { describe, expect, it } from 'vitest';
import { createRun, type RunSnapshot, type TaskProgress } from '#domain/index.js';
import { deriveRunBlocker, deriveRunState, MonitorApplication, projectMonitorRun, type MonitorLedgerApproval, type MonitorLedgerAttempt, type MonitorLedgerPool,
  type MonitorRunEvidence, type WorkerObservation } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const NOW = 1_000_000;
type Phase = TaskProgress['phase'];
const graph = (tasks: readonly { id: string; deps?: string[] }[]) => ({ schemaVersion: 2 as const, revision: 1,
  tasks: tasks.map(task => ({ id: task.id, kind: 'coding', dependencies: task.deps ?? [], acceptanceCriteria: ['ok'] })),
  criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'process-exit', version: 1 }, parameters: {} }] });
function snapshot(tasks: readonly { id: string; deps?: string[]; phase?: Phase; unresolved?: boolean; notBefore?: number }[], cancelRequested = false): RunSnapshot {
  const g = graph(tasks); const base = createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, g, 0, fixtureExecution(g));
  const bindings = tasks.filter(task => task.phase && task.phase !== 'pending').map(task => ({ identity: identity(task.id), observedRevision: null, observedKind: null }));
  return { ...base, cancelRequested, bindings, progress: tasks.map(task => ({ taskId: task.id, phase: task.phase ?? 'pending', unresolvedEffects: task.unresolved ?? false,
    eligibility: task.notBefore ? { kind: 'not-before' as const, at: task.notBefore } : { kind: 'immediate' as const } })) } as RunSnapshot;
}
const identity = (taskId: string) => ({ runId: 'r', taskId, attemptId: 'a-' + taskId, scopeId: 's', layoutRevision: 'l', generation: 1 });
function attempt(taskId: string, over: Partial<MonitorLedgerAttempt> = {}): MonitorLedgerAttempt {
  return { attemptId: 'a-' + taskId, generation: 1, observedKind: null, observedRevision: null, evaluationObserved: false, reservedAtMs: 100, sealedAtMs: null,
    dispatch: { launch: 'granted', grantedAtMs: 200, terminal: null, outputRecorded: false }, ...over };
}
const exited = (taskId: string, over: Partial<MonitorLedgerAttempt> = {}) => attempt(taskId, { observedKind: 'exited', observedRevision: 3, sealedAtMs: 900,
  dispatch: { launch: 'granted', grantedAtMs: 200, terminal: { exitCode: 0, signal: null, interrupted: false }, outputRecorded: true }, ...over });
function worker(taskId: string, freshness: 'fresh' | 'stale' | 'unknown', ageMs: number | null = 50, process: WorkerObservation['process'] = 'running'): WorkerObservation {
  return { taskId, identity: identity(taskId), authority: 'next-ledger', provider: 'claude', workspace: '/w', process, handle: 'h', terminal: null, outputRecorded: false,
    patchRecorded: false, diagnostics: [], files: { provider: 'claude', heartbeat: { state: 'available', ageMs, freshness, phase: 'running' },
      log: { state: 'available', byteLength: 0, truncated: false, sampledLines: 0, diagnostics: [], events: [] },
      result: { state: 'missing', exitCode: null, reportedAssessment: null }, pid: null,
      activity: { phase: 'editing', detail: null, target: 'src/a.ts', atMs: 5, receivedAt: 800 }, usage: null, eventsTruncated: false } };
}
const pool = (over: Partial<MonitorLedgerPool> = {}): MonitorLedgerPool => ({ poolId: 'p', executionSlots: 2, inFlightSlots: 2, execution: 0, inFlight: 0, hold: null, ...over });
const approval = (taskId: string): MonitorLedgerApproval => ({ scopeId: 's', approvalId: 'ap-' + taskId, subjectKind: 'task', runId: 'r', taskId, summary: 'x', createdAtMs: 300, expiresAtMs: NOW + 1 });
function evidence(run: RunSnapshot, attempts: MonitorLedgerAttempt[] = [], over: Partial<MonitorRunEvidence> = {}): MonitorRunEvidence {
  return { run: { snapshot: run, poolId: 'p', admitted: true, createdAtMs: 50, attempts }, approvals: [], pool: pool(), workers: new Map(), observedAt: NOW, ...over };
}
const workers = (...list: WorkerObservation[]) => new Map(list.map(value => [value.identity!.attemptId, value]));
const blocker = (value: MonitorRunEvidence) => deriveRunBlocker(value);
const state = (value: MonitorRunEvidence) => deriveRunState(value, deriveRunBlocker(value));

describe('monitor run blocker and state derivation (pure)', () => {
  it('terminal Runs carry no blocker: accepted, failed wins over cancelled, cancelled', () => {
    for (const [phases, expected] of [[['accepted', 'accepted'], 'accepted'], [['accepted', 'failed'], 'failed'], [['cancelled', 'failed'], 'failed'], [['accepted', 'cancelled'], 'cancelled']] as const) {
      const value = evidence(snapshot([{ id: 'a', phase: phases[0] }, { id: 'b', phase: phases[1] }]));
      expect(blocker(value)).toBeNull(); expect(state(value)).toBe(expected);
    }
  });
  it('cancellation-pending outranks every task blocker and waits', () => {
    const value = evidence(snapshot([{ id: 'a', phase: 'active', unresolved: true }], true), [attempt('a')]);
    expect(blocker(value)).toEqual({ code: 'cancellation-pending', taskId: null, sinceMs: null, detail: null }); expect(state(value)).toBe('waiting');
  });
  it('unresolved-effect for reconciling or unresolved tasks, blocked, detail = observed kind', () => {
    const value = evidence(snapshot([{ id: 'a', phase: 'reconciling', unresolved: true }]), [attempt('a', { observedKind: 'unknown', observedRevision: 2 })]);
    expect(blocker(value)).toEqual({ code: 'unresolved-effect', taskId: 'a', sinceMs: null, detail: 'unknown' }); expect(state(value)).toBe('blocked');
    const flagged = evidence(snapshot([{ id: 'a', phase: 'active', unresolved: true }]), [attempt('a')], { workers: workers(worker('a', 'fresh')) });
    expect(blocker(flagged)?.code).toBe('unresolved-effect');
  });
  it('evaluation-unknown when an evaluation was committed but the task stays evaluating (HOLD)', () => {
    const value = evidence(snapshot([{ id: 'a', phase: 'evaluating' }]), [exited('a', { evaluationObserved: true })]);
    expect(blocker(value)).toEqual({ code: 'evaluation-unknown', taskId: 'a', sinceMs: null, detail: null }); expect(state(value)).toBe('blocked');
  });
  it('worker-exited-unevaluated when output and terminal are recorded and no evaluation exists; since = sealed log time', () => {
    const value = evidence(snapshot([{ id: 'a', phase: 'evaluating' }]), [exited('a')]);
    expect(blocker(value)).toEqual({ code: 'worker-exited-unevaluated', taskId: 'a', sinceMs: 900, detail: null }); expect(state(value)).toBe('waiting');
    const projection = evidence(snapshot([{ id: 'a', phase: 'active' }]), [exited('a', { observedKind: null, observedRevision: null })]);
    expect(blocker(projection)).toEqual({ code: 'worker-exited-unevaluated', taskId: 'a', sinceMs: 900, detail: 'projection-pending' });
  });
  it('evaluation-not-ready names the missing evaluation input', () => {
    const noOutput = evidence(snapshot([{ id: 'a', phase: 'evaluating' }]), [exited('a', { sealedAtMs: null,
      dispatch: { launch: 'granted', grantedAtMs: 200, terminal: { exitCode: 0, signal: null, interrupted: false }, outputRecorded: false } })]);
    expect(blocker(noOutput)).toEqual({ code: 'evaluation-not-ready', taskId: 'a', sinceMs: null, detail: 'output-missing' }); expect(state(noOutput)).toBe('blocked');
    const interrupted = evidence(snapshot([{ id: 'a', phase: 'evaluating' }]), [exited('a', {
      dispatch: { launch: 'granted', grantedAtMs: 200, terminal: { exitCode: null, signal: 'SIGKILL', interrupted: true }, outputRecorded: true } })]);
    expect(blocker(interrupted)?.detail).toBe('interrupted');
    expect(blocker(evidence(snapshot([{ id: 'a', phase: 'evaluating' }]), [exited('a', { dispatch: null })]))?.detail).toBe('terminal-missing');
  });
  it('worker-running only with a fresh heartbeat; since = launch grant; detail = live worker phase', () => {
    const value = evidence(snapshot([{ id: 'a', phase: 'active' }]), [attempt('a')], { workers: workers(worker('a', 'fresh')) });
    expect(blocker(value)).toEqual({ code: 'worker-running', taskId: 'a', sinceMs: 200, detail: 'editing' }); expect(state(value)).toBe('progressing');
  });
  it('worker-stale-heartbeat for stale/unknown heartbeats or a gone process; since = last heartbeat (observedAt - age)', () => {
    const value = evidence(snapshot([{ id: 'a', phase: 'active' }]), [attempt('a')], { workers: workers(worker('a', 'stale', 30_000)) });
    expect(blocker(value)).toEqual({ code: 'worker-stale-heartbeat', taskId: 'a', sinceMs: NOW - 30_000, detail: 'stale' }); expect(state(value)).toBe('blocked');
    expect(blocker(evidence(snapshot([{ id: 'a', phase: 'active' }]), [attempt('a')], { workers: workers(worker('a', 'unknown', null)) })))
      .toEqual({ code: 'worker-stale-heartbeat', taskId: 'a', sinceMs: null, detail: 'unknown' });
    expect(blocker(evidence(snapshot([{ id: 'a', phase: 'active' }]), [attempt('a')], { workers: workers(worker('a', 'fresh', 10, 'missing')) }))?.code).toBe('worker-stale-heartbeat');
  });
  it('unknown when a launched worker has no observation at all (never guessed as running)', () => {
    const value = evidence(snapshot([{ id: 'a', phase: 'active' }]), [attempt('a')]);
    expect(blocker(value)).toEqual({ code: 'unknown', taskId: 'a', sinceMs: null, detail: 'worker-unobserved' }); expect(state(value)).toBe('blocked');
  });
  it('awaiting-approval for a ready task with a pending task approval of this Run; since = approval creation', () => {
    const value = evidence(snapshot([{ id: 'a' }]), [], { approvals: [approval('a'), { ...approval('a'), approvalId: 'other-run', runId: 'x' }] });
    expect(blocker(value)).toEqual({ code: 'awaiting-approval', taskId: 'a', sinceMs: 300, detail: 'ap-a' }); expect(state(value)).toBe('waiting');
    // An approval of another Run, another scope or a non-task subject never blocks this Run.
    for (const other of [{ runId: 'x' }, { scopeId: 'other' }, { subjectKind: 'operation', runId: null, taskId: null }]) {
      expect(blocker(evidence(snapshot([{ id: 'a' }]), [], { approvals: [{ ...approval('a'), ...other }] }))?.code).toBe('none');
    }
  });
  it('not-admitted when the Run has no automatic progression intent; since = creation', () => {
    const value = evidence(snapshot([{ id: 'a' }]), [], { run: { snapshot: snapshot([{ id: 'a' }]), poolId: 'p', admitted: false, createdAtMs: 50, attempts: [] } });
    expect(blocker(value)).toEqual({ code: 'not-admitted', taskId: 'a', sinceMs: 50, detail: null }); expect(state(value)).toBe('blocked');
  });
  it('pool-held (since = hold time, detail = pool) outranks waiting-pool-slot', () => {
    const held = evidence(snapshot([{ id: 'a' }]), [], { pool: pool({ execution: 2, hold: { state: 'held', changedAtMs: 400, changedBy: 'ops' } }) });
    expect(blocker(held)).toEqual({ code: 'pool-held', taskId: 'a', sinceMs: 400, detail: 'p' }); expect(state(held)).toBe('waiting');
    const reopened = evidence(snapshot([{ id: 'a' }]), [], { pool: pool({ hold: { state: 'open', changedAtMs: 400, changedBy: 'ops' } }) });
    expect(blocker(reopened)?.code).toBe('none');
  });
  it('waiting-pool-slot when either pool limit is exhausted', () => {
    for (const full of [{ execution: 2 }, { inFlight: 2 }]) {
      const value = evidence(snapshot([{ id: 'a' }]), [], { pool: pool(full) });
      expect(blocker(value)).toEqual({ code: 'waiting-pool-slot', taskId: 'a', sinceMs: null, detail: 'p' }); expect(state(value)).toBe('waiting');
    }
  });
  it('waiting-dependency names the first unaccepted dependency; a failed dependency makes the Run blocked', () => {
    const waiting = evidence(snapshot([{ id: 'a', phase: 'evaluating' }, { id: 'b', deps: ['a'] }]), [exited('a', { evaluationObserved: true })]);
    expect(blocker(waiting)?.code).toBe('evaluation-unknown');
    const pendingOnly = evidence(snapshot([{ id: 'a', phase: 'active' }, { id: 'b', deps: ['a'] }]), [attempt('a')], { workers: workers(worker('a', 'fresh')) });
    expect(blocker(pendingOnly)?.code).toBe('worker-running');
    const failed = evidence(snapshot([{ id: 'a', phase: 'failed' }, { id: 'b', deps: ['a'] }]));
    expect(blocker(failed)).toEqual({ code: 'waiting-dependency', taskId: 'b', sinceMs: null, detail: 'a' }); expect(state(failed)).toBe('blocked');
  });
  it('none while work progresses normally: reservation, dispatch and launch pending (since = reservation)', () => {
    const ready = evidence(snapshot([{ id: 'a' }]));
    expect(blocker(ready)).toEqual({ code: 'none', taskId: 'a', sinceMs: null, detail: 'reservation-pending' }); expect(state(ready)).toBe('progressing');
    expect(blocker(evidence(snapshot([{ id: 'a', phase: 'active' }]), [attempt('a', { dispatch: null })])))
      .toEqual({ code: 'none', taskId: 'a', sinceMs: 100, detail: 'dispatch-pending' });
    expect(blocker(evidence(snapshot([{ id: 'a', phase: 'active' }]), [attempt('a', { dispatch: { launch: 'pending', grantedAtMs: null, terminal: null, outputRecorded: false } })]))?.detail)
      .toBe('launch-pending');
    expect(blocker(evidence(snapshot([{ id: 'a', notBefore: NOW + 10 }])))).toEqual({ code: 'none', taskId: 'a', sinceMs: null, detail: 'not-before' });
  });
  it('precedence: human/repair blockers outrank progress; ties keep graph order', () => {
    const run = snapshot([{ id: 'a', phase: 'active' }, { id: 'b' }, { id: 'c', phase: 'active' }]);
    const value = evidence(run, [attempt('a'), attempt('c')], { approvals: [approval('b')], workers: workers(worker('a', 'fresh'), worker('c', 'stale', 10)) });
    expect(blocker(value)?.code).toBe('worker-stale-heartbeat'); expect(blocker(value)?.taskId).toBe('c');
    const noStale = evidence(run, [attempt('a'), attempt('c')], { approvals: [approval('b')], workers: workers(worker('a', 'fresh'), worker('c', 'fresh')) });
    expect(blocker(noStale)).toMatchObject({ code: 'awaiting-approval', taskId: 'b' });
  });
  it('projects tasks, attempts, phase counts, evaluation verdicts and the latest proven activity', () => {
    const run = snapshot([{ id: 'a', phase: 'accepted' }, { id: 'b', phase: 'failed' }, { id: 'c', phase: 'evaluating' }, { id: 'd', phase: 'active' }, { id: 'e', deps: ['a'] }]);
    const projected = projectMonitorRun(evidence(run, [exited('a', { evaluationObserved: true }), exited('b', { evaluationObserved: true, sealedAtMs: 950 }), exited('c'), attempt('d')],
      { workers: workers(worker('d', 'fresh')) }));
    expect(projected).toMatchObject({ scopeId: 's', runId: 'r', revision: 0, state: 'waiting', cancellationRequested: false, createdAtMs: 50,
      phaseCounts: { accepted: 1, failed: 1, evaluating: 1, active: 1, pending: 1 }, blocker: { code: 'worker-exited-unevaluated', taskId: 'c', sinceMs: 900 } });
    const byId = Object.fromEntries(projected.tasks.map(task => [task.taskId, task]));
    expect(byId.a!.evaluation.verdict).toBe('accepted'); expect(byId.b!.evaluation.verdict).toBe('rejected');
    expect(byId.c!.evaluation.verdict).toBe('pending'); expect(byId.e!.evaluation.verdict).toBeNull(); expect(byId.e!.dependencies).toEqual(['a']);
    expect(byId.d!).toMatchObject({ kind: 'coding', phase: 'active', attempts: 1, profile: { id: 'fixture-profile', version: 1 }, lastAttempt: { attemptId: 'a-d', generation: 1,
      launch: 'granted', exitCode: null, startedAtMs: 200, endedAtMs: null, workerPhase: 'editing', heartbeatAgeMs: 50, provider: 'claude' } });
    expect(byId.b!.lastAttempt).toMatchObject({ exitCode: 0, endedAtMs: 950 }); expect(byId.e!.lastAttempt).toBeNull();
    // The freshest proof is the heartbeat (observedAt - age); sealed logs, grants, reservations and creation are older.
    expect(projected.lastActivityMs).toBe(NOW - 50);
    expect(projectMonitorRun(evidence(run, [exited('a'), exited('b', { sealedAtMs: 950 })])).lastActivityMs).toBe(950);
  });
});

describe('monitor application over ports', () => {
  const reading = (scopeIds: string[]) => ({ ledgerVersion: 44, scopeIds, diagnostics: ['ledger-version-older:43'], approvals: [{ ...approval('a'), scopeId: 's' }, { ...approval('a'), scopeId: 'hidden', approvalId: 'h' }],
    pools: [pool({ execution: 1, inFlight: 1, hold: { state: 'held' as const, changedAtMs: 400, changedBy: 'ops' } })],
    runs: [{ snapshot: snapshot([{ id: 'a', phase: 'active' }]), poolId: 'p', admitted: true, createdAtMs: 50, attempts: [attempt('a')] },
      { snapshot: { ...snapshot([{ id: 'a' }]), identity: { runId: 'r', scopeId: 'hidden', layoutRevision: 'l' } } as RunSnapshot, poolId: 'p', admitted: true, createdAtMs: 60, attempts: [] }] });
  const failure = (code: string) => Object.assign(new Error(code), { code });
  it('maps service, scope access, workers and diagnostics without throwing', async () => {
    const app = new MonitorApplication({ now: () => NOW,
      async describeService(target) {
        if (target.id === 'current') return { schemaVersion: 1, instanceId: 'i-1', shutdownAvailable: false, identity: null, processId: 42, build: { sourceTreeSha256: 'c'.repeat(64), sourceCommit: 'd'.repeat(40) } };
        throw failure(target.id === 'stopped' ? 'LOCAL_RUNTIME_UNAVAILABLE' : 'RUNTIME_SERVICE_TRANSPORT');
      },
      async readLedger(target) { if (target.id === 'broken') throw failure('MANAGED_FILE_MISSING'); return reading(['hidden', 's']); },
      async observeScope(target, scopeId) {
        if (scopeId === 'hidden') return { access: 'denied', workers: [], workerStatus: 'denied', truncated: false };
        if (target.id === 'flaky') throw failure('POLICY_UNAVAILABLE');
        return { access: 'admitted', workers: [worker('a', 'fresh'), { ...worker('a', 'stale'), identity: { ...identity('a'), scopeId: 'other' } }], workerStatus: 'available', truncated: true };
      } });
    const snapshotValue = await app.inspect([{ id: 'current', path: '/c' }, { id: 'stopped', path: '/s' }, { id: 'broken', path: '/b' }, { id: 'flaky', path: '/f' }]);
    const [current, stopped, broken, flaky] = snapshotValue.installs;
    expect(snapshotValue).toMatchObject({ schemaVersion: 1, observedAt: NOW, control: 'observe-only' });
    expect(current).toMatchObject({ status: 'available', scopeIds: ['s'], ledgerVersion: 44, service: { state: 'running', instanceId: 'i-1', processId: 42,
      build: { sourceCommit: 'd'.repeat(40), sourceTreeSha256: 'c'.repeat(64), builtAt: null } },
      approvals: [{ scopeId: 's', approvalId: 'ap-a', requiredAssurance: null, createdAtMs: 300 }], pools: [{ poolId: 'p', capacity: 2, inFlight: 1, held: true, heldBy: 'ops', executing: 1 }] });
    expect(current!.diagnostics).toEqual(['ledger-version-older:43', 'scope-denied:hidden', 'workers-truncated:s']);
    expect(current!.runs.map(run => run.scopeId)).toEqual(['s']);
    // The worker joins its own scope's attempt only (an equal attempt id in another scope never leaks in).
    expect(current!.runs[0]!.blocker).toMatchObject({ code: 'worker-running', detail: 'editing' });
    expect(stopped!.service).toEqual({ state: 'stopped', instanceId: null, processId: null, build: null }); expect(stopped!.diagnostics).not.toContain('service-unavailable:LOCAL_RUNTIME_UNAVAILABLE');
    expect(broken).toMatchObject({ status: 'unavailable', runs: [], ledgerVersion: null, service: { state: 'unknown' } });
    expect(broken!.diagnostics).toEqual(['service-unavailable:RUNTIME_SERVICE_TRANSPORT', 'ledger-unavailable:MANAGED_FILE_MISSING']);
    expect(flaky).toMatchObject({ status: 'denied', runs: [], pools: [], approvals: [] });
    expect(flaky!.diagnostics).toContain('scope-unavailable:s:POLICY_UNAVAILABLE');
  });
});
