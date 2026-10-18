import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAttemptObservation, createAttempt, createRun, executionRegistrySchema, observeRunAttempt, recoverStalledTask, reserveRunTasks, resolveTaskDecision, runSnapshotSchema,
  type AttemptIdentity, type RunSnapshot } from '#domain/index.js';
import { proposeTaskEvaluationCommit } from '#engine/core/task-evaluation/index.js';
import { DispatchApplication, RunReservationApplication, TaskEvaluationApplication, deriveRunBlocker, projectRunView, reservationRefusalOutcome, inactivityVerdict, inactivityWatch, resolveExecutionRegistry, type ExecutionSupervisor } from '#engine/index.js';
import { FileArtifactStore, classifyDockerTaskEffects, inventoryReadsPerCall, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { fixtureDockerRegistry, fixtureExecution } from '../support/execution-registry.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfile, custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

/** R3 (owner D4a/D5a): silence watchdog verdict, frozen policy, the one retry owner, its effect gate and the dispatch interrupt cause. */
const policy = { warnAfterMs: 180_000, stopAfterMs: 600_000, maxRetries: 1 };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify fixture task', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const workInput = { schemaVersion: 1, task: 'Post the invoice', scope: { paths: ['erp/invoices'] }, acceptance: 'Invoice posted', model: { channelId: 'channel', modelId: 'model', auxiliaryModelIds: [] } };
const id = (generation = 1, attemptId = 'a') => Object.freeze({ runId: 'r', scopeId: 's', taskId: 't', attemptId, layoutRevision: 'l', generation });
const unknown = [{ criterionId: 'verified', verdict: 'unknown' as const, evidenceIds: ['dispatch-output'] }];
const timing = { now: 100, timeoutMs: 1000 };

describe('inactivity verdict (pure, host-observed inputs only)', () => {
  it.each([
    ['no event since dispatch, before warn', { lastEventReceivedAt: null, lastModelTrafficAt: null, now: 179_999 }, 'active'],
    ['no event since dispatch, warn bound', { lastEventReceivedAt: null, lastModelTrafficAt: null, now: 180_000 }, 'warn'],
    ['no event since dispatch, stop bound', { lastEventReceivedAt: null, lastModelTrafficAt: null, now: 600_000 }, 'stop'],
    ['events, then silence past stop', { lastEventReceivedAt: 50_000, lastModelTrafficAt: null, now: 650_000 }, 'stop'],
    ['a recent event keeps it active', { lastEventReceivedAt: 640_000, lastModelTrafficAt: null, now: 650_000 }, 'active'],
    ['model traffic without events counts as active', { lastEventReceivedAt: null, lastModelTrafficAt: 640_000, now: 650_000 }, 'active'],
  ] as const)('%s', (_name, input, verdict) => {
    expect(inactivityVerdict({ dispatchedAt: 0, policy, ...input })).toBe(verdict);
  });
  it('samples the gateway counters: any received batch (even refused) or tunnelled byte is activity; unchanged counters stop', () => {
    const watch = inactivityWatch(policy, 0), counters = { events: 0, eventsDropped: 0, eventsUnreported: 0, bytes: 0 };
    expect(watch(599_999, counters)).toBe('warn'); expect(watch(600_000, counters)).toBe('stop');
    const fresh = inactivityWatch(policy, 0);
    expect(fresh(500_000, { ...counters, bytes: 10 })).toBe('active'); expect(fresh(1_100_000, { ...counters, bytes: 10 })).toBe('stop');
    expect(fresh(1_100_001, { ...counters, bytes: 10, eventsUnreported: 1 })).toBe('active');
  });
});

describe('admission freezes the silence policy per watchable task', () => {
  const quiet = { schemaVersion: 2, revision: 'quiet-v1', classes: [{ id: 'quiet', parentClassId: 'small', defaultEffort: 'high', acceptanceProfile: { schemaVersion: 1, version: 1,
    criterionTypes: ['completion'], evidenceTypes: ['verification-result'], rubric: [{ criterionType: 'completion', evidenceTypes: ['verification-result'], weight: 1 }],
    ceilingRules: [], decisionThresholds: { rejectBelow: 0.2, acceptAt: 1 } }, inactivity: { warnAfterMs: 60_000, stopAfterMs: 120_000 } }], bindings: [{ kind: 'fixture', classId: 'quiet' }] };
  const admit = (deadline: number | null, workClasses?: unknown) => resolveExecutionRegistry(graph, { schemaVersion: 1, revision: 'fixture', ...(workClasses ? { workClasses } : {}),
    profiles: [{ id: 'p', version: 1, adapter: { id: 'test-supervisor', version: 1 }, parameters: { fixture: true } }], kinds: [{ kind: 'fixture', profile: { id: 'p', version: 1 } }],
    evaluators: [{ id: 'test-evaluator', version: 1, implementation: { id: 'test-evaluator', version: 1 } }] },
  { profile() { return undefined; }, criterion() { return undefined; }, silence: { policy, deadline: () => deadline } }).tasks[0]!.stall;
  it('freezes the installation default only for a profile with a liveness channel whose deadline comes later', () => {
    expect(admit(null)).toBeUndefined();
    expect(admit(1_200_000)).toEqual(policy);
    // The default never refuses a short-deadline task: that task keeps today's deadline bound alone.
    expect(admit(600_000)).toBeUndefined();
  });
  it('a work class policy overrides warn/stop and is refused typed when it cannot stop before the deadline', () => {
    expect(admit(1_200_000, quiet)).toEqual({ warnAfterMs: 60_000, stopAfterMs: 120_000, maxRetries: 1 });
    expect(() => admit(120_000, quiet)).toThrow('WORKER_INACTIVITY_POLICY_INVALID');
    const inverted = { ...quiet, classes: [{ ...quiet.classes[0]!, inactivity: { warnAfterMs: 120_000, stopAfterMs: 60_000 } }] };
    expect(() => executionRegistrySchema.parse({ schemaVersion: 1, revision: 'x', workClasses: inverted, profiles: [{ id: 'p', version: 1, adapter: { id: 'a', version: 1 }, parameters: {} }],
      kinds: [{ kind: 'fixture', profile: { id: 'p', version: 1 } }], evaluators: [{ id: 'e', version: 1, implementation: { id: 'e', version: 1 } }] })).toThrow();
  });
  it('the one docker effect classifier: an installed docker profile is workspace-only, anything else unknown', () => {
    expect(classifyDockerTaskEffects(fixtureDockerRegistry(['fixture']).profiles[0]!)).toBe('workspace-only');
    expect(classifyDockerTaskEffects({ id: 'p', version: 1, adapter: { id: 'erp-adapter', version: 1 }, parameters: {} })).toBe('unknown');
  });
});

function evaluated(options: { exitCode?: number; interrupted?: boolean | null; cause?: string; stall?: boolean; work?: boolean } = {}) {
  const base = fixtureExecution(graph);
  const execution = options.stall === false ? base : { ...base, tasks: base.tasks.map(task => ({ ...task, stall: { warnAfterMs: 100, stopAfterMs: 200, maxRetries: 1 } })) };
  const created = createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 0, execution);
  const admitted = options.work ? runSnapshotSchema.parse({ ...created, graph: { ...created.graph, schemaVersion: 3, tasks: [{ ...created.graph.tasks[0]!, workInput }] } }) : created;
  return observed(reserveRunTasks(admitted, 0, [id()], 0), id(), options);
}
function observed(reserved: RunSnapshot, identity: AttemptIdentity, options: { exitCode?: number; interrupted?: boolean | null; cause?: string } = {}) {
  const exitCode = options.exitCode ?? 137;
  const attempt = applyAttemptObservation(createAttempt(identity), { protocolVersion: 1 as const, identity, sequence: 1, eventId: 'exit', result: { kind: 'exited' as const, exitCode } }, 0);
  const run = observeRunAttempt(reserved, reserved.revision, attempt);
  const dispatch = { schemaVersion: 2 as const, request: { protocolVersion: 1 as const, identity, workspace: '/recorded/workspace', argv: ['tool'] }, owner: 'supervisor',
    profile: { schemaVersion: 1 as const, adapterId: 'test-supervisor', adapterVersion: 1, parameters: { fixture: 'strict-custody-profile' } }, launch: 'granted' as const,
    grant: { generation: identity.generation, grantedAt: 1, principal: { id: 'launcher', issuer: 'test', subject: 'fixture' } },
    terminal: { handle: 'handle', exitCode, interrupted: options.interrupted === undefined ? true : options.interrupted, ...(options.cause === undefined ? { interruptCause: 'inactivity' } : options.cause === 'legacy' ? {} : { interruptCause: options.cause }) },
    output: { schemaVersion: 1 as const, scopeId: 's', digest: 'a'.repeat(64), byteLength: 1 } };
  return { run, attempt, dispatch };
}
const stall = (identity: AttemptIdentity, cause: string, extra: object = {}) => ({ schemaVersion: 1, evaluationId: 'evaluation-' + identity.generation, identity, graphRevision: 1,
  attemptRevision: 1, criteria: unknown, stall: { cause, backoffMs: 50 }, ...extra });

describe('the one retry owner (domain) through the evaluation transition the store re-runs', () => {
  it('a watchdog stop retries once on a NEW Attempt after the backoff, then fails worker-stalled without parking the task', () => {
    const f = evaluated(), before = JSON.stringify(f);
    const first = proposeTaskEvaluationCommit(f.run, f.attempt, f.dispatch, f.run.revision, stall(id(), 'inactivity'), timing);
    expect(JSON.stringify(f)).toBe(before);
    expect(first.conclusion).toBe('unknown');
    expect(first.snapshot.progress[0]).toMatchObject({ phase: 'pending', eligibility: { kind: 'not-before', at: 150 }, unresolvedEffects: false });
    expect(first.snapshot.progress[0]!.notAcceptedReason).toBeUndefined();
    expect(first.snapshot.bindings).toEqual([]);
    expect(first.snapshot.previousBindings).toEqual([{ identity: id(), observedRevision: 1, observedKind: 'stalled', stallCause: 'inactivity' }]);
    expect(first.snapshot.state).toEqual({ kind: 'running' });
    // The new Attempt waits for the backoff and must be the next generation with a fresh id (new lease); the old one is never re-bound.
    expect(() => reserveRunTasks(first.snapshot, first.snapshot.revision, [id(2, 'b')], 149)).toThrow('RUN_TASK_NOT_READY');
    expect(() => reserveRunTasks(first.snapshot, first.snapshot.revision, [id(1, 'b')], 150)).toThrow('RUN_ATTEMPT_CONFLICT');
    expect(() => reserveRunTasks(first.snapshot, first.snapshot.revision, [id(2, 'a')], 150)).toThrow('RUN_ATTEMPT_CONFLICT');
    const second = observed(reserveRunTasks(first.snapshot, first.snapshot.revision, [id(2, 'b')], 150), id(2, 'b'));
    const exhausted = proposeTaskEvaluationCommit(second.run, second.attempt, second.dispatch, second.run.revision, stall(id(2, 'b'), 'inactivity'), timing);
    expect(exhausted.conclusion).toBe('fail');
    expect(exhausted.snapshot.progress[0]).toMatchObject({ phase: 'failed', notAcceptedReason: 'worker-stalled' });
    expect(exhausted.snapshot.progress[0]!.decision).toBeUndefined();
    expect(exhausted.snapshot.state).not.toMatchObject({ reason: 'evaluation-not-ready' });
    expect(exhausted.snapshot.previousBindings).toHaveLength(1);
  });
  it('maxRetries 0 fails at once; an unresolved effect, a missing frozen policy or a live Run refuse the transition', () => {
    const f = evaluated(), none = runSnapshotSchema.parse({ ...f.run, execution: { ...f.run.execution, tasks: f.run.execution.tasks.map(task => ({ ...task, stall: { ...task.stall!, maxRetries: 0 } })) } });
    expect(recoverStalledTask(none, none.revision, id(), 'inactivity', { now: 100, backoffMs: 0, timeoutMs: 1000 }).snapshot.progress[0]).toMatchObject({ phase: 'failed', notAcceptedReason: 'worker-stalled' });
    const uncertain = { ...f.run, progress: f.run.progress.map(task => ({ ...task, unresolvedEffects: true })) };
    expect(() => recoverStalledTask(uncertain, f.run.revision, id(), 'inactivity', { now: 100, backoffMs: 0, timeoutMs: 1000 })).toThrow('RUN_ATTEMPT_CONFLICT');
    const legacy = evaluated({ stall: false });
    expect(() => proposeTaskEvaluationCommit(legacy.run, legacy.attempt, legacy.dispatch, legacy.run.revision, stall(id(), 'inactivity'), timing)).toThrow('RUN_ATTEMPT_CONFLICT');
    const cancelled = { ...f.run, cancelRequested: true };
    expect(() => recoverStalledTask(cancelled, f.run.revision, id(), 'inactivity', { now: 100, backoffMs: 0, timeoutMs: 1000 })).toThrow('RUN_ATTEMPT_CONFLICT');
  });
  it('a deadline, a legacy interruption or a stop without stall evidence is never retried (today\'s not-ready hold)', () => {
    for (const cause of ['deadline', 'cancel', 'legacy']) {
      const f = evaluated({ cause });
      expect(() => proposeTaskEvaluationCommit(f.run, f.attempt, f.dispatch, f.run.revision, stall(id(), 'inactivity'), timing)).toThrow('TASK_EVALUATION_NOT_READY');
    }
    const f = evaluated();
    expect(() => proposeTaskEvaluationCommit(f.run, f.attempt, f.dispatch, f.run.revision, { ...stall(id(), 'inactivity'), stall: undefined }, timing)).toThrow('TASK_EVALUATION_NOT_READY');
  });
  it('withholding events can only stop a worker: a stall can never carry a pass or apply to a clean exit', () => {
    const f = evaluated();
    expect(() => proposeTaskEvaluationCommit(f.run, f.attempt, f.dispatch, f.run.revision, { ...stall(id(), 'inactivity'), criteria: [{ ...unknown[0]!, verdict: 'pass' }] }, timing)).toThrow('TASK_EVALUATION_INVALID');
    const clean = evaluated({ exitCode: 0, interrupted: false, cause: 'legacy' });
    expect(() => proposeTaskEvaluationCommit(clean.run, clean.attempt, clean.dispatch, clean.run.revision, stall(id(), 'inactivity'), timing)).toThrow('TASK_EVALUATION_INVALID');
    expect(() => runSnapshotSchema.parse({ ...f.run, bindings: f.run.bindings.map(row => ({ ...row, observedKind: 'stalled', stallCause: 'inactivity' })) })).toThrow();
    expect(() => runSnapshotSchema.parse({ ...f.run, bindings: [], progress: f.run.progress.map(task => ({ ...task, phase: 'pending' })),
      previousBindings: f.run.bindings.map(row => ({ ...row, observedKind: 'stalled' })) })).toThrow();
  });
  it('D5a: a missing report on a clean exit shares the same bound; a pass criterion cannot bypass it', () => {
    const f = evaluated({ exitCode: 0, interrupted: false, cause: 'legacy', work: true });
    const report = (identity: AttemptIdentity) => stall(identity, 'report-missing', { report: { status: 'missing' }, criteria: [{ ...unknown[0]!, verdict: 'pass' }] });
    expect(() => proposeTaskEvaluationCommit(f.run, f.attempt, f.dispatch, f.run.revision, { ...report(id()), stall: { cause: 'report-invalid', backoffMs: 50 } }, timing)).toThrow('TASK_EVALUATION_INVALID');
    const first = proposeTaskEvaluationCommit(f.run, f.attempt, f.dispatch, f.run.revision, report(id()), timing);
    expect(first.snapshot.progress[0]).toMatchObject({ phase: 'pending' });
    expect(first.snapshot.previousBindings?.[0]).toMatchObject({ observedKind: 'stalled', stallCause: 'report-missing' });
    const second = observed(reserveRunTasks(first.snapshot, first.snapshot.revision, [id(2, 'b')], 150), id(2, 'b'), { exitCode: 0, interrupted: false, cause: 'legacy' });
    const exhausted = proposeTaskEvaluationCommit(second.run, second.attempt, second.dispatch, second.run.revision, report(id(2, 'b')), timing);
    expect(exhausted.snapshot.progress[0]).toMatchObject({ phase: 'failed', notAcceptedReason: 'report-missing' });
    // Without the stall evidence (no frozen policy / not proven retryable) the S4 floor fails at once, unchanged.
    expect(proposeTaskEvaluationCommit(f.run, f.attempt, f.dispatch, f.run.revision, { ...report(id()), stall: undefined }, timing).snapshot.progress[0])
      .toMatchObject({ phase: 'failed', notAcceptedReason: 'report-missing' });
  });
});

describe.skipIf(process.platform === 'win32')('composed through the SQLite ledger and the evaluation application (requires POSIX private artifacts)', () => {
  const roots: string[] = [], stores: SqliteAttemptStore[] = [];
  afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  const principal = { id: 'operator', issuer: 'fixture', subject: 'operator', assurance: 'os-user' as const, scopeIds: ['s'] };
  const verifier = { async verify() { return principal; } }, authorization = { async authorize() {} };
  async function ledger(options: { stall?: boolean; operation?: boolean; cause?: string } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'deckent-stall-')); roots.push(root); let now = 1000, sequence = 0;
    const store = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: () => now, timeoutMs: 5000 }, 'allow', custodyProfiles); stores.push(store);
    await mkdir(join(root, 'artifacts'), { mode: 0o700 }); const artifacts = new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 65536 });
    const base = fixtureExecution(graph);
    const execution = { ...base, tasks: base.tasks.map(task => ({ ...task, ...(options.stall === false ? {} : { stall: { warnAfterMs: 100, stopAfterMs: 200, maxRetries: 1 } }) })),
      criteria: base.criteria.map(row => options.operation ? { ...row, evaluator: { ...row.evaluator, implementation: { id: 'operation-evidence', version: 1 } } } : row) };
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 4, inFlightSlots: 4 } });
    await store.createRun({ commandId: 'create-r', actor: { id: 'operator', issuer: 'fixture', subject: 'operator' }, identity: { scopeId: 's', runId: 'r', layoutRevision: 'l' }, graph, execution, now,
      policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['t'] } });
    const reservation = new RunReservationApplication(store, verifier, authorization, authorization, { now: () => now, attemptId: () => `a-${++sequence}` });
    const reserve = async () => (await reservation.reserve({ schemaVersion: 1, scopeId: 's', runId: 'r', commandId: `reserve-${++sequence}`, expectedRevision: (await store.loadRun('s', 'r'))!.revision })).identities[0]!;
    async function stop(identity: AttemptIdentity) {
      const claim = { request: { protocolVersion: 1 as const, identity, workspace: '/fixture', argv: ['fixture'] }, owner: 'worker' };
      await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
      await store.retainDispatchOutput(claim, await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'partial', stdout: '', stderr: '' }))));
      const cause = options.cause ?? 'inactivity';
      await store.finishDispatch(claim, { handle: identity.attemptId, exitCode: 137, interrupted: true, ...(cause === 'legacy' ? {} : { interruptCause: cause as 'inactivity' }) });
    }
    const evaluator = { evaluate: vi.fn(async () => 'pass' as const) };
    let effects: 'workspace-only' | 'external' | 'unknown' | 'throws' = 'workspace-only';
    const app = new TaskEvaluationApplication(store, verifier, authorization, evaluator, artifacts, { maxEvidenceItems: 1, maxTotalBytes: 65536 }, { now: () => now, timeoutMs: 5000 },
      undefined, undefined, undefined, { backoffMs: 50, effects: () => { if (effects === 'throws') throw new Error('unclassified'); return effects; } });
    const evaluate = async (identity: AttemptIdentity, commandId = `eval-${++sequence}`) => app.execute({ schemaVersion: 1, identity, commandId, expectedRevision: (await store.loadRun('s', 'r'))!.revision });
    return { root, store, reserve, stop, evaluate, evaluator, app, setEffects(value: typeof effects) { effects = value; }, setNow(value: number) { now = value; } };
  }
  it('retries a workspace-only stop once (receipt replays), then fails worker-stalled; the evaluator never runs', async () => {
    const f = await ledger(); const first = await f.reserve(); await f.stop(first);
    const receipt = await f.evaluate(first, 'eval-first');
    expect(receipt.snapshot.progress[0]).toMatchObject({ phase: 'pending', eligibility: { kind: 'not-before', at: 1050 } });
    expect(receipt.snapshot.previousBindings?.[0]).toMatchObject({ observedKind: 'stalled', stallCause: 'inactivity' });
    const replay = await f.app.execute({ schemaVersion: 1, identity: first, commandId: 'eval-first', expectedRevision: receipt.snapshot.revision - 1 });
    expect(replay.snapshot).toEqual(receipt.snapshot);
    // The Run stays `running` (the progression keeps visiting it); before the backoff a reservation is the quiet `waiting` outcome.
    expect(receipt.snapshot.state).toEqual({ kind: 'running' });
    const early = await f.reserve().then(() => null, (error: { code?: string; params?: { reason?: string } }) => error);
    expect(early).toMatchObject({ code: 'RUN_CAPACITY_OR_ORDER' }); expect(reservationRefusalOutcome(early!.code!)).toBe('waiting');
    f.setNow(1050); const second = await f.reserve(); expect(second).toMatchObject({ generation: 2 }); expect(second.attemptId).not.toBe(first.attemptId);
    await f.stop(second); const exhausted = await f.evaluate(second);
    expect(exhausted.snapshot.progress[0]).toMatchObject({ phase: 'failed', notAcceptedReason: 'worker-stalled' });
    expect(f.evaluator.evaluate).not.toHaveBeenCalled();
    // Read paths after a retry and after exhaustion: the stall evaluation receipts stay readable by inspection and the Run view.
    const reader = inventoryReadsPerCall(async () => join(f.root, 'ledger.db'), { busyTimeoutMs: 100 });
    for (const snapshot of [receipt.snapshot, exhausted.snapshot]) {
      const evaluations = await reader.loadRunEvaluations(snapshot);
      expect(() => projectRunView(snapshot, [], evaluations)).not.toThrow();
    }
  });
  it.each([['external effects', { effects: 'external' as const }], ['unknown effects', { effects: 'unknown' as const }], ['an unclassifiable profile', { effects: 'throws' as const }],
    ['a criterion that reads business operation settlements (ERP/CRM)', { operation: true }], ['an older Run without a frozen policy', { stall: false }],
    ['a deadline stop', { cause: 'deadline' }], ['a legacy interruption', { cause: 'legacy' }]] as const)('never retries %s: it keeps the evaluation-not-ready hold and accept stays refused', async (_name, options) => {
    const f = await ledger(options); if ('effects' in options) f.setEffects(options.effects);
    const identity = await f.reserve(); await f.stop(identity);
    const parked = await f.evaluate(identity);
    expect(parked.snapshot.progress[0]).toMatchObject({ phase: 'awaiting-decision', decision: { reason: 'evaluation-not-ready' } });
    expect(parked.snapshot.previousBindings ?? []).toEqual([]);
    expect(() => resolveTaskDecision(parked.snapshot, parked.snapshot.revision, 't', 'accept', 1001, 5000)).toThrow('RUN_DECISION_NOT_READY');
    expect(f.evaluator.evaluate).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('dispatch records why the supervisor stopped waiting', () => {
  const roots: string[] = [], stores: SqliteAttemptStore[] = [];
  afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  const verifier = { async verify() { return { id: 'user', issuer: 'test', subject: 'user', assurance: 'os-user' as const, scopeIds: ['s'] }; } };
  it.each([['inactivity', 'inactivity'], ['operator', 'cancel'], [null, 'deadline']] as const)('abort reason %s records interruptCause %s; no new token or secret reaches the worker', async (reason, cause) => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-stall-dispatch-')); roots.push(root);
    const store = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles); stores.push(store);
    const identity = { runId: 'r', taskId: 't', attemptId: randomUUID(), scopeId: 's', generation: 1, layoutRevision: 'l' };
    await admitRunAttempts(store, [identity]); await mkdir(join(root, 'artifacts'), { mode: 0o700 });
    const request = { protocolVersion: 1 as const, identity, workspace: join(root, 'workspace'), argv: ['worker'] };
    const seen: unknown[] = [];
    const supervisor: ExecutionSupervisor & { captureProfile(): Promise<typeof custodyProfile> } = { async captureProfile() { return custodyProfile; },
      async cancel() { throw new Error('not cancelled'); }, async recoverOutput() { throw new Error('not recovered'); }, async observe() { throw new Error('not observed'); }, async release() { return 'absent' as const; },
      async execute(input, signal) {
        seen.push(input);
        if (reason !== null) await new Promise(resolve => signal!.addEventListener('abort', resolve, { once: true }));
        return { handle: 'h', result: { kind: 'exited', exitCode: 137 }, outputCompleteness: 'partial', stdout: '', stderr: '', interrupted: true };
      } };
    const controller = new AbortController();
    const app = new DispatchApplication(store, supervisor, verifier, { async authorize() {} }, 'p', new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 65536 }));
    const running = app.execute(request, undefined, controller.signal);
    if (reason !== null) setTimeout(() => controller.abort(reason), 10);
    const outcome = await running;
    expect(outcome.record.terminal).toMatchObject({ interrupted: true, interruptCause: cause });
    // The supervisor receives exactly the authorized request: the watchdog adds a signal, never argv, env, credentials or paths.
    expect(seen).toEqual([request]);
  });
});

describe('monitor: worker-silent warns, the fresh-heartbeat running derivation is unchanged', () => {
  const NOW = 1_000_000, run = (frozen: boolean) => {
    const base = createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
    const execution = frozen ? { ...base.execution, tasks: base.execution.tasks.map(task => ({ ...task, stall: { warnAfterMs: 180_000, stopAfterMs: 600_000, maxRetries: 1 } })) } : base.execution;
    return reserveRunTasks({ ...base, execution }, 0, [id()], 0);
  };
  const attempt = { attemptId: 'a', generation: 1, observedKind: null, observedRevision: null, evaluationObserved: false, reservedAtMs: 100, sealedAtMs: null,
    dispatch: { launch: 'granted' as const, grantedAtMs: 200, terminal: null, outputRecorded: false } };
  const worker = (receivedAt: number | null) => ({ taskId: 't', identity: id(), authority: 'next-ledger' as const, provider: 'claude', workspace: '/w', process: 'running' as const, handle: 'h',
    terminal: null, outputRecorded: false, patchRecorded: false, diagnostics: [], files: { provider: 'claude', heartbeat: { state: 'available', ageMs: 50, freshness: 'fresh' as const, phase: 'running' },
      log: { state: 'available', byteLength: 0, truncated: false, sampledLines: 0, diagnostics: [], events: [] }, result: { state: 'missing', exitCode: null, reportedAssessment: null }, pid: null,
      activity: receivedAt === null ? null : { phase: 'editing' as const, detail: null, target: null, atMs: 5, receivedAt }, usage: null, eventsTruncated: false } });
  const derive = (frozen: boolean, receivedAt: number | null) => deriveRunBlocker({ run: { snapshot: run(frozen), poolId: 'p', admitted: true, createdAtMs: 50, attempts: [attempt] },
    approvals: [], pool: null, workers: new Map([['a', worker(receivedAt)]]), observedAt: NOW });
  it('a fresh heartbeat with old (or no) worker events past the frozen warn bound is worker-silent; recent events or no policy stay worker-running', () => {
    expect(derive(true, NOW - 180_000)).toEqual({ code: 'worker-silent', taskId: 't', sinceMs: NOW - 180_000, detail: 'no-worker-events' });
    expect(derive(true, null)).toMatchObject({ code: 'worker-silent', sinceMs: 200 });
    expect(derive(true, NOW - 1000)).toMatchObject({ code: 'worker-running', detail: 'editing' });
    expect(derive(false, null)).toMatchObject({ code: 'worker-running', sinceMs: 200 });
  });
  it('typed details: a watchdog stop awaiting evaluation and a Run parked by an exhausted stall', () => {
    const stopped = evaluated();
    expect(deriveRunBlocker({ run: { snapshot: stopped.run, poolId: 'p', admitted: true, createdAtMs: 50, attempts: [{ ...attempt, observedKind: 'exited', observedRevision: 1,
      dispatch: { ...attempt.dispatch, terminal: { exitCode: 137, signal: null, interrupted: true, interruptCause: 'inactivity' }, outputRecorded: true } }] },
    approvals: [], pool: null, workers: new Map(), observedAt: NOW })).toMatchObject({ code: 'evaluation-not-ready', detail: 'WORKER_INACTIVITY_STOPPED' });
    const none = runSnapshotSchema.parse({ ...stopped.run, execution: { ...stopped.run.execution, tasks: stopped.run.execution.tasks.map(task => ({ ...task, stall: { ...task.stall!, maxRetries: 0 } })) } });
    const exhausted = recoverStalledTask(none, none.revision, id(), 'inactivity', { now: 100, backoffMs: 0, timeoutMs: 1000 }).snapshot;
    expect(deriveRunBlocker({ run: { snapshot: exhausted, poolId: 'p', admitted: true, createdAtMs: 50, attempts: [] }, approvals: [], pool: null, workers: new Map(), observedAt: 100 }))
      .toMatchObject({ code: 'parked', detail: 'TASK_STALL_RETRY_EXHAUSTED' });
  });
});

describe.skipIf(process.platform === 'win32' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('real Docker: the watchdog abort follows the existing kill path', () => {
  const roots: string[] = [], stores: SqliteAttemptStore[] = [];
  afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  it('an inactivity abort kills the silent container, settles an exited terminal and records interruptCause inactivity', async () => {
    const { DockerSupervisor } = await import('#adapters/index.js'); const { custodyOrDockerProfiles } = await import('../support/custody.js');
    const root = await mkdtemp(join(tmpdir(), 'deckent-stall-docker-')); roots.push(root); await mkdir(join(root, 'workspace')); await mkdir(join(root, 'artifacts'), { mode: 0o700 });
    const store = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyOrDockerProfiles); stores.push(store);
    const identity = { runId: 'r', taskId: 't', attemptId: randomUUID(), scopeId: 's', generation: 1, layoutRevision: 'l' };
    await admitRunAttempts(store, [identity]);
    const request = { protocolVersion: 1 as const, identity, workspace: join(root, 'workspace'), argv: ['node', '-e', 'setTimeout(() => {}, 60000)'] };
    const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: process.env.DECKENT_TEST_DOCKER_IMAGE!, uid: process.getuid!(), gid: process.getgid!(),
      logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 50000, controlTimeoutMs: 10000, outputBytes: 65536 });
    const app = new DispatchApplication(store, supervisor, { async verify() { return { id: 'user', issuer: 'test', subject: 'user', assurance: 'os-user' as const, scopeIds: ['s'] }; } },
      { async authorize() {} }, 'p', new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 1048576 }));
    const controller = new AbortController(), started = Date.now();
    try {
      setTimeout(() => controller.abort('inactivity'), 3000);
      const outcome = await app.execute(request, undefined, controller.signal);
      expect(outcome.kind).toBe('terminal');
      expect(outcome.record.terminal).toMatchObject({ interrupted: true, interruptCause: 'inactivity' });
      expect(outcome.record.terminal!.exitCode).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(40000);
    } finally { await supervisor.release(request).catch(() => undefined); }
  }, 60000);
});

describe.skipIf(process.platform === 'win32')('composed evaluation (evaluateConfiguredTask) wires the classifier and the installation backoff', () => {
  const roots: string[] = [];
  afterEach(async () => { const { clearConfigCache } = await import('#platform/index.js'); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  it.each([['an installed docker profile is retried', true], ['an unclassified profile keeps the hold', false]] as const)('%s', async (_name, docker) => {
    const { writeFile } = await import('node:fs/promises'); const { hostname, userInfo } = await import('node:os');
    const { prepareProductDirectory } = await import('#platform/index.js');
    const { openConfiguredAttemptStore } = await import('../../../src/composition/core/storage/index.js');
    const { evaluateConfiguredTask } = await import('../../../src/composition/core/runs/index.js');
    const root = await mkdtemp(join(tmpdir(), 'stall-compose-')); roots.push(root);
    const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, runRuntime: { stallRecovery: { schemaVersion: 1, backoffMs: 7000 } } }));
    const options = { env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') } };
    const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
    const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: opened.layout.revision };
    const base = structuredClone(fixtureExecution(graph));
    base.criteria[0]!.evaluator.implementation = { id: 'process-exit', version: 1 };
    const execution = { ...base, tasks: base.tasks.map(task => ({ ...task, ...(docker ? { profile: fixtureDockerRegistry(['fixture']).profiles[0]! } : {}), stall: { warnAfterMs: 1000, stopAfterMs: 2000, maxRetries: 1 } })) };
    const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    const actor = { id: 'fixture', issuer: 'test', subject: 'fixture' };
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
    await store.createRun({ commandId: 'create', actor, identity: { runId: 'r', scopeId: 's', layoutRevision: identity.layoutRevision }, graph, execution, now: 0,
      policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
    await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'r', expectedRevision: 0, now: 0, identities: [identity] });
    const claim = { owner: 'fixture', request: { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['test'] } };
    await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
    const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 65536 });
    await store.retainDispatchOutput(claim, await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'partial', stdout: '', stderr: '' }))));
    await store.finishDispatch(claim, { handle: 'h', exitCode: 137, interrupted: true, interruptCause: 'inactivity' });
    store.close();
    const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    await writeFile(join(root, 'data/policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'test', restrictions: [], grants: [
      { id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
      { id: 'run', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
      { id: 'evaluation', effect: 'allow', actions: ['evaluate', 'read-output', 'recover-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: ['a'] } },
    ] }), { mode: 0o600 });
    const before = Date.now();
    const result = await evaluateConfiguredTask(project, { schemaVersion: 1, commandId: 'evaluation', identity, expectedRevision: 2 }, options);
    const reader = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    try {
      const run = (await reader.loadRun('s', 'r'))!;
      if (docker) {
        expect(run.progress[0]).toMatchObject({ phase: 'pending', eligibility: { kind: 'not-before' } });
        const at = (run.progress[0]!.eligibility as { at: number }).at;
        expect(at - before).toBeGreaterThanOrEqual(7000); expect(at - Date.now()).toBeLessThanOrEqual(7000);
        expect(run.previousBindings?.[0]).toMatchObject({ observedKind: 'stalled', stallCause: 'inactivity' });
      } else expect(run.progress[0]).toMatchObject({ phase: 'awaiting-decision', decision: { reason: 'evaluation-not-ready' } });
      expect(result.evaluation.run).toBeDefined();
    } finally { reader.close(); }
  });
});
