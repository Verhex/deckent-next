import { lstatSync, readdirSync, statfsSync, type Dirent, type StatsFsBase } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';

/**
 * How a sandbox scan reads the file system (SANDBOX-SPEED). The deny/inode-floor scans of every shell call (bubblewrap and Landlock) read
 * thousands of directory entries and link counts. Through libuv's thread pool each `lstat` costs ~20 µs of queueing and wake-ups; the
 * same call made synchronously on a local disk costs ~2 µs (measured here: 6,392 files, 139 ms async-concurrent → 14 ms sync). A
 * synchronous read blocks the event loop for its duration, which is only acceptable when the storage answers from local memory/disk, so
 * the choice is made per directory from the file system type (`statfs` f_type): a known local type reads synchronously, anything else
 * (network, 9p/drvfs, FUSE, unknown, or a failing `statfs`) keeps the asynchronous reads. The security verdict is identical in both
 * flavours: the same `readdir` and the same link count are read afresh on every call; only the way of asking differs.
 */
export interface FsOps {
  readonly kind: 'sync' | 'async';
  /** The directory's entries; throws (or rejects) when it cannot be read — the caller's unreadable-directory branch. */
  readonly readdir: (path: string) => Dirent[] | Promise<Dirent[]>;
  /** The link count of a path; 2 (multi-linked, so suspect) when it cannot be read, never a thrown error. */
  readonly nlink: (path: string) => number | Promise<number>;
}

export const ASYNC_FS_OPS: FsOps = Object.freeze({
  kind: 'async',
  readdir: (path: string) => readdir(path, { withFileTypes: true }),
  nlink: (path: string) => lstat(path).then(info => info.nlink, () => 2),
});
export const SYNC_FS_OPS: FsOps = Object.freeze({
  kind: 'sync',
  readdir: (path: string) => readdirSync(path, { withFileTypes: true }),
  nlink: (path: string) => { try { return lstatSync(path).nlink; } catch { return 2; } },
});

/** `f_type` values of file systems whose metadata is served locally (statfs(2), Linux man-pages 6.19): ext2/3/4, XFS, Btrfs, tmpfs,
 * overlayfs, F2FS, ZFS. 9p (WSL `/mnt/c`), NFS, SMB/CIFS, FUSE, virtiofs and every unknown type are absent on purpose. */
export const LOCAL_FILESYSTEM_TYPES: ReadonlySet<number> = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0xf2f52010, 0x2fc12fc1]);

/** The reads to use for a directory: synchronous only on a positively identified local type; `statfs` failing or unsupported → async. */
export function fsOpsFor(path: string, statfs: (path: string) => Pick<StatsFsBase<number>, 'type'> = statfsSync): FsOps {
  try { return LOCAL_FILESYSTEM_TYPES.has(statfs(path).type) ? SYNC_FS_OPS : ASYNC_FS_OPS; } catch { return ASYNC_FS_OPS; }
}
