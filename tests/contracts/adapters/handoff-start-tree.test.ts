import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { GitWorkspaceBroker, applyAcceptedPredecessorPatches, readWorkspace, snapshotDigest, SnapshotBudget } from '#adapters/index.js';
import { patchFile, patchDigest, patchExclusions, type WorkspacePatch } from '#engine/index.js';
const exec = promisify(execFile), limits = { maxBytes: 65536, maxEntries: 100, maxDepth: 10, maxPathBytes: 256 };
const identity = { runId: 'r', taskId: 'b', attemptId: 'b1', scopeId: 's', layoutRevision: 'l', generation: 1 };

it('empty fixed-base start returns no fabricated G2 and performs no workspace access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-empty-'));
  try {
    const options = { sourceRoot: root, workspaceRoot: root, gitExecutable: join(root, 'never-run'), timeoutMs: 10000, outputBytes: 65536 };
    const lease = { schemaVersion: 1 as const, id: 'fixture', identity, workspace: join(root, 'never-opened'), baseCommit: 'b'.repeat(40) };
    expect(await applyAcceptedPredecessorPatches(lease, options, limits, [])).toEqual({ receipts: [], bindingDigest: undefined, snapshotDigest: undefined });
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('returns one verified start-tree pair for multiple exact sources, preserving alpha.28 private binding bytes', async context => {
  if (process.platform !== 'linux') {
    await expect(readWorkspace(join(tmpdir(), 'never-opened-handoff'), new SnapshotBudget(limits, Date.now() + 10000)))
      .rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
    context.skip('PATCH_UNSAFE: pre-access refusal verified; real Git G2 verify-not-run outside Linux');
  }
  const root = await mkdtemp(join(tmpdir(), 'handoff-tree-')), sourceRoot = join(root, 'source'), workspaceRoot = join(root, 'workspaces');
  try {
    await mkdir(sourceRoot); await mkdir(workspaceRoot);
    const git = async (...args: string[]) => (await exec('git', ['-C', sourceRoot, ...args], { timeout: 10000 })).stdout.trim();
    await git('init'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(sourceRoot, 'tracked'), 'base\n'); await git('add', '.'); await git('commit', '-m', 'base');
    const options = { sourceRoot, workspaceRoot, gitExecutable: (await exec('which', ['git'])).stdout.trim(), timeoutMs: 10000, outputBytes: 65536 };
    const broker = new GitWorkspaceBroker(options), sourceBase = await broker.captureSourceBase();
    const lease = await broker.allocate({ schemaVersion: 1, identity, baseCommit: sourceBase.baseCommit });
    const file = (text: string) => patchFile(Buffer.from(text), '100644');
    const starts = ['a', 'c'].map(taskId => {
      const source = { ...identity, taskId, attemptId: taskId + '1' };
      const patch: WorkspacePatch = { schemaVersion: 1, kind: 'workspace-patch', identity: source, baseCommit: lease.baseCommit,
        source: { schemaVersion: 1, adapter: sourceBase.adapter, sourceFingerprint: sourceBase.sourceFingerprint },
        snapshotDigest: patchDigest(taskId), exclusions: patchExclusions,
        changes: [{ path: taskId, before: null, after: file(taskId) }] };
      return { source, patch, receipt: { schemaVersion: 1 as const, scopeId: 's', digest: patchDigest(JSON.stringify(patch)), byteLength: Buffer.byteLength(JSON.stringify(patch)) } };
    });
    const before = snapshotDigest(await readWorkspace(lease.workspace, new SnapshotBudget(limits, Date.now() + 10000)));
    const applied = await applyAcceptedPredecessorPatches(lease, options, limits, starts);
    const current = snapshotDigest(await readWorkspace(lease.workspace, new SnapshotBudget(limits, Date.now() + 10000)));
    expect(applied.receipts).toEqual(starts.map(start => ({ source: start.source, digest: start.receipt.digest })));
    expect(applied.snapshotDigest).toBe(current); expect(current).not.toBe(before);
    expect(starts.every(start => start.patch.snapshotDigest !== current)).toBe(true);
    const bindingDigest = patchDigest(JSON.stringify({ identity: lease.identity, baseCommit: lease.baseCommit,
      receipts: starts.map(start => ({ sourceTaskId: start.source.taskId, sourceAttemptId: start.source.attemptId, digest: start.receipt.digest })) }));
    expect(applied.bindingDigest).toBe(bindingDigest);
    const path = join(dirname(lease.workspace), 'handoff-start.json'), bytes = await readFile(path, 'utf8');
    expect(JSON.parse(bytes)).toEqual({ schemaVersion: 1, state: 'ready', bindingDigest, snapshotDigest: current });
    // This sidecar retains the alpha.28 shape and digest algorithm; replay must return its recorded digest.
    expect(await applyAcceptedPredecessorPatches(lease, options, limits, starts)).toEqual(applied);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect((await broker.openRecorded(identity))!.baseCommit).toBe(lease.baseCommit);
    await writeFile(join(lease.workspace, 'a'), 'foreign');
    await expect(applyAcceptedPredecessorPatches(lease, options, limits, starts)).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(await readFile(join(sourceRoot, 'tracked'), 'utf8')).toBe('base\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
