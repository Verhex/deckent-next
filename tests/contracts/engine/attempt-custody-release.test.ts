import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, openSqliteAttemptStore, sealWorkerEventLog, type SqliteAttemptStore } from '#adapters/index.js';
import { AttemptCustodyReleaseApplication, DispatchApplication, SupervisorError, WorkspacePatchApplication, patchExclusions, type AttemptWorkspaceCustody,
  type ExecutionSupervisor, type SandboxRequest } from '#engine/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyOrDockerProfiles, custodyProfile } from '../support/custody.js';

const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const principal = { id: 'user', issuer: 'test', subject: 'user', assurance: 'os-user' as const, scopeIds: ['s'] };
const verifier = { async verify() { return principal; } };
const allow = { async authorize() {}, async authorizeIdentity() {} };
const exited = (handle = 'h1', exitCode = 0) => ({ handle, result: { kind: 'exited' as const, exitCode } });

/** Real ledger + artifact store; fake supervisor and clone custody record every release call. */
async function fixture(count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-custody-')); roots.push(root);
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'allow', custodyOrDockerProfiles); stores.push(store);
  const runId = 'r-' + randomUUID();
  const identities: AttemptIdentity[] = Array.from({ length: count }, (_, index) => ({ runId, taskId: 't' + index, attemptId: randomUUID(), scopeId: 's', generation: 1, layoutRevision: 'l' }));
  await admitRunAttempts(store, identities);
  const artifactRoot = join(root, 'artifacts'); await mkdir(artifactRoot, { mode: 0o700 });
  const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: 1048576 });
  const calls = { container: [] as string[], workspace: [] as string[] };
  let observed = exited(); let containerFailure: Error | null = null; let workspaceFailure: Error | null = null;
  const supervisor: ExecutionSupervisor & { captureProfile(): Promise<typeof custodyProfile> } = {
    async captureProfile() { return custodyProfile; }, async cancel() { throw new Error('unused'); }, async recoverOutput() { throw new Error('unused'); },
    async observe() { return observed; },
    async execute() { return { handle: 'h1', result: { kind: 'exited', exitCode: 0 }, stdout: 'ok', stderr: '', interrupted: false, outputCompleteness: 'complete' }; },
    async release(request: SandboxRequest) { if (containerFailure) throw containerFailure; calls.container.push(request.identity.attemptId); return 'removed'; },
  };
  const workspaces: AttemptWorkspaceCustody = {
    async releaseAttempt(request) { if (workspaceFailure) throw workspaceFailure; calls.workspace.push(request.identity.attemptId); return 'removed'; },
    async holds() { return true; }, async countDetached() { return 0; },
  };
  const request = (identity: AttemptIdentity) => ({ protocolVersion: 1 as const, identity, workspace: join(root, 'w', identity.attemptId, 'tree'), argv: ['node'] });
  const execute = (identity: AttemptIdentity) => new DispatchApplication(store, supervisor, verifier, allow, 'owner', artifacts).execute(request(identity));
  const patchOf = (identity: AttemptIdentity) => ({ schemaVersion: 1, kind: 'workspace-patch', identity, baseCommit: 'a'.repeat(40), snapshotDigest: 'b'.repeat(64),
    source: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'c'.repeat(64) }, exclusions: patchExclusions, changes: [] });
  const retain = async (identity: AttemptIdentity, value: unknown = patchOf(identity)) => {
    const receipt = await artifacts.put('s', Buffer.from(JSON.stringify(value)));
    await store.retainDispatchPatch({ request: request(identity), owner: 'owner' }, receipt); return receipt;
  };
  const app = (overrides: Partial<ConstructorParameters<typeof AttemptCustodyReleaseApplication>[0]> = {}) => new AttemptCustodyReleaseApplication({ store, artifacts, verifier,
    authorization: allow, owner: 'owner', supervisor: () => supervisor, observed: () => false, workspaces, retention: { release: 'after-retained-patch', sweepLimit: 16 }, ...overrides });
  return { root, store, artifacts, identities, identity: identities[0]!, calls, execute, retain, patchOf, app, request, workspaces,
    setObserved(value: ReturnType<typeof exited>) { observed = value; }, failContainer(error: Error | null) { containerFailure = error; }, failWorkspace(error: Error | null) { workspaceFailure = error; } };
}
const released = { schemaVersion: 1, status: 'released', container: 'removed', workspace: 'removed' };

describe.skipIf(process.platform === 'win32')('requires POSIX private FileArtifactStore; ARTIFACT_UNSUPPORTED', () => {
describe('attempt custody release (EXEC-RELEASE)', () => {
  it('negative 1: complete retained output without a patch releases nothing and stays recoverable', async () => {
    const f = await fixture(); const outcome = await f.execute(f.identity); expect(outcome.kind).toBe('terminal'); expect(outcome.record.output).toBeDefined();
    expect(await f.app().release(f.identity)).toEqual({ schemaVersion: 1, status: 'held', reason: 'patch-missing', code: null });
    expect(f.calls).toEqual({ container: [], workspace: [] });
    expect((await f.store.loadBoundDispatch(f.identity))?.terminal).toEqual(outcome.record.terminal);
  });
  it('negative 2: a capture or retain failure never reaches release', async () => {
    const f = await fixture(); await f.execute(f.identity); let releases = 0; const expected: unknown[] = [];
    const custody = { async release(_identity: unknown, receipt?: unknown) { releases++; expected.push(receipt); return { schemaVersion: 1 as const, status: 'released' as const, container: 'removed' as const, workspace: 'removed' as const }; } };
    const patches = new WorkspacePatchApplication(f.store, f.artifacts, verifier, allow, 1048576, 'warn', custody);
    await expect(patches.prepare(f.identity, { async capture() { throw new Error('capture-failed'); } }, f.store)).rejects.toThrow('capture-failed');
    const failingWriter = { loadBoundDispatch: (identity: AttemptIdentity) => f.store.loadBoundDispatch(identity), async retainDispatchPatch(): Promise<never> { throw new Error('retain-failed'); } };
    await expect(patches.prepare(f.identity, { async capture() { return f.patchOf(f.identity) as never; } }, failingWriter)).rejects.toThrow('retain-failed');
    expect(releases).toBe(0); expect(f.calls).toEqual({ container: [], workspace: [] });
    expect((await patches.prepare(f.identity, { async capture() { return f.patchOf(f.identity) as never; } }, f.store)).custody).toMatchObject({ status: 'released' });
    expect(releases).toBe(1); expect(expected).toEqual([(await f.store.loadBoundDispatch(f.identity))!.patch]);
  });
  it('negative 3: corrupt bytes, a patch of another attempt or a different receipt release nothing', async () => {
    const f = await fixture(3);
    for (const identity of f.identities) await f.execute(identity);
    const [corrupt, foreign, mismatch] = f.identities as [AttemptIdentity, AttemptIdentity, AttemptIdentity];
    const receipt = await f.retain(corrupt);
    await writeFile((await f.artifacts.prepareReadOnlyFile('s', receipt)).path, JSON.stringify({ broken: true }).padEnd(receipt.byteLength), { mode: 0o600 });
    expect(await f.app().release(corrupt)).toMatchObject({ status: 'held', reason: 'patch-corrupt', code: 'ARTIFACT_CORRUPT' });
    await f.retain(foreign, f.patchOf(mismatch));
    expect(await f.app().release(foreign)).toMatchObject({ status: 'held', reason: 'patch-corrupt' });
    await f.retain(mismatch);
    const other = await f.artifacts.put('s', Buffer.from('other'));
    expect(await f.app().release(mismatch, other)).toMatchObject({ status: 'held', reason: 'patch-mismatch' });
    expect(f.calls).toEqual({ container: [], workspace: [] });
  });
  it('releases container then clone only after the verified patch; replays report the removal and the record keeps its fence', async () => {
    const f = await fixture(); const outcome = await f.execute(f.identity); const receipt = await f.retain(f.identity);
    expect(await f.app().release(f.identity, receipt)).toEqual(released);
    expect(f.calls).toEqual({ container: [f.identity.attemptId], workspace: [f.identity.attemptId] });
    const record = await f.store.loadBoundDispatch(f.identity); expect(record?.terminal).toEqual(outcome.record.terminal); expect(record?.patch).toEqual(receipt);
  });
  it('negative 5: a failed container or clone removal is typed, keeps the rest and is retryable; the ledger is unchanged', async () => {
    const f = await fixture(); await f.execute(f.identity); await f.retain(f.identity); const before = await f.store.loadBoundDispatch(f.identity);
    f.failContainer(new SupervisorError('SUPERVISOR_RELEASE_UNCONFIRMED'));
    expect(await f.app().release(f.identity)).toEqual({ schemaVersion: 1, status: 'held', reason: 'container-release-failed', code: 'SUPERVISOR_RELEASE_UNCONFIRMED' });
    expect(f.calls.workspace).toEqual([]);
    f.failContainer(null); f.failWorkspace(Object.assign(new Error('rename'), { code: 'EACCES' }));
    expect(await f.app().release(f.identity)).toEqual({ schemaVersion: 1, status: 'held', reason: 'workspace-release-failed', code: 'EACCES' });
    f.failWorkspace(null); expect(await f.app().release(f.identity)).toEqual(released);
    expect(await f.store.loadBoundDispatch(f.identity)).toEqual(before);
  });
  it('removes only the ledger\'s exact terminal container and refuses policy denial, keep retention and a missing terminal', async () => {
    const f = await fixture(2); await f.execute(f.identity); await f.retain(f.identity);
    f.setObserved(exited('other-handle')); expect(await f.app().release(f.identity)).toMatchObject({ reason: 'container-release-failed', code: 'SUPERVISOR_IDENTITY_CONFLICT' });
    f.setObserved(exited('h1', 3)); expect(await f.app().release(f.identity)).toMatchObject({ reason: 'container-release-failed', code: 'SUPERVISOR_IDENTITY_CONFLICT' });
    f.setObserved(exited());
    const denied = { ...allow, async authorizeIdentity() { throw Object.assign(new Error('denied'), { code: 'POLICY_DENIED' }); } };
    expect(await f.app({ authorization: denied }).release(f.identity)).toMatchObject({ reason: 'release-denied', code: 'POLICY_DENIED' });
    expect(await f.app({ retention: { release: 'keep', sweepLimit: 16 } }).release(f.identity)).toMatchObject({ reason: 'retention-keep' });
    expect(await f.app().release(f.identities[1]!)).toMatchObject({ reason: 'not-terminal' });
    expect(f.calls).toEqual({ container: [], workspace: [] });
  });
  it('lead (a′) / Sol ER-R1: an observed worker needs a verified sealed event stream of its exact attempt before anything is removed', async () => {
    const f = await fixture(8); for (const identity of f.identities) { await f.execute(identity); await f.retain(identity); }
    const [none, missing, corrupt, malformed, foreign, healthy, empty, unobserved] = f.identities as AttemptIdentity[] as [AttemptIdentity, AttemptIdentity, AttemptIdentity, AttemptIdentity, AttemptIdentity, AttemptIdentity, AttemptIdentity, AttemptIdentity];
    const streamOf = (excerpt: string) => Buffer.from(sealWorkerEventLog([{ schemaVersion: 1, sequence: 1, atMs: 0, kind: 'message', role: 'assistant', textBytes: 1, thinking: false, excerpt }], null, 0, 65536).join(''));
    const stream = streamOf('healthy');
    const seal = async (identity: AttemptIdentity, bytes: Buffer, eventCount: number, bound: AttemptIdentity = identity) => {
      const events = await f.artifacts.put('s', bytes);
      await f.store.saveWorkerEventLog({ schemaVersion: 1, identity: bound, events, eventCount, sealedAt: 1, projection: 'partial' }); return events;
    };
    const observed = f.app({ observed: () => true });
    expect(await observed.release(none)).toEqual({ schemaVersion: 1, status: 'held', reason: 'events-unsealed', code: null });
    expect(await f.app({ observed: () => { throw new Error('profile'); } }).release(none)).toMatchObject({ reason: 'events-unsealed' });
    // Valid metadata whose blob is gone, corrupted in place (same size), not an event stream, or bound to another generation of the attempt.
    await rm((await f.artifacts.prepareReadOnlyFile('s', await seal(missing, streamOf('missing'), 1))).path);
    const corrupted = await seal(corrupt, streamOf('corrupt'), 1);
    await writeFile((await f.artifacts.prepareReadOnlyFile('s', corrupted)).path, Buffer.alloc(corrupted.byteLength, 32), { mode: 0o600 });
    await seal(malformed, Buffer.from('{}\n'), 1);
    await seal(foreign, stream, 1, { ...foreign, generation: foreign.generation + 1 });
    for (const identity of [missing, corrupt, malformed, foreign])
      expect(await observed.release(identity), identity.taskId).toEqual({ schemaVersion: 1, status: 'held', reason: 'events-unsealed', code: 'WORKER_OBSERVATION_INVALID' });
    expect(f.calls).toEqual({ container: [], workspace: [] });
    // Controls: a healthy sealed stream (partial live projection is not corruption), a valid zero-event log, and an unobserved profile.
    await seal(healthy, stream, 1); await seal(empty, Buffer.alloc(0), 0);
    expect(await observed.release(healthy)).toEqual(released); expect(await observed.release(empty)).toEqual(released);
    expect(await f.app({ observed: () => false }).release(unobserved)).toEqual(released);
    expect(f.calls.workspace).toEqual([healthy.attemptId, empty.attemptId, unobserved.attemptId]);
  });
  it('negative 6: the start sweep releases only terminal records with a verified retained patch, bounded and isolated per record', async () => {
    const f = await fixture(5);
    const [ready, noPatch, notTerminal, corrupt, second] = f.identities as [AttemptIdentity, AttemptIdentity, AttemptIdentity, AttemptIdentity, AttemptIdentity];
    for (const identity of [ready, noPatch, corrupt, second]) await f.execute(identity);
    await f.retain(ready); await f.retain(second); await f.retain(corrupt, f.patchOf(ready));
    const all = await f.app().sweep('s', 2);
    expect(all.error).toBeNull(); expect(all.released).toBe(2);
    expect(all.entries.map(entry => [entry.identity.attemptId, entry.outcome.status])).toEqual(expect.arrayContaining([[ready.attemptId, 'released'], [second.attemptId, 'released'], [corrupt.attemptId, 'held']]));
    expect(all.entries.some(entry => [noPatch.attemptId, notTerminal.attemptId].includes(entry.identity.attemptId))).toBe(false);
    expect(new Set(f.calls.workspace)).toEqual(new Set([ready.attemptId, second.attemptId]));
    expect((await f.app({ retention: { release: 'after-retained-patch', sweepLimit: 1 } }).sweep('s', 2)).entries).toHaveLength(1);
    expect((await f.app({ retention: { release: 'keep', sweepLimit: 16 } }).sweep('s', 2)).entries).toHaveLength(0);
    const flaky = { ...f.workspaces, async holds(identity: AttemptIdentity) { if (identity.attemptId === ready.attemptId) throw Object.assign(new Error('io'), { code: 'EIO' }); return true; } };
    const isolated = await f.app({ workspaces: flaky }).sweep('s', 2);
    expect(isolated.entries.find(entry => entry.identity.attemptId === ready.attemptId)?.outcome).toMatchObject({ reason: 'record-unreadable', code: 'EIO' });
    expect(isolated.entries.filter(entry => entry.outcome.status === 'released').length).toBe(1);
  });
});

});
