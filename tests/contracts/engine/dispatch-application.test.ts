import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { DockerSupervisor, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
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
  return { root, workspace, store, request };
}
it.skipIf(!imageId)('returns durable terminal after real Docker release without executing twice; replay still requires authorization', async () => {
  const f = await fixture(); let denied = false; let authorizations = 0;
  const policy = { async authorize() { authorizations++; if (denied) throw new Error('DENIED'); } };
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: f.root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
    memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 });
  const app = new DispatchApplication(f.store, supervisor, verifier, policy, 'process-1');
  try {
    const first = await app.execute(f.request); expect(first.kind).toBe('terminal'); expect(first.record.terminal?.exitCode).toBe(0);
    await app.release(f.request);
    const restarted = new DispatchApplication(f.store, supervisor, verifier, policy, 'process-2');
    expect(await restarted.execute(f.request)).toEqual(first);
    expect(await readFile(join(f.workspace, 'result'), 'utf8')).toBe('once');
    denied = true; await expect(restarted.execute(f.request)).rejects.toThrow('DENIED');
    expect(authorizations).toBe(4);
  } finally { await supervisor.release(f.request); }
});
it('never retries an unknown launch and refuses release without terminal evidence', async () => {
  const f = await fixture(); let calls = 0;
  const supervisor: ExecutionSupervisor = { async observe() { throw new Error('not observed'); }, async execute() { calls++; throw new Error('transport interrupted'); }, async release() { throw new Error('must not release'); } };
  const app = new DispatchApplication(f.store, supervisor, verifier, { async authorize() {} }, 'p');
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
  const failingStore = { claimDispatch: f.store.claimDispatch.bind(f.store), readDispatch: f.store.readDispatch.bind(f.store),
    async finishDispatch(): Promise<never> { throw new Error('injected terminal write failure'); } };
  const first = new DispatchApplication(failingStore, supervisor, verifier, policy, 'process-lost');
  try {
    await expect(first.execute(f.request)).rejects.toThrow('injected terminal write failure');
    expect((await f.store.readDispatch(f.request))?.terminal).toBeNull();
    const recovery = new DispatchApplication(f.store, supervisor, verifier, policy, 'process-recovery');
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
  const app = new DispatchApplication(f.store, supervisor, verifier, { async authorize() {} }, 'recovery');
  await expect(app.reconcile(f.request)).rejects.toThrow('DISPATCH_NOT_ADMITTED');
  expect(await f.store.readDispatch(f.request)).toBeNull();
  await f.store.claimDispatch({ request: f.request, owner: 'lost' });
  expect((await app.reconcile(f.request)).kind).toBe('unresolved');
  expect((await supervisor.observe(f.request)).result.kind).toBe('unknown');
  await expect(readFile(join(f.workspace, 'result'))).rejects.toMatchObject({ code: 'ENOENT' });
});
