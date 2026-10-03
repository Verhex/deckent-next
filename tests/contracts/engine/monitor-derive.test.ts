import { describe, expect, it } from 'vitest';
import { createRun, parkTaskAwaitingDecision, resolveTaskDecision, expireParkedRun, type RunSnapshot, type TaskProgress } from '#domain/index.js';
import { deriveRunBlocker, deriveRunState, MONITOR_FINISHED_WORKERS, MonitorApplication, projectMonitorRun, type MonitorLedgerApproval, type MonitorLedgerAttempt, type MonitorLedgerPool,
  type MonitorRunEvidence, type WorkerObservation } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const NOW = 1_000_000;
type Phase = TaskProgress['phase'];
const graph = (tasks: readonly { id: string; deps?: string[] }[]) => ({ schemaVersion: 2 as const, revision: 1,
  tasks: tasks.map(task => ({ id: task.id, kind: 'coding', dependencies: task.deps ?? [], acceptanceCriteria: ['ok'] })),
  criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'process-exit', version: 1 }, parameters: {} }] });
function snapshot(tasks: readonly { id: string; deps?: string[]; phase?: Phase; unresolved?: boolean; notBefore?: number }[], cancelRequested = false): RunSnapshot {
  const g = graph(tasks); const base = createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, g, 0, fixtureExecution(g));
  const bindings = tasks.filter(task => task.phase && task.phase !== 'pending').map(task => ({ identity: identity(task.id), observedRevision: task.phase === 'evaluating' ? 1 : null, observedKind: task.phase === 'evaluating' ? 'exited' as const : null }));
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
    // Without worker events the phase is unknown (null), never the heartbeat's process state.
    const quiet = worker('a', 'fresh'); const silent = evidence(snapshot([{ id: 'a', phase: 'active' }]), [attempt('a')], { workers: workers({ ...quiet, files: { ...quiet.files!, activity: null } }) });
    expect(blocker(silent)?.detail).toBeNull(); expect(projectMonitorRun(silent).tasks[0]!.lastAttempt?.workerPhase).toBeNull();
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
    // Observed without sidecars (e.g. attempt read-output denied): no heartbeat was read, so it is neither running nor stale.
    const denied = evidence(snapshot([{ id: 'a', phase: 'active' }]), [attempt('a')], { workers: workers({ ...worker('a', 'fresh'), process: 'unknown', files: null, diagnostics: ['output-denied'] }) });
    expect(blocker(denied)).toEqual({ code: 'unknown', taskId: 'a', sinceMs: null, detail: 'output-denied' }); expect(state(denied)).toBe('blocked');
    expect(projectMonitorRun(denied).tasks[0]!.lastAttempt).toMatchObject({ workerPhase: null, heartbeatAgeMs: null });
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
  it('waiting-execution-slot derives reserved work awaiting dispatch, without claiming an observed gate wait', () => {
    const value = evidence(snapshot([{ id: 'a', phase: 'active' }]), [attempt('a', { dispatch: null })]);
    expect(blocker(value)).toEqual({ code: 'waiting-execution-slot', taskId: 'a', sinceMs: 100, detail: 'dispatch-pending' });
    expect(state(value)).toBe('waiting');
    expect(projectMonitorRun(value).tasks[0]!.lastAttempt).toMatchObject({ launch: null, startedAtMs: null });
    expect(blocker({ ...value, run: { ...value.run, admitted: false } }))
      .toEqual({ code: 'not-admitted', taskId: 'a', sinceMs: 50, detail: null });
    expect(blocker({ ...value, run: { ...value.run, admitted: null } }))
      .toEqual({ code: 'none', taskId: 'a', sinceMs: 100, detail: 'dispatch-pending' });
    expect(blocker({ ...value, run: { ...value.run, snapshot: { ...value.run.snapshot, cancelRequested: true } } })?.code).toBe('cancellation-pending');
    expect(blocker(evidence(snapshot([{ id: 'a', phase: 'active' }]), [attempt('a', { dispatch: null, reservedAtMs: null })]))?.sinceMs).toBeNull();
  });
  it('none while work progresses normally: reservation and launch pending (since = reservation)', () => {
    const ready = evidence(snapshot([{ id: 'a' }]));
    expect(blocker(ready)).toEqual({ code: 'none', taskId: 'a', sinceMs: null, detail: 'reservation-pending' }); expect(state(ready)).toBe('progressing');
    expect(blocker(evidence(snapshot([{ id: 'a', phase: 'active' }]), [attempt('a', { dispatch: { launch: 'pending', grantedAtMs: null, terminal: null, outputRecorded: false } })])))
      .toEqual({ code: 'none', taskId: 'a', sinceMs: 100, detail: 'launch-pending' });
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
  const reading = (scopeIds: string[]) => ({ ledgerVersion: 44, scopeIds, diagnostics: ['info:ledger-version-older:43'], approvals: [{ ...approval('a'), scopeId: 's' }, { ...approval('a'), scopeId: 'hidden', approvalId: 'h' }],
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
      async readLedger(target) { if (target.id === 'broken') throw failure('MANAGED_FILE_MISSING'); return target.id === 'empty' ? { ...reading([]), runs: [], approvals: [] } : reading(['hidden', 's']); },
      async observeScope(target, scopeId) {
        if (scopeId === 'hidden') return { access: 'denied', workers: [], workerStatus: 'denied', truncated: false };
        if (target.id === 'flaky') throw failure('POLICY_UNAVAILABLE');
        return { access: 'admitted', workers: [worker('a', 'fresh'), { ...worker('a', 'stale'), identity: { ...identity('a'), scopeId: 'other' } }], workerStatus: 'available', truncated: true,
          approvals: target.id !== 'quiet' };
      } });
    const snapshotValue = await app.inspect([{ id: 'current', path: '/c' }, { id: 'stopped', path: '/s' }, { id: 'broken', path: '/b' }, { id: 'flaky', path: '/f' }, { id: 'empty', path: '/e' }, { id: 'quiet', path: '/q' }]);
    const [current, stopped, broken, flaky, empty, quiet] = snapshotValue.installs;
    expect(snapshotValue).toMatchObject({ schemaVersion: 1, observedAt: NOW, control: 'observe-only' });
    expect(current).toMatchObject({ status: 'available', scopeIds: ['s'], ledgerVersion: 44, service: { state: 'running', instanceId: 'i-1', processId: 42,
      build: { sourceCommit: 'd'.repeat(40), sourceTreeSha256: 'c'.repeat(64), builtAt: null } },
      approvals: [{ scopeId: 's', approvalId: 'ap-a', summary: 'x', requiredAssurance: null, createdAtMs: 300 }], pools: [{ poolId: 'p', capacity: 2, inFlight: 1, held: true, heldBy: 'ops', executing: 1 }] });
    expect(current!.diagnostics).toEqual(['info:ledger-version-older:43', 'scope-denied:hidden', 'info:workers-truncated:s']);
    expect(current!.runs.map(run => run.scopeId)).toEqual(['s']);
    // The worker joins its own scope's attempt only (an equal attempt id in another scope never leaks in).
    expect(current!.runs[0]!.blocker).toMatchObject({ code: 'worker-running', detail: 'editing' });
    expect(stopped!.service).toEqual({ state: 'stopped', instanceId: null, processId: null, build: null }); expect(stopped!.diagnostics).not.toContain('service-unavailable:LOCAL_RUNTIME_UNAVAILABLE');
    expect(broken).toMatchObject({ status: 'unavailable', runs: [], ledgerVersion: null, service: { state: 'unknown' } });
    expect(broken!.diagnostics).toEqual(['service-unavailable:RUNTIME_SERVICE_TRANSPORT', 'ledger-unavailable:MANAGED_FILE_MISSING']);
    expect(flaky).toMatchObject({ status: 'denied', runs: [], pools: [], approvals: [] });
    expect(flaky!.diagnostics).toContain('scope-unavailable:s:POLICY_UNAVAILABLE');
    // Without the approval list decision the approval stays visible (it blocks a Run) but its summary text is withheld.
    expect(quiet!.approvals).toMatchObject([{ approvalId: 'ap-a', summary: '' }]); expect(quiet!.diagnostics).toContain('approvals-denied:s');
    // A ledger with no scope yet (fresh install) still shows its installation-wide pools.
    expect(empty).toMatchObject({ status: 'available', scopeIds: [], runs: [], pools: [{ poolId: 'p', held: true }] });
  });
  it('keeps every open worker and only the most recent finished ones (by sealed log, else launch grant)', async () => {
    const ids = Array.from({ length: 26 }, (_, i) => 't' + String(i).padStart(2, '0'));
    const run = snapshot(ids.map(id => ({ id, phase: 'active' as const })));
    // Recency: t00..t24 finished, ranked by sealedAt (even) or grantedAt (odd); t25 is open (no ledger terminal).
    const attempts = ids.map((id, i) => attempt(id, { sealedAtMs: i % 2 ? null : 10_000 + i, dispatch: { launch: 'granted', grantedAtMs: 5_000 + i, outputRecorded: true,
      terminal: i === 25 ? null : { exitCode: 0, signal: null, interrupted: false } } }));
    const observed = ids.map((id, i) => ({ ...worker(id, 'fresh'), terminal: i === 25 ? null : { handle: 'h', exitCode: 0, interrupted: false } }));
    const stranger = { ...worker('zz', 'stale'), terminal: { handle: 'h', exitCode: 1, interrupted: false } };
    const app = new MonitorApplication({ now: () => NOW, describeService: async () => { throw failure('LOCAL_RUNTIME_UNAVAILABLE'); },
      readLedger: async () => ({ ledgerVersion: 44, scopeIds: ['s'], diagnostics: [], approvals: [], pools: [], runs: [{ snapshot: run, poolId: null, admitted: true, createdAtMs: 1, attempts }] }),
      observeScope: async () => ({ access: 'admitted', workers: [stranger, ...observed], workerStatus: 'available', truncated: false }) });
    const install = (await app.inspect([{ id: 'current', path: '/c' }])).installs[0]!;
    const kept = install.workers.map(value => value.taskId);
    expect(MONITOR_FINISHED_WORKERS).toBe(20); expect(kept).toHaveLength(21); expect(kept).toContain('t25'); expect(kept).not.toContain('zz');
    // Ranks: even i → 10_000 + i, odd i → 5_000 + i; the 20 most recent finished are all 13 even (t00..t24) and the 7 highest odd (t11..t23).
    expect(kept.filter(id => id !== 't25').sort()).toEqual([...ids.slice(0, 25).filter((_, i) => i % 2 === 0), 't11', 't13', 't15', 't17', 't19', 't21', 't23'].sort());
    expect(install.diagnostics).toContain('info:workers-finished-capped:6');
  });
});

describe('monitor v1.1 projection and ordering', () => {
  const pin = { channelId: 'claude-cli-subscription', modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] };
  const view = (usage: string[] | null) => ({ provider: 'claude' as const, requested: pin, init: usage?.[0] ?? null, usage, verdict: usage ? 'verified' as const : 'unverified' as const,
    unexpected: [], evidence: usage ? 'sealed' as const : 'none' as const });
  const failedAttempt = (taskId: string, over: Partial<MonitorLedgerAttempt> = {}) => exited(taskId, { evaluationObserved: true, provider: 'docker', model: null,
    firstFailure: '✗ [unit-budget] src/surfaces/core/cli — 2025 lines > unit budget 2000', recentEvents: [{ atMs: 7, kind: 'tool.call', summary: 'shell Bash npm test' }], ...over });
  it('projects ledger provider/model, first failure, recent events, finish time and delivery', () => {
    const run = snapshot([{ id: 'a', phase: 'accepted' }, { id: 'b', phase: 'failed' }]);
    const projected = projectMonitorRun({ ...evidence(run, [exited('a', { evaluationObserved: true, provider: 'claude', model: view(['claude-sonnet-5-5']), sealedAtMs: 950 }),
      failedAttempt('b', { sealedAtMs: 990 })]), run: { snapshot: run, poolId: 'p', admitted: true, createdAtMs: 50, attempts: [], delivery: { state: 'adopted', commit: 'c'.repeat(40) } } });
    expect(projected).toMatchObject({ state: 'failed', finishedAtMs: null, delivery: { state: 'adopted', commit: 'c'.repeat(40) } });
    const withAttempts = projectMonitorRun(evidence(run, [exited('a', { evaluationObserved: true, provider: 'claude', model: view(['claude-sonnet-5-5']), sealedAtMs: 950 }),
      failedAttempt('b', { sealedAtMs: 990 })]));
    expect(withAttempts.finishedAtMs).toBe(990); expect(withAttempts.delivery).toBeNull();
    const [a, b] = withAttempts.tasks;
    expect(a!.lastAttempt).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', firstFailure: null });
    expect(b!.lastAttempt).toMatchObject({ provider: 'docker', model: null, firstFailure: '✗ [unit-budget] src/surfaces/core/cli — 2025 lines > unit budget 2000',
      recentEvents: [{ atMs: 7, kind: 'tool.call', summary: 'shell Bash npm test' }] });
    // A requested pin without usage still names the model; an attempt without a sealed end leaves the finish unproven.
    expect(projectMonitorRun(evidence(run, [exited('a', { model: view(null) }), failedAttempt('b', { sealedAtMs: null })])).tasks[0]!.lastAttempt!.model).toBe('claude-sonnet-5-5');
    // The model actually used (sealed usage) wins over the requested pin.
    expect(projectMonitorRun(evidence(run, [exited('a', { model: view(['claude-opus-5-5']) }), failedAttempt('b')])).tasks[0]!.lastAttempt!.model).toBe('claude-opus-5-5');
    expect(projectMonitorRun(evidence(run, [exited('a'), failedAttempt('b', { sealedAtMs: null })])).finishedAtMs).toBeNull();
    // A non-terminal Run has no finish time even when its attempts ended.
    expect(projectMonitorRun(evidence(snapshot([{ id: 'a', phase: 'evaluating' }]), [exited('a')])).finishedAtMs).toBeNull();
  });
  it('enriches ledger-only workers with ledger provider/model and orders workers and runs newest first', async () => {
    const older = { ...snapshot([{ id: 'a', phase: 'accepted' }]), identity: { runId: 'old', scopeId: 's', layoutRevision: 'l' } } as RunSnapshot;
    const newer = { ...snapshot([{ id: 'a', phase: 'active' }]), identity: { runId: 'new', scopeId: 's', layoutRevision: 'l' } } as RunSnapshot;
    const oldAttempt = { ...exited('a', { evaluationObserved: true, provider: 'claude', model: view(['claude-sonnet-5-5']), sealedAtMs: 900 }), attemptId: 'a-old' };
    const newAttempt = { ...attempt('a'), attemptId: 'a-new', dispatch: { launch: 'granted' as const, grantedAtMs: 5_000, terminal: null, outputRecorded: false } };
    const bind = (run: RunSnapshot, attemptId: string) => ({ ...run, bindings: run.bindings.length ? run.bindings.map(value => ({ ...value, identity: { ...value.identity, runId: run.identity.runId, attemptId } }))
      : [{ identity: { ...identity('a'), runId: run.identity.runId, attemptId }, observedRevision: 3, observedKind: 'exited' as const }] }) as RunSnapshot;
    const ledgerOnly = { ...worker('a', 'fresh'), identity: { ...identity('a'), runId: 'old', attemptId: 'a-old' }, provider: 'unknown', process: 'unknown' as const, files: null,
      terminal: { handle: 'h', exitCode: 0, interrupted: false }, diagnostics: ['info:ledger-only'] };
    const live = { ...worker('a', 'fresh'), identity: { ...identity('a'), runId: 'new', attemptId: 'a-new' } };
    const app = new MonitorApplication({ now: () => NOW, describeService: async () => { throw failure('LOCAL_RUNTIME_UNAVAILABLE'); },
      readLedger: async () => ({ ledgerVersion: 44, scopeIds: ['s'], diagnostics: [], approvals: [], pools: [], runs: [
        { snapshot: bind(older, 'a-old'), poolId: null, admitted: true, createdAtMs: 1, attempts: [oldAttempt] },
        { snapshot: bind(newer, 'a-new'), poolId: null, admitted: true, createdAtMs: 2, attempts: [newAttempt] }] }),
      observeScope: async () => ({ access: 'admitted', workers: [ledgerOnly, live], workerStatus: 'available', truncated: false }) });
    const install = (await app.inspect([{ id: 'current', path: '/c' }])).installs[0]!;
    expect(install.runs.map(run => run.runId)).toEqual(['new', 'old']);
    expect(install.workers.map(value => value.identity?.attemptId)).toEqual(['a-new', 'a-old']);
    expect(install.workers[1]).toMatchObject({ provider: 'claude', model: { usage: ['claude-sonnet-5-5'] }, diagnostics: ['info:ledger-only'] });
    expect(install.workers[0]!.provider).toBe('claude');
  });
});

describe('monitor attempt end evidence', () => {
  it('ends an attempt at its sealed log, else at the host-observed exit, never at the grant; the Run finishes at the latest proven end', () => {
    const run = snapshot([{ id: 'a', phase: 'accepted' }, { id: 'b', phase: 'accepted' }]);
    const observed = projectMonitorRun(evidence(run, [exited('a', { sealedAtMs: 900, observedEndAtMs: 950 }), exited('b', { sealedAtMs: null, observedEndAtMs: 470_000 })]));
    expect(observed.tasks[0]!.lastAttempt).toMatchObject({ endedAtMs: 900, endedAtSource: 'sealed' });
    expect(observed.tasks[1]!.lastAttempt).toMatchObject({ startedAtMs: 200, endedAtMs: 470_000, endedAtSource: 'observed' });
    expect(observed.finishedAtMs).toBe(470_000); expect(observed.lastActivityMs).toBe(470_000);
    const unproven = projectMonitorRun(evidence(run, [exited('a', { sealedAtMs: 900 }), exited('b', { sealedAtMs: null })]));
    expect(unproven.tasks[1]!.lastAttempt).toMatchObject({ endedAtMs: null, endedAtSource: null }); expect(unproven.finishedAtMs).toBeNull();
    // No evaluation time exists in the ledger: the verdict carries none.
    expect(observed.tasks[1]!.evaluation.observedAtMs).toBeNull();
  });
});

it('projects parked and awaiting decision truth with incomplete and accepted-unverified outcomes', () => {
  const base = snapshot([{ id: 'a', phase: 'evaluating' }]);
  const parked = parkTaskAwaitingDecision(base, 0, 'a', 'evaluation-unknown', 100, 1000);
  const value = evidence(parked, [exited('a', { evaluationObserved: true })]);
  expect(blocker(value)).toEqual({ code: 'parked', taskId: null, sinceMs: 100, detail: 'awaiting-decision', deadlineMs: 1100 });
  expect(state(value)).toBe('parked'); expect(projectMonitorRun(value).tasks[0].evaluation.verdict).toBe('unknown');
  const accepted = resolveTaskDecision(parked, 1, 'a', 'accept', 200, 1000);
  expect(projectMonitorRun(evidence(accepted)).tasks[0].evaluation.verdict).toBe('accepted-unverified');
  const mixed = snapshot([{ id: 'a', phase: 'evaluating' }, { id: 'b', phase: 'accepted' }]);
  const waiting = parkTaskAwaitingDecision(mixed, 0, 'a', 'evaluation-not-ready', 100, 1000);
  expect(projectMonitorRun(evidence(waiting)).tasks[0]!.evaluation.verdict).toBe('pending');
  expect(projectMonitorRun(evidence(waiting)).tasks[0]!.decision).toEqual({ reason: 'evaluation-not-ready', sinceMs: 100, deadlineMs: 1100 });
  const closed = expireParkedRun(waiting, 1, 1100, 1000);
  expect(state(evidence(closed))).toBe('incomplete'); expect(blocker(evidence(closed))).toBeNull();
  const parallel = parkTaskAwaitingDecision(snapshot([{ id: 'a', phase: 'evaluating' }, { id: 'b', phase: 'active' }]), 0, 'a', 'evaluation-unknown', 100, 1000);
  expect(blocker(evidence(parallel))?.code).toBe('awaiting-decision');
});
