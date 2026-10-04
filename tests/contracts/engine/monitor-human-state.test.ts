import { describe, expect, it } from 'vitest';
import { createRun, parkTaskAwaitingDecision } from '#domain/index.js';
import { projectHumanState, projectMonitorRun, type MonitorBlockerCode, type MonitorRunEvidence, type MonitorTask, type MonitorWorker } from '#engine/index.js';
import { fullSnapshot } from '../../fixtures/monitor/snapshots.js';
import { fixtureExecution } from '../support/execution-registry.js';

const base = fullSnapshot.installs[0]!.runs[0]!;
const task = (phase: string): MonitorTask => ({ ...base.tasks[0]!, phase });
const hold = (code: MonitorBlockerCode) => ({ code, taskId: 'build', sinceMs: null, detail: null });
const run = (code: MonitorBlockerCode) => ({ ...base, state: 'waiting' as const, blocker: hold(code) });
const worker = (): MonitorWorker => ({ taskId: 'build', identity: null, authority: 'next-ledger', provider: 'codex', workspace: null,
  process: 'running', handle: null, terminal: null, outputRecorded: false, patchRecorded: false, diagnostics: [], files: null });
const freshWorker = (): MonitorWorker => ({ ...worker(), identity: { runId: 'r', scopeId: 's', layoutRevision: 'l', taskId: 'build', attemptId: 'a', generation: 1 }, files: { provider: 'codex', heartbeat: { state: 'available', ageMs: 0, freshness: 'fresh', phase: 'running' },
  log: { state: 'available', byteLength: 0, truncated: false, sampledLines: 0, diagnostics: [], events: [] },
  result: { state: 'missing', exitCode: null, reportedAssessment: null }, pid: null, activity: null, usage: null, eventsTruncated: false } });

describe('global human status preserves evidence and authority', () => {
  it.each([
    ['waiting-dependency', 'queued'], ['waiting-pool-slot', 'queued'], ['waiting-execution-slot', 'queued'], ['none', 'queued'],
    ['worker-running', 'running'], ['worker-exited-unevaluated', 'checking'], ['evaluation-not-ready', 'checking'],
    ['awaiting-decision', 'held'], ['awaiting-approval', 'held'], ['pool-held', 'held'], ['worker-stale-heartbeat', 'held'],
    ['unresolved-effect', 'held'], ['evaluation-unknown', 'held'], ['cancellation-pending', 'held'], ['not-admitted', 'held'], ['unknown', 'held'],
  ] as const)('maps observed blocker %s to %s without changing its code', (code, expected) => {
    const value = run(code), before = JSON.stringify(value);
    expect(projectHumanState({ kind: 'run', value }).state).toBe(expected); expect(JSON.stringify(value)).toBe(before);
  });
  it.each([['awaiting-decision', 'you', 'inspect-task'], ['awaiting-approval', 'you', 'inspect-approvals'], ['pool-held', 'operator', 'inspect-pool'],
    ['unknown', 'system', 'inspect-run']] as const)('keeps all hold fields for %s and unknown times explicit', (reason, waitingOn, nextAction) => {
    expect(projectHumanState({ kind: 'run', value: run(reason) })).toEqual({ state: 'held', waitingOn, reason, detail: null, since: null, deadline: null, nextAction });
  });
  it('keeps epoch zero and durable deadlines, without synthesizing expiry', () => {
    const value = { ...run('awaiting-decision'), blocker: { ...hold('awaiting-decision'), sinceMs: 0, deadlineMs: 900, detail: 'evaluation-unknown' } };
    expect(projectHumanState({ kind: 'run', value })).toMatchObject({ state: 'held', since: 0, deadline: 900, detail: 'evaluation-unknown' });
  });
  it.each(['failed', 'cancelled', 'skipped'])('terminal task %s cannot become an approval wait', phase => {
    expect(projectHumanState({ kind: 'task', value: task(phase), blocker: hold('awaiting-approval') })).toEqual({ state: 'stopped' });
  });
  it('accepted task is done; evaluation and reconciliation stay distinct', () => {
    expect(projectHumanState({ kind: 'task', value: task('accepted') })).toEqual({ state: 'done' });
    expect(projectHumanState({ kind: 'task', value: task('evaluating') })).toEqual({ state: 'checking' });
    expect(projectHumanState({ kind: 'task', value: task('reconciling') })).toMatchObject({ state: 'held', waitingOn: 'system', reason: 'unresolved-effect' });
  });
  it('a terminal failed Run remains stopped despite a stale approval or delivery record', () => {
    expect(projectHumanState({ kind: 'run', value: { ...run('awaiting-approval'), state: 'failed' } })).toEqual({ state: 'stopped' });
  });
  it('parked dependency failure does not invent a human decision', () => {
    const value = { ...base, state: 'parked' as const, blocker: { ...hold('parked'), taskId: null, detail: 'dependency-failed', sinceMs: 300, deadlineMs: 600 }, tasks: [task('failed'), task('skipped')] };
    expect(projectHumanState({ kind: 'run', value })).toEqual({ state: 'held', waitingOn: 'system', reason: 'parked', detail: 'dependency-failed', since: 300, deadline: 600, nextAction: 'inspect-run' });
  });
  it('real domain decision -> monitor producer -> human hold retains decision custody', () => {
    const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'build', kind: 'coding', dependencies: [], acceptanceCriteria: ['ok'] }],
      criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'process-exit', version: 1 }, parameters: {} }] };
    const created = createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
    const identity = { runId: 'r', scopeId: 's', layoutRevision: 'l', taskId: 'build', attemptId: 'a', generation: 1 };
    const evaluating = { ...created, bindings: [{ identity, observedKind: 'exited' as const, observedRevision: 1 }],
      progress: [{ taskId: 'build', phase: 'evaluating' as const, unresolvedEffects: false, eligibility: { kind: 'immediate' as const } }] };
    const parked = parkTaskAwaitingDecision(evaluating, evaluating.revision, 'build', 'evaluation-unknown', 100, 200);
    const evidence: MonitorRunEvidence = { run: { snapshot: parked, poolId: null, admitted: true, createdAtMs: 0, attempts: [] }, approvals: [], pool: null, workers: new Map(), observedAt: 150 };
    const produced = projectMonitorRun(evidence), before = JSON.stringify(produced);
    expect(projectHumanState({ kind: 'run', value: produced })).toMatchObject({ state: 'held', waitingOn: 'you', reason: 'awaiting-decision', since: 100, deadline: 300 });
    expect(JSON.stringify(produced)).toBe(before); expect(produced.tasks[0]!.phase).toBe('awaiting-decision');
  });
  it('worker-running needs actual fresh process custody; missing/denied/stale/paused never become running', () => {
    expect(projectHumanState({ kind: 'worker', value: freshWorker() })).toEqual({ state: 'running' });
    for (const value of [worker(), { ...freshWorker(), authority: 'legacy-activity' as const }, { ...freshWorker(), identity: null }, { ...freshWorker(), process: 'paused' as const }, { ...freshWorker(), process: 'denied' as const },
      { ...freshWorker(), files: { ...freshWorker().files!, heartbeat: { ...freshWorker().files!.heartbeat, freshness: 'stale' as const } } }]) {
      expect(projectHumanState({ kind: 'worker', value })).toMatchObject({ state: 'held', waitingOn: 'system' });
    }
  });
  it('exit does not decide acceptance: standalone finished worker is checking, failed owner task is stopped', () => {
    const value = { ...freshWorker(), process: 'exited' as const, terminal: { exitCode: 1, signal: null, interrupted: false } };
    expect(projectHumanState({ kind: 'worker', value })).toEqual({ state: 'checking' });
    expect(projectHumanState({ kind: 'worker', value, task: task('failed') })).toEqual({ state: 'stopped' });
  });
  it('reserved attempt is queued, ended attempt checking, bare launch grant unknown', () => {
    const value = { ...base.tasks[0]!.lastAttempt!, endedAtMs: null, launch: null };
    expect(projectHumanState({ kind: 'attempt', value })).toEqual({ state: 'queued' });
    expect(projectHumanState({ kind: 'attempt', value: { ...value, launch: 'granted' } })).toMatchObject({ state: 'held', waitingOn: 'system' });
    expect(projectHumanState({ kind: 'attempt', value: { ...value, endedAtMs: 0 } })).toEqual({ state: 'checking' });
  });
  it.each([['integrating', 'checking'], ['delivering', 'checking'], ['adopting', 'checking'], ['rolling-back', 'checking'],
    ['integrated', 'done'], ['delivered', 'done'], ['adopted', 'done'], ['rolled-back', 'stopped']] as const)('delivery %s is %s', (value, state) => {
    expect(projectHumanState({ kind: 'delivery', value })).toEqual({ state });
  });
});
