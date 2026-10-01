import type { MonitorApproval, MonitorBlockerCode, MonitorInstall, MonitorPool, MonitorRun, MonitorRunState, MonitorSnapshot, MonitorTask,
  WorkerObservation } from '../../../src/engine/index.js';

/** MONITOR-SURFACE fixtures: deterministic MonitorSnapshot values (no ledger, no clock). Times are offsets from OBSERVED_AT. */
export const OBSERVED_AT = Date.UTC(2026, 9, 2, 9, 30, 0);
const ago = (ms: number) => OBSERVED_AT - ms;
const MIN = 60_000, HOUR = 60 * MIN;

function task(taskId: string, phase: string, overrides: Partial<MonitorTask> = {}): MonitorTask {
  return { taskId, kind: 'coding', phase, profile: { id: 'coding-default', version: 3 }, attempts: phase === 'pending' ? 0 : 1, lastAttempt: phase === 'pending' ? null : {
    attemptId: `att-${taskId}-0001-aaaa`, generation: 1, launch: 'launched', exitCode: phase === 'active' ? null : 0, startedAtMs: ago(20 * MIN),
    endedAtMs: phase === 'active' ? null : ago(5 * MIN), workerPhase: phase === 'active' ? 'editing' : 'finished', heartbeatAgeMs: phase === 'active' ? 1_500 : null, provider: 'claude' },
  evaluation: { verdict: phase === 'accepted' ? 'accepted' : phase === 'failed' ? 'rejected' : null, observedAtMs: phase === 'accepted' || phase === 'failed' ? ago(4 * MIN) : null },
  dependencies: [], ...overrides };
}
function run(runId: string, state: MonitorRunState, code: MonitorBlockerCode | null, sinceMs: number | null, overrides: Partial<MonitorRun> = {}): MonitorRun {
  const tasks = overrides.tasks ?? [task('build', state === 'accepted' ? 'accepted' : state === 'failed' ? 'failed' : 'active'), task('verify', state === 'accepted' ? 'accepted' : 'pending', { dependencies: ['build'] })];
  const phaseCounts: Record<string, number> = {};
  for (const item of tasks) phaseCounts[item.phase] = (phaseCounts[item.phase] ?? 0) + 1;
  return { scopeId: 'scope-a', runId, revision: 7, state, phaseCounts, tasks, cancellationRequested: false, lastActivityMs: ago(2 * MIN),
    blocker: code === null ? null : { code, taskId: 'build', sinceMs, detail: null }, ...overrides };
}
function worker(taskId: string, overrides: Partial<WorkerObservation> = {}, heartbeat: { ageMs: number | null; freshness: 'fresh' | 'stale' | 'unknown' } = { ageMs: 1_200, freshness: 'fresh' },
  phase: string | null = 'editing'): WorkerObservation {
  return { taskId, identity: { scopeId: 'scope-a', runId: 'run-blocked-approval', taskId, attemptId: `att-${taskId}-0001-aaaa`, layoutRevision: 'layout-1', generation: 1 },
    authority: 'next-ledger', provider: 'claude', workspace: `/srv/deckent/workspaces/${taskId}`, process: 'running', handle: `ctr-${taskId}`, terminal: null,
    outputRecorded: false, patchRecorded: false, diagnostics: [],
    files: { provider: 'claude', heartbeat: { state: 'present', ageMs: heartbeat.ageMs, freshness: heartbeat.freshness, phase: 'work' },
      log: { state: 'present', byteLength: 1024, truncated: false, sampledLines: 3, diagnostics: [], events: [] }, result: { state: 'absent', exitCode: null, reportedAssessment: null },
      pid: 4242, activity: phase ? { phase: phase as 'editing', detail: 'apply patch', target: 'src/app.ts', atMs: 1_000, receivedAt: ago(2_000) } : null,
      usage: { provider: 'claude', model: 'model-alpha-2', outcome: 'running', turns: 12, durationMs: 60_000, apiDurationMs: 40_000,
        tokens: { input: 12_000, output: 3_400, cacheRead: 9_000, cacheWrite: 1_000, thinking: null }, cacheReadRatio: 0.75, costUsd: 0.4321, costBasis: 'reported',
        toolCalls: { read: 4, edit: 3, write: 0, shell: 2, search: 1, network: 0, agent: 0, other: 0 }, toolErrors: 1, filesTouched: ['src/app.ts'], messages: 8,
        quota: [], unmapped: 0, dropped: 0, events: 30 }, eventsTruncated: false },
    model: { provider: 'claude', requested: { channelId: 'subscription', modelId: 'model-alpha-2', auxiliaryModelIds: [] }, init: 'model-alpha-2', usage: null,
      verdict: 'pending', unexpected: [], evidence: 'live' },
    ...overrides } as WorkerObservation;
}
const approval = (approvalId: string, createdAgoMs: number, expiresInMs: number | null, overrides: Partial<MonitorApproval> = {}): MonitorApproval => ({
  scopeId: 'scope-a', approvalId, subjectKind: 'operation', summary: 'Push branch lane/monitor to origin', requiredAssurance: 'local-os',
  createdAtMs: ago(createdAgoMs), expiresAtMs: expiresInMs === null ? null : OBSERVED_AT + expiresInMs, ...overrides });
const pool = (poolId: string, capacity: number | null, inFlight: number, heldBy: string | null = null): MonitorPool => ({ poolId, capacity, inFlight, held: heldBy !== null, heldBy });
const SERVICE = { state: 'running' as const, instanceId: 'svc-01', processId: 31337,
  build: { sourceCommit: 'b0e66d92c0ffee1234567890abcdef0123456789', sourceTreeSha256: 'f'.repeat(64), builtAt: '2026-10-02T08:00:00.000Z' } };

/** Every blocker code once (open Runs), plus terminal Runs: one accepted, one failed (first failure), one cancelled. */
export const BLOCKER_CODES: readonly MonitorBlockerCode[] = ['none', 'waiting-pool-slot', 'pool-held', 'waiting-dependency', 'awaiting-approval', 'worker-running',
  'worker-stale-heartbeat', 'worker-exited-unevaluated', 'evaluation-not-ready', 'evaluation-unknown', 'unresolved-effect', 'cancellation-pending', 'not-admitted', 'unknown'];
const stateOf = (code: MonitorBlockerCode): MonitorRunState => code === 'none' || code === 'worker-running' ? 'progressing'
  : ['waiting-pool-slot', 'pool-held', 'waiting-dependency', 'awaiting-approval', 'not-admitted'].includes(code) ? 'waiting' : 'blocked';
const currentRuns: MonitorRun[] = [
  ...BLOCKER_CODES.map((code, index) => run(code === 'awaiting-approval' ? 'run-blocked-approval' : `run-${code}`, stateOf(code), code,
    code === 'unknown' ? null : ago((index + 1) * 7 * MIN + index * 13_000), code === 'awaiting-approval' ? { blocker: { code, taskId: 'build', sinceMs: ago(3 * HOUR + 12 * MIN), detail: 'appr-0001' } } : {})),
  run('run-done', 'accepted', null, null, { lastActivityMs: ago(50 * MIN) }),
  run('run-broken', 'failed', null, null, { lastActivityMs: ago(25 * MIN) }),
  run('run-stopped', 'cancelled', null, null, { lastActivityMs: ago(26 * HOUR), cancellationRequested: true }),
];

export const fullSnapshot: MonitorSnapshot = { schemaVersion: 1, observedAt: OBSERVED_AT, control: 'observe-only', installs: [
  { id: 'current', path: '/home/owner/projects/deckent-next', status: 'available', scopeIds: ['scope-a'], service: SERVICE, ledgerVersion: 44,
    runs: currentRuns,
    workers: [worker('build'), worker('lint', {}, { ageMs: 95_000, freshness: 'stale' }, 'running'),
      worker('docs', { process: 'exited', terminal: { handle: 'ctr-docs', exitCode: 3, interrupted: false } }, { ageMs: null, freshness: 'unknown' }, null),
      worker('pack', { custody: 'released', process: 'missing' }, { ageMs: null, freshness: 'unknown' }, null)],
    approvals: [approval('appr-0001', 3 * HOUR + 12 * MIN, 45 * MIN), approval('appr-0002', 4 * MIN, -2 * MIN, { subjectKind: 'effect', summary: 'Delete stale preview environment', requiredAssurance: null })],
    pools: [pool('default', 4, 4), pool('gpu', 1, 0, 'owner@local'), pool('ci', null, 2)], diagnostics: [] },
  { id: 'dogfood', path: '/home/owner/deckent-dogfood', status: 'available', scopeIds: ['scope-dog'], service: { ...SERVICE, instanceId: 'svc-02', processId: 2001,
    build: { ...SERVICE.build, sourceCommit: '76582f9f00000000000000000000000000000000', builtAt: '2026-10-01T22:15:00.000Z' } }, ledgerVersion: 43,
    runs: [run('run-dog-1', 'progressing', 'worker-running', ago(90_000), { scopeId: 'scope-dog' })], workers: [], approvals: [], pools: [pool('default', 2, 1)],
    diagnostics: ['WORKER_SIDECAR_UNREADABLE'] },
  { id: 'remote-lab', path: '/mnt/lab/deckent', status: 'unavailable', scopeIds: [], service: null, ledgerVersion: null, runs: [], workers: [], approvals: [], pools: [],
    diagnostics: ['MONITOR_SOURCE_UNREADABLE', 'LEDGER_LOCKED'] },
] };

export const emptySnapshot: MonitorSnapshot = { schemaVersion: 1, observedAt: OBSERVED_AT, control: 'observe-only', installs: [
  { id: 'current', path: '/home/owner/projects/fresh', status: 'available', scopeIds: [], service: null, ledgerVersion: 44, runs: [], workers: [], approvals: [], pools: [],
    diagnostics: [] }] };

const LONG = 'run-2026-10-02-extremely-long-identifier-for-a-delivery-run-0123456789abcdef';
export const longIdSnapshot: MonitorSnapshot = { schemaVersion: 1, observedAt: OBSERVED_AT, control: 'observe-only', installs: [
  { id: 'current', path: '/home/owner/a/very/deep/directory/structure/that/never/ends/projects/deckent-next-with-a-long-name', status: 'available',
    scopeIds: ['scope-with-a-really-long-name-for-enterprise-unit-alpha'], service: SERVICE, ledgerVersion: 44,
    runs: [run(LONG, 'blocked', 'worker-stale-heartbeat', ago(2 * 86_400_000 + 3 * HOUR), { scopeId: 'scope-with-a-really-long-name-for-enterprise-unit-alpha',
      blocker: { code: 'worker-stale-heartbeat', taskId: 'task-with-a-long-name-0123456789', sinceMs: ago(2 * 86_400_000 + 3 * HOUR), detail: 'HEARTBEAT_STALE_FOR_LONGER_THAN_ALLOWED' } })],
    workers: [worker('task-with-a-long-name-0123456789', { identity: { scopeId: 'scope-with-a-really-long-name-for-enterprise-unit-alpha', runId: LONG,
      taskId: 'task-with-a-long-name-0123456789', attemptId: 'att-0123456789abcdef', layoutRevision: 'l', generation: 2 } }, { ageMs: 3_600_000, freshness: 'stale' })],
    approvals: [approval('appr-long', MIN, null, { summary: 'A very long approval summary that explains in detail which files will be pushed to which remote and why the owner must look at it first' })],
    pools: [pool('pool-with-a-long-identifier-for-the-gpu-cluster', 16, 3)], diagnostics: [] }] };

export const installFixture = (snapshot: MonitorSnapshot, id: string): MonitorInstall => snapshot.installs.find(install => install.id === id)!;
