import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { userInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerSupervisor, FileArtifactStore, openSqliteAttemptStore, runNodeDockerCommand,
  validateDockerSupervisorProfile, type SqliteAttemptStore } from '#adapters/index.js';
import type { DockerCommand } from '#adapters/index.js';
import { DispatchApplication, RunApplication, type DispatchStore } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const principal = { id: 'operator', issuer: 'test', subject: 'fixture', assurance: 'os-user' as const, scopeIds: ['s'] };
const verifier = { async verify() { return principal; } }; const authorization = { async authorize() {} };
async function reachedWithin(reached: Promise<void>) {
  await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('LAUNCH_RACE_BARRIER_TIMEOUT')), 10_000))]);
}
async function setup(barrier: 'create' | 'start' | null) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-launch-race-')); roots.push(root);
  const workspace = join(root, 'workspace'); const artifactsRoot = join(root, 'artifacts'); await mkdir(workspace); await mkdir(artifactsRoot);
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, 'allow',
    { validate: validateDockerSupervisorProfile }); stores.push(store);
  const identity = { runId: 'r', taskId: 't', attemptId: randomUUID(), scopeId: 's', generation: 1, layoutRevision: 'layout' };
  await admitRunAttempts(store, [identity]);
  const request = { protocolVersion: 1 as const, identity, workspace,
    argv: ['node', '-e', "require('node:fs').writeFileSync('/workspace/effect','effect-after-grant')"] };
  let releaseBarrier!: () => void; let announceBarrier!: () => void; let released = false;
  const reached = new Promise<void>(resolve => { announceBarrier = resolve; });
  const hold = new Promise<void>(resolve => { releaseBarrier = () => { released = true; resolve(); }; });
  const commands: string[] = [];
  const runner = async (command: DockerCommand, signal?: AbortSignal) => {
    commands.push(command.args[0]!);
    if (barrier && command.args[0] === barrier && !released) { announceBarrier(); await hold; }
    return runNodeDockerCommand(command, signal);
  };
  const os = userInfo();
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', imageId: imageId!, workspaceRoot: root, uid: os.uid, gid: os.gid,
    memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
    deadlineMs: 20_000, controlTimeoutMs: 10_000, outputBytes: 65_536 }, runner);
  const artifacts = new FileArtifactStore({ root: artifactsRoot, maxBytes: 1_048_576 });
  const run = new RunApplication(store, verifier, authorization);
  const cancelRun = () => run.execute({ schemaVersion: 1, action: 'cancel', commandId: 'cancel', scopeId: 's', runId: 'r', expectedRevision: 1 });
  const cancellation = new DispatchApplication(store, supervisor, verifier, authorization, 'cancellation', artifacts);
  return { root, workspace, store, request, supervisor, artifacts, reached, releaseBarrier, commands, cancelRun, cancellation };
}

describe.skipIf(!imageId)('atomic launch and cancellation barriers with real Docker', () => {
  it('prevents execution when durable Run cancellation wins after claim but before grant', async () => {
    const f = await setup(null); let releaseGrant!: () => void;
    const reachedGrant = new Promise<void>(resolve => { releaseGrant = resolve; });
    let continueGrant!: () => void; const grantGate = new Promise<void>(resolve => { continueGrant = resolve; });
    const gated: DispatchStore = {
      claimDispatch: f.store.claimDispatch.bind(f.store), readDispatch: f.store.readDispatch.bind(f.store),
      requestDispatchCancellation: f.store.requestDispatchCancellation.bind(f.store), retainDispatchOutput: f.store.retainDispatchOutput.bind(f.store),
      finishDispatch: f.store.finishDispatch.bind(f.store),
      async grantLaunch(input) { releaseGrant(); await grantGate; return f.store.grantLaunch(input); },
    };
    const execution = new DispatchApplication(gated, f.supervisor, verifier, authorization, 'runner', f.artifacts).execute(f.request);
    try {
      await reachedWithin(reachedGrant); const cancelled = await f.cancelRun();
      expect(cancelled.snapshot.cancelRequested).toBe(true); continueGrant();
      const outcome = await execution; expect(outcome.kind).toBe('prevented');
      expect(outcome.record).toMatchObject({ launch: 'prevented-before-launch', prevention: { reason: 'cancel-requested' } });
      expect(f.commands).not.toContain('create'); expect(f.commands).not.toContain('start');
      await expect(readFile(join(f.workspace, 'effect'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await f.store.loadRun('s', 'r'))!.progress[0]!.phase).toBe('cancelled');
    } finally {
      continueGrant(); await execution.catch(() => {}); await f.supervisor.cancel(f.request).catch(() => {}); await f.supervisor.release(f.request).catch(() => {});
    }
  }, 30_000);

  it.each(['create', 'start'] as const)('records cancellation after grant at the Docker %s barrier without claiming no effect', async barrier => {
    const f = await setup(barrier);
    const execution = new DispatchApplication(f.store, f.supervisor, verifier, authorization, 'runner', f.artifacts).execute(f.request);
    try {
      await reachedWithin(f.reached);
      expect((await f.store.readDispatch(f.request))!).toMatchObject({ launch: 'granted', grant: { generation: 1, principal: { id: 'operator' } } });
      const cancelledRun = await f.cancelRun(); expect(cancelledRun.snapshot.cancelRequested).toBe(true);
      const delivery = await f.cancellation.cancel(f.request); expect(delivery.kind).toBe('unresolved');
      expect((await f.store.load('s', f.request.identity.attemptId))!.cancelRequested).toBe(true);
      f.releaseBarrier(); const completed = await execution; expect(completed.kind).toBe('terminal');
      const effect = await readFile(join(f.workspace, 'effect'), 'utf8').then(() => 'observed-after-grant' as const,
        () => 'not-observed-after-grant' as const);
      expect(effect).toBe('observed-after-grant');
      expect((await f.store.readDispatch(f.request))!).toMatchObject({ launch: 'granted', cancellation: { id: 'operator' }, terminal: {} });
    } finally {
      f.releaseBarrier(); await execution.catch(() => {}); await f.supervisor.cancel(f.request).catch(() => {}); await f.supervisor.release(f.request).catch(() => {});
    }
  }, 30_000);
});
