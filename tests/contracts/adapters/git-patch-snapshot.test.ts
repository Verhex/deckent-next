import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, unlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspacePatchError } from '#engine/index.js';
import type { GitWorkspaceLease, GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { diffAgainstBase, gitBlobOid, gitFailure, hashAlgorithmOf, listBase, readBaseBlobs, readWorkspace, SnapshotBudget } from '#adapters/core/git-patch/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

const exec = promisify(execFile); const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const limits = { maxBytes: 64 * 1024 * 1024, maxEntries: 10000, maxDepth: 32, maxPathBytes: 1024 };
const FILES = 1500;
async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deckent-snapshot-'))); roots.push(root);
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', root, ...args])).stdout.trim();
  await git('init', '-q'); await git('config', 'user.email', 't@example.invalid'); await git('config', 'user.name', 'T');
  for (let i = 0; i < FILES; i++) {
    const dir = join(root, `dir${i % 40}`); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `file${i}.txt`), `content ${i}\n`);
  }
  await git('add', '-A'); await git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  const head = await git('rev-parse', 'HEAD');
  const lease = { baseCommit: head, workspace: root, sourceBase: { source: { repositoryRoot: root } } } as unknown as GitWorkspaceLease;
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
});
