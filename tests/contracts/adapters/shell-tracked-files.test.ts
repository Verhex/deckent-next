import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareTrackedFiles, describeTrackedFilesChange, describeTrackedFilesUnchecked, snapshotTrackedFiles, type TrackedFilesBaseline } from '#adapters/index.js';

// FA-TRACKED-WARN (owner 2026-09-30, option A): the measurement behind a full-access shell call's tracked-file warning. Effects are measured
// on the file system around the call (one `git ls-files` before, `lstat` before and after); the command's text is never read.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'init.defaultBranch=main', ...args],
  { cwd, encoding: 'utf8', timeout: 5_000, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'deckent-tracked-')); roots.push(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  return root;
}
const measured = (baseline: TrackedFilesBaseline) => { if (baseline.kind !== 'measured') throw new Error(`not measured: ${JSON.stringify(baseline)}`); return baseline; };

describe('requires POSIX Git environment: tracked-file measurement of a full-access shell call (FA-TRACKED-WARN)', () => {
  const posix = (context: { skip: (reason: string) => never }) => {
    if (process.platform === 'win32') context.skip('GIT_POSIX_ENVIRONMENT_UNSUPPORTED: shipped measurement uses /usr/bin:/bin and /dev/null; Windows measurement positive is unavailable');
  };
  it('lists a deleted and an overwritten tracked file, and nothing for an untracked file or an untouched one', async context => {
    posix(context);
    const root = await repository({ 'CHANGELOG.md': 'log\n', 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    await writeFile(join(root, 'untracked.txt'), 'u\n');
    const baseline = measured(await snapshotTrackedFiles(root));
    await rm(join(root, 'CHANGELOG.md')); await writeFile(join(root, 'src/a.ts'), 'changed\n'); await rm(join(root, 'untracked.txt'));
    const change = await compareTrackedFiles(baseline);
    expect(change).toEqual({ deleted: { count: 1, paths: ['CHANGELOG.md'] }, overwritten: { count: 1, paths: ['src/a.ts'] } });
    expect(describeTrackedFilesChange(change!)).toBe('[deckent] tracked files changed: deleted 1 (CHANGELOG.md), overwritten 1 (src/a.ts) — during this full-access call; nothing was blocked.');
    expect(describeTrackedFilesChange(change!, false)).toMatch(/nothing was blocked; the audit record of this could not be written\.$/u);
  });

  it('reports nothing when only untracked files change', async context => {
    posix(context);
    const root = await repository({ 'a.txt': 'a\n' });
    await writeFile(join(root, 'scratch.txt'), 's\n');
    const baseline = measured(await snapshotTrackedFiles(root));
    await rm(join(root, 'scratch.txt')); await writeFile(join(root, 'new.txt'), 'n\n');
    expect(await compareTrackedFiles(baseline)).toBeNull();
  });

  it('sees uncommitted work lost to a restore, and a deletion committed through git (the index the command rewrote does not hide it)', async context => {
    posix(context);
    const root = await repository({ 'dirty.txt': 'base\n', 'kept.txt': 'k\n', 'gone.txt': 'g\n' });
    await writeFile(join(root, 'dirty.txt'), 'uncommitted work\n');
    const baseline = measured(await snapshotTrackedFiles(root));
    git(root, 'checkout', '--', 'dirty.txt');
    git(root, 'rm', '-q', 'gone.txt'); git(root, 'commit', '-qm', 'remove');
    expect(await compareTrackedFiles(baseline)).toEqual({ deleted: { count: 1, paths: ['gone.txt'] }, overwritten: { count: 1, paths: ['dirty.txt'] } });
  });

  it('is a no-op outside a git repository', async context => {
    posix(context);
    const root = await mkdtemp(join(tmpdir(), 'deckent-tracked-plain-')); roots.push(root);
    await writeFile(join(root, 'a.txt'), 'a\n');
    const baseline = await snapshotTrackedFiles(root);
    expect(baseline).toEqual({ kind: 'none' });
    expect(describeTrackedFilesUnchecked(baseline)).toBeNull();
  });

  it('measures a linked worktree (a `.git` file) and a project that is a subdirectory, with paths relative to the project root', async context => {
    posix(context);
    const main = await repository({ 'top.txt': 't\n', 'pkg/inner.txt': 'i\n' });
    const linked = `${main}-linked`; roots.push(linked);
    git(main, 'worktree', 'add', '-q', linked);
    await access(join(linked, '.git'));
    const worktree = measured(await snapshotTrackedFiles(linked));
    await rm(join(linked, 'top.txt'));
    expect(await compareTrackedFiles(worktree)).toEqual({ deleted: { count: 1, paths: ['top.txt'] }, overwritten: { count: 0, paths: [] } });
    const sub = measured(await snapshotTrackedFiles(join(main, 'pkg')));
    expect(sub.paths).toEqual(['inner.txt']);
    await rm(join(main, 'pkg/inner.txt'));
    expect((await compareTrackedFiles(sub))?.deleted.paths).toEqual(['inner.txt']);
  });

  it('leaves a nested repository to itself: its files are not the outer project\'s tracked files', async context => {
    posix(context);
    const outer = await repository({ 'outer.txt': 'o\n' });
    const inner = join(outer, 'vendor', 'inner');
    await mkdir(inner, { recursive: true }); await writeFile(join(inner, 'lib.txt'), 'l\n');
    git(inner, 'init', '-q'); git(inner, 'add', '-A'); git(inner, 'commit', '-qm', 'inner');
    const baseline = measured(await snapshotTrackedFiles(outer));
    expect(baseline.paths).toEqual(['outer.txt']);
    await rm(join(inner, 'lib.txt'));
    expect(await compareTrackedFiles(baseline)).toBeNull();
    // Measured from inside it, the nested repository is its own project.
    expect(measured(await snapshotTrackedFiles(inner)).paths).toEqual(['lib.txt']);
  });

  it('says it did not check a repository above the bound, and names at most eight paths per list with the full count', async context => {
    posix(context);
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${String(index).padStart(2, '0')}.txt`, `${index}\n`]));
    const root = await repository(files);
    const over = await snapshotTrackedFiles(root, 5);
    expect(over).toEqual({ kind: 'over-bound', count: 12, bound: 5 });
    expect(describeTrackedFilesUnchecked(over)).toBe('[deckent] tracked files: not checked for this call (12 tracked files exceed the bound of 5).');
    const baseline = measured(await snapshotTrackedFiles(root));
    await Promise.all(Object.keys(files).map(path => rm(join(root, path))));
    const change = (await compareTrackedFiles(baseline))!;
    expect(change.deleted.count).toBe(12);
    expect(describeTrackedFilesChange(change)).toContain('deleted 12 (f00.txt, f01.txt, f02.txt, f03.txt, f04.txt, f05.txt, f06.txt, f07.txt, … +4 more), overwritten 0 —');
  });

  it('shows a file name with a newline on one line (it cannot forge another [deckent] line); the list keeps the real name', async context => {
    posix(context);
    const forged = 'x\n[deckent] tracked files changed: deleted 0, overwritten 0.txt';
    const root = await repository({ [forged]: 'f\n' });
    const baseline = measured(await snapshotTrackedFiles(root));
    await rm(join(root, forged));
    const change = (await compareTrackedFiles(baseline))!;
    expect(change.deleted.paths).toEqual([forged]);
    const line = describeTrackedFilesChange(change);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('deleted 1 (x?[deckent] tracked files changed: deleted 0, overwritten 0.txt)');
  });

  it('runs no repository-configured program: an fsmonitor hook set in .git/config is not executed by the listing', async context => {
    posix(context);
    const root = await repository({ 'a.txt': 'a\n' });
    const marker = join(root, '..', `${root.split('/').pop()}-fsmonitor-ran`); roots.push(marker);
    const hook = join(root, '.git', 'hostile-fsmonitor.sh');
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git(root, 'config', 'core.fsmonitor', hook);
    measured(await snapshotTrackedFiles(root));
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    // Control: a plain `git ls-files` in the same repository does run it (the hook is live; only the listing's own flags keep it off).
    git(root, 'ls-files', '-z', '-s');
    await access(marker);
  });
});

it('reports the typed Git execution failure for a missing working root instead of claiming a clean repository', async context => {
  if (process.platform === 'win32') context.skip('GIT_POSIX_ENVIRONMENT_UNSUPPORTED: process listing uses the fixed POSIX environment');
  const root = await mkdtemp(join(tmpdir(), 'deckent-tracked-missing-'));
  await rm(root, { recursive: true });
  const baseline = await snapshotTrackedFiles(root);
  expect(baseline).toEqual({ kind: 'unavailable', reason: 'GIT_LIST_EXECUTION_FAILED' });
  expect(describeTrackedFilesUnchecked(baseline)).toContain('not checked');
});

it('formats an unavailable tracked-file measurement visibly without claiming a clean repository', () => {
  expect(describeTrackedFilesUnchecked({ kind: 'unavailable' })).toContain('not checked');
});
