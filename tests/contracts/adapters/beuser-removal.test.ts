import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { beuserBindingSchema, beuserEvaluatorPrincipalRef, verifiedPrincipalSchema } from '#domain/index.js';
import { pinBeuserLimits, beuserBindingDigest, BeuserRealmApplication, type BeuserContext, type BeuserRealmLease } from '#engine/index.js';
import { createBeuserRemovalReadback, DockerBeuserRealmRuntime, BeuserContainerMissing, type BeuserRealmCommand } from '#adapters/core/beuser-realm/index.js';
import type { ArtifactStore } from '#capabilities/index.js';
import type { JsonRecordFile } from '#platform/index.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat), readFile: vi.fn(actual.readFile) };
});
const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const absentError = () => Object.assign(new Error('fixture missing'), { code: 'ENOENT' });
async function fixture(rootMode: 'missing-field' | 'unreadable' | 'readable' = 'missing-field') {
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'beuser-removal-'))); roots.push(root);
  const mergedRoot = join(root, 'merged'), controlDirectory = join(root, 'control'); await fs.mkdir(mergedRoot); await fs.mkdir(controlDirectory, { mode: 0o700 });
  const control = await fs.lstat(controlDirectory, { bigint: true });
  const id = 'a'.repeat(64), pid = 424242, group = `/sys/fs/cgroup/docker/${id}`;
  let processAlive = true, cgroupAlive = true, removed = false, daemonDown = false, filesystemDenied = false, daemonId = 'fixture-daemon', labelled = '';
  vi.mocked(fs.lstat).mockImplementation((async (path: Parameters<typeof fs.lstat>[0], ...args: unknown[]) => {
    if (path === `/proc/${pid}`) { if (!processAlive) throw absentError(); return { isDirectory: () => true }; }
    if (path === group) { if (!cgroupAlive) throw absentError(); return { isDirectory: () => true }; }
    if (path === mergedRoot && (rootMode === 'unreadable' || filesystemDenied)) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    if (path === mergedRoot && removed) throw absentError();
    return Reflect.apply(actual.lstat, undefined, [path, ...args]);
  }) as typeof fs.lstat);
  vi.mocked(fs.readFile).mockImplementation((async (path: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
    if (path === `/proc/${pid}/stat`) return `${pid} (fixture process) S ${Array(18).fill('0').join(' ')} 123`;
    if (path === `/proc/${pid}/cgroup`) return `0::/docker/${id}\n`;
    return Reflect.apply(actual.readFile, undefined, [path, ...args]);
  }) as typeof fs.readFile);
  const context: BeuserContext = { binding: beuserBindingSchema.parse({ schemaVersion: 1,
    identity: { scopeId: 'scope', runId: 'run', taskId: 'task', attemptId: 'attempt', generation: 1, layoutRevision: 'layout' },
    candidate: { adapter: 'package', version: 'fixture', evidenceRef: 'fixture', stateDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) },
    candidateDigest: 'c'.repeat(64), personaDigest: 'd'.repeat(64), journeyDigest: 'e'.repeat(64), rubricDigest: 'f'.repeat(64),
    realmId: 'realm', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'transcript' }),
    principal: verifiedPrincipalSchema.parse({ id: 'evaluator', ...beuserEvaluatorPrincipalRef({ issuer: 'fixture', subject: 'owner' }), assurance: 'workload-verified', scopeIds: ['scope'] }),
    signal: new AbortController().signal, limits: pinBeuserLimits({ schemaVersion: 1, revision: 'fixture', source: 'fixture', provisional: true,
      maxSteps: 10, maxWallMs: 10000, maxWaitMs: 1000, maxCalls: 2, maxTokens: 100, maxCost: 1, currency: 'USD', maxReruns: 1,
      maxTranscriptBytes: 10000, maxArtifactBytes: 10000, cleanupDeadlineMs: 1000, criticalRepetitions: 1 }) };
  const handle = { binding: context.binding, containerId: id, incarnation: '22345678-1234-4234-8234-123456789abc', controlDirectory, controlIdentity: `${control.dev}:${control.ino}` };
  let saved: unknown;
  const file: JsonRecordFile = { read: vi.fn(async () => saved ? { kind: 'ready' as const, value: saved } : { kind: 'absent' as const }),
    write: vi.fn(async value => { saved = value; }), remove: vi.fn() };
  const command = vi.fn<BeuserRealmCommand>(async args => {
    if (daemonDown) throw new Error('fixture daemon unreachable');
    if (args[0] === 'info') return daemonId;
    if (args[1] === 'ls') return labelled;
    if (removed) throw new BeuserContainerMissing(id);
    return JSON.stringify([{ Id: id, State: { Pid: pid }, GraphDriver: { Data: rootMode === 'missing-field' ? {} : { MergedDir: mergedRoot } } }]);
  });
  const put = vi.fn(async (_scope, bytes: Buffer) => ({ digest: 'e'.repeat(64), size: bytes.length }));
  const options = { controllerRoot: root, packageRoot: root, executable: '/fixture/docker', image: `sha256:${id}`,
    uid: 1000, gid: 1000, memoryBytes: 1024, nanoCpus: 1000000000, pids: 10, filesystemBytes: 1024 };
  const readback = createBeuserRemovalReadback(options, { put } as unknown as ArtifactStore, file, command);
  const runtime = new DockerBeuserRealmRuntime(options, { retainEvidence: async () => 'fixture', verifyPackage: async () => true, removalEvidence: readback.read }, command);
  const capture = () => readback.capture(context, { kind: 'containment', bindingDigest: beuserBindingDigest(context.binding), incarnation: handle.incarnation,
    value: JSON.stringify({ id, state: { Pid: pid } }) });
  let lease: BeuserRealmLease = { handle, observation: { binding: context.binding, state: 'admitted', evidenceRefs: ['fixture-containment'] } };
  const app = new BeuserRealmApplication({ create: vi.fn(), inspect: vi.fn(), remove: ctx => readback.read(ctx, handle) },
    { reserve: vi.fn(), publish: vi.fn(), load: async () => lease, settle: async (_ctx, observation) => { lease = { ...lease, observation }; } });
  return { context, handle, file, command, put, readback, runtime, app, capture, saved: () => saved,
    remove() { removed = true; processAlive = false; cgroupAlive = false; }, processAlive() { processAlive = true; },
    cgroupAlive() { cgroupAlive = true; }, denyFilesystem() { filesystemDenied = true; }, allowFilesystem() { filesystemDenied = false; }, daemonDown() { daemonDown = true; }, daemonChanged() { daemonId = 'foreign-daemon'; },
    labelled() { labelled = 'b'.repeat(64) + '\n'; } };
}

it.skipIf(process.platform !== 'linux')('retains kernel pins without MergedDir and destroys with separately typed daemon attestation', async () => {
  const h = await fixture(); await h.capture();
  expect(vi.mocked(h.file.write).mock.calls[0]![0]).toMatchObject({ schemaVersion: 2, pid: 424242, start: '123', mergedRoot: null, daemonId: null });
  expect(h.saved()).toMatchObject({ daemonId: 'fixture-daemon', mergedRoot: null });
  h.remove();
  expect(await h.app.destroy(h.context)).toMatchObject({ state: 'destroyed', filesystemProof: { schemaVersion: 1, source: 'daemon-attested' } });
  expect(JSON.parse(h.put.mock.calls[0]![1].toString())).toMatchObject({ schemaVersion: 2, processesAbsent: true, cgroupAbsent: true, filesystemAbsent: false,
    daemon: { id: 'fixture-daemon', containerAbsent: true, incarnationAbsent: true } });
  expect(h.command).toHaveBeenCalledWith(['container', 'inspect', h.handle.containerId], expect.anything());
  expect(h.command).toHaveBeenCalledWith(['container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `label=deckent.beuser.incarnation=${h.handle.incarnation}`], expect.anything());
});
it.skipIf(process.platform !== 'linux')('keeps unreadable storage daemon-attested and refuses a live pinned process', async () => {
  const h = await fixture('unreadable'); await h.capture(); h.remove();
  expect((await h.readback.read(h.context, h.handle)).filesystemProof?.source).toBe('daemon-attested');
  h.processAlive();
  expect((await h.app.destroy(h.context)).state).toBe('quarantined');
});
it.skipIf(process.platform !== 'linux')('quarantines a surviving cgroup despite daemon absence', async () => {
  const h = await fixture(); await h.capture(); h.remove(); h.cgroupAlive();
  expect((await h.app.destroy(h.context)).state).toBe('quarantined');
});
it.skipIf(process.platform !== 'linux')('quarantines an unreachable daemon even after successful capture and kernel disappearance', async () => {
  const h = await fixture(); await h.capture(); h.remove(); h.daemonDown();
  expect((await h.app.destroy(h.context)).state).toBe('quarantined');
});
it.skipIf(process.platform !== 'linux')('retains the kernel record when the daemon is already unreachable during capture', async () => {
  const h = await fixture(); h.daemonDown(); await h.capture();
  expect(h.saved()).toMatchObject({ pid: 424242, start: '123', mergedRoot: null, daemonId: null });
  h.remove(); expect((await h.app.destroy(h.context)).state).toBe('quarantined');
});
it.skipIf(process.platform !== 'linux')('quarantines a changed daemon rather than trusting its empty inventory', async () => {
  const h = await fixture(); await h.capture(); h.remove(); h.daemonChanged();
  expect((await h.app.destroy(h.context)).state).toBe('quarantined');
});
it.skipIf(process.platform !== 'linux')('quarantines an incarnation still listed in any container state', async () => {
  const h = await fixture(); await h.capture(); h.remove(); h.labelled();
  expect((await h.app.destroy(h.context)).state).toBe('quarantined');
});
it.skipIf(process.platform !== 'linux')('never manufactures pins after removal or overwrites the original custody on reinspection', async () => {
  const h = await fixture(); h.remove();
  expect((await h.app.destroy(h.context)).state).toBe('quarantined');
  const other = await fixture(); await other.capture(); const saved = other.saved(); other.remove(); await other.capture();
  expect(other.saved()).toEqual(saved); expect(other.file.write).toHaveBeenCalledTimes(2);
});
it.skipIf(process.platform !== 'linux')('keeps readable-root kernel proof and refuses early filesystem completion or a late daemon downgrade', async () => {
  const h = await fixture('readable'); await h.capture();
  expect((await h.app.destroy(h.context)).state).toBe('quarantined');
  h.remove(); h.denyFilesystem();
  expect((await h.app.destroy(h.context)).state).toBe('quarantined');
  expect(h.command.mock.calls.filter(([args]) => args[1] === 'ls')).toHaveLength(0);
  h.allowFilesystem();
  expect(await h.app.destroy(h.context)).toMatchObject({ state: 'destroyed', filesystemProof: { schemaVersion: 1, source: 'kernel-proven' } });
  expect(JSON.parse(h.put.mock.calls.at(-1)![1].toString())).toMatchObject({ filesystemAbsent: true });
  expect(h.command.mock.calls.filter(([args]) => args[1] === 'ls')).toHaveLength(0);
});

it.skipIf(process.platform !== 'linux')('the Docker removal adapter deletes only its control directory without relabelling daemon proof as filesystem absence', async () => {
  const h = await fixture(); await h.capture(); h.remove();
  expect(await h.runtime.remove(h.context, h.handle)).toMatchObject({ processesAbsent: true, cgroupAbsent: true, filesystemAbsent: false,
    filesystemProof: { schemaVersion: 1, source: 'daemon-attested' } });
  await expect(fs.lstat(h.handle.controlDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});
