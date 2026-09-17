import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore, DockerSupervisor, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { createAttempt } from '#domain/index.js';
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
  await store.commit({ commandId: 'admit', command: 'admit', expectedRevision: null, snapshot: createAttempt(identity) });
  const artifactRoot = join(root, 'artifacts'); await mkdir(artifactRoot, { mode: 0o700 });
  const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: 1048576 });
  return { root, workspace, store, request, artifacts };
}
it.skipIf(!imageId)('returns durable terminal after real Docker release without executing twice; replay still requires authorization', async () => {
  const f = await fixture(); let denied = false; let authorizations = 0;
  const policy = { async authorize() { authorizations++; if (denied) throw new Error('DENIED'); } };
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: f.root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
    memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 });
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
  const supervisor: ExecutionSupervisor = { async observe() { throw new Error('not observed'); }, async execute() { calls++; throw new Error('transport interrupted'); }, async release() { throw new Error('must not release'); } };
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
    memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 });
  const policy = { async authorize() { if (denied) throw new Error('DENIED'); } };
  const failingStore = { retainDispatchOutput: f.store.retainDispatchOutput.bind(f.store), claimDispatch: f.store.claimDispatch.bind(f.store), readDispatch: f.store.readDispatch.bind(f.store),
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
    memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 });
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
      return { handle: 'native-test', result: { kind: 'exited', exitCode: result.code, signal: result.signal }, stdout: '', stderr: '', interrupted: false };
    },
    async observe() { throw new Error('not observed'); }, async release() {},
  };
  const app = new DispatchApplication(f.store, supervisor, verifier, { async authorize() {} }, 'native-test', f.artifacts);
  const result = await app.execute(f.request);
  expect(result.record.terminal).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
  expect((await f.store.load('s', f.request.identity.attemptId))?.lastObservation?.result).toEqual({ kind: 'exited', exitCode: null, signal: 'SIGTERM' });
});
it.skipIf(!imageId)('allows real execute and reconcile to race on the same completed container without duplicate transition', async () => {
  const f = await fixture();
  const docker = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: f.root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
    memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 });
  let arrived!: () => void; let release!: () => void;
  const atTerminal = new Promise<void>(resolve => { arrived = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const delayed: ExecutionSupervisor = { observe: docker.observe.bind(docker), release: docker.release.bind(docker),
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
  const supervisor: ExecutionSupervisor = { async execute() { return { handle: 'test', result: { kind: 'exited', exitCode: 0 }, stdout: 'kept', stderr: '', interrupted: false }; },
    async observe() { throw new Error('not observed'); }, async release() { releases++; } };
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
  const supervisor: ExecutionSupervisor = { async execute() { return { handle: 'test', result: { kind: 'exited', exitCode: 137 }, stdout: 'partial', stderr: '', interrupted: true }; },
    async observe() { throw new Error('not observed'); }, async release() { releases++; } };
  const app = new DispatchApplication(f.store, supervisor, verifier, { async authorize() {} }, 'p', f.artifacts);
  const result = await app.execute(f.request); expect(result.kind).toBe('terminal');
  const stored = JSON.parse(new TextDecoder().decode(await f.artifacts.read('s', result.record.output!)));
  expect(stored.completeness).toBe('partial');
  await expect(app.release(f.request)).rejects.toThrow('DISPATCH_ARTIFACT_REQUIRED'); expect(releases).toBe(0);
});
