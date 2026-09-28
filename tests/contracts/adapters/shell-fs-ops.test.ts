import { statfsSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ASYNC_FS_OPS, buildLandlockRules, fsOpsFor, LOCAL_FILESYSTEM_TYPES, scanGitDirectory, SYNC_FS_OPS } from '#adapters/core/host-shell/index.js';
import { resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { createWorkspaceScope } from '#adapters/index.js';

// SANDBOX-SPEED: the scan reads synchronously on a local file system and asynchronously elsewhere. The choice is a latency matter only:
// the verdict (what is masked, which rules exist) must be identical in both flavours, and the choice must fail toward async.
const roots: string[] = [], locked: string[] = [];
afterEach(async () => {
  for (const dir of locked.splice(0)) await chmod(dir, 0o700).catch(() => undefined);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('file system read selection (fsOpsFor)', () => {
  const type = (value: number) => () => ({ type: value });
  it('reads synchronously only on a positively identified local type', () => {
    for (const local of [0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630]) expect(fsOpsFor('/x', type(local)).kind).toBe('sync');
    expect([...LOCAL_FILESYSTEM_TYPES].every(value => Number.isInteger(value))).toBe(true);
  });
  it('keeps asynchronous reads on 9p/drvfs, NFS, SMB, FUSE, an unknown type and a failing statfs', () => {
    for (const remote of [0x01021997, 0x6969, 0xff534d42, 0x65735546, 0x12345678, 0]) expect(fsOpsFor('/x', type(remote)).kind).toBe('async');
    expect(fsOpsFor('/x', () => { throw new Error('ENOSYS'); }).kind).toBe('async');
  });
  it('is decided by the real file system of the directory it is asked about', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dn-fsops-')); roots.push(dir);
    expect(fsOpsFor(dir).kind).toBe(LOCAL_FILESYSTEM_TYPES.has(statfsSync(dir).type) ? 'sync' : 'async');
    expect(fsOpsFor(join(dir, 'missing')).kind).toBe('async');
  });
  it('both flavours read the same: entries, link counts, and an unreadable path is an error / suspect link count', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dn-fsops-')); roots.push(dir);
    await writeFile(join(dir, 'a'), 'a'); await link(join(dir, 'a'), join(dir, 'b')); await writeFile(join(dir, 'c'), 'c');
    for (const ops of [SYNC_FS_OPS, ASYNC_FS_OPS]) {
      expect((await ops.readdir(dir)).map(entry => entry.name).sort()).toEqual(['a', 'b', 'c']);
      expect([await ops.nlink(join(dir, 'a')), await ops.nlink(join(dir, 'c'))]).toEqual([2, 1]);
      expect(await ops.nlink(join(dir, 'missing'))).toBe(2);
      await expect(Promise.resolve().then(() => ops.readdir(join(dir, 'missing')))).rejects.toThrow();
    }
  });
});

/** A project with everything the scans decide on: protected files, a hard-linked alias, a link, an unreadable directory, a `.git` with a foreign hard link. */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dn-fsops-')); roots.push(base);
  const root = join(base, 'project'), outside = join(base, 'outside');
  for (const dir of [join(root, '.git', 'objects', 'ab'), join(root, 'src', 'deep'), join(root, 'pkg'), join(root, 'node_modules', 'x'), join(root, 'locked'), outside]) await mkdir(dir, { recursive: true });
  await Promise.all([writeFile(join(root, '.env'), 'SECRET=1\n'), writeFile(join(root, 'pkg', '.env'), 'DEEP=1\n'), writeFile(join(root, 'pkg', 'p.ts'), 'export {};\n'),
    writeFile(join(root, 'src', 'deep', 'a.ts'), 'a\n'), writeFile(join(root, 'node_modules', 'x', 'i.js'), ''), writeFile(join(root, 'locked', 'z'), 'z'),
    writeFile(join(root, '.git', 'config'), '[core]\n'), writeFile(join(root, '.git', 'objects', 'ab', 'cd'), 'not an object\n'), writeFile(join(outside, 'secret'), 'OUT\n')]);
  await link(join(root, '.env'), join(root, 'src', 'alias.txt')); await link(join(root, '.env'), join(root, '.git', 'objects', 'alias'));
  await symlink(outside, join(root, 'src', 'out'));
  await chmod(join(root, 'locked'), 0o000); locked.push(join(root, 'locked'));
  const scope = await createWorkspaceScope(root);
  return { root: scope.root, layout: { project: scope, scratchDir: null } };
}

describe('the scan verdict does not depend on the read flavour', () => {
  const environment = { HOME: '/nonexistent-home', PATH: '/usr/bin:/bin' };
  it('bubblewrap: the same view from synchronous, asynchronous and default reads', async () => {
    const f = await fixture();
    const [sync, async, auto] = await Promise.all([SYNC_FS_OPS, ASYNC_FS_OPS, undefined].map(ops => resolveBubblewrapView(f.layout, environment, ops ? { fsOps: () => ops } : {})));
    if (!sync.ok || !async.ok || !auto.ok) throw new Error('view refused');
    expect(sync.view).toEqual(async.view); expect(auto.view).toEqual(async.view);
    expect(async.view.maskedFiles).toEqual(expect.arrayContaining([join(f.root, '.env'), join(f.root, 'src', 'alias.txt'), join(f.root, 'pkg', '.env'), join(f.root, '.git', 'objects', 'alias')]));
    expect(async.view.maskedDirectories).toEqual(expect.arrayContaining([join(f.root, 'locked')]));
  });
  it('Landlock: the same rule set from synchronous, asynchronous and default reads', async () => {
    const f = await fixture();
    const [sync, async, auto] = await Promise.all([SYNC_FS_OPS, ASYNC_FS_OPS, undefined].map(ops => buildLandlockRules(f.layout, {}, ...(ops ? [() => ops] : []))));
    expect(sync).toEqual(async); expect(auto).toEqual(async);
    if (!async.ok) throw new Error(async.reason);
    const paths = async.rules.map(([, path]) => path);
    expect(paths).not.toContain('.env'); expect(paths).not.toContain('src/alias.txt'); expect(paths).not.toContain('locked'); expect(paths).toContain('src/deep');
  });
  it('git metadata: a foreign hard link is suspect in both flavours', async () => {
    const f = await fixture();
    const scans = await Promise.all([SYNC_FS_OPS, ASYNC_FS_OPS].map(ops => scanGitDirectory(join(f.root, '.git', 'objects'), ops)));
    expect(scans[0]).toEqual(scans[1]);
    expect(scans[0]!.suspectFiles).toEqual(['alias']);
  });
});
