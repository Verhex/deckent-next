import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { inventoryReadsPerCall, createNormalizerState, createCodexState, normalizeClaudeLine, normalizeCodexLine, FileArtifactStore, openSqliteAttemptStore, sealAttemptWorkerEvents, type SqliteAttemptStore } from '#adapters/index.js';
import { AuditApplication, QuotaReleaseApplication, PoolControlPolicyAuthorization, TaskEvaluationApplication, RunLifecycleApplication, RunReservationApplication, projectMonitorRun, projectRunView } from '#engine/index.js';
import { runSnapshotSchema, requestRunCancellation, verifyWorkerModels, mcpPrincipalRef, holdRun, type WorkerEvent, type AttemptIdentity } from '#domain/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { quotaWaitText } from '#surfaces/core/monitor/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const quotaPolicy = JSON.parse(readFileSync(new URL('../../../src/adapters/core/native-connection/internal/providers.json', import.meta.url), 'utf8')).quotaPolicy;
const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = { id: 'operator', issuer: 'fixture', subject: 'operator' };
const principal = { ...actor, assurance: 'os-user' as const, scopeIds: ['s'] };
const verifier = { async verify() { return principal; } }, authorization = { async authorize() {} };
const pin = { channelId: 'subscription-channel', modelId: 'native-model', auxiliaryModelIds: [] };
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'business criterion', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
type Variant = 'claude-rate-limit' | 'codex-text' | 'exit-text';
async function fixture(source: Variant = 'claude-rate-limit', options: { bootstrap?: { stdout: string; exitCode: number }; exit?: { code: number | null; signal: string | null; failure: string | null }; substituted?: boolean; resetsAtMs?: number | null; maxResumes?: number; maxWaitMs?: number; interrupted?: boolean; partial?: boolean; dropped?: boolean; noSeal?: boolean; recoveredSession?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-quota-')); roots.push(root); let now = 1000, sequence = 0;
  const path = join(root, 'ledger.db'), storage = { busyTimeoutMs: 100, journalMode: 'wal' as const, durability: 'full' as const };
  const store = await openSqliteAttemptStore(path, storage, { now: () => now, timeoutMs: 5000 }, 'allow', custodyProfiles); stores.push(store);
  await mkdir(join(root, 'artifacts'), { mode: 0o700 }); const artifacts = new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 65536 });
  const provider = source === 'codex-text' ? 'codex' : 'claude';
  const base = fixtureExecution(graph), execution = { ...base, tasks: base.tasks.map(task => ({ ...task, profile: { ...task.profile,
    parameters: { ...task.profile.parameters, nativeSubscription: { schemaVersion: 2, provider, model: pin, modelUsageEvidence: provider === 'claude' ? 'session-events' : 'none' } } } })) };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 4, inFlightSlots: 4 } });
  async function create(runId: string, channelId = pin.channelId, poolId = 'p') {
    const frozen = { ...execution, tasks: execution.tasks.map(task => ({ ...task, profile: { ...task.profile, parameters: { ...task.profile.parameters,
      nativeSubscription: { ...task.profile.parameters.nativeSubscription, model: { ...pin, channelId } } } } })) };
    await store.createRun({ commandId: `create-${runId}`, actor, identity: { scopeId: 's', runId, layoutRevision: 'l' }, graph, execution: frozen, now,
      policy: { schemaVersion: 2, poolId, capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['t'] } });
  }
  const reserve = new RunReservationApplication(store, verifier, authorization, authorization, { now: () => now, attemptId: () => `a-${++sequence}` });
  async function reserveRun(runId: string) {
    const run = (await store.loadRun('s', runId))!;
    return reserve.reserve({ schemaVersion: 1, scopeId: 's', runId, commandId: `reserve-${++sequence}`, expectedRevision: run.revision });
  }
  await create('r'); const first = await reserveRun('r'); const identity = first.identities[0]!;
  const evaluator = { evaluate: vi.fn(async () => 'fail' as const) };
  const app = new TaskEvaluationApplication(store, verifier, authorization, evaluator, artifacts, { maxEvidenceItems: 1, maxTotalBytes: 65536 },
    { now: () => now, timeoutMs: 5000 }, undefined, undefined, { maxResumes: options.maxResumes ?? 1, maxWaitMs: options.maxWaitMs ?? 10000 });
  async function finish(identity: AttemptIdentity, resetsAtMs: number | null = source === 'claude-rate-limit' ? options.resetsAtMs === undefined ? 6000 : options.resetsAtMs : null) {
    const claim = { request: { protocolVersion: 1 as const, identity, workspace: '/fixture', argv: ['fixture'] }, owner: 'worker' };
    await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
    const stdout = options.bootstrap?.stdout ?? JSON.stringify({ schemaVersion: 1, kind: 'native-coding-exit', ...(options.exit ?? { code: 1, signal: null, failure: 'capacity' }), outputBytes: 1 }) + '\n';
    const output = await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: options.partial ? 'partial' : 'complete', stdout, stderr: '' })));
    await store.retainDispatchOutput(claim, output); await store.finishDispatch(claim, { handle: identity.attemptId, exitCode: options.bootstrap?.exitCode ?? 1, interrupted: options.interrupted ?? false });
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
    if (options.dropped) events.push({ schemaVersion: 1, sequence: events.length + 1, atMs: 2, kind: 'dropped', reason: 'event-cap', count: 1 });
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
  // S9: an unknown reset waits at most the configured bound (maxWaitMs 10000 here), not the 24 h parking timeout.
  expect(first.snapshot.state).toMatchObject({ kind: 'parked', reason: 'quota-exhausted', since: 1000, deadline: source === 'claude-rate-limit' ? 6000 : 11000 });
  expect(first.snapshot.progress[0]!.phase).toBe('pending'); expect(f.evaluator.evaluate).not.toHaveBeenCalled();
  const attempt = (await f.store.load('s', f.identity.attemptId))!;
  expect(attempt.lastObservation?.result).toMatchObject({ kind: 'quota-exhausted', quota: { source }, evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await f.app.execute(command)).toEqual(first); expect((await f.store.loadRun('s', 'r'))!.revision).toBe(first.snapshot.revision);
  await expect(f.app.execute({ ...command, identity: { ...f.identity, generation: 2 } })).rejects.toThrow('RUN_COMMAND_CONFLICT');
  // ATAMA-0: a park is its own quota-park metric row (no Task outcome); the immutable replay writes no second row.
  const db = new DatabaseSync(f.path, { readOnly: true }); expect(db.prepare('SELECT outcome_kind FROM acceptance_metrics').all()).toEqual([{ outcome_kind: 'quota-park' }]); db.close();
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
  expect((await f.store.loadRun('s', 'r'))!.state).toMatchObject({ kind: 'parked', reason: 'quota-ask' });
});
it.skipIf(process.platform === 'win32').each([null, 999])('does not treat unknown or stale reset %s as permission to retry', async resetsAtMs => {
  const f = await fixture('claude-rate-limit', { resetsAtMs }); await f.evaluate(); f.setNow(6000);
  expect(await f.lifecycle.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' })).toBeNull(); // still inside the configured bound
  f.setNow(11000); await f.lifecycle.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' });
  const run = (await f.store.loadRun('s', 'r'))!; expect(run.state).toMatchObject({ kind: 'parked', reason: 'quota-ask' }); expect(run.progress[0]!.phase).toBe('pending'); expect(run.previousBindings).toBeUndefined();
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
  vi.spyOn(Date, 'now').mockReturnValue(1000);
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
  // Retained exit evidence still parks the Attempt if the best-effort worker quota event was lost.
  for (const exit of [
    { code: null, signal: 'SIGKILL', failure: 'capacity:quota-stop' },
    { code: null, signal: 'SIGKILL', failure: 'capacity:quota-stop-incomplete' },
    { code: 0, signal: null, failure: 'capacity:quota-stop' }, // CLI exited just before its quota group's kill; bootstrap still exits 1.
  ]) {
    const f = await fixture('exit-text', { noSeal: true, exit });
    const result = await f.evaluate();
    expect(result.snapshot.state).toMatchObject({ kind: 'parked', reason: 'quota-exhausted' });
    expect(result.snapshot.quotaWaits?.[0]).toMatchObject({ quota: { source: 'exit-text' } });
    expect((await f.store.load('s', f.identity.attemptId))!.lastObservation?.result.kind).toBe('quota-exhausted');
  }
  const dropped = await fixture('exit-text', { dropped: true, exit: { code: null, signal: 'SIGKILL', failure: 'capacity:quota-stop' } });
  expect((await dropped.evaluate()).snapshot.quotaWaits?.[0]).toMatchObject({ quota: { source: 'exit-text' } });
  const weak = await fixture('claude-rate-limit', { dropped: true, exit: { code: null, signal: 'SIGKILL', failure: 'native' } });
  expect((await weak.evaluate()).snapshot.quotaWaits).toBeUndefined();
  for (const exit of [
    { code: null, signal: 'SIGKILL', failure: 'native' },
    { code: null, signal: 'SIGKILL', failure: 'capacity' },
    { code: 0, signal: null, failure: 'capacity' },
    { code: 0, signal: null, failure: null },
  ]) {
    const f = await fixture('exit-text', { noSeal: true, exit });
    expect((await f.evaluate()).snapshot.quotaWaits).toBeUndefined();
  }

  const f = await fixture('exit-text', { noSeal: true, maxResumes: 0 }); const parked = (await f.evaluate()).snapshot;
  expect(parked.quotaWaits?.[0]).toMatchObject({ maxResumes: 0, quota: { resetsAtMs: null, source: 'exit-text' } });
  expect(runSnapshotSchema.parse(parked)).toEqual(parked); expect(projectRunView(parked).quotaWaits).toEqual([{ taskId: 't', since: 1000, deadline: 11000, resetsAtMs: null, retryLimitReached: true }]);
  expect(JSON.stringify(projectRunView(parked))).not.toContain(parked.quotaWaits![0]!.evidenceDigest);
  expect(JSON.stringify(projectRunView(parked).quotaWaits)).not.toContain(pin.channelId);
  const monitor = projectMonitorRun({ run: { snapshot: parked, poolId: 'p', admitted: true, createdAtMs: 0, attempts: [] }, approvals: [], pool: null, workers: new Map(), observedAt: 1000 });
  expect(monitor.blocker).toMatchObject({ detail: 'quota-retry-limit', deadlineMs: 11000 });
  expect(quotaWaitText(6000, false, 'tr')).toContain('bilinmiyor'); expect(quotaWaitText(6000, true, 'en')).toContain('resumes at');
  expect(quotaWaitText(6000, true, 'tr', true)).toContain('sınırına');
});

it.skipIf(process.platform !== 'linux' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('distinguishes observed quota stops from text guesses through the real bootstrap, retained output and evaluation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-bootstrap-')); roots.push(root);
  const docker = promisify(execFile), capability = 'f'.repeat(64); // Public fixture sentinel, no provider credentials.
  const setup = { schemaVersion: 1, provider: 'fixture', capabilities: { eventStream: 'claude-code-stream-json', modelUsageEvidence: 'session-events' },
    home: '.fixture', file: 'fixture.json', credential: {}, environment: {}, quotaPolicy, limits: { connections: 2, idleMs: 1000 } };
  let events: WorkerEvent[] = [];
  const gateway = createServer((request, response) => {
    expect(request.headers.authorization).toBe(capability);
    if (request.url === '/bootstrap') { response.end(JSON.stringify(setup)); return; }
    let body = ''; request.on('data', part => { body += part; });
    request.on('end', () => { events.push(...body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))); response.end('{}'); });
  });
  await writeFile(join(root, 'capability'), capability);
  await new Promise<void>(resolve => gateway.listen(join(root, 'gateway.sock'), resolve));
  try {
    for (const mode of ['killed-text', 'observed', 'incomplete', 'text-nonzero', 'success'] as const) {
      events = [];
      const quota = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }) + '\n';
      const descendant = `process.stdout.write(${JSON.stringify(quota)});setInterval(()=>{},1000);`;
      const cli = mode === 'killed-text' ? "process.stdout.write('quota calculation\\n',()=>process.kill(process.pid,'SIGKILL'));"
        : mode === 'text-nonzero' ? "console.log('quota calculation');process.exitCode=7;"
          : mode === 'success' ? "console.log('ordinary result');"
            : mode === 'observed' ? descendant
              : `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore',process.stdout,process.stderr]});setInterval(()=>{},1000);`;
      await writeFile(join(root, 'cli.cjs'), cli);
      const name = `quota-evaluation-${process.pid}-${mode}`;
      try {
        const args = ['run', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--user', `${process.getuid!()}:${process.getgid!()}`, '--pids-limit', '32', '--memory', '268435456', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16777216',
          '--mount', `type=bind,src=${fileURLToPath(new URL('../../../src/adapters/core/native-connection/internal/worker.ts', import.meta.url))},dst=/run/deckent-bootstrap.ts,readonly`,
          '--mount', `type=bind,src=${root}/gateway.sock,dst=/run/deckent-connection.sock`,
          '--mount', `type=bind,src=${root}/capability,dst=/run/deckent-bootstrap.key,readonly`,
          '--mount', `type=bind,src=${root}/cli.cjs,dst=/run/fixture-cli.cjs,readonly`,
          '--entrypoint', 'node', process.env.DECKENT_TEST_DOCKER_IMAGE!, '/run/deckent-bootstrap.ts', '/usr/local/bin/node', '/run/fixture-cli.cjs'];
        const completed = await docker('docker', args, { timeout: 10000 }).then(result => ({ ...result, exitCode: 0 }),
          (error: { stdout: string; stderr: string; code: number }) => ({ stdout: error.stdout, stderr: error.stderr, exitCode: error.code }));
        const exit = completed.stdout.trim().split('\n').map(line => JSON.parse(line)).find(record => record.kind === 'native-coding-exit');
        expect(exit, completed.stderr).toBeDefined();
        const observed = mode === 'observed' || mode === 'incomplete';
        expect(events.some(event => event.kind === 'quota-exhausted')).toBe(observed);
        expect(exit).toMatchObject(mode === 'success' ? { code: 0, signal: null, failure: null }
          : mode === 'text-nonzero' ? { code: 7, signal: null, failure: 'capacity' }
            : { code: null, signal: 'SIGKILL', failure: mode === 'killed-text' ? 'capacity' : mode === 'incomplete' ? 'capacity:quota-stop-incomplete' : 'capacity:quota-stop' });
        // No event seal: only the actual bootstrap stdout retained by dispatch can authorize the fallback.
        const f = await fixture('exit-text', { noSeal: true, bootstrap: completed }), result = await f.evaluate();
        if (observed || mode === 'text-nonzero') {
          expect(result.snapshot.state).toMatchObject({ kind: 'parked', reason: 'quota-exhausted' });
          expect((await f.store.load('s', f.identity.attemptId))!.lastObservation?.result.kind).toBe('quota-exhausted');
        } else {
          expect(result.snapshot.quotaWaits).toBeUndefined();
          expect(result.snapshot.progress[0]!.phase).toBe('failed');
          expect(f.evaluator.evaluate).toHaveBeenCalledOnce();
        }
      } finally { await docker('docker', ['rm', '-f', name], { timeout: 10000 }); }
    }
  } finally { await new Promise<void>(resolve => gateway.close(() => resolve())); }
});

it.skipIf(process.platform === 'win32')('does not recycle an earlier rejection after a successful native session and a later unrelated process failure', async () => {
  const f = await fixture('claude-rate-limit', { recoveredSession: true }); const evaluated = await f.evaluate();
  expect(evaluated.snapshot.quotaWaits).toBeUndefined(); expect(evaluated.snapshot.progress[0]!.phase).toBe('failed');
  expect(f.evaluator.evaluate).toHaveBeenCalledOnce();
});

function release(f: Awaited<ReturnType<typeof fixture>>, scopes: 'all' | string[] = 'all', mcp = false, brokenAudit = false, poolIds = ['p'], action = 'release-quota') {
  const person = mcp ? { ...principal, ...mcpPrincipalRef(principal) } : principal;
  const document = { schemaVersion: 1, revision: 'quota-policy', restrictions: [], grants: [{ id: 'owner-release-quota', effect: 'allow',
    actions: [action], scopes, principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'pool', ids: poolIds } }] };
  return new QuotaReleaseApplication({ async verify() { return person; } }, new PoolControlPolicyAuthorization({ async load() { return document; } }), f.store,
    audit => brokenAudit ? { record() { throw new Error('BROKEN_AUDIT'); } } : new AuditApplication(audit, createHmacIntegrity('quota-test', randomBytes(32))), () => 2000, 'p');
}
const releaseCommand = { schemaVersion: 1, scopeId: 's', commandId: 'release-channel', channelId: pin.channelId };
async function secondWait(f: Awaited<ReturnType<typeof fixture>>, poolId: string) {
  if (poolId !== 'p') await f.store.createExecutionPool({ schemaVersion: 1, poolId, capacity: { executionSlots: 4, inFlightSlots: 4 } });
  await f.create('second', pin.channelId, poolId);
  const identity = (await f.reserveRun('second')).identities[0]!;
  await f.finish(identity);
  return identity;
}
it.skipIf(process.platform === 'win32').each(['denied', 'allowed', 'audit'] as const)('checks every affected pool and releases atomically: %s', async variant => {
  const f = await fixture(), second = await secondWait(f, 'q');
  const beforeP = (await f.evaluate()).snapshot, beforeQ = (await f.evaluate(second)).snapshot;
  const app = release(f, 'all', false, variant === 'audit', variant === 'denied' ? ['p'] : ['p', 'q']);
  if (variant === 'allowed') {
    const receipt = await app.apply(releaseCommand);
    expect(receipt).toMatchObject({ poolId: 'p', poolIds: ['p', 'q'], released: 2 });
    for (const [runId, before] of [['r', beforeP], ['second', beforeQ]] as const) {
      const run = (await f.store.loadRun('s', runId))!;
      expect(run.revision).toBe(before.revision + 1); expect(run.state).toEqual({ kind: 'running' });
      expect(run.quotaWaits?.[0]).toMatchObject({ ...before.quotaWaits![0]!, releasedAtMs: 2000 });
      expect(run.bindings).toEqual([]); expect(run.previousBindings).toEqual(before.bindings);
    }
    expect(await app.apply(releaseCommand)).toEqual(receipt);
    // Replay must authorize the historical affected pools even though the waits have already been released.
    await expect(release(f).apply(releaseCommand)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  } else {
    await expect(app.apply({ ...releaseCommand, poolId: 'p' })).rejects.toThrow(variant === 'denied' ? 'POLICY_DENIED' : 'BROKEN_AUDIT');
    expect(await f.store.loadRun('s', 'r')).toEqual(beforeP); expect(await f.store.loadRun('s', 'second')).toEqual(beforeQ);
  }
  const db = new DatabaseSync(f.path, { readOnly: true }); try {
    const waits = db.prepare('SELECT released_at_ms FROM run_quota_waits ORDER BY run_id').all();
    expect(waits).toEqual([{ released_at_ms: variant === 'allowed' ? 2000 : null }, { released_at_ms: variant === 'allowed' ? 2000 : null }]);
    expect(db.prepare('SELECT count(*) n FROM quota_release_receipts').get()!.n).toBe(variant === 'allowed' ? 1 : 0);
    const events = db.prepare("SELECT record FROM audit_events WHERE kind='quota-release' ORDER BY sequence").all().map(row => JSON.parse(String(row.record)));
    expect(events).toHaveLength(variant === 'audit' ? 0 : variant === 'allowed' ? 2 : 1);
    for (const event of events) expect(event).toMatchObject({ mac: expect.any(String), event: { subject: { poolIds: ['p', 'q'] } } });
    if (variant === 'denied') expect(events[0].event.subject).toMatchObject({ decisionPoolId: 'q', released: null, decision: { effect: 'deny' } });
  } finally { db.close(); }
});
it.skipIf(process.platform === 'win32').each(['p', 'q'])('covers a wait added during authorization only if its pool %s is authorized', async poolId => {
  const f = await fixture(), second = await secondWait(f, poolId), beforeP = (await f.evaluate()).snapshot;
  // Publish the second sealed quota result after the advisory read, before the writer's BEGIN IMMEDIATE.
  const real = new PoolControlPolicyAuthorization({ async load() { return { schemaVersion: 1, revision: 'quota-policy', restrictions: [], grants: [{
    id: 'owner-release-quota', effect: 'allow', actions: ['release-quota'], scopes: 'all', principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'pool', ids: ['p'] } }] }; } });
  let added: Awaited<ReturnType<typeof f.evaluate>> | undefined;
  const authorization = { async decide(...args: Parameters<PoolControlPolicyAuthorization['decide']>) {
    added = await f.evaluate(second); return real.decide(...args);
  } };
  const raced = new QuotaReleaseApplication(verifier, authorization, f.store,
    audit => new AuditApplication(audit, createHmacIntegrity('quota-race', randomBytes(32))), () => 2000, 'p');
  if (poolId === 'q') {
    await expect(raced.apply(releaseCommand)).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
    expect(await f.store.loadRun('s', 'r')).toEqual(beforeP);
    const q = (await f.store.loadRun('s', 'second'))!;
    expect(q).toEqual(added!.snapshot);
    expect(q.state.kind).toBe('parked'); expect(q.bindings[0]!.identity).toEqual(second);
    expect(q.quotaWaits?.[0]?.releasedAtMs).toBeUndefined(); expect(q.previousBindings).toBeUndefined();
    const db = new DatabaseSync(f.path, { readOnly: true }); try {
      expect(db.prepare('SELECT count(*) n FROM quota_release_receipts').get()!.n).toBe(0);
      expect(db.prepare("SELECT count(*) n FROM audit_events WHERE kind='quota-release'").get()!.n).toBe(0);
      expect(db.prepare('SELECT count(*) n FROM run_quota_waits WHERE released_at_ms IS NOT NULL').get()!.n).toBe(0);
    } finally { db.close(); }
  } else {
    expect(await raced.apply(releaseCommand)).toMatchObject({ poolIds: ['p'], released: 2 });
    expect((await f.store.loadRun('s', 'r'))!.state.kind).toBe('running');
    expect((await f.store.loadRun('s', 'second'))!.state.kind).toBe('running');
  }
});
it.skipIf(process.platform === 'win32')('refuses mixed policy revisions before any Run, audit or receipt change', async () => {
  const f = await fixture(), second = await secondWait(f, 'q');
  const beforeP = (await f.evaluate()).snapshot, beforeQ = (await f.evaluate(second)).snapshot; let revision = 0;
  const authorization = new PoolControlPolicyAuthorization({ async load() { return { schemaVersion: 1, revision: `policy-${++revision}`, restrictions: [], grants: [{
    id: 'owner-release-quota', effect: 'allow', actions: ['release-quota'], scopes: 'all', principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'pool', ids: ['p', 'q'] } }] }; } });
  const app = new QuotaReleaseApplication(verifier, authorization, f.store,
    audit => new AuditApplication(audit, createHmacIntegrity('quota-revision', randomBytes(32))), () => 2000, 'p');
  await expect(app.apply(releaseCommand)).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
  expect(await f.store.loadRun('s', 'r')).toEqual(beforeP); expect(await f.store.loadRun('s', 'second')).toEqual(beforeQ);
  const db = new DatabaseSync(f.path, { readOnly: true }); try {
    expect(db.prepare('SELECT count(*) n FROM quota_release_receipts').get()!.n).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM audit_events WHERE kind='quota-release'").get()!.n).toBe(0);
  } finally { db.close(); }
});
it.skipIf(process.platform === 'win32')('does not guess historical receipt authority from current waits', async () => {
  const f = await fixture(); await f.evaluate(); const app = release(f); await app.apply(releaseCommand);
  const before = await f.store.loadRun('s', 'r'), db = new DatabaseSync(f.path);
  try {
    const row = db.prepare('SELECT record FROM quota_release_receipts').get()!, record = JSON.parse(String(row.record));
    delete record.receipt.poolIds;
    db.prepare('UPDATE quota_release_receipts SET record=?').run(JSON.stringify(record));
    const retained = db.prepare('SELECT record FROM quota_release_receipts').get();
    await expect(app.apply(releaseCommand)).rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
    expect(await f.store.loadRun('s', 'r')).toEqual(before);
    expect(db.prepare('SELECT record FROM quota_release_receipts').get()).toEqual(retained);
    expect(db.prepare("SELECT count(*) n FROM audit_events WHERE kind='quota-release'").get()!.n).toBe(1);
  } finally { db.close(); }
});
it.skipIf(process.platform === 'win32').each(['codex-text', 'exit-text', 'unknown', 'bounded'] as const)('does not hold any other Run for weak/invalid signal %s', async variant => {
  const f = await fixture(variant === 'unknown' || variant === 'bounded' ? 'claude-rate-limit' : variant,
    variant === 'unknown' ? { resetsAtMs: null } : variant === 'bounded' ? { resetsAtMs: 50000, maxWaitMs: 10000 } : {});
  const parked = (await f.evaluate()).snapshot;
  await f.create('waiting'); expect((await f.reserveRun('waiting')).identities).toHaveLength(1);
  // S9: a reset beyond the bound asks the person at once; every other weak signal waits the bound and then asks. None cancels.
  expect(parked.state).toMatchObject(variant === 'bounded' ? { kind: 'parked', reason: 'quota-ask' } : { kind: 'parked', reason: 'quota-exhausted', deadline: 11000 });
  if (variant === 'bounded') {
    expect(parked.quotaWaits?.[0]).toMatchObject({ resetBoundExceeded: true, quota: { resetsAtMs: 50000 } });
    expect((await f.store.load('s', f.identity.attemptId))!.lastObservation?.result).toMatchObject({ resetBoundExceeded: true });
  }
  f.setNow(11000); await f.lifecycle.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' });
  const after = (await f.store.loadRun('s', 'r'))!;
  expect(after.state).toMatchObject({ kind: 'parked', reason: 'quota-ask' }); expect(after.progress[0]!.phase).toBe('pending');
});
it.skipIf(process.platform === 'win32')('owner release re-enables own and other reservations, retains reset evidence, seals audit and cannot replay over a later hold', async () => {
  const f = await fixture(); const before = (await f.evaluate()).snapshot; await f.create('waiting');
  await expect(f.reserveRun('waiting')).rejects.toThrow('RUN_CAPACITY_OR_ORDER');
  const app = release(f), receipt = await app.apply(releaseCommand); expect(receipt).toMatchObject({ released: 1, atMs: 2000 });
  const resumed = (await f.store.loadRun('s', 'r'))!;
  expect(resumed.state).toEqual({ kind: 'running' }); expect(resumed.quotaWaits?.[0]).toMatchObject({ ...before.quotaWaits![0]!, releasedAtMs: 2000 });
  expect(resumed.previousBindings?.[0]?.identity).toEqual(f.identity); expect((await f.reserveRun('waiting')).identities).toHaveLength(1);
  const second = (await f.reserveRun('r')).identities[0]!; expect(second.generation).toBe(2);
  await f.finish(second); await f.evaluate(second);
  expect(await app.apply(releaseCommand)).toEqual(receipt);
  expect((await f.store.loadRun('s', 'r'))!.state.kind).toBe('parked');
  await expect(app.apply({ ...releaseCommand, channelId: 'different' })).rejects.toThrow('RUN_COMMAND_CONFLICT');
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    const rows = db.prepare("SELECT record FROM audit_events WHERE kind='quota-release'").all(); expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]!.record))).toMatchObject({ mac: expect.any(String), event: { subject: { released: 1, decision: { effect: 'allow', ruleId: 'owner-release-quota' } } } });
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT since_ms,deadline_ms FROM run_quota_waits WHERE channel_id=? AND deadline_ms>? AND released_at_ms IS NULL AND channel_held=1 ORDER BY deadline_ms DESC LIMIT 1").all(pin.channelId, 1000);
    expect(JSON.stringify(plan)).toContain('run_quota_waits_channel'); expect(JSON.stringify(plan)).not.toContain('SCAN runs');
  } finally { db.close(); }
});
it.skipIf(process.platform === 'win32').each(['scoped', 'mcp', 'audit', 'resume-only'] as const)('refuses %s release without changing the wait, revision or receipt', async variant => {
  const f = await fixture(); const before = (await f.evaluate()).snapshot;
  await expect(release(f, variant === 'scoped' ? ['s'] : 'all', variant === 'mcp', variant === 'audit', ['p'], variant === 'resume-only' ? 'resume' : 'release-quota').apply(releaseCommand)).rejects.toThrow(variant === 'audit' ? 'BROKEN_AUDIT' : 'POLICY_DENIED');
  expect(await f.store.loadRun('s', 'r')).toEqual(before);
  const db = new DatabaseSync(f.path, { readOnly: true }); try {
    expect(db.prepare('SELECT count(*) n FROM quota_release_receipts').get()!.n).toBe(0);
    const events = db.prepare("SELECT record FROM audit_events WHERE kind='quota-release'").all(); expect(events).toHaveLength(variant === 'audit' ? 0 : 1);
    if (events[0]) expect(JSON.parse(String(events[0].record)).event.subject).toMatchObject({ released: null, decision: { effect: 'deny' } });
  } finally { db.close(); }
});
it.skipIf(process.platform === 'win32')('release keeps cancelled Runs terminal and operator-held Runs held', async () => {
  const f = await fixture(); const parked = (await f.evaluate()).snapshot;
  await f.store.cancelRun({ commandId: 'cancel', actor, scopeId: 's', runId: 'r', expectedRevision: parked.revision });
  await release(f).apply(releaseCommand); expect((await f.store.loadRun('s', 'r'))!.state).toMatchObject({ kind: 'terminal', outcome: 'cancelled' });
  await f.create('waiting'); expect((await f.reserveRun('waiting')).identities).toHaveLength(1);
  const g = await fixture(); const quota = (await g.evaluate()).snapshot;
  const held = holdRun(quota, quota.revision, 'manual intervention', 1500, 10000);
  const db = new DatabaseSync(g.path); try { db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=?').run(held.revision, JSON.stringify(held), 's', 'r'); } finally { db.close(); }
  const heldState = held.state; if (heldState.kind !== 'parked') throw new Error('FIXTURE_HOLD_REQUIRED');
  await release(g).apply(releaseCommand); expect((await g.store.loadRun('s', 'r'))!.state).toEqual({
    kind: 'parked', reason: 'operator-hold', note: 'manual intervention', since: heldState.since, deadline: heldState.deadline });
  expect((await g.store.loadRun('s', 'r'))!.bindings).toEqual([]);
});
it.skipIf(process.platform === 'win32')('inspect uses current time and omits expired channel holds', async () => {
  const f = await fixture(); await f.evaluate(); await f.create('waiting');
  vi.spyOn(Date, 'now').mockReturnValue(6000);
  const evidence = await inventoryReadsPerCall(async () => f.path, { busyTimeoutMs: 100 }).loadRunPoolEvidence('s', 'waiting'); expect(evidence.quotaHolds).toEqual([]);
});
it.each(['en', 'tr'] as const)('shows dates for distant resets and the release command in %s', locale => {
  const now = new Date(2026, 9, 13, 10).getTime(), deadline = now + 48 * 60 * 60 * 1000;
  expect(quotaWaitText(deadline, true, locale, false, now)).toContain('2026-10-15');
  expect(quotaWaitText(deadline, false, locale, false, now)).toContain('quota-release --channel');
  expect(quotaWaitText(now + 60 * 60 * 1000, true, locale, false, now)).not.toContain('2026-10-13');
});
