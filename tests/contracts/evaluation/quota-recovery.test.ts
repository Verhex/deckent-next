import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { inventoryReadsPerCall, createNormalizerState, createCodexState, normalizeClaudeLine, normalizeCodexLine, FileArtifactStore, openSqliteAttemptStore, sealAttemptWorkerEvents, type SqliteAttemptStore } from '#adapters/index.js';
import { TaskEvaluationApplication, RunLifecycleApplication, RunReservationApplication, projectMonitorRun, projectRunView } from '#engine/index.js';
import { runSnapshotSchema, requestRunCancellation, verifyWorkerModels, type WorkerEvent, type AttemptIdentity } from '#domain/index.js';
import { quotaWaitText } from '#surfaces/core/monitor/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const quotaPolicy = JSON.parse(readFileSync(new URL('../../../src/adapters/core/native-connection/internal/providers.json', import.meta.url), 'utf8')).quotaPolicy;
const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = { id: 'operator', issuer: 'fixture', subject: 'operator' };
const principal = { ...actor, assurance: 'os-user' as const, scopeIds: ['s'] };
const verifier = { async verify() { return principal; } }, authorization = { async authorize() {} };
const pin = { channelId: 'subscription-channel', modelId: 'native-model', auxiliaryModelIds: [] };
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'business criterion', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
type Variant = 'claude-rate-limit' | 'codex-text' | 'exit-text';
async function fixture(source: Variant = 'claude-rate-limit', options: { substituted?: boolean; resetsAtMs?: number | null; maxResumes?: number; interrupted?: boolean; partial?: boolean; noSeal?: boolean; recoveredSession?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-quota-')); roots.push(root); let now = 1000, sequence = 0;
  const path = join(root, 'ledger.db'), storage = { busyTimeoutMs: 100, journalMode: 'wal' as const, durability: 'full' as const };
  const store = await openSqliteAttemptStore(path, storage, { now: () => now, timeoutMs: 5000 }, 'allow', custodyProfiles); stores.push(store);
  await mkdir(join(root, 'artifacts'), { mode: 0o700 }); const artifacts = new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 65536 });
  const provider = source === 'codex-text' ? 'codex' : 'claude';
  const base = fixtureExecution(graph), execution = { ...base, tasks: base.tasks.map(task => ({ ...task, profile: { ...task.profile,
    parameters: { ...task.profile.parameters, nativeSubscription: { schemaVersion: 2, provider, model: pin, modelUsageEvidence: provider === 'claude' ? 'session-events' : 'none' } } } })) };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 4, inFlightSlots: 4 } });
  async function create(runId: string, channelId = pin.channelId) {
    const frozen = { ...execution, tasks: execution.tasks.map(task => ({ ...task, profile: { ...task.profile, parameters: { ...task.profile.parameters,
      nativeSubscription: { ...task.profile.parameters.nativeSubscription, model: { ...pin, channelId } } } } })) };
    await store.createRun({ commandId: `create-${runId}`, actor, identity: { scopeId: 's', runId, layoutRevision: 'l' }, graph, execution: frozen, now,
      policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['t'] } });
  }
  const reserve = new RunReservationApplication(store, verifier, authorization, authorization, { now: () => now, attemptId: () => `a-${++sequence}` });
  async function reserveRun(runId: string) {
    const run = (await store.loadRun('s', runId))!;
    return reserve.reserve({ schemaVersion: 1, scopeId: 's', runId, commandId: `reserve-${++sequence}`, expectedRevision: run.revision });
  }
  await create('r'); const first = await reserveRun('r'); const identity = first.identities[0]!;
  const evaluator = { evaluate: vi.fn(async () => 'fail' as const) };
  const app = new TaskEvaluationApplication(store, verifier, authorization, evaluator, artifacts, { maxEvidenceItems: 1, maxTotalBytes: 65536 },
    { now: () => now, timeoutMs: 5000 }, undefined, undefined, { maxResumes: options.maxResumes ?? 1 });
  async function finish(identity: AttemptIdentity, resetsAtMs: number | null = source === 'claude-rate-limit' ? options.resetsAtMs === undefined ? 6000 : options.resetsAtMs : null) {
    const claim = { request: { protocolVersion: 1 as const, identity, workspace: '/fixture', argv: ['fixture'] }, owner: 'worker' };
    await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
    const stdout = JSON.stringify({ schemaVersion: 1, kind: 'native-coding-exit', code: 1, signal: null, failure: 'capacity', outputBytes: 1 }) + '\n';
    const output = await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: options.partial ? 'partial' : 'complete', stdout, stderr: '' })));
    await store.retainDispatchOutput(claim, output); await store.finishDispatch(claim, { handle: identity.attemptId, exitCode: 1, interrupted: options.interrupted ?? false });
    const used = options.substituted ? 'different-model' : pin.modelId;
    const events: WorkerEvent[] = [ { schemaVersion: 1, sequence: 1, atMs: 0, kind: 'session.started', provider, model: used, cliVersion: 'fixture' } ];
    if (source !== 'exit-text') {
      const state = createNormalizerState([], 0, quotaPolicy);
      const native = source === 'claude-rate-limit'
        ? normalizeClaudeLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs === null ? null : resetsAtMs / 1000 } }), state, 1)
        : normalizeCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'Rate limit exceeded' } }), state, createCodexState(), 1);
      events.push(...native.map(event => ({ ...event, sequence: events.length + event.sequence })));
    }
    if (options.recoveredSession) events.push({ schemaVersion: 1, sequence: events.length + 1, atMs: 2, kind: 'session.ended', outcome: 'success', turns: 1, durationMs: 2, apiDurationMs: null, costUsd: null, costBasis: null, tokens: null, permissionDenials: 0 });
    if (!options.noSeal) await sealAttemptWorkerEvents(identity, artifacts, store, { events, verification: { ...verifyWorkerModels({ evidenceCapability: provider === 'claude' ? 'session-events' : 'none', admitted: pin, startedModel: used, usedModels: [used] }), evidenceCapability: provider === 'claude' ? 'session-events' : 'none' },
      unreported: 0, projectionComplete: true, maxBytes: 65536 });
    return claim;
  }
  const claim = await finish(identity);
  const lifecycle = new RunLifecycleApplication(store, verifier, authorization, authorization, () => ({ record() {} }), () => now, 5000, 'fixture-policy');
  async function evaluate(identity = first.identities[0]!, commandId = `eval-${++sequence}`) {
    const run = (await store.loadRun('s', identity.runId))!; return app.execute({ schemaVersion: 1, identity, commandId, expectedRevision: run.revision });
  }
  return { root, path, storage, store, artifacts, app, evaluator, execution, identity, claim, lifecycle, create, reserveRun, finish, evaluate, setNow(value: number) { now = value; } };
}
it.skipIf(process.platform === 'win32').each(['claude-rate-limit', 'codex-text', 'exit-text'] as const)('parks %s with durable digest, exact Attempt quota result and an authenticated immutable replay', async source => {
  const f = await fixture(source); const run = (await f.store.loadRun('s', 'r'))!;
  const command = { schemaVersion: 1, identity: f.identity, commandId: 'evaluate-quota', expectedRevision: run.revision };
  const first = await f.app.execute(command);
  expect(first.snapshot.state).toMatchObject({ kind: 'parked', reason: 'quota-exhausted', since: 1000, deadline: 6000 });
  expect(first.snapshot.progress[0]!.phase).toBe('pending'); expect(f.evaluator.evaluate).not.toHaveBeenCalled();
  const attempt = (await f.store.load('s', f.identity.attemptId))!;
  expect(attempt.lastObservation?.result).toMatchObject({ kind: 'quota-exhausted', quota: { source }, evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await f.app.execute(command)).toEqual(first); expect((await f.store.loadRun('s', 'r'))!.revision).toBe(first.snapshot.revision);
  await expect(f.app.execute({ ...command, identity: { ...f.identity, generation: 2 } })).rejects.toThrow('RUN_COMMAND_CONFLICT');
  const db = new DatabaseSync(f.path, { readOnly: true }); expect(db.prepare('SELECT count(*) n FROM acceptance_metrics').get()?.n).toBe(0); db.close();
});
it.skipIf(process.platform === 'win32')('resets once, retains the old quota Attempt across restart and reserves the same frozen profile with the next generation', async () => {
  const f = await fixture(); const parked = await f.evaluate();
  f.setNow(5999); expect(await f.lifecycle.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' })).toBeNull();
  f.setNow(6000); await f.lifecycle.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' });
  const resumed = (await f.store.loadRun('s', 'r'))!; expect(resumed.state).toEqual({ kind: 'running' }); expect(resumed.previousBindings?.[0]?.identity).toEqual(f.identity);
  expect(resumed.execution).toEqual(parked.snapshot.execution); expect(await f.lifecycle.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' })).toBeNull();
  const fresh = await f.reserveRun('r'); expect(fresh.identities[0]).toMatchObject({ generation: 2, taskId: 't' });
  expect(fresh.identities[0]!.attemptId).not.toBe(f.identity.attemptId);
  const reopened = await openSqliteAttemptStore(f.path, f.storage, { now: () => 6000, timeoutMs: 5000 }, 'forbid', custodyProfiles); stores.push(reopened);
  expect((await reopened.load('s', f.identity.attemptId))!.lastObservation?.result.kind).toBe('quota-exhausted');
  expect((await reopened.loadRun('s', 'r'))!.bindings).toHaveLength(1);
  await f.finish(fresh.identities[0]!, 12000); await f.evaluate(fresh.identities[0]!); f.setNow(12000);
  await f.lifecycle.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' });
  expect((await f.store.loadRun('s', 'r'))!.state).toMatchObject({ kind: 'terminal', reason: 'park-timeout' });
});
it.skipIf(process.platform === 'win32').each([null, 999])('does not treat unknown or stale reset %s as permission to retry', async resetsAtMs => {
  const f = await fixture('claude-rate-limit', { resetsAtMs }); await f.evaluate(); f.setNow(6000);
  await f.lifecycle.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' });
  const run = (await f.store.loadRun('s', 'r'))!; expect(run.state).toMatchObject({ kind: 'terminal', reason: 'park-timeout' }); expect(run.previousBindings).toBeUndefined();
});
it.skipIf(process.platform === 'win32')('holds other Runs and reserved Attempts on the same channel; unrelated channels and existing custody continue', async () => {
  const f = await fixture(); await f.create('reserved'); const reserved = await f.reserveRun('reserved');
  await f.create('live'); const live = await f.reserveRun('live');
  const liveClaim = { request: { protocolVersion: 1 as const, identity: live.identities[0]!, workspace: '/fixture', argv: ['fixture'] }, owner: 'worker' };
  await f.store.claimDispatch(dispatchAdmission(liveClaim)); await grantTestLaunch(f.store, liveClaim);
  await f.create('waiting'); await f.create('other', 'other-channel'); await f.evaluate();
  await expect(f.reserveRun('waiting')).rejects.toMatchObject({ code: 'RUN_CAPACITY_OR_ORDER' });
  await expect(f.store.claimDispatch(dispatchAdmission({ request: { protocolVersion: 1, identity: reserved.identities[0]!, workspace: '/fixture', argv: ['fixture'] }, owner: 'worker' })))
    .rejects.toMatchObject({ code: 'RUN_POOL_HELD' });
  expect((await f.store.claimDispatch(dispatchAdmission(liveClaim))).acquired).toBe(false);
  expect((await f.store.loadBoundDispatch(live.identities[0]!))!.launch).toBe('granted');
  expect((await f.reserveRun('other')).identities).toHaveLength(1);
  const before = (await f.store.loadRun('s', 'waiting'))!; const holds = await f.store.quotaHeldTasks(before, 1000); expect(holds).toEqual(['t']);
  const evidence = await inventoryReadsPerCall(async () => f.path, { busyTimeoutMs: 100 }).loadRunPoolEvidence('s', 'waiting');
  expect(evidence.quotaHolds).toEqual([{ taskId: 't', since: 1000, deadline: 6000, resetsAtMs: 6000 }]);
  const monitor = projectMonitorRun({ run: { snapshot: before, poolId: 'p', admitted: true, createdAtMs: 0, attempts: [], quotaHolds: evidence.quotaHolds }, approvals: [], pool: null, workers: new Map(), observedAt: 1000 });
  expect(monitor.blocker).toMatchObject({ detail: 'quota-exhausted', deadlineMs: 6000 });
  expect(JSON.stringify(evidence.quotaHolds)).not.toContain(f.identity.attemptId);
  f.setNow(6000); expect(await f.store.quotaHeldTasks(before, 6000)).toEqual([]); expect((await f.reserveRun('waiting')).identities).toHaveLength(1);
});
it.skipIf(process.platform === 'win32')('substitution still fails despite quota evidence; cancellation preserves the channel hold without granting a retry', async () => {
  const wrong = await fixture('claude-rate-limit', { substituted: true }); const failed = await wrong.evaluate();
  expect(failed.snapshot.progress[0]!.phase).toBe('failed'); expect(failed.snapshot.quotaWaits).toBeUndefined();
  const f = await fixture(); const parked = (await f.evaluate()).snapshot;
  const cancelled = requestRunCancellation(parked, parked.revision, { now: 2000, timeoutMs: 5000 }); expect(cancelled.state).toMatchObject({ kind: 'terminal', outcome: 'cancelled' });
  await f.store.cancelRun({ commandId: 'cancel-quota', actor, scopeId: 's', runId: 'r', expectedRevision: parked.revision });
  await f.create('waiting'); await expect(f.reserveRun('waiting')).rejects.toMatchObject({ code: 'RUN_CAPACITY_OR_ORDER' });
  f.setNow(6000); expect(await f.lifecycle.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' })).toBeNull();
});
it.skipIf(process.platform === 'win32').each([{ interrupted: true }, { partial: true }])('refuses quota parking on incomplete custody %j', async options => {
  const f = await fixture('claude-rate-limit', options), before = await f.store.loadRun('s', 'r');
  if (options.interrupted) {
    const result = await f.evaluate(); expect(result.snapshot.state).toMatchObject({ kind: 'parked', reason: 'evaluation-not-ready' });
    expect(result.snapshot.quotaWaits).toBeUndefined(); expect((await f.store.load('s', f.identity.attemptId))!.lastObservation?.result.kind).toBe('exited');
  } else { await expect(f.evaluate()).rejects.toThrow(); expect(await f.store.loadRun('s', 'r')).toEqual(before); }
});
it.skipIf(process.platform === 'win32')('uses verified bootstrap exit fallback without a seal, zero retry config and scope-safe monitor wait projection', async () => {
  const f = await fixture('exit-text', { noSeal: true, maxResumes: 0 }); const parked = (await f.evaluate()).snapshot;
  expect(parked.quotaWaits?.[0]).toMatchObject({ maxResumes: 0, quota: { resetsAtMs: null, source: 'exit-text' } });
  expect(runSnapshotSchema.parse(parked)).toEqual(parked); expect(projectRunView(parked).quotaWaits).toEqual([{ taskId: 't', since: 1000, deadline: 6000, resetsAtMs: null, retryLimitReached: true }]);
  expect(JSON.stringify(projectRunView(parked))).not.toContain(parked.quotaWaits![0]!.evidenceDigest);
  expect(JSON.stringify(projectRunView(parked).quotaWaits)).not.toContain(pin.channelId);
  const monitor = projectMonitorRun({ run: { snapshot: parked, poolId: 'p', admitted: true, createdAtMs: 0, attempts: [] }, approvals: [], pool: null, workers: new Map(), observedAt: 1000 });
  expect(monitor.blocker).toMatchObject({ detail: 'quota-retry-limit', deadlineMs: 6000 });
  expect(quotaWaitText(6000, false, 'tr')).toContain('bilinmiyor'); expect(quotaWaitText(6000, true, 'en')).toContain('resumes at');
  expect(quotaWaitText(6000, true, 'tr', true)).toContain('sınırına');
});

it.skipIf(process.platform === 'win32')('does not recycle an earlier rejection after a successful native session and a later unrelated process failure', async () => {
  const f = await fixture('claude-rate-limit', { recoveredSession: true }); const evaluated = await f.evaluate();
  expect(evaluated.snapshot.quotaWaits).toBeUndefined(); expect(evaluated.snapshot.progress[0]!.phase).toBe('failed');
  expect(f.evaluator.evaluate).toHaveBeenCalledOnce();
});
