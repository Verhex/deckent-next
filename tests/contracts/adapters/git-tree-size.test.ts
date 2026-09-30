import { describe, expect, it, vi } from 'vitest';
import { listBase, SnapshotBudget } from '#adapters/core/git-patch/index.js';
import type { GitWorkspaceLease, GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';

const fixture = vi.hoisted(() => ({ stdout: Buffer.alloc(0) }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(() => {}, {
  [Symbol.for('nodejs.util.promisify.custom')]: async () => ({ stdout: fixture.stdout }),
}) }));
const oid = 'a'.repeat(40);
// Git v2.55.0 show_tree_long: %06o %s %s %7s\t, followed by the -z path.
// An unreadable blob emits BAD with success exit status (not malformed tree syntax).
// Source checked 2026-09-30: https://github.com/git/git/blob/v2.55.0/builtin/ls-tree.c
async function listing(record: string) {
  fixture.stdout = Buffer.from(record);
  const lease = { baseCommit: oid, sourceBase: { source: { repositoryRoot: '/repo' } } } as unknown as GitWorkspaceLease;
  const options = { gitExecutable: '/usr/bin/git', outputBytes: 65536 } as GitWorkspaceOptions;
  return listBase(lease, options, new SnapshotBudget({ maxBytes: 65536, maxEntries: 10, maxDepth: 10, maxPathBytes: 1024 }, Date.now() + 10_000));
}

describe('Git long tree size protocol', () => {
  it('reports an unreadable blob as unavailable, including SHA-256 object ids', async () => {
    for (const object of [oid, 'b'.repeat(64)]) {
      await expect(listing(`100644 blob ${object}     BAD\tfile.txt\0`)).rejects.toMatchObject({ code: 'PATCH_UNAVAILABLE' });
    }
  });
  it('retains numeric size and executable mode', async () => {
    expect(await listing(`100755 blob ${oid}       3\tfile.txt\0`)).toEqual(new Map([['file.txt', { mode: '100755', oid, size: 3 }]]));
  });
  it('still rejects malformed sizes and unsafe paths, and refuses submodules', async () => {
    for (const size of ['oops', '-1', '3x']) {
      await expect(listing(`100644 blob ${oid} ${size}\tfile.txt\0`)).rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
    }
    await expect(listing(`100644 blob ${oid}     BAD\t../escape\0`)).rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
    await expect(listing(`160000 commit ${oid}       -\tsubmodule\0`)).rejects.toMatchObject({ code: 'PATCH_UNSUPPORTED' });
  });
});
