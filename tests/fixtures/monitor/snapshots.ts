import type { MonitorApproval, MonitorBlockerCode, MonitorInstall, MonitorMap, MonitorPool, MonitorRun, MonitorRunState, MonitorSnapshot, MonitorTask,
  WorkerObservation } from '../../../src/engine/index.js';

/** MONITOR-SURFACE fixtures: deterministic MonitorSnapshot values (no ledger, no clock). Times are offsets from OBSERVED_AT. */
export const OBSERVED_AT = Date.UTC(2026, 9, 2, 9, 30, 0);
const ago = (ms: number) => OBSERVED_AT - ms;
const MIN = 60_000, HOUR = 60 * MIN;
/** Deterministic attempt id per Run task (FNV-1a), so workers and Run tasks cross-reference by identity like real ledger ids. */
export function attemptIdFor(runId: string, taskId: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${runId}/${taskId}`) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return `${hash.toString(16).padStart(8, '0')}-attempt`;
}
const EVENTS = [{ atMs: ago(90_000), kind: 'tool.call', summary: 'edit src/surfaces/core/monitor/internal/view.ts' },
  { atMs: ago(30_000), kind: 'tool.call', summary: 'shell npm test -- monitor-surface' }, { atMs: ago(5_000), kind: 'message', summary: 'Applying the review fixes to the monitor view' }];

function task(taskId: string, phase: string, overrides: Partial<MonitorTask> = {}): MonitorTask {
  return { taskId, kind: 'coding', phase, profile: { id: 'coding-default', version: 3 }, attempts: phase === 'pending' ? 0 : 1, lastAttempt: phase === 'pending' ? null : {
    attemptId: `att-${taskId}-0001-aaaa`, generation: 1, launch: 'launched', exitCode: phase === 'active' ? null : 0, startedAtMs: ago(20 * MIN),
    endedAtMs: phase === 'active' ? null : ago(5 * MIN), workerPhase: phase === 'active' ? 'editing' : 'finished', heartbeatAgeMs: phase === 'active' ? 1_500 : null, provider: 'claude',
    model: 'model-alpha-2', firstFailure: null, ...(phase === 'active' ? { recentEvents: EVENTS } : {}) },
  evaluation: { verdict: phase === 'accepted' ? 'accepted' : phase === 'failed' ? 'rejected' : null, observedAtMs: phase === 'accepted' || phase === 'failed' ? ago(4 * MIN) : null },
  dependencies: [], ...overrides };
}
function run(runId: string, state: MonitorRunState, code: MonitorBlockerCode | null, sinceMs: number | null, overrides: Partial<MonitorRun> = {}): MonitorRun {
  const tasks = overrides.tasks ?? [task('build', state === 'accepted' ? 'accepted' : state === 'failed' ? 'failed' : 'active'), task('verify', state === 'accepted' ? 'accepted' : 'pending', { dependencies: ['build'] })];
  const phaseCounts: Record<string, number> = {};
  for (const item of tasks) phaseCounts[item.phase] = (phaseCounts[item.phase] ?? 0) + 1;
  const own = tasks.map(item => item.lastAttempt ? { ...item, lastAttempt: { ...item.lastAttempt, attemptId: attemptIdFor(runId, item.taskId) } } : item);
  return { scopeId: 'scope-a', runId, revision: 7, state, phaseCounts, cancellationRequested: false, lastActivityMs: ago(2 * MIN), createdAtMs: ago(HOUR),
    blocker: code === null ? null : { code, taskId: 'build', sinceMs, detail: null }, ...overrides, tasks: own };
}
function worker(taskId: string, overrides: Partial<WorkerObservation> = {}, heartbeat: { ageMs: number | null; freshness: 'fresh' | 'stale' | 'unknown' } = { ageMs: 1_200, freshness: 'fresh' },
  phase: string | null = 'editing'): WorkerObservation {
  return { taskId, identity: { scopeId: 'scope-a', runId: 'run-blocked-approval', taskId, attemptId: attemptIdFor('run-blocked-approval', taskId), layoutRevision: 'layout-1', generation: 1 },
    authority: 'next-ledger', provider: 'claude', workspace: `/srv/deckent/workspaces/${taskId}`, process: 'running', handle: `ctr-${taskId}`, terminal: null,
    outputRecorded: false, patchRecorded: false, diagnostics: [],
    files: { provider: 'claude', heartbeat: { state: 'present', ageMs: heartbeat.ageMs, freshness: heartbeat.freshness, phase: 'work' },
      log: { state: 'present', byteLength: 1024, truncated: false, sampledLines: 3, diagnostics: [], events: [] }, result: { state: 'absent', exitCode: null, reportedAssessment: null },
      pid: 4242, activity: phase ? { phase: phase as 'editing', detail: 'apply patch', target: 'src/app.ts', atMs: 1_000, receivedAt: ago(2_000) } : null,
      usage: { tokenUsageRecorded: true, provider: 'claude', model: 'model-alpha-2', outcome: 'running', turns: 12, durationMs: 60_000, apiDurationMs: 40_000,
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
    code === 'unknown' ? null : ago((index + 1) * 7 * MIN + index * 13_000), {
      // Admitted at staggered times (the Runs tab is newest first); the `unknown` Run has no proven admission time.
      createdAtMs: code === 'unknown' ? null : ago(4 * HOUR - index * 10 * MIN),
      ...(code === 'awaiting-approval' ? { blocker: { code, taskId: 'build', sinceMs: ago(3 * HOUR + 12 * MIN), detail: 'appr-0001' } } : {}) })),
  run('run-done', 'accepted', null, null, { lastActivityMs: ago(50 * MIN), createdAtMs: ago(2 * HOUR), finishedAtMs: ago(50 * MIN),
    delivery: { state: 'adopted', commit: '1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5' } }),
  // First failure recorded: the line the owner asks for ("where did it first fail").
  // Its end is the host-observed worker exit (no sealed log end): the duration carries ≈. No delivery was recorded.
  run('run-broken', 'failed', null, null, { lastActivityMs: ago(25 * MIN), createdAtMs: ago(40 * MIN), finishedAtMs: ago(25 * MIN), delivery: null, tasks: [
    task('build', 'failed', { lastAttempt: { ...task('build', 'failed').lastAttempt!, exitCode: 1, startedAtMs: ago(35 * MIN), endedAtMs: ago(25 * MIN), endedAtSource: 'observed',
      firstFailure: '✗ [unit-budget] src/surfaces/core/cli — 2001 lines > unit budget 2000', recentEvents: EVENTS } }),
    task('verify', 'cancelled', { dependencies: ['build'], lastAttempt: null, attempts: 0 })] }),
  // Failed without a recorded first failing line: the surface says so instead of inventing one.
  // No proven end (finishedAtMs absent): the duration is "unknown", never last-activity arithmetic; its output was not readable.
  run('run-broken-quiet', 'failed', null, null, { lastActivityMs: ago(35 * MIN), createdAtMs: ago(45 * MIN), tasks: [
    task('build', 'failed', { lastAttempt: { ...task('build', 'failed').lastAttempt!, diagnostics: ['output-denied'] } }), task('verify', 'pending', { dependencies: ['build'] })] }),
  run('run-stopped', 'cancelled', null, null, { lastActivityMs: ago(26 * HOUR), cancellationRequested: true, createdAtMs: ago(30 * HOUR), finishedAtMs: null,
    delivery: { state: 'rolled-back', commit: null } }),
];
const MAP: MonitorMap = {
  config: [{ layer: 'default', path: null, sections: ['layout', 'inspection', 'approvals'] }, { layer: 'global', path: '/home/owner/.deckent/config.json', sections: ['language'] },
    { layer: 'project', path: '/home/owner/projects/deckent-next/.deckent/config.json', sections: ['layout', 'terminal', 'inspection'] },
    { layer: 'environment', path: null, sections: [] }],
  registry: { profiles: [{ id: 'coding-default', version: 3, adapter: 'docker' }, { id: 'review', version: 1, adapter: 'docker' }, { id: 'legacy-shell', version: 1, adapter: 'host' }],
    kinds: [{ kind: 'coding', profile: 'coding-default@3' }, { kind: 'review', profile: 'review' }] },
  models: [{ channelId: 'subscription', modelId: 'model-alpha-2', active: true }, { channelId: 'subscription', modelId: 'model-alpha-1', active: false },
    { channelId: 'local-vllm', modelId: 'qwen-local-v6', active: true }],
  policy: { grants: 12, byResourceKind: { operation: 5, effect: 4, secret: 3 }, separationOfDuties: 2,
    permissionModes: [{ principal: 'owner@local', mode: 'standart' }, { principal: 'ci@local', mode: 'full-auto' }] },
  memory: { available: false },
};

export const fullSnapshot: MonitorSnapshot = { schemaVersion: 1, observedAt: OBSERVED_AT, control: 'observe-only', sourcesRead: ['current', 'dogfood', 'remote-lab'], installs: [
  { id: 'current', path: '/home/owner/projects/deckent-next', status: 'available', scopeIds: ['scope-a'], service: SERVICE, ledgerVersion: 44,
    runs: currentRuns,
    workers: [worker('build'), worker('lint', {}, { ageMs: 95_000, freshness: 'stale' }, 'running'),
      // A finished, ledger-only worker: no sidecar files; model and first failure come from its Run attempt.
      worker('build', { process: 'exited', terminal: { handle: 'ctr-docs', exitCode: 1, interrupted: false }, files: null, model: null, diagnostics: ['ledger-only'],
        identity: { scopeId: 'scope-a', runId: 'run-broken', taskId: 'build', attemptId: attemptIdFor('run-broken', 'build'), layoutRevision: 'layout-1', generation: 1 } }),
      worker('pack', { custody: 'released', process: 'missing' }, { ageMs: null, freshness: 'unknown' }, null)],
    approvals: [approval('appr-0001', 3 * HOUR + 12 * MIN, 45 * MIN), approval('appr-0002', 4 * MIN, -2 * MIN, { subjectKind: 'effect', summary: 'Delete stale preview environment', requiredAssurance: null })],
    pools: [pool('default', 4, 4), pool('gpu', 1, 0, 'owner@local'), pool('ci', null, 2)], diagnostics: ['scope-unavailable:scope-x:LEDGER_LOCKED'], map: MAP },
  { id: 'dogfood', path: '/home/owner/deckent-dogfood', status: 'available', scopeIds: ['scope-dog'], service: { ...SERVICE, instanceId: 'svc-02', processId: 2001,
    build: { ...SERVICE.build, sourceCommit: '76582f9f00000000000000000000000000000000', builtAt: '2026-10-01T22:15:00.000Z' } }, ledgerVersion: 43,
    runs: [run('run-dog-1', 'progressing', 'worker-running', ago(90_000), { scopeId: 'scope-dog' })], workers: [],
    // The principal may list this approval but not read its summary: the data lane sends '' plus an install diagnostic.
    approvals: [approval('appr-dog', 10 * MIN, null, { scopeId: 'scope-dog', summary: '' })], pools: [pool('default', 2, 1)],
    diagnostics: ['info:workers-finished-capped:5', 'ledger-version-older:43', 'future-code:abc', 'approvals-denied:scope-dog'], map: null },
  { id: 'remote-lab', path: '/mnt/lab/deckent', status: 'unavailable', scopeIds: [], service: null, ledgerVersion: null, runs: [], workers: [], approvals: [], pools: [],
    diagnostics: ['ledger-unavailable:LEDGER_LOCKED', 'service-unavailable:LOCAL_RUNTIME_DENIED'] },
] };

export const emptySnapshot: MonitorSnapshot = { schemaVersion: 1, observedAt: OBSERVED_AT, control: 'observe-only', sourcesRead: ['current'], installs: [
  { id: 'current', path: '/home/owner/projects/fresh', status: 'available', scopeIds: [], service: null, ledgerVersion: 44, runs: [], workers: [], approvals: [], pools: [],
    diagnostics: [] }] };

const LONG = 'run-2026-10-02-extremely-long-identifier-for-a-delivery-run-0123456789abcdef';
export const longIdSnapshot: MonitorSnapshot = { schemaVersion: 1, observedAt: OBSERVED_AT, control: 'observe-only', sourcesRead: ['current'], installs: [
  { id: 'current', path: '/home/owner/a/very/deep/directory/structure/that/never/ends/projects/deckent-next-with-a-long-name', status: 'available',
    scopeIds: ['scope-with-a-really-long-name-for-enterprise-unit-alpha'], service: SERVICE, ledgerVersion: 44,
    runs: [run(LONG, 'blocked', 'worker-stale-heartbeat', ago(2 * 86_400_000 + 3 * HOUR), { scopeId: 'scope-with-a-really-long-name-for-enterprise-unit-alpha',
      blocker: { code: 'worker-stale-heartbeat', taskId: 'task-with-a-long-name-0123456789', sinceMs: ago(2 * 86_400_000 + 3 * HOUR), detail: 'HEARTBEAT_STALE_FOR_LONGER_THAN_ALLOWED' } })],
    workers: [worker('task-with-a-long-name-0123456789', { identity: { scopeId: 'scope-with-a-really-long-name-for-enterprise-unit-alpha', runId: LONG,
      taskId: 'task-with-a-long-name-0123456789', attemptId: 'att-0123456789abcdef', layoutRevision: 'l', generation: 2 } }, { ageMs: 3_600_000, freshness: 'stale' })],
    approvals: [approval('appr-long', MIN, null, { summary: 'A very long approval summary that explains in detail which files will be pushed to which remote and why the owner must look at it first' })],
    pools: [pool('pool-with-a-long-identifier-for-the-gpu-cluster', 16, 3)], diagnostics: [] }] };

export const installFixture = (snapshot: MonitorSnapshot, id: string): MonitorInstall => snapshot.installs.find(install => install.id === id)!;
