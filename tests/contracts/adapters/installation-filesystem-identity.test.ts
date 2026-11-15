import { mkdir, mkdtemp, rename, rm, stat, statfs, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { localInstallationBindingSource, inspectFilesystemIdentity } from '#adapters/core/installation-files/index.js';
import { resolveProductLayout, linuxMountsAt, linuxDeviceNumber, readHostMetadata } from '#platform/index.js';
const nativeFault = vi.hoisted(() => ({ unavailable: false }));
vi.mock('node:module', async importOriginal => {
  const original = await importOriginal<typeof import('node:module')>();
  return { ...original, createRequire: (...args: Parameters<typeof original.createRequire>) => {
    if (nativeFault.unavailable) throw new Error('NATIVE_NOT_INSTALLED');
    return original.createRequire(...args);
  } };
});
const { assessFilesystemIdentity } = await import('#adapters/core/installation-files/internal/filesystem-identity.js');
const { nativeFilesystemIdentity } = await import('#adapters/core/local-runtime-socket/internal/filesystem-identity.js');
const root = '/srv/data root', device = '2049', inode = '131', fs = { type: 61267, fsid: '033b6aacc3f1ba86', device, inode };
const mount = '36 25 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n';

it('uses shared longest-mount parsing and refuses every unproven or inconsistent kernel observation', () => {
  expect(linuxDeviceNumber(2049n)).toBe('8:1');
  expect(linuxMountsAt(root, `${mount}37 36 8:1 /nested /srv/data\\040root rw - ext4 /dev/sda1 rw\n`)[0]).toMatchObject({ id: '37', base: '/nested', path: root });
  for (const [text, kernel, reason] of [
    [mount, fs, null],
    ['', fs, 'mount-unavailable'],
    [mount.replace(' / / ', ' /subdir / '), fs, 'bind-mount'],
    [mount + '37 36 8:1 /nested /srv/data\\040root rw - ext4 /dev/sda1 rw\n', fs, 'bind-mount'],
    [mount + '37 36 8:1 / /mnt/wslg/distro rw - ext4 /dev/sda1 rw\n', fs, null], // full-root alias elsewhere
    [mount + '37 36 8:1 / /srv/data\\040root rw - ext4 /dev/sda1 rw\n', fs, null], // own full-root mount
    [mount + '37 36 8:2 / /srv/data\\040root rw - ext4 /dev/sdb1 rw\n', fs, 'device-mismatch'],
    [mount, { ...fs, type: 0x58465342 }, 'filesystem-mismatch'],
    [mount.replace('8:1', '8:2'), fs, 'device-mismatch'],
    [mount, { ...fs, inode: '132' }, 'location-changed'],
    [mount, { ...fs, device: '2050' }, 'location-changed'],
    [mount, { ...fs, fsid: '0000000000000000' }, 'identity-zero'],
  ] as const) {
    expect(assessFilesystemIdentity(root, device, inode, text, kernel)).toEqual(reason ? { status: 'unavailable', reason }
      : { status: 'available', identity: { kind: 'linux.ext4.statfs-fsid.v1', value: fs.fsid } });
  }
  for (const type of ['xfs', 'btrfs', 'overlay', 'tmpfs', '9p', 'drvfs', 'nfs', 'ext3']) {
    expect(assessFilesystemIdentity(root, device, inode, mount.replace('ext4', type), fs)).toEqual({ status: 'unavailable', reason: 'filesystem-unproven' });
  }
  // A different filesystem at the same path is observed under its own identity, never the older device's identity.
  expect(assessFilesystemIdentity(root, '2050', inode,
    mount + '37 36 8:2 / /srv/data\\040root rw - ext4 /dev/sdb1 rw\n', { ...fs, device: '2050', fsid: '133b6aacc3f1ba86' }))
    .toEqual({ status: 'available', identity: { kind: 'linux.ext4.statfs-fsid.v1', value: '133b6aacc3f1ba86' } });
});

it('without a loadable native module the producer is unavailable, never a subprocess fallback', async () => {
  nativeFault.unavailable = true;
  try {
    expect(nativeFilesystemIdentity(process.cwd())).toBeNull();
    if (process.platform !== 'linux') expect(await inspectFilesystemIdentity(process.cwd())).toEqual({ status: 'unavailable', reason: 'platform-unsupported' });
    else if ((await statfs(parse(process.cwd()).root)).type === 61267) {
      expect(await inspectFilesystemIdentity(parse(process.cwd()).root)).toEqual({ status: 'unavailable', reason: 'native-unavailable' });
    }
  } finally { nativeFault.unavailable = false; }
});

it.skipIf(process.platform !== 'linux')('refuses a captured directory replaced by a symlink to the same inode at another canonical path', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'deckent-fsid-swap-'));
  try {
    const root = join(temporary, 'original'), moved = join(temporary, 'moved');
    await mkdir(root);
    const info = await stat(root, { bigint: true });
    await rename(root, moved); await symlink(moved, root);
    expect(await inspectFilesystemIdentity(root, { device: String(info.dev), inode: String(info.ino) }))
      .toEqual({ status: 'unavailable', reason: 'location-changed' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

it('on a real ext4 host the native identity is captured and remains observation only', async context => {
  if (process.platform !== 'linux') context.skip('verify-not-run: no filesystem identity producer outside Linux');
  // The worktree is itself a sandbox bind mount; observe only filesystem metadata at the OS root, without opening an installation.
  const hostRoot = parse(process.cwd()).root;
  if ((await statfs(hostRoot)).type !== 61267) context.skip('verify-not-run: real host filesystem is not ext4; only ext4 producer proven');
  const kernel = nativeFilesystemIdentity(hostRoot);
  expect(kernel, 'native Release artifact must be built before the real-host assertion').not.toBeNull();
  // Independent host oracle (test only); production never spawns stat or reads udev.
  expect(kernel!.fsid).toBe(execFileSync('stat', ['-f', '-c', '%i', hostRoot], { encoding: 'utf8', timeout: 2000 }).trim().padStart(16, '0'));
  const actual = await inspectFilesystemIdentity(hostRoot);
  expect(actual).toEqual({ status: 'available', identity: { kind: 'linux.ext4.statfs-fsid.v1', value: kernel!.fsid } });
  const capture = await localInstallationBindingSource(resolveProductLayout({ projectRoot: hostRoot, root: hostRoot })).capture();
  expect(capture).toHaveProperty('filesystemIdentity', actual.status === 'available' ? actual.identity : null);
  // Exercise the shared bounded metadata reader as well as the fixture parser.
  await expect(readHostMetadata('/proc/self/mountinfo', 1)).rejects.toThrow('HOST_METADATA_LIMIT');
});
