import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, unlink, realpath, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorkspaceBroker, GitRunWorkspaceProvider } from '#adapters/core/git-workspace/index.js';
import { createNativeCodingTemplate, compileNativeCodingWorkInput } from '#adapters/core/native-coding/index.js';
import { nativeWorkerCustodyFile, resolveNativeCliWorkerProfile } from '#adapters/core/native-cli-worker/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { WorkspacePatchError, type DispatchRecord } from '#engine/index.js';
import type { GitWorkspaceLease, GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { GitWorkspacePatchSource, diffAgainstBase, gitBlobOid, gitFailure, hashAlgorithmOf, listBase, readBaseBlobs, readWorkspace, snapshotDigest, SnapshotBudget } from '#adapters/core/git-patch/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

const exec = promisify(execFile); const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const limits = { maxBytes: 64 * 1024 * 1024, maxEntries: 10000, maxDepth: 32, maxPathBytes: 1024 };
const FILES = 1500;
async function repository(files = FILES) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deckent-snapshot-'))); roots.push(root);
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', root, ...args])).stdout.trim();
  await git('init', '-q'); await git('config', 'user.email', 't@example.invalid'); await git('config', 'user.name', 'T');
  for (let i = 0; i < files; i++) {
    const dir = join(root, `dir${i % 40}`); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `file${i}.txt`), `content ${i}\n`);
  }
  await git('add', '-A'); // Git commit may start auto gc/maintenance as a detached background process (observed on the CI runner's Git 2.55; no release-note attribution — Sol 2208 CI-N1); it would write
  // into .git while afterEach removes the fixture (ENOTEMPTY). The fixture is a leaf test repository, so no background work is wanted.
  await git('-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'gc.autoDetach=false', '-c', 'maintenance.auto=false', 'commit', '-q', '-m', 'base');
  const head = await git('rev-parse', 'HEAD');
  const lease = { baseCommit: head, workspace: root, sourceBase: { adapter: { id: 'git', version: 1 }, source: { repositoryRoot: root } } } as unknown as GitWorkspaceLease;
  const options = (outputBytes: number) => ({ gitExecutable: '/usr/bin/git', timeoutMs: 30_000, outputBytes, sourceRoot: root, workspaceRoot: root }) as unknown as GitWorkspaceOptions;
  return { root, head, lease, options, budget: () => new SnapshotBudget(limits, Date.now() + 30_000) };
}

describe.skipIf(process.platform !== 'linux')('git patch snapshot on a repository-sized tree', () => {
  it('reports an exhausted Git output bound as a typed limit, not as unavailability', async () => {
    const r = await repository();
    await expect(listBase(r.lease, r.options(65_536), r.budget())).rejects.toMatchObject({ code: 'PATCH_LIMIT', detail: 'git-output' });
    const listing = await listBase(r.lease, r.options(4_194_304), r.budget());
    expect(listing.size).toBe(FILES);
  });
  it('reads only changed base blobs: hash-diff identifies modified, added and removed paths without touching unchanged files', async () => {
    const r = await repository(); const listing = await listBase(r.lease, r.options(4_194_304), r.budget());
    await writeFile(join(r.root, 'dir1/file1.txt'), 'changed\n'); await writeFile(join(r.root, 'dir2/new.txt'), 'new\n'); await unlink(join(r.root, 'dir3/file3.txt'));
    const after = await readWorkspace(r.root, r.budget());
    expect(after.size).toBe(FILES);
    const changed = diffAgainstBase(listing, after, hashAlgorithmOf(r.head));
    expect(changed).toEqual(['dir1/file1.txt', 'dir2/new.txt', 'dir3/file3.txt']);
    const budget = r.budget();
    const base = await readBaseBlobs(r.lease, r.options(4_194_304), budget, changed.flatMap(path => { const entry = listing.get(path); return entry ? [[path, entry] as const] : []; }));
    expect([...base.keys()]).toEqual(['dir1/file1.txt', 'dir3/file3.txt']);
    expect(base.get('dir1/file1.txt')!.text).toBe('content 1\n'); expect(base.get('dir3/file3.txt')!.text).toBe('content 3\n');
    expect(budget.bytes).toBe(Buffer.byteLength('content 1\n') + Buffer.byteLength('content 3\n'));
    expect(gitBlobOid(Buffer.from('content 1\n'), 'sha1')).toBe(listing.get('dir1/file1.txt')!.oid);
  });
  it('maps Git failures and budget exhaustion to bounded limit details that reach the typed error surface', () => {
    expect(gitFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).toMatchObject({ code: 'PATCH_LIMIT', detail: 'git-output' });
    expect(gitFailure({ killed: true })).toMatchObject({ code: 'PATCH_LIMIT', detail: 'git-timeout' });
    expect(gitFailure({ code: 'ENOENT' })).toMatchObject({ code: 'PATCH_UNAVAILABLE' });
    expect(() => new SnapshotBudget(limits, Date.now() - 1).time()).toThrow(expect.objectContaining({ code: 'PATCH_LIMIT', detail: 'time' }));
    expect(() => new SnapshotBudget({ ...limits, maxEntries: 0 }, Date.now() + 1000).entry()).toThrow(expect.objectContaining({ detail: 'entries' }));
    expect(() => new SnapshotBudget({ ...limits, maxBytes: 1 }, Date.now() + 1000).size(2)).toThrow(expect.objectContaining({ detail: 'bytes' }));
    const surfaced = queryFailure(new WorkspacePatchError('PATCH_LIMIT', 'git-output'));
    expect(surfaced.code).toBe('PATCH_LIMIT'); expect(JSON.stringify(surfaced)).toContain('git-output');
  });
  describe('byte budget bounds carried content, not the unchanged repository', () => {
    const base = async (r: Awaited<ReturnType<typeof repository>>) => ({ listing: await listBase(r.lease, r.options(4_194_304), r.budget()), algorithm: hashAlgorithmOf(r.head) });
    // The unchanged tree (1500 files, about 20 KiB) is larger than maxBytes = 4 KiB, as the 19 MB repository was larger than 16 MiB.
    const small = { ...limits, maxBytes: 4_096 };
    const budget = (l = small) => new SnapshotBudget(l, Date.now() + 30_000);
    it('succeeds with a tiny change in a tree larger than maxBytes and charges only the changed file', async () => {
      const r = await repository(); const b = await base(r);
      await writeFile(join(r.root, 'dir1/file1.txt'), 'changed\n'); await writeFile(join(r.root, 'dir2/new.txt'), 'new\n'); await unlink(join(r.root, 'dir3/file3.txt'));
      const charged = budget();
      const after = await readWorkspace(r.root, charged, b);
      expect(after.size).toBe(FILES);
      expect(charged.bytes).toBe(Buffer.byteLength('changed\n') + Buffer.byteLength('new\n'));
      expect(diffAgainstBase(b.listing, after, b.algorithm)).toEqual(['dir1/file1.txt', 'dir2/new.txt', 'dir3/file3.txt']);
      expect(after.get('dir1/file1.txt')!.text).toBe('changed\n');
      // the digest is identical to a full read, so recorded patches keep verifying
      const full = await readWorkspace(r.root, new SnapshotBudget(limits, Date.now() + 30_000));
      expect(snapshotDigest(after)).toBe(snapshotDigest(full));
    });
    it('without the baseline the same tree is refused (the pre-fix behaviour), naming limit, observed value and field', async () => {
      const r = await repository();
      const error = await readWorkspace(r.root, budget()).catch((e: unknown) => e) as WorkspacePatchError;
      expect(error).toMatchObject({ code: 'PATCH_LIMIT', detail: 'bytes', params: { limit: 4_096 } });
      expect(Number(error.params!['observed'])).toBeGreaterThan(4_096);
    });
    it('still refuses a changed file larger than maxBytes with detailed params, and a same-size content change is detected by hash', async () => {
      const r = await repository(); const b = await base(r);
      await writeFile(join(r.root, 'dir1/file1.txt'), 'x'.repeat(5_000));
      await expect(readWorkspace(r.root, budget(), b)).rejects.toMatchObject({ code: 'PATCH_LIMIT', detail: 'bytes', params: { limit: 4_096, observed: 5_000 } });
      await writeFile(join(r.root, 'dir1/file1.txt'), 'content X\n'); // same length as 'content 1\n'
      const after = await readWorkspace(r.root, budget(), b);
      expect(diffAgainstBase(b.listing, after, b.algorithm)).toEqual(['dir1/file1.txt']);
    });
    it('keeps the scan bounds: entries, depth, path bytes and time', async () => {
      const r = await repository(); const b = await base(r);
      await expect(readWorkspace(r.root, budget({ ...small, maxEntries: 100 }), b)).rejects.toMatchObject({ code: 'PATCH_LIMIT', detail: 'entries', params: { limit: 100 } });
      await expect(readWorkspace(r.root, budget({ ...small, maxDepth: 1 }), b)).rejects.toMatchObject({ code: 'PATCH_LIMIT', detail: 'depth', params: { limit: 1, observed: 2 } });
      await expect(readWorkspace(r.root, budget({ ...small, maxPathBytes: 8 }), b)).rejects.toMatchObject({ code: 'PATCH_LIMIT', detail: 'path', params: { limit: 8 } });
      await expect(readWorkspace(r.root, new SnapshotBudget(small, Date.now() - 1), b)).rejects.toMatchObject({ code: 'PATCH_LIMIT', detail: 'time' });
    });
    it('renders the exceeded limit and the config field in EN and TR', () => {
      const params = { observed: 20_000_000, limit: 16_777_216 };
      const cases: Array<[WorkspacePatchError, string]> = [
        [new WorkspacePatchError('PATCH_LIMIT', 'bytes', params), 'artifacts.maxBytes'],
        [new WorkspacePatchError('PATCH_LIMIT', 'entries', params), 'artifacts.patchPreview.maxEntries'],
        [new WorkspacePatchError('PATCH_LIMIT', 'depth', params), 'artifacts.patchPreview.maxDepth'],
        [new WorkspacePatchError('PATCH_LIMIT', 'path', params), 'artifacts.patchPreview.maxPathBytes'],
        [new WorkspacePatchError('PATCH_LIMIT', 'time', params), 'execution.git.timeoutMs']];
      for (const locale of ['en', 'tr'] as const) for (const [error, field] of cases) {
        const surfaced = queryFailure(error); expect(surfaced.params).toMatchObject({ detail: error.detail, field });
        const message = ErrorRegistry.createError('PATCH_LIMIT', { params: surfaced.params!, locale }).message;
        expect(message).toContain(field); expect(message).toContain('16777216'); expect(message).toContain('20000000'); expect(message).not.toMatch(/\{\w+\}/);
      }
      expect(ErrorRegistry.createError('PATCH_LIMIT', { params: queryFailure(cases[0]![0]).params!, locale: 'tr' }).message).toContain('baytı');
    });
  });
});

// Retained producer fixture: no process launch or Docker daemon; compiled CLI evidence exercises the real producer separately.
async function nativePatch() {
  const r = await repository(2), workspaceRoot = join(r.root, 'attempts'); await mkdir(workspaceRoot);
  const options = { sourceRoot: r.root, workspaceRoot, gitExecutable: '/usr/bin/git', timeoutMs: 30_000, outputBytes: 4_194_304 };
  const broker = new GitWorkspaceBroker(options), provider = new GitRunWorkspaceProvider(broker);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
  const captured = await provider.captureSource();
  const custody = { schemaVersion: 1 as const, scopeId: 's', runId: 'r', ...captured };
  const lease = await provider.allocate(identity, custody), entry = nativeCliAgent('claude-code-stream-json')!;
  const task = compileNativeCodingWorkInput(createNativeCodingTemplate({ imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456,
    pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 },
  { provider: entry.id, cliVersion: '9.1.0', discovery: { schemaVersion: 1, mode: 'disabled' }, permissionMode: 'unattended' },
  { schemaVersion: 1, connectionId: 'aabbccdd-1234-4123-8123-123456789abc', protocolFamily: entry.headless.protocolFamily ?? entry.command.capabilities.eventStream,
    profileDigest: 'b'.repeat(64), resourceKey: 'fixture', definition: { schemaVersion: 1, executable: '/fixture/cli', configDir: '/fixture/login',
      stateDir: '/fixture/state', ownerUid: 1000, minCliVersion: '2.1.0', delegatedUse: null } }),
  { schemaVersion: 1, task: 'Update a note', scope: { paths: ['dir1/file1.txt'] }, acceptance: 'Changed note',
    model: { channelId: 'fixture', modelId: 'fixture-model', auxiliaryModelIds: [] } });
  const profile = { schemaVersion: 1 as const, adapterId: 'native-cli-worker', adapterVersion: 1, parameters: { task } };
  const request = { protocolVersion: 1 as const, identity, workspace: lease.workspace, argv: resolveNativeCliWorkerProfile(task).argv };
  const terminal = { handle: 'native-retained-fixture', exitCode: 0 };
  const file = nativeWorkerCustodyFile(request);
  await file.write({ schemaVersion: 1, request, profileDigest: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
    result: { handle: terminal.handle, result: { kind: 'exited', exitCode: 0 }, stdout: '', stderr: '', outputCompleteness: 'complete', interrupted: false } });
  const record = { request, profile, terminal } as DispatchRecord;
  return { ...r, broker, lease, file, record, patch: new GitWorkspacePatchSource(options, limits, { loadRunWorkspaceCustody: async () => custody }) };
}
describe.skipIf(process.platform !== 'linux')('native retained git patch custody', () => {
  it('captures the native terminal patch and proves release only after the workspace lease is gone', async () => {
    const f = await nativePatch(); await writeFile(join(f.lease.workspace, 'dir1/file1.txt'), 'native change\n');
    const patch = await f.patch.capture(f.record);
    expect(patch.changes).toEqual([expect.objectContaining({ path: 'dir1/file1.txt', before: expect.objectContaining({ text: 'content 1\n' }), after: expect.objectContaining({ text: 'native change\n' }) })]);
    expect(await f.patch.released(f.record)).toBe(false);
    await f.broker.releaseAttempt({ schemaVersion: 1, identity: f.record.request.identity, baseCommit: f.lease.baseCommit }, f.lease.workspace);
    expect(await f.patch.released(f.record)).toBe(true);
  });
  it('refuses missing or mismatched terminal custody and invalid native versions without a Docker fallback', async () => {
    const f = await nativePatch();
    await expect(f.patch.capture({ ...f.record, terminal: { ...f.record.terminal!, exitCode: 1 } })).rejects.toMatchObject({ code: 'PATCH_UNAVAILABLE' });
    await expect(f.patch.capture({ ...f.record, profile: { ...f.record.profile, adapterVersion: 2 } })).rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
    await f.file.remove();
    await expect(f.patch.capture(f.record)).rejects.toMatchObject({ code: 'PATCH_UNAVAILABLE' });
    expect(await f.patch.released(f.record)).toBe(false);
  });
  it('keeps an outside symlink PATCH_UNSAFE and leaves its target unchanged', async () => {
    const f = await nativePatch(), outside = join(f.root, 'outside'); await writeFile(outside, 'untouched');
    await symlink(outside, join(f.lease.workspace, 'unsafe'));
    await expect(f.patch.capture(f.record)).rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
    expect(await readFile(outside, 'utf8')).toBe('untouched');
  });
});
