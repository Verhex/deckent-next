import { RunApplication, RunCancellationCoordinator, PolicyAuthorizationError } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore, DockerSupervisor, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { DispatchApplication, type ExecutionSupervisor } from '#engine/index.js';
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
const verifier = { async verify() { return { id: 'user', issuer: 'test', subject: 'user', assurance: 'os-user', scopeIds: ['s'] }; } };
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-dispatch-app-')); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }); stores.push(store);
  const identity = { runId: 'r', taskId: 't', attemptId: randomUUID(), scopeId: 's', generation: 1, layoutRevision: 'l' };
  const request = { protocolVersion: 1 as const, identity, workspace, argv: ['node', '-e', "require('node:fs').appendFileSync('/workspace/result','once')"] };
  await admitRunAttempts(store, [identity]);
  const artifactRoot = join(root, 'artifacts'); await mkdir(artifactRoot, { mode: 0o700 });
  const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: 1048576 });
  return { root, workspace, store, request, artifacts };
}
it.skipIf(!imageId)('returns durable terminal after real Docker release without executing twice; replay still requires authorization', async () => {
  const f = await fixture(); let denied = false; let authorizations = 0;
  const policy = { async authorize() { authorizations++; if (denied) throw new Error('DENIED'); } };
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: f.root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
    logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 });
  const app = new DispatchApplication(f.store, supervisor, verifier, policy, 'process-1', f.artifacts);
  try {
    const first = await app.execute(f.request); expect(first.kind).toBe('terminal'); expect(first.record.terminal?.exitCode).toBe(0);
    expect((await f.store.load('s', f.request.identity.attemptId))?.lastObservation?.result).toEqual({ kind: 'exited', exitCode: 0 });
    await app.release(f.request);
    await expect(promisify(execFile)('/usr/bin/docker', ['inspect', first.record.terminal!.handle])).rejects.toMatchObject({ stderr: expect.stringMatching(/no such object/i) });
    const restarted = new DispatchApplication(f.store, supervisor, verifier, policy, 'process-2', f.artifacts);
    expect(await restarted.execute(f.request)).toEqual(first);
    expect(await readFile(join(f.workspace, 'result'), 'utf8')).toBe('once');
    denied = true; await expect(restarted.execute(f.request)).rejects.toThrow('DENIED');
    expect(authorizations).toBe(4);
  } finally { await supervisor.release(f.request); }
});
it('never retries an unknown launch and refuses release without terminal evidence', async () => {
  const f = await fixture(); let calls = 0;
  const supervisor: ExecutionSupervisor = { async cancel() { throw new Error('not cancelled'); }, async recoverOutput() { throw new Error('not recovered'); }, async observe() { throw new Error('not observed'); }, async execute() { calls++; throw new Error('transport interrupted'); }, async release() { throw new Error('must not release'); } };
  const app = new DispatchApplication(f.store, supervisor, verifier, { async authorize() {} }, 'p', f.artifacts);
  await expect(app.release(f.request)).rejects.toThrow('DISPATCH_NOT_ADMITTED');
  expect(await f.store.readDispatch(f.request)).toBeNull();
  await expect(app.execute(f.request)).rejects.toThrow('transport interrupted');
  expect((await app.execute(f.request)).kind).toBe('unresolved'); expect(calls).toBe(1);
  await expect(app.release(f.request)).rejects.toThrow('DISPATCH_NOT_ADMITTED');
});
it.skipIf(!imageId)('reconciles real terminal container after failed journal write without granting a new launch', async () => {
  const f = await fixture(); let denied = false;
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: f.root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
    logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 });
  const policy = { async authorize() { if (denied) throw new Error('DENIED'); } };
  const failingStore = { requestDispatchCancellation: f.store.requestDispatchCancellation.bind(f.store), retainDispatchOutput: f.store.retainDispatchOutput.bind(f.store), claimDispatch: f.store.claimDispatch.bind(f.store), readDispatch: f.store.readDispatch.bind(f.store),
    async finishDispatch(): Promise<never> { throw new Error('injected terminal write failure'); } };
  const first = new DispatchApplication(failingStore, supervisor, verifier, policy, 'process-lost', f.artifacts);
  try {
    await expect(first.execute(f.request)).rejects.toThrow('injected terminal write failure');
    expect((await f.store.readDispatch(f.request))?.terminal).toBeNull();
    const recovery = new DispatchApplication(f.store, supervisor, verifier, policy, 'process-recovery', f.artifacts);
    denied = true; await expect(recovery.reconcile(f.request)).rejects.toThrow('DENIED'); denied = false;
    const recovered = await recovery.reconcile(f.request);
    expect(recovered.kind).toBe('terminal'); expect(recovered.record.terminal).toMatchObject({ exitCode: 0, interrupted: null });
    expect(recovered.record.owner).toBe('process-lost');
    await recovery.release(f.request);
    expect(await recovery.execute(f.request)).toEqual(recovered);
    expect(await readFile(join(f.workspace, 'result'), 'utf8')).toBe('once');
  } finally { await supervisor.release(f.request); }
});
it.skipIf(!imageId)('observes an absent container without creating or starting it; unclaimed recovery stays read-only', async () => {
  const f = await fixture();
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: f.root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
    logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 });
  const app = new DispatchApplication(f.store, supervisor, verifier, { async authorize() {} }, 'recovery', f.artifacts);
  await expect(app.reconcile(f.request)).rejects.toThrow('DISPATCH_NOT_ADMITTED');
  expect(await f.store.readDispatch(f.request)).toBeNull();
  await f.store.claimDispatch({ request: f.request, owner: 'lost' });
  expect((await app.reconcile(f.request)).kind).toBe('unresolved');
  expect((await supervisor.observe(f.request)).result.kind).toBe('unknown');
  await expect(readFile(join(f.workspace, 'result'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('carries a real subprocess signal exit through dispatch and atomic Attempt projection', async () => {
  const f = await fixture();
  const supervisor: ExecutionSupervisor = {
    async execute() {
      const child = spawn(process.execPath, ['-e', 'process.kill(process.pid,"SIGTERM")'], { stdio: 'ignore' });
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      if (result.code !== null || result.signal !== 'SIGTERM') throw new Error('expected real signal exit');
      return { handle: 'native-test', result: { kind: 'exited', exitCode: result.code, signal: result.signal }, stdout: '', stderr: '', interrupted: false, outputCompleteness: 'complete' };
    },
    async cancel() { throw new Error('not cancelled'); }, async recoverOutput() { throw new Error('not recovered'); }, async observe() { throw new Error('not observed'); }, async release() {},
  };
  const app = new DispatchApplication(f.store, supervisor, verifier, { async authorize() {} }, 'native-test', f.artifacts);
  const result = await app.execute(f.request);
  expect(result.record.terminal).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
  expect((await f.store.load('s', f.request.identity.attemptId))?.lastObservation?.result).toEqual({ kind: 'exited', exitCode: null, signal: 'SIGTERM' });
});
it.skipIf(!imageId)('allows real execute and reconcile to race on the same completed container without duplicate transition', async () => {
  const f = await fixture();
  const docker = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: f.root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
    logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 });
  let arrived!: () => void; let release!: () => void;
  const atTerminal = new Promise<void>(resolve => { arrived = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const delayed: ExecutionSupervisor = { cancel: docker.cancel.bind(docker), recoverOutput: docker.recoverOutput.bind(docker), observe: docker.observe.bind(docker), release: docker.release.bind(docker),
    async execute(request, signal) { const result = await docker.execute(request, signal); arrived(); await proceed; return result; } };
  const policy = { async authorize() {} };
  const runner = new DispatchApplication(f.store, delayed, verifier, policy, 'original', f.artifacts);
  const recovery = new DispatchApplication(f.store, docker, verifier, policy, 'recovery', f.artifacts);
  const execution = runner.execute(f.request);
  try {
    await Promise.race([atTerminal, execution.then(() => { throw new Error('unexpected early return'); })]);
    expect((await recovery.reconcile(f.request)).record.terminal?.interrupted).toBeNull();
    const snapshot = await f.store.load('s', f.request.identity.attemptId);
    release(); expect((await execution).record.terminal?.interrupted).toBe(false);
    expect(await f.store.load('s', f.request.identity.attemptId)).toEqual(snapshot);
    expect(await readFile(join(f.workspace, 'result'), 'utf8')).toBe('once');
  } finally { release(); await execution.catch(() => {}); await docker.release(f.request); }
});
it('refuses cleanup if retained output is unreadable or partial despite terminal execution', async () => {
  const f = await fixture(); let releases = 0; let corrupt = false;
  const supervisor: ExecutionSupervisor = { async execute() { return { handle: 'test', result: { kind: 'exited', exitCode: 0 }, stdout: 'kept', stderr: '', interrupted: false, outputCompleteness: 'complete' }; },
    async cancel() { throw new Error('not cancelled'); }, async recoverOutput() { throw new Error('not recovered'); }, async observe() { throw new Error('not observed'); }, async release() { releases++; } };
  const artifacts = { put: f.artifacts.put.bind(f.artifacts), async read(scope: string, receipt: Parameters<typeof f.artifacts.read>[1]) {
    if (corrupt) throw new Error('ARTIFACT_CORRUPT'); return f.artifacts.read(scope, receipt);
  } };
  const app = new DispatchApplication(f.store, supervisor, verifier, { async authorize() {} }, 'p', artifacts);
  const result = await app.execute(f.request);
  expect(result.record.output?.scopeId).toBe('s');
  const stored = JSON.parse(new TextDecoder().decode(await f.artifacts.read('s', result.record.output!)));
  expect(stored).toMatchObject({ completeness: 'complete', stdout: 'kept', identity: f.request.identity });
  corrupt = true; await expect(app.release(f.request)).rejects.toThrow('ARTIFACT_CORRUPT'); expect(releases).toBe(0);
  corrupt = false; await app.release(f.request); expect(releases).toBe(1);
});
it('retains partial output honestly and blocks destructive cleanup', async () => {
  const f = await fixture(); let releases = 0;
  const supervisor: ExecutionSupervisor = { async execute() { return { handle: 'test', result: { kind: 'exited', exitCode: 137 }, stdout: 'partial', stderr: '', interrupted: true, outputCompleteness: 'partial' }; },
    async cancel() { throw new Error('not cancelled'); }, async recoverOutput() { throw new Error('not recovered'); }, async observe() { throw new Error('not observed'); }, async release() { releases++; } };
  const app = new DispatchApplication(f.store, supervisor, verifier, { async authorize() {} }, 'p', f.artifacts);
  const result = await app.execute(f.request); expect(result.kind).toBe('terminal');
  const stored = JSON.parse(new TextDecoder().decode(await f.artifacts.read('s', result.record.output!)));
  expect(stored.completeness).toBe('partial');
  await expect(app.release(f.request)).rejects.toThrow('DISPATCH_ARTIFACT_REQUIRED'); expect(releases).toBe(0);
});
it.skipIf(!imageId)('recovers daemon-retained output after capture loss but never labels rotated storage complete', async () => {
  const f = await fixture(); let denyRecovery = false;
  const request = { ...f.request, argv: ['node', '-e', "console.log('retained-out');console.error('retained-err')"] };
  const docker = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: f.root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
    logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 });
  await f.store.claimDispatch({ request, owner: 'lost' });
  try {
    // Actual execution occurred, but simulate the host losing the returned attach output before retaining it.
    expect((await docker.execute(request)).result.kind).toBe('exited');
    const app = new DispatchApplication(f.store, docker, verifier, { async authorize(action) { if (action === 'recover-output' && denyRecovery) throw new Error('DENIED'); } }, 'recovery', f.artifacts);
    const terminal = await app.reconcile(request); expect(terminal.record.output).toBeUndefined();
    await expect(app.release(request)).rejects.toThrow('DISPATCH_ARTIFACT_REQUIRED');
    denyRecovery = true; await expect(app.recoverOutput(request)).rejects.toThrow('DENIED'); denyRecovery = false;
    const retained = await app.recoverOutput(request);
    const output = JSON.parse(new TextDecoder().decode(await f.artifacts.read('s', retained.output!)));
    expect(output).toMatchObject({ completeness: 'partial', stdout: 'retained-out\n', stderr: 'retained-err\n', identity: request.identity });
    expect(await app.recoverOutput(request)).toEqual(retained);
    await expect(app.release(request)).rejects.toThrow('DISPATCH_ARTIFACT_REQUIRED');
    const config = JSON.parse((await promisify(execFile)('/usr/bin/docker', ['inspect', retained.terminal!.handle])).stdout)[0].HostConfig.LogConfig;
    expect(config.Type).toBe('local'); expect(config.Config).toMatchObject({ 'max-size': '64k', 'max-file': '2', mode: 'blocking' });
  } finally { await docker.release(request); }
});
it.skipIf(!imageId)('persists authorized cancellation before another controller stops a confirmed running Docker worker', async () => {
  const f = await fixture(); let deny = true;
  const request = { ...f.request, argv: ['node', '-e', "require('node:fs').writeFileSync('/workspace/ready','yes');setInterval(()=>{},1000)"] };
  const options = { executable: '/usr/bin/docker', workspaceRoot: f.root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
    logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 };
  const original = new DockerSupervisor(options); const separate = new DockerSupervisor(options);
  const otherStore = await openSqliteAttemptStore(join(f.root, 'ledger.db'), { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }); stores.push(otherStore);
  const running = new DispatchApplication(f.store, original, verifier, { async authorize() {} }, 'runner', f.artifacts);
  const cancellation = new DispatchApplication(otherStore, separate, verifier, { async authorize(action) { if (action === 'cancel' && deny) throw new Error('DENIED'); } }, 'operator', f.artifacts);
  const execution = running.execute(request);
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = await readFile(join(f.workspace, 'ready'), 'utf8') === 'yes'; } catch { /* startup */ }
      if (ready) break; await sleep(50);
    }
    expect(ready).toBe(true);
    await expect(cancellation.cancel(request)).rejects.toThrow('DENIED');
    expect((await otherStore.load('s', request.identity.attemptId))?.cancelRequested).toBe(false);
    deny = false; const cancelled = await cancellation.cancel(request);
    expect(cancelled.kind).toBe('terminal'); expect(cancelled.record.terminal?.exitCode).not.toBe(0);
    expect(cancelled.record.cancellation).toEqual({ id: 'user', issuer: 'test', subject: 'user' });
    expect((await otherStore.load('s', request.identity.attemptId))?.cancelRequested).toBe(true);
    const completed = await execution; expect(completed.kind).toBe('terminal');
    const snapshot = await otherStore.load('s', request.identity.attemptId);
    await cancellation.cancel(request); expect(await otherStore.load('s', request.identity.attemptId)).toEqual(snapshot);
  } finally { await separate.cancel(request); await execution.catch(() => {}); await original.release(request); }
}, 20000);

it('does not signal a worker if the durable cancellation transaction fails', async () => {
  const f = await fixture(); await f.store.claimDispatch({ request: f.request, owner: 'runner' }); let signals = 0;
  const supervisor: ExecutionSupervisor = {
    async cancel() { signals++; throw new Error('must not signal'); }, async execute() { throw new Error('unused'); },
    async observe() { throw new Error('unused'); }, async recoverOutput() { throw new Error('unused'); }, async release() {},
  };
  const db = new DatabaseSync(join(f.root, 'ledger.db'));
  db.exec("CREATE TRIGGER fail_cancel BEFORE UPDATE ON dispatches BEGIN SELECT RAISE(ABORT,'injected'); END;");
  try {
    const app = new DispatchApplication(f.store, supervisor, verifier, { async authorize() {} }, 'operator', f.artifacts);
    await expect(app.cancel(f.request)).rejects.toThrow(); expect(signals).toBe(0);
    expect((await f.store.load('s', f.request.identity.attemptId))?.cancelRequested).toBe(false);
    expect((await f.store.readDispatch(f.request))?.cancellation).toBeUndefined();
  } finally { db.close(); }
});

it.skipIf(!imageId)('delivers a durable Run cancellation through a separate controller to a real Docker worker', async () => {
  const f = await fixture(); let deny = true;
  const request = { ...f.request, argv: ['node', '-e', "require('node:fs').writeFileSync('/workspace/ready','yes');setInterval(()=>{},1000)"] };
  const options = { executable: '/usr/bin/docker', workspaceRoot: f.root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
    logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 };
  const original = new DockerSupervisor(options); const separate = new DockerSupervisor(options);
  const otherStore = await openSqliteAttemptStore(join(f.root, 'ledger.db'), { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }); stores.push(otherStore);
  const running = new DispatchApplication(f.store, original, verifier, { async authorize() {} }, 'runner', f.artifacts);
  const cancellation = new DispatchApplication(otherStore, separate, verifier, { async authorize(action) { if (action === 'cancel' && deny) throw new PolicyAuthorizationError('POLICY_DENIED'); } }, 'operator', f.artifacts);
  const runApp = new RunApplication(otherStore, verifier, { async authorize() {} });
  const coordinator = new RunCancellationCoordinator(runApp, otherStore, cancellation, 2);
  const command = { schemaVersion: 1, action: 'cancel', commandId: 'cancel-run', scopeId: 's', runId: request.identity.runId, expectedRevision: 1 };
  const execution = running.execute(request);
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = await readFile(join(f.workspace, 'ready'), 'utf8') === 'yes'; } catch { /* startup */ }
      if (ready) break; await sleep(50);
    }
    expect(ready).toBe(true);
    expect((await coordinator.cancel(command)).outcomes[0]!.status).toBe('denied');
    expect((await otherStore.load('s', request.identity.attemptId))?.cancelRequested).toBe(true);
    deny = false; const cancelled = await coordinator.cancel(command);
    expect(cancelled.outcomes[0]!.status).toBe('terminal');
    expect((await otherStore.readDispatch(request))!.terminal!.exitCode).not.toBe(0);
    expect((await otherStore.load('s', request.identity.attemptId))?.cancelRequested).toBe(true);
    const completed = await execution; expect(completed.kind).toBe('terminal');
    const snapshot = await otherStore.load('s', request.identity.attemptId);
    await coordinator.cancel(command); expect(await otherStore.load('s', request.identity.attemptId)).toEqual(snapshot);
  } finally { await separate.cancel(request); await execution.catch(() => {}); await original.release(request); }
}, 20000);

it('keeps malformed supervisor terminal evidence unresolved without retaining output or relaunching', async () => {
  const f = await fixture(); let launches = 0;
  const malformed = { handle: 'worker', result: { kind: 'exited', exitCode: 0, signal: 'SIGTERM' },
    stdout: 'untrusted output', stderr: '', outputCompleteness: 'complete', interrupted: false };
  const supervisor: ExecutionSupervisor = {
    async execute() { launches++; return malformed as Awaited<ReturnType<ExecutionSupervisor['execute']>>; },
    async observe() { return malformed as Awaited<ReturnType<ExecutionSupervisor['observe']>>; },
    async cancel() { return malformed as Awaited<ReturnType<ExecutionSupervisor['cancel']>>; },
    async recoverOutput() { return { stdout: '', stderr: '', completeness: 'complete' } as unknown as Awaited<ReturnType<ExecutionSupervisor['recoverOutput']>>; },
    async release() { throw new Error('must not release'); },
  };
  const app = new DispatchApplication(f.store, supervisor, verifier, { async authorize() {} }, 'owner', f.artifacts);
  await expect(app.execute(f.request)).rejects.toThrow();
  const claim = await f.store.readDispatch(f.request); expect(claim?.terminal).toBeNull(); expect(claim?.output).toBeUndefined();
  expect((await app.execute(f.request)).kind).toBe('unresolved'); expect(launches).toBe(1);
  await expect(app.reconcile(f.request)).rejects.toThrow();
  await expect(app.cancel(f.request)).rejects.toThrow();
  expect((await f.store.readDispatch(f.request))?.terminal).toBeNull();
});
