import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorkspaceBroker, applyAcceptedPredecessorPatches, completeHiddenBase, diffAgainstBase, hashAlgorithmOf, listBase, readBaseBlobs, readWorkspace,
  SnapshotBudget, type GitWorkspaceLease } from '#adapters/index.js';
import { assertPatchScope, capturedWorkspacePatch, classifyPatchScope, patchDigest, patchExclusions, patchFile, type WorkspacePatch } from '#engine/index.js';
import { workspacePathHidden } from '#domain/index.js';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };

/** C2 (owner Q4 2026-10-23, law-audit fold 5): a Cursor worker's checkout without the instruction surface yields the same patch as a full one. */
const exec = promisify(execFile), roots: string[] = [], limits = { maxBytes: 1_048_576, maxEntries: 1000, maxDepth: 16, maxPathBytes: 512 };
const HIDDEN = registry.instructionSurface.hiddenPaths;
const BASE: Record<string, string> = { 'AGENTS.md': 'root agents\n', 'CLAUDE.md': '@DECKENT.md\n', 'DECKENT.md': 'terminal instructions\n',
  'lib/DECKENT.md': 'nested, not root: stays\n', 'lib/a.ts': 'export const a = 1;\n', 'sub/AGENTS.md': 'nested agents\n',
  '.agents/skills/x/SKILL.md': 'skill\n', '.cursor/rules/r.mdc': 'rule\n', '.claude/s.md': 'claude\n', '.deckent/worker-instructions.md': 'admitted snapshot source\n',
  'src/code.ts': 'export const code = 1;\n' };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-checkout-shaping-')); roots.push(root);
  const sourceRoot = join(root, 'source'), workspaceRoot = join(root, 'workspaces'); await mkdir(sourceRoot); await mkdir(workspaceRoot);
  const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd, ...args], { timeout: 10000 })).stdout.trim();
  await git(sourceRoot, 'init', '-q'); await git(sourceRoot, 'config', 'user.name', 'Fixture'); await git(sourceRoot, 'config', 'user.email', 'fixture@example.invalid');
  for (const [path, text] of Object.entries(BASE)) { await mkdir(dirname(join(sourceRoot, path)), { recursive: true }); await writeFile(join(sourceRoot, path), text); }
  await git(sourceRoot, 'add', '-A'); await git(sourceRoot, 'commit', '-qm', 'base');
  const options = { sourceRoot, workspaceRoot, gitExecutable: (await exec('which', ['git'])).stdout.trim(), timeoutMs: 10000, outputBytes: 1_048_576 };
  const broker = new GitWorkspaceBroker(options), base = await broker.captureSourceBase();
  const identity = (attemptId: string, taskId = 't') => ({ runId: 'r', taskId, attemptId, scopeId: 's', generation: 1, layoutRevision: 'l' });
  const allocate = (attemptId: string, hidden?: readonly string[], taskId?: string) => broker.allocate({ schemaVersion: 1, identity: identity(attemptId, taskId), baseCommit: base.baseCommit }, hidden);
  return { git, options, broker, base, identity, allocate };
}
/** The capture path of GitWorkspacePatchSource after its custody checks, with one fixed identity stamp so whole patches compare. */
async function capture(f: Awaited<ReturnType<typeof fixture>>, lease: GitWorkspaceLease, hidden: readonly string[] | null) {
  const budget = () => new SnapshotBudget(limits, Date.now() + 10000), listing = await listBase(lease, f.options, budget()), algorithm = hashAlgorithmOf(lease.baseCommit);
  const after = await completeHiddenBase(lease, f.options, budget(), { listing, algorithm }, hidden, await readWorkspace(lease.workspace, budget(), { listing, algorithm }));
  const changed = diffAgainstBase(listing, after, algorithm);
  const before = await readBaseBlobs(lease, f.options, budget(), changed.flatMap(path => { const entry = listing.get(path); return entry ? [[path, entry] as const] : []; }));
  return capturedWorkspacePatch(f.identity('stamp'), { schemaVersion: 1, adapter: f.base.adapter, sourceFingerprint: f.base.sourceFingerprint }, lease.baseCommit, changed, before, after);
}
const work = async (workspace: string) => {
  await writeFile(join(workspace, 'src/code.ts'), 'export const code = 2;\n'); await writeFile(join(workspace, 'src/new.ts'), 'export {};\n'); await unlink(join(workspace, 'lib/a.ts'));
};

describe.skipIf(process.platform !== 'linux')('worker checkout shaping (C2): sparse clone without the instruction surface', () => {
  it('leaves out exactly the hidden set, keeps everything else and starts with a clean git status', async () => {
    const f = await fixture(), lease = await f.allocate('sparse', HIDDEN);
    const tracked = (await f.git(lease.workspace, 'ls-files')).split('\n');
    const present = (await exec('find', ['.', '-path', './.git', '-prune', '-o', '-type', 'f', '-print'], { cwd: lease.workspace })).stdout.trim().split('\n').map(path => path.slice(2)).sort();
    expect(present).toEqual(tracked.filter(path => !workspacePathHidden(path, HIDDEN)).sort());
    expect(present).toEqual(['lib/DECKENT.md', 'lib/a.ts', 'src/code.ts']);
    expect(await f.git(lease.workspace, 'status', '--porcelain')).toBe('');
    // The shape is the clone's own config, so the worker's Git keeps it; reopening the same attempt reuses the clone unchanged.
    expect(await f.git(lease.workspace, 'config', 'core.sparseCheckout')).toBe('true');
    expect(await f.allocate('sparse', HIDDEN)).toEqual(lease);
    // Without a hidden set (verification, integration, argv-realised workers) the checkout is full.
    const full = await f.allocate('full');
    expect((await exec('find', ['.', '-path', './.git', '-prune', '-o', '-type', 'f', '-print'], { cwd: full.workspace })).stdout.trim().split('\n')).toHaveLength(tracked.length);
  });

  it('gives the same patch, digest and changed files for the same work in a sparse and a full checkout; no hidden file is deleted', async () => {
    const f = await fixture(), sparse = await f.allocate('sparse', HIDDEN), full = await f.allocate('full');
    await work(sparse.workspace); await work(full.workspace);
    const shaped = await capture(f, sparse, HIDDEN), plain = await capture(f, full, null);
    expect(shaped.changes.map(change => change.path)).toEqual(['lib/a.ts', 'src/code.ts', 'src/new.ts']);
    expect(patchDigest(JSON.stringify(shaped))).toBe(patchDigest(JSON.stringify(plain)));
    expect(shaped.snapshotDigest).toBe(plain.snapshotDigest);
    // Negative: the completion is load-bearing — read without the pinned set, the absent instruction files are deletions.
    const unpinned = await capture(f, sparse, null);
    expect(unpinned.changes.filter(change => change.after === null).map(change => change.path)).toEqual(expect.arrayContaining(['AGENTS.md', 'CLAUDE.md', 'DECKENT.md', 'sub/AGENTS.md', '.agents/skills/x/SKILL.md']));
  });

  it('keeps a worker write to a hidden path visible in the patch, never dropped', async () => {
    const f = await fixture(), lease = await f.allocate('sparse', HIDDEN);
    await writeFile(join(lease.workspace, 'AGENTS.md'), 'worker rewrote the instructions\n');
    await mkdir(join(lease.workspace, '.agents'), { recursive: true }); await writeFile(join(lease.workspace, '.agents/added.md'), 'new\n');
    const patch = await capture(f, lease, HIDDEN);
    expect(patch.changes).toEqual([
      { path: '.agents/added.md', before: null, after: patchFile(Buffer.from('new\n'), '100644') },
      { path: 'AGENTS.md', before: patchFile(Buffer.from(BASE['AGENTS.md']!), '100644'), after: patchFile(Buffer.from('worker rewrote the instructions\n'), '100644') }]);
    // A worker restoring hidden files with their base content (e.g. `git sparse-checkout disable`) is no change at all.
    for (const path of ['AGENTS.md', 'CLAUDE.md']) await writeFile(join(lease.workspace, path), BASE[path]!);
    expect((await capture(f, lease, HIDDEN)).changes.map(change => change.path)).toEqual(['.agents/added.md']);
  });

  it('G1: a sparse worker overwriting an instruction file it never saw is refused at delivery unless the task scope names it', async () => {
    const f = await fixture(), lease = await f.allocate('sparse', HIDDEN);
    await writeFile(join(lease.workspace, 'CLAUDE.md'), 'overwritten blind\n'); await writeFile(join(lease.workspace, 'src/code.ts'), 'export const code = 3;\n');
    const patch = await capture(f, lease, HIDDEN);
    expect(patch.changes.map(change => change.path)).toEqual(['CLAUDE.md', 'src/code.ts']);
    const blind = classifyPatchScope(patch, ['src/**'], 'warn', HIDDEN);
    expect(blind.instructionSurface).toEqual(['CLAUDE.md']);
    expect(() => assertPatchScope(blind)).toThrow(expect.objectContaining({ code: 'PATCH_INSTRUCTION_SURFACE_WRITE' }));
    expect(() => assertPatchScope(classifyPatchScope(patch, ['src/**', 'CLAUDE.md'], 'warn', HIDDEN))).not.toThrow();
  });

  it('starts a shaped attempt from predecessor patches, including one that changes a hidden path', async () => {
    const f = await fixture(), lease = await f.allocate('b1', HIDDEN, 'b'), file = (text: string) => patchFile(Buffer.from(text), '100644');
    const source = f.identity('a1', 'a'), patch: WorkspacePatch = { schemaVersion: 1, kind: 'workspace-patch', identity: source, baseCommit: lease.baseCommit,
      source: { schemaVersion: 1, adapter: f.base.adapter, sourceFingerprint: f.base.sourceFingerprint }, snapshotDigest: patchDigest('a'), exclusions: patchExclusions,
      changes: [{ path: 'AGENTS.md', before: file(BASE['AGENTS.md']!), after: file('predecessor changed it\n') }, { path: 'src/code.ts', before: file(BASE['src/code.ts']!), after: file('a\n') }] };
    const start = { source, patch, receipt: { schemaVersion: 1 as const, scopeId: 's', digest: patchDigest(JSON.stringify(patch)), byteLength: Buffer.byteLength(JSON.stringify(patch)) } };
    // Without the pinned set the absent hidden files make the start tree unprovable (refused, never applied over a guess).
    await expect(applyAcceptedPredecessorPatches(lease, f.options, limits, [start])).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
    const applied = await applyAcceptedPredecessorPatches(lease, f.options, limits, [start], HIDDEN);
    expect(applied.receipts).toEqual([{ source, digest: start.receipt.digest }]);
    expect(await readFile(join(lease.workspace, 'AGENTS.md'), 'utf8')).toBe('predecessor changed it\n');
    expect(await applyAcceptedPredecessorPatches(lease, f.options, limits, [start], HIDDEN)).toEqual(applied);
  });
});
