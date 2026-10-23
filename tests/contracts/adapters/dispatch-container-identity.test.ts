import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DockerSupervisor, FileArtifactStore, openSqliteAttemptStore, validateDockerSupervisorProfile, type SqliteAttemptStore } from '#adapters/index.js';
import { AuditApplication, DispatchApplication, dispatchNeedsObservation, dispatchRecordSchema, encodeLostDispatchWrite, measureTaskOccupancy,
  type ExecutionSupervisor, type SandboxRequest, type SupervisorLaunchHooks } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyPrincipal, custodyProfile, custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

// S6R-1 (design §2 F5, §7 step 2): the created container id is durable before `start`, the full incarnation (id + StartedAt) follows at the
// first `running` observation and must be that same container, and a cancellation on a fenced dispatch never settles it as a clean exit.
const stores: SqliteAttemptStore[] = [], roots: string[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const }, timing = { now: () => 10, timeoutMs: 1000 };
const created = 'c'.repeat(64), other = 'd'.repeat(64);
const incarnation = (id = created) => ({ kind: 'container' as const, id, startedAt: '2026-10-23T03:16:25.075503723Z' });
async function fixture(grant = true, claimed = true) {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-container-')); roots.push(root);
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), options, timing, 'allow', custodyProfiles); stores.push(store);
  const identity = { scopeId: 's', runId: 'run', taskId: 'task', attemptId: 'attempt', layoutRevision: 'layout', generation: 1 };
  await admitRunAttempts(store, [identity]);
  const claim = { request: { protocolVersion: 1 as const, identity, workspace: root, argv: ['fixture'] }, owner: 'owner' };
  if (claimed) await store.claimDispatch(dispatchAdmission(claim)); if (claimed && grant) await grantTestLaunch(store, claim);
  return { root, store, claim, identity };
}
async function fence(f: Awaited<ReturnType<typeof fixture>>) {
  const current = (await f.store.load('s', 'attempt'))!, run = (await f.store.loadRun('s', 'run'))!;
  const { write, commandId, command } = encodeLostDispatchWrite({ schemaVersion: 1, identity: f.identity, owner: f.claim.owner, actor: custodyPrincipal,
    expectedRunRevision: run.revision, expectedAttemptRevision: current.revision, now: 10, reasonCode: 'WORKER_LOST' });
  await f.store.fenceLostDispatch(write, (audit, snapshot) => new AuditApplication(audit, createHmacIntegrity('fixture', Buffer.alloc(32, 7))).record({ schemaVersion: 1,
    eventId: commandId, scopeId: 's', principal: { issuer: write.actor.issuer, subject: write.actor.subject }, policyRevision: 'fixture-policy', atMs: write.now,
    subject: { kind: 'run-lifecycle', action: 'hold', runId: 'run', taskId: 'task', commandId, revision: snapshot.revision, evidence: null,
      inputDigest: createHash('sha256').update(command).digest('hex') } }));
}

it('retains the created container id once per granted dispatch; a different id is a conflict', async () => {
  const f = await fixture();
  expect((await f.store.retainDispatchContainer(f.claim, created)).containerId).toBe(created);
  expect((await f.store.retainDispatchContainer(f.claim, created)).containerId).toBe(created);
  await expect(f.store.retainDispatchContainer(f.claim, other)).rejects.toMatchObject({ code: 'DISPATCH_CONFLICT' });
  await expect(f.store.retainDispatchContainer({ ...f.claim, owner: 'stranger' }, created)).rejects.toMatchObject({ code: 'DISPATCH_CONFLICT' });
  expect((await f.store.readDispatch(f.claim.request))!.containerId).toBe(created);
});

it('refuses a container id before the launch grant and on a fenced dispatch', async () => {
  const pending = await fixture(false);
  await expect(pending.store.retainDispatchContainer(pending.claim, created)).rejects.toMatchObject({ code: 'DISPATCH_CONFLICT' });
  const fenced = await fixture(); await fence(fenced);
  await expect(fenced.store.retainDispatchContainer(fenced.claim, created)).rejects.toMatchObject({ code: 'DISPATCH_FENCED' });
  expect((await fenced.store.readDispatch(fenced.claim.request))!.containerId).toBeUndefined();
});

it('accepts only the incarnation of the created container (id match), in either order', async () => {
  const f = await fixture();
  await f.store.retainDispatchContainer(f.claim, created);
  await expect(f.store.retainDispatchWorker(f.claim, incarnation(other))).rejects.toMatchObject({ code: 'DISPATCH_CONFLICT' });
  expect((await f.store.retainDispatchWorker(f.claim, incarnation())).worker).toEqual(incarnation());
  const g = await fixture();
  await g.store.retainDispatchWorker(g.claim, incarnation());
  await expect(g.store.retainDispatchContainer(g.claim, other)).rejects.toMatchObject({ code: 'DISPATCH_CONFLICT' });
  expect((await g.store.retainDispatchContainer(g.claim, created)).containerId).toBe(created);
});

it('keeps the record invariant in the schema: container id only after a grant, never a different worker id, and older records without it still parse', async () => {
  const f = await fixture(); const granted = (await f.store.readDispatch(f.claim.request))!;
  expect(dispatchRecordSchema.parse(granted)).not.toHaveProperty('containerId');
  expect(dispatchRecordSchema.safeParse({ ...granted, containerId: created, worker: incarnation(other) }).success).toBe(false);
  expect(dispatchRecordSchema.safeParse({ ...granted, containerId: 'C'.repeat(64) }).success).toBe(false);
  const unGranted = await fixture(false), pending = (await unGranted.store.readDispatch(unGranted.claim.request))!;
  expect(dispatchRecordSchema.safeParse({ ...pending, containerId: created }).success).toBe(false);
});

/** A test supervisor: `created` fires the application's hook the way the Docker adapter does after `create`, before any start. */
function supervisor(behaviour: { exit?: boolean; started: string[] }): ExecutionSupervisor & { captureProfile(): Promise<typeof custodyProfile> } {
  const result = (request: SandboxRequest) => ({ handle: `h-${request.identity.attemptId}`, result: behaviour.exit === false ? { kind: 'unknown' as const, reasonCode: 'SUPERVISOR_OUTCOME_UNRESOLVED' } : { kind: 'exited' as const, exitCode: 0 } });
  return { async captureProfile() { return custodyProfile; },
    async execute(request: SandboxRequest, _signal?: AbortSignal, hooks?: SupervisorLaunchHooks) {
      await hooks?.created(created); behaviour.started.push(request.identity.attemptId);
      return { ...result(request), stdout: '', stderr: '', interrupted: false, outputCompleteness: 'complete' as const };
    },
    async cancel(request) { return result(request); }, async observe(request) { return result(request); },
    async recoverOutput() { return { stdout: '', stderr: '', completeness: 'partial' as const }; }, async release() { return 'absent' as const; } };
}
const verifier = { async verify() { return custodyPrincipal; } }, authorization = { async authorize() {} };

it('makes the created container id durable through the application before the worker starts', async () => {
  const f = await fixture(false, false); await mkdir(join(f.root, 'artifacts'));
  const artifacts = new FileArtifactStore({ root: join(f.root, 'artifacts'), maxBytes: 65536 }), behaviour = { exit: false, started: [] as string[] };
  const outcome = await new DispatchApplication(f.store, supervisor(behaviour), verifier, authorization, 'owner', artifacts).execute(f.claim.request);
  expect(outcome.kind).toBe('unresolved'); expect(behaviour.started).toEqual(['attempt']);
  expect((await f.store.readDispatch(f.claim.request))!.containerId).toBe(created);
});

it('cancelling a fenced dispatch issues the stop but never settles it: the late exit is refused, the Attempt stays unknown and the slot held', async () => {
  const f = await fixture(); await fence(f); await mkdir(join(f.root, 'artifacts'));
  const before = (await f.store.load('s', 'attempt'))!;
  const artifacts = new FileArtifactStore({ root: join(f.root, 'artifacts'), maxBytes: 65536 });
  // The cancellation intent passes the fence (the cancellation actor may stop a fenced worker) ...
  expect((await f.store.requestDispatchCancellation(f.claim.request, custodyPrincipal)).cancellation).toMatchObject({ id: custodyPrincipal.id });
  // ... but the induced exit cannot close the task around the gate (S6R-3 must treat this refusal as "stop issued, proof pending").
  await expect(new DispatchApplication(f.store, supervisor({ started: [] }), verifier, authorization, 'owner', artifacts).cancel(f.claim.request))
    .rejects.toMatchObject({ code: 'DISPATCH_FENCED' });
  expect((await f.store.readDispatch(f.claim.request))!.terminal).toBeNull();
  expect((await f.store.load('s', 'attempt'))!.lastObservation).toEqual(before.lastObservation);
  const run = (await f.store.loadRun('s', 'run'))!;
  expect(run.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  expect(measureTaskOccupancy(run.progress)).toEqual({ execution: 1, inFlight: 1 });
});

it('asks for an observation of a granted live dispatch only while its terminal or its first incarnation is missing', () => {
  const base = { launch: 'granted' as const, terminal: null };
  expect(dispatchNeedsObservation('exited', base)).toBe(true);
  expect(dispatchNeedsObservation('running', base)).toBe(true);
  expect(dispatchNeedsObservation('paused', base)).toBe(true);
  expect(dispatchNeedsObservation('running', { ...base, worker: incarnation() })).toBe(false);
  expect(dispatchNeedsObservation('exited', { ...base, worker: incarnation() })).toBe(true);
  for (const state of ['created', 'missing', 'unknown'] as const) expect(dispatchNeedsObservation(state, base)).toBe(false);
  expect(dispatchNeedsObservation('running', { ...base, launch: 'pending' })).toBe(false);
  expect(dispatchNeedsObservation('exited', { ...base, terminal: { handle: 'h', exitCode: 0, interrupted: null } })).toBe(false);
});

/** Real Docker: the id retained at `create` is the container that ran, and the first running sample retains its incarnation (the
 * heartbeat's `dispatchNeedsObservation` → `reconcile` path) while `start --attach` is still waiting. */
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
it.skipIf(!imageId)('Docker: retains the created id before start and the running incarnation before the worker exits', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dispatch-container-docker-'))); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace); await mkdir(join(root, 'artifacts'), { mode: 0o700 });
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), options, { now: Date.now, timeoutMs: 86400000 }, 'allow', { validate: validateDockerSupervisorProfile }); stores.push(store);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: randomUUID(), generation: 1, layoutRevision: 'layout' };
  await admitRunAttempts(store, [identity]);
  const request = { protocolVersion: 1 as const, identity, workspace, argv: ['node', '-e', 'setTimeout(() => {}, 4000)'] }, os = userInfo();
  const docker = new DockerSupervisor({ executable: '/usr/bin/docker', imageId: imageId!, workspaceRoot: root, uid: os.uid, gid: os.gid, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 30_000, controlTimeoutMs: 10_000, outputBytes: 65_536 });
  const app = new DispatchApplication(store, docker, verifier, authorization, 'runner', new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 1_048_576 }));
  const execution = app.execute(request);
  try {
    let sampled = false;
    for (let i = 0; i < 100 && !sampled; i++) {
      const record = await store.readDispatch(request), activity = await docker.inspectActivity(request);
      if (record && dispatchNeedsObservation(activity.state, record) && activity.state === 'running') { await app.reconcile(request); sampled = true; }
      else await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(sampled).toBe(true);
    const live = (await store.readDispatch(request))!;
    expect(live.terminal).toBeNull(); expect(live.containerId).toMatch(/^[a-f0-9]{64}$/); expect(live.worker?.id).toBe(live.containerId);
    expect(dispatchNeedsObservation('running', live)).toBe(false);
    const outcome = await execution;
    expect(outcome.kind).toBe('terminal'); expect(outcome.record.containerId).toBe(live.containerId); expect(outcome.record.worker).toEqual(live.worker);
  } finally { await execution.catch(() => undefined); await app.release(request).catch(() => undefined); }
}, 60_000);
