import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GitWorkspaceBroker, applyAcceptedPredecessorPatches, listBase, readWorkspace, diffAgainstBase, SnapshotBudget } from '#adapters/index.js';
import { patchFile, patchDigest, patchExclusions, type WorkspacePatch } from '#engine/index.js';
const exec = promisify(execFile), roots: string[] = [];
const limits = { maxBytes: 65536, maxEntries: 100, maxDepth: 10, maxPathBytes: 256 };
const identity = { scopeId: 's', runId: 'r', taskId: 'b', attemptId: 'b1', generation: 1, layoutRevision: 'l' };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-handoff-patch-')); roots.push(root);
  const sourceRoot = join(root, 'source'), workspaceRoot = join(root, 'workspaces'); await mkdir(sourceRoot); await mkdir(workspaceRoot);
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', sourceRoot, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(sourceRoot, 'tracked'), 'base\n'); await git('add', 'tracked'); await git('commit', '-m', 'base');
  const options = { sourceRoot, workspaceRoot, gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 };
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
  const f = await fixture();
  expect(await applyAcceptedPredecessorPatches(f.lease, f.options, limits, [])).toEqual([]);
  expect(await readFile(join(f.lease.workspace, 'tracked'), 'utf8')).toBe('base\n');
  expect((await f.broker.openRecorded(identity))?.baseCommit).toBe(f.lease.baseCommit);
});
it('applies accepted patch with a durable exact receipt, replays safely and keeps Run base unchanged', async () => {
  const f = await fixture();
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
it('refuses incompatible before content and never writes even a preceding applicable change', async () => {
  const f = await fixture();
  const patch = { ...f.patch, changes: [{ path: 'added', before: null, after: f.file('new') }, { ...f.patch.changes[0]!, before: f.file('wrong') }] };
  const receipt = { ...f.start.receipt, digest: patchDigest(JSON.stringify(patch)), byteLength: Buffer.byteLength(JSON.stringify(patch)) };
  await expect(applyAcceptedPredecessorPatches(f.lease, f.options, limits, [{ ...f.start, receipt, patch }])).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
  await expect(readFile(join(f.lease.workspace, 'added'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(f.lease.workspace, 'tracked'), 'utf8')).toBe('base\n');
});
it.each(['wrong-base', 'wrong-source', 'wrong-attempt', 'digest-mismatch'] as const)('refuses %s before changing the checkout', async mode => {
  const f = await fixture();
  const patch = mode === 'wrong-base' ? { ...f.patch, baseCommit: '0'.repeat(40) } : mode === 'wrong-source' ? { ...f.patch, source: { ...f.patch.source, sourceFingerprint: '0'.repeat(64) } }
    : mode === 'wrong-attempt' ? { ...f.patch, identity: { ...f.patch.identity, attemptId: 'foreign' } } : f.patch;
  const receipt = { ...f.start.receipt, digest: mode === 'digest-mismatch' ? '0'.repeat(64) : patchDigest(JSON.stringify(patch)), byteLength: Buffer.byteLength(JSON.stringify(patch)) };
  await expect(applyAcceptedPredecessorPatches(f.lease, f.options, limits, [{ ...f.start, receipt, patch }])).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
  expect(await readFile(join(f.lease.workspace, 'tracked'), 'utf8')).toBe('base\n');
});
it('refuses a changed checkout on replay rather than silently blessing changed bytes', async () => {
  const f = await fixture(); await applyAcceptedPredecessorPatches(f.lease, f.options, limits, [f.start]);
  await writeFile(join(f.lease.workspace, 'tracked'), 'foreign\n');
  await expect(applyAcceptedPredecessorPatches(f.lease, f.options, limits, [f.start])).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
});
