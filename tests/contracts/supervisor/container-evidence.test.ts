import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, type TestContext } from 'vitest';
import { DockerSupervisor, FileArtifactStore, readMonitorLedger, openSqliteAttemptStore, openSqliteInventoryReader } from '#adapters/index.js';
import { DispatchApplication, projectMonitorRun, containerEvidenceSchema, mergeDispatchTerminal } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyOrDockerProfiles } from '../support/custody.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const container = { schemaVersion: 1, containerId: 'c'.repeat(64), imageId: 'sha256:' + 'a'.repeat(64),
  startedAt: '2026-10-03T11:46:50.000000001Z', finishedAt: '2026-10-03T11:49:15.000000002Z',
  resources: { cpus: 1, memoryBytes: 268435456, pids: 64, tmpBytes: 16777216 } };
async function assertUnsupported(root: string) {
  expect(() => new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 65536 })).toThrow(expect.objectContaining({ code: 'ARTIFACT_UNSUPPORTED' }));
  expect(await readdir(root)).toEqual([]);
}
async function artifactStore(root: string, context: TestContext) {
  if (process.platform === 'win32') {
    await assertUnsupported(root);
    context.skip('ARTIFACT_UNSUPPORTED: container evidence requires POSIX private artifacts; refusal before artifact/ledger/Docker effects verified');
  }
  return new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 65536 });
}
it('refuses Windows artifact storage before artifact/ledger/Docker effects (native Windows or platform-property simulation)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'container-unsupported-')); roots.push(root);
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try { await assertUnsupported(root); }
  finally { Object.defineProperty(process, 'platform', original); }
});
it.for(['complete', 'cancel', 'recovery'] as const)('Docker %s preserves exact bounded evidence after release and reopen', async (mode, context) => {
  const root = await mkdtemp(join(tmpdir(), 'container-evidence-')); roots.push(root);
  const artifacts = await artifactStore(root, context);
  const workspace = join(root, 'workspace'); await mkdir(workspace); await mkdir(join(root, 'artifacts'), { mode: 0o700 });
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
  const request = { protocolVersion: 1 as const, identity, workspace, argv: ['node', 'test'] };
  let label = '', state = 'missing', launches = 0;
  const runner = async ({ args }: { args: readonly string[] }) => {
    const at = args[0] === '--host' ? 2 : 0, verb = args[at];
    if (verb === 'context') return { stdout: JSON.stringify({ Host: 'unix:///var/run/docker.sock' }), stderr: '' };
    if (verb === 'info') return { stdout: 'daemon', stderr: '' };
    if (verb === 'inspect') {
      if (state === 'missing') throw { stderr: 'No such object: ' + args[at + 1] };
      return { stdout: JSON.stringify([{ Id: container.containerId, Image: container.imageId, Config: { Labels: { 'deckent.request': label }, Env: ['SECRET=never-retain'] }, Mounts: [{ Type: 'bind', Source: workspace, Destination: '/workspace', RW: true }],
        State: { Status: state, ExitCode: mode === 'cancel' ? 137 : 0, StartedAt: container.startedAt, FinishedAt: container.finishedAt } }]), stderr: '' };
    }
    if (verb === 'create') { label = args[args.indexOf('--label') + 1]!.slice('deckent.request='.length); state = 'created'; return { stdout: container.containerId, stderr: '' }; }
    if (verb === 'start') { launches++; state = mode === 'cancel' ? 'running' : 'exited'; return { stdout: '', stderr: '' }; }
    if (verb === 'kill') { state = 'exited'; return { stdout: '', stderr: '' }; }
    if (verb === 'rm') { state = 'missing'; return { stdout: container.containerId, stderr: '' }; }
    throw new Error('unexpected Docker command');
  };
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: container.imageId,
    uid: 1000, gid: 1000, ...container.resources, logMaxSizeKiB: 64, logMaxFiles: 2, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 }, runner);
  const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const }, path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyOrDockerProfiles);
  try {
    await admitRunAttempts(store, [identity]);
    const verifier = { async verify() { return { id: 'test', issuer: 'test', subject: 'fixture', assurance: 'os-user' as const, scopeIds: ['s'] }; } };
    let fail = mode !== 'complete';
    const crashStore = new Proxy(store, { get(target, property) { if (property === 'finishDispatch') return async (...args: Parameters<typeof store.finishDispatch>) => {
      if (fail) throw new Error('ledger write lost'); return target.finishDispatch(...args); }; const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
    const app = new DispatchApplication(crashStore, supervisor, verifier, { async authorize() {} }, 'worker', artifacts);
    if (mode === 'complete') await app.execute(request);
    else { if (mode === 'cancel') expect((await app.execute(request)).kind).toBe('unresolved');
      else await expect(app.execute(request)).rejects.toThrow('ledger write lost'); fail = false;
      if (mode === 'cancel') await app.cancel(request); else await app.reconcile(request); }
    const first = await store.readDispatch(request);
    expect(first!.terminal).toHaveProperty('container', container);
    expect(JSON.stringify(first!.terminal)).not.toContain('SECRET');
    expect(JSON.stringify(first!.terminal).length).toBeLessThan(1024);
    if (mode === 'cancel') await supervisor.release(request); else await app.release(request);
    const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: 20 });
    try { expect((await reader.loadBoundDispatch(identity))!.terminal).toEqual(first!.terminal);
      expect((await reader.listDispatches({ schemaVersion: 1, scopeId: 's', after: null, limit: 1 })).entries).toHaveLength(1);
    } finally { reader.close(); }
    const reading = await readMonitorLedger(path, { busyTimeoutMs: 20, maxRuns: 10 });
    expect(projectMonitorRun({ run: reading.runs[0]!, approvals: [], pool: reading.pools[0]!, workers: new Map(), observedAt: Date.now() }).tasks[0]!.lastAttempt!.container).toEqual(container);
    expect(launches).toBe(1);
  } finally { store.close(); }
});

it('terminal container evidence cannot be overwritten or carry secrets; missing historical fields stay absent', () => {
  const terminal = { handle: 'h', exitCode: 0, interrupted: false, container };
  expect(mergeDispatchTerminal(terminal, { handle: 'h', exitCode: 0, interrupted: null })).toEqual(terminal);
  expect(() => mergeDispatchTerminal(terminal, { ...terminal, container: { ...container, containerId: 'd'.repeat(64) } })).toThrow('DISPATCH_CONFLICT');
  expect(containerEvidenceSchema.safeParse({ ...container, env: ['SECRET=private'] }).success).toBe(false);
  expect(containerEvidenceSchema.safeParse({ ...container, containerId: 'short' }).success).toBe(false);
  expect(containerEvidenceSchema.safeParse({ ...container, startedAt: '2026-10-03T11:49:16.000000001Z' }).success).toBe(false);
  expect(() => mergeDispatchTerminal({ ...terminal, container: { ...container, startedAt: null, finishedAt: null } }, terminal)).toThrow('DISPATCH_CONFLICT');
  expect(mergeDispatchTerminal({ handle: 'h', exitCode: 0, interrupted: null }, terminal)).toEqual(terminal);
});

// Reconstructed inspect variants: the retained host failure contains no raw inspect payload.
// Its root-level custom issue identifies the schema's finish-before-start refinement.
it.for([
  { name: 'backwards daemon clock', fields: { StartedAt: '2026-10-03T11:49:16.000000001Z', FinishedAt: container.finishedAt }, evidence: 'partial' },
  { name: 'Docker zero times', fields: { StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z' }, evidence: 'partial' },
  { name: 'missing times', fields: { StartedAt: undefined, FinishedAt: undefined }, evidence: 'partial' },
  { name: 'malformed times', fields: { StartedAt: 42, FinishedAt: 'not-a-time' }, evidence: 'partial' },
  { name: 'nanosecond times', fields: {}, evidence: 'complete' },
  { name: 'invalid container id', fields: {}, id: 'short', evidence: 'absent' },
  { name: 'missing image id', fields: {}, image: null, evidence: 'absent' },
  { name: 'missing exit code', fields: { ExitCode: undefined }, evidence: 'unknown' },
])('Docker cancel preserves exit truth with $name inspection evidence', async variant => {
  const root = await mkdtemp(join(tmpdir(), 'container-cancel-')); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const request = { protocolVersion: 1 as const, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' }, workspace, argv: ['node', 'test'] };
  let label = '', state = 'missing', kills = 0;
  const runner = async ({ args }: { args: readonly string[] }) => {
    const at = args[0] === '--host' ? 2 : 0, verb = args[at];
    if (verb === 'context') return { stdout: JSON.stringify({ Host: 'unix:///var/run/docker.sock' }), stderr: '' };
    if (verb === 'inspect') {
      if (state === 'missing') throw { stderr: 'No such object: ' + args[at + 1] };
      return { stdout: JSON.stringify([{ Id: variant.id ?? container.containerId, Image: variant.image === null ? undefined : container.imageId,
        Config: { Labels: { 'deckent.request': label }, Env: ['SECRET=never-retain'] }, Args: ['secret-argv'], Mounts: [{ Type: 'bind', Source: workspace, Destination: '/workspace', RW: true }],
        HostConfig: { Memory: 0, NanoCpus: 0, PidsLimit: null },
        State: { Status: state, ExitCode: 137, StartedAt: container.startedAt, FinishedAt: container.finishedAt, ...variant.fields } }]), stderr: '' };
    }
    if (verb === 'create') { label = args[args.indexOf('--label') + 1]!.slice('deckent.request='.length); state = 'created'; return { stdout: container.containerId, stderr: '' }; }
    if (verb === 'start') { state = 'running'; return { stdout: '', stderr: '' }; }
    if (verb === 'kill') { kills++; state = 'exited'; return { stdout: '', stderr: '' }; }
    throw new Error('unexpected Docker command');
  };
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: container.imageId, uid: 1000, gid: 1000,
    ...container.resources, logMaxSizeKiB: 64, logMaxFiles: 2, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 }, runner);
  expect((await supervisor.execute(request)).result.kind).toBe('unknown');
  const cancelled = await supervisor.cancel(request); expect(kills).toBe(1);
  expect(cancelled.result).toEqual(variant.evidence === 'unknown' ? { kind: 'unknown', reasonCode: 'SUPERVISOR_OUTCOME_UNRESOLVED' } : { kind: 'exited', exitCode: 137 });
  if (variant.evidence === 'partial' || variant.evidence === 'complete') {
    expect(cancelled.container).toEqual({ ...container, ...(variant.evidence === 'partial' ? { startedAt: null, finishedAt: null } : {}) });
    expect(containerEvidenceSchema.safeParse(cancelled.container).success).toBe(true);
    const terminal = { handle: cancelled.handle, exitCode: 137, interrupted: null, container: cancelled.container };
    expect(mergeDispatchTerminal(terminal, { handle: cancelled.handle, exitCode: 137, interrupted: null })).toEqual(terminal);
  } else expect(cancelled).not.toHaveProperty('container');
  expect(await supervisor.observe(request)).toEqual(cancelled);
  const replay = await supervisor.execute(request); expect(replay.result).toEqual(cancelled.result); expect(replay.container).toEqual(cancelled.container);
  for (const hidden of ['SECRET', 'secret-argv', 'HostConfig']) expect(JSON.stringify(cancelled)).not.toContain(hidden);
});

it('real Docker dispatch retains immutable container evidence after governed release', async context => {
  const root = await mkdtemp(join(tmpdir(), 'container-real-')); roots.push(root);
  const artifacts = await artifactStore(root, context);
  if (!process.env.DECKENT_TEST_DOCKER_IMAGE) context.skip('DOCKER_IMAGE_NOT_CONFIGURED: pinned local Docker image is required for real container evidence');
  const workspace = join(root, 'workspace'); await mkdir(workspace); await mkdir(join(root, 'artifacts'), { mode: 0o700 });
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
  const request = { protocolVersion: 1 as const, identity, workspace, argv: ['node', '-e', "process.stdout.write('done')"] };
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: process.env.DECKENT_TEST_DOCKER_IMAGE!,
    uid: process.getuid!(), gid: process.getgid!(), ...container.resources, logMaxSizeKiB: 64, logMaxFiles: 2, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 });
  const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyOrDockerProfiles);
  try {
    await admitRunAttempts(store, [identity]);
    const app = new DispatchApplication(store, supervisor, { async verify() { return { id: 'test', issuer: 'test', subject: 'fixture', assurance: 'os-user' as const, scopeIds: ['s'] }; } },
      { async authorize() {} }, 'worker', artifacts);
    const result = await app.execute(request);
    expect(result.kind).toBe('terminal'); expect(result.record.terminal!.container).toMatchObject({ imageId: process.env.DECKENT_TEST_DOCKER_IMAGE, resources: container.resources });
    expect(result.record.terminal!.container!.containerId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.record.terminal!.container!.startedAt).not.toBeNull(); expect(result.record.terminal!.container!.finishedAt).not.toBeNull();
    await app.release(request);
    const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: 20 });
    try { expect((await reader.loadBoundDispatch(identity))!.terminal).toEqual(result.record.terminal); } finally { reader.close(); }
  } finally { try { await supervisor.cancel(request); await supervisor.release(request); } catch { /* unavailable Docker remains a failed check */ } store.close(); }
});
