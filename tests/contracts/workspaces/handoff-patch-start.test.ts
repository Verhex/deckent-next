import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { GitWorkspaceBroker, applyAcceptedPredecessorPatches, listBase, readWorkspace, diffAgainstBase, SnapshotBudget } from '#adapters/index.js';
import { patchFile, patchDigest, patchExclusions, workspacePatchSchema, type WorkspacePatch, type WorkspacePatchError } from '#engine/index.js';
const gitExecutable = process.platform === 'win32' ? 'git.exe' : '/usr/bin/git';
const exec = promisify(execFile), roots: string[] = [];
const limits = { maxBytes: 65536, maxEntries: 100, maxDepth: 10, maxPathBytes: 256 };
const identity = { scopeId: 's', runId: 'r', taskId: 'b', attemptId: 'b1', generation: 1, layoutRevision: 'l' };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
type PatchCapability = { kind: 'available' } | { kind: 'unsupported'; code: WorkspacePatchError['code']; reason: string };
const patchCapability = (): PatchCapability => process.platform === 'linux' ? { kind: 'available' }
  : { kind: 'unsupported', code: 'PATCH_UNSAFE', reason: 'descriptor-relative workspace snapshots require Linux /proc; platform refusal is tested separately' };
function requirePatchCapability(context: TestContext) {
  const capability = patchCapability();
  if (capability.kind === 'unsupported') context.skip(`${capability.code}: ${capability.reason}`);
}
// Portable fixture supplies recorded custody only; the real patch port validates inputs before snapshot/I/O.
async function portableFixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-handoff-portable-')); roots.push(root);
  const workspace = join(root, 'checkout'); await mkdir(workspace); await writeFile(join(workspace, 'tracked'), 'base\n');
  const sourceBase = { schemaVersion: 1 as const, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'a'.repeat(64), baseCommit: 'b'.repeat(40),
    source: { schemaVersion: 1 as const, sourceRoot: root, repositoryRoot: root } };
  const lease = { schemaVersion: 1 as const, id: 'fixture', identity, workspace, baseCommit: sourceBase.baseCommit, sourceBase };
  const file = (text: string) => patchFile(Buffer.from(text), '100644');
  const source = { ...identity, taskId: 'a', attemptId: 'a1' };
  const patch: WorkspacePatch = { schemaVersion: 1, kind: 'workspace-patch', identity: source, baseCommit: lease.baseCommit,
    source: { schemaVersion: 1, adapter: sourceBase.adapter, sourceFingerprint: sourceBase.sourceFingerprint }, snapshotDigest: patchDigest('snapshot'),
    exclusions: patchExclusions, changes: [{ path: 'tracked', before: file('base\n'), after: file('accepted\n') }] };
  const receipt = { schemaVersion: 1 as const, scopeId: 's', digest: patchDigest(JSON.stringify(patch)), byteLength: Buffer.byteLength(JSON.stringify(patch)) };
  const options = { sourceRoot: root, workspaceRoot: root, gitExecutable: join(root, process.platform === 'win32' ? 'git.exe' : 'git'), timeoutMs: 10000, outputBytes: 65536 };
  return { root, options, lease, patch, file, start: { source, receipt, patch } };
}
async function fixture(context: TestContext) {
  requirePatchCapability(context);
  const root = await mkdtemp(join(tmpdir(), 'deckent-handoff-patch-')); roots.push(root);
  const sourceRoot = join(root, 'source'), workspaceRoot = join(root, 'workspaces'); await mkdir(sourceRoot); await mkdir(workspaceRoot);
  const git = async (...args: string[]) => (await exec(gitExecutable, ['-C', sourceRoot, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(sourceRoot, 'tracked'), 'base\n'); await git('add', 'tracked'); await git('commit', '-m', 'base');
  const options = { sourceRoot, workspaceRoot, gitExecutable, timeoutMs: 10000, outputBytes: 65536 };
  const broker = new GitWorkspaceBroker(options); const sourceBase = await broker.captureSourceBase();
  const lease = await broker.allocate({ schemaVersion: 1, identity, baseCommit: sourceBase.baseCommit });
  const source = { ...identity, taskId: 'a', attemptId: 'a1' };
  const file = (text: string) => patchFile(Buffer.from(text), '100644');
  const patch: WorkspacePatch = { schemaVersion: 1, kind: 'workspace-patch', identity: source, baseCommit: lease.baseCommit,
    source: { schemaVersion: 1, adapter: sourceBase.adapter, sourceFingerprint: sourceBase.sourceFingerprint }, snapshotDigest: patchDigest('snapshot'),
    exclusions: patchExclusions, changes: [{ path: 'tracked', before: file('base\n'), after: file('accepted\n') }] };
  const receipt = { schemaVersion: 1 as const, scopeId: 's', digest: patchDigest(JSON.stringify(patch)), byteLength: Buffer.byteLength(JSON.stringify(patch)) };
  return { root, options, broker, lease, patch, start: { source, receipt, patch }, file };
}
it('empty start list preserves fixed-base checkout byte-identically without a handoff sidecar', async () => {
  const f = await portableFixture();
  expect(await applyAcceptedPredecessorPatches(f.lease, f.options, limits, [])).toEqual([]);
  expect(await readFile(join(f.lease.workspace, 'tracked'), 'utf8')).toBe('base\n');
  expect(f.lease.baseCommit).toBe('b'.repeat(40));
  expect(await readdir(f.root)).toEqual(['checkout']);
});
it('applies accepted patch with a durable exact receipt, replays safely and keeps Run base unchanged', async context => {
  const f = await fixture(context);
  const receipt = await applyAcceptedPredecessorPatches(f.lease, f.options, limits, [f.start]);
  expect(receipt).toEqual([{ sourceTaskId: 'a', sourceAttemptId: 'a1', digest: f.start.receipt.digest }]);
  expect(await readFile(join(f.lease.workspace, 'tracked'), 'utf8')).toBe('accepted\n');
  expect((await f.broker.openRecorded(identity))?.baseCommit).toBe(f.lease.baseCommit);
  expect(await applyAcceptedPredecessorPatches(f.lease, f.options, limits, [f.start])).toEqual(receipt);
  const listing = await listBase(f.lease, f.options, new SnapshotBudget(limits, Date.now() + 10000));
  const current = await readWorkspace(f.lease.workspace, new SnapshotBudget(limits, Date.now() + 10000));
  expect(diffAgainstBase(listing, current, 'sha1')).toEqual(['tracked']);
  expect(current.get('tracked')!.text).toBe('accepted\n');
});
it('refuses incompatible before content and never writes even a preceding applicable change', async context => {
  const f = await fixture(context);
  const patch = { ...f.patch, changes: [{ path: 'added', before: null, after: f.file('new') }, { ...f.patch.changes[0]!, before: f.file('wrong') }] };
  const receipt = { ...f.start.receipt, digest: patchDigest(JSON.stringify(patch)), byteLength: Buffer.byteLength(JSON.stringify(patch)) };
  await expect(applyAcceptedPredecessorPatches(f.lease, f.options, limits, [{ ...f.start, receipt, patch }])).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
  await expect(readFile(join(f.lease.workspace, 'added'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(f.lease.workspace, 'tracked'), 'utf8')).toBe('base\n');
});
it.each(['wrong-base', 'wrong-source', 'wrong-attempt', 'digest-mismatch'] as const)('refuses %s before changing the checkout', async mode => {
  const f = await portableFixture();
  vi.spyOn(GitWorkspaceBroker.prototype, 'openRecorded').mockResolvedValue(f.lease);
  const patch = mode === 'wrong-base' ? { ...f.patch, baseCommit: '0'.repeat(40) } : mode === 'wrong-source' ? { ...f.patch, source: { ...f.patch.source, sourceFingerprint: '0'.repeat(64) } }
    : mode === 'wrong-attempt' ? { ...f.patch, identity: { ...f.patch.identity, attemptId: 'foreign' } } : f.patch;
  const outputBudget = vi.fn(() => 65536); Object.defineProperty(f.options, 'outputBytes', { get: outputBudget });
  const receipt = { ...f.start.receipt, digest: mode === 'digest-mismatch' ? '0'.repeat(64) : patchDigest(JSON.stringify(patch)), byteLength: Buffer.byteLength(JSON.stringify(patch)) };
  await expect(applyAcceptedPredecessorPatches(f.lease, f.options, limits, [{ ...f.start, receipt, patch }])).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
  expect(await readFile(join(f.lease.workspace, 'tracked'), 'utf8')).toBe('base\n');
  expect(await readdir(f.root)).toEqual(['checkout']);
  expect(outputBudget).toHaveBeenCalledTimes(1); // Broker option validation only; no sidecar/snapshot phase.
});
it('refuses a changed checkout on replay rather than silently blessing changed bytes', async context => {
  const f = await fixture(context); await applyAcceptedPredecessorPatches(f.lease, f.options, limits, [f.start]);
  await writeFile(join(f.lease.workspace, 'tracked'), 'foreign\n');
  await expect(applyAcceptedPredecessorPatches(f.lease, f.options, limits, [f.start])).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
});

it('portable before-content digest corruption refuses before any snapshot or checkout write', async () => {
  const f = await portableFixture(); vi.spyOn(GitWorkspaceBroker.prototype, 'openRecorded').mockResolvedValue(f.lease);
  const patch = { ...f.patch, changes: [{ ...f.patch.changes[0]!, before: { ...f.file('base\n'), digest: '0'.repeat(64) } }] };
  expect(workspacePatchSchema.safeParse(patch).success).toBe(false);
  const receipt = { ...f.start.receipt, digest: patchDigest(JSON.stringify(patch)), byteLength: Buffer.byteLength(JSON.stringify(patch)) };
  await expect(applyAcceptedPredecessorPatches(f.lease, f.options, limits, [{ ...f.start, receipt, patch }])).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
  expect(await readFile(join(f.lease.workspace, 'tracked'), 'utf8')).toBe('base\n');
  expect(await readdir(f.root)).toEqual(['checkout']);
});
it.each(['darwin', 'win32'] as const)('real snapshot %s capability refusal before path access (platform-property simulation on Linux)', async platform => {
  const f = await portableFixture(), original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  vi.spyOn(GitWorkspaceBroker.prototype, 'openRecorded').mockResolvedValue(f.lease);
  const before = await readdir(f.root);
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    // Missing path proves the real snapshot port refuses before realpath/open, independently of fixture custody.
    await expect(readWorkspace(join(f.root, 'never-created'), new SnapshotBudget(limits, Date.now() + 10000))).rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
    await expect(applyAcceptedPredecessorPatches(f.lease, f.options, limits, [f.start])).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
  } finally { Object.defineProperty(process, 'platform', original); }
  expect(await readdir(f.root)).toEqual(before); expect(await readdir(f.lease.workspace)).toEqual(['tracked']);
  expect(await readFile(join(f.lease.workspace, 'tracked'), 'utf8')).toBe('base\n');
});
it('unsupported native platform refuses the real snapshot before workspace/artifact/worker effects', async context => {
  if (process.platform === 'linux') context.skip('PATCH_UNSAFE: native non-Linux check verify-not-run on Linux; explicit property simulations run above');
  const f = await portableFixture();
  await expect(readWorkspace(join(f.root, 'never-created'), new SnapshotBudget(limits, Date.now() + 10000))).rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
  vi.spyOn(GitWorkspaceBroker.prototype, 'openRecorded').mockResolvedValue(f.lease);
  await expect(applyAcceptedPredecessorPatches(f.lease, f.options, limits, [f.start])).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
  expect(await readdir(dirname(f.lease.workspace))).toEqual(['checkout']);
  expect(await readFile(join(f.lease.workspace, 'tracked'), 'utf8')).toBe('base\n');
});

it.for(['darwin', 'win32'] as const)('full real retained Git lease refuses %s patch start (Linux capability simulation)', async (platform, context) => {
  const f = await fixture(context), original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const before = await readdir(dirname(f.lease.workspace));
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    await expect(applyAcceptedPredecessorPatches(f.lease, f.options, limits, [f.start])).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
  } finally { Object.defineProperty(process, 'platform', original); }
  expect(await readdir(dirname(f.lease.workspace))).toEqual(before);
  expect(await readFile(join(f.lease.workspace, 'tracked'), 'utf8')).toBe('base\n');
  expect((await f.broker.openRecorded(identity))?.baseCommit).toBe(f.lease.baseCommit);
});
