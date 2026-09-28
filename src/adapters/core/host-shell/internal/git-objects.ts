import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fsOpsFor, type FsOps } from './fs-ops.js';

/**
 * Whether a multi-linked file inside Git metadata is a genuine content-addressed object (Astra 2156): a hard-linked local clone
 * shares its objects with another repository, and masking them would take the sandboxed git its history. Genuine means the
 * file's content hashes to its own name — a loose object (`objects/xx/yyyy…`, inflated `<type> <size>\0<content>`), a pack
 * (`pack-<hash>.pack`: the trailer is the hash of everything before it and is the name) or its index (`pack-<hash>.idx`: its own
 * trailer checksum holds, and the pack checksum before it is the name). Another name of a protected inode can be given any name
 * but not the matching content, so it never verifies. Results are cached per inode and expected identity (see `isVerifiedGitObject`);
 * a file too large to hash within the bound is not verified (masked).
 */
const LOOSE = /\/objects\/([0-9a-f]{2})\/([0-9a-f]{38}|[0-9a-f]{62})$/u;
const PACK = /\/objects\/pack\/pack-([0-9a-f]{40}|[0-9a-f]{64})\.(pack|idx)$/u;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;
const CACHE_MAX = 50_000;
const verified = new Map<string, boolean>();

function hashOf(hexLength: number, data: Buffer): string {
  return createHash(hexLength === 40 ? 'sha1' : 'sha256').update(data).digest('hex');
}
async function verify(path: string): Promise<boolean> {
  const loose = LOOSE.exec(path);
  const pack = loose ? null : PACK.exec(path);
  if (!loose && !pack) return false;
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_BYTES) return false;
  const raw = await readFile(path);
  if (loose) {
    const name = loose[1]! + loose[2]!;
    let data: Buffer;
    try { data = inflateSync(raw, { maxOutputLength: MAX_INFLATED_BYTES }); } catch { return false; }
    return hashOf(name.length, data) === name;
  }
  const name = pack![1]!, digestBytes = name.length / 2;
  if (raw.length < 2 * digestBytes) return false;
  const trailer = raw.subarray(raw.length - digestBytes).toString('hex');
  if (hashOf(name.length, raw.subarray(0, raw.length - digestBytes)) !== trailer) return false;
  return pack![2] === 'pack' ? trailer === name : raw.subarray(raw.length - 2 * digestBytes, raw.length - digestBytes).toString('hex') === name;
}

/** The object or pack identity a path promises (its name), with the file kind; null when the path is not an object/pack path. */
function expectedIdentity(path: string): string | null {
  const loose = LOOSE.exec(path);
  if (loose) return `loose:${loose[1]}${loose[2]}`;
  const pack = PACK.exec(path);
  return pack ? `${pack[2]}:${pack[1]}` : null;
}

/**
 * True only for a file whose content hashes to its Git object/pack name (see above); false for anything else or on any error. The
 * result is cached per process under the inode's device, inode number, size, mtime, **ctime** and the identity the path promises
 * (Astra 2158 R2): content cannot change without the kernel advancing ctime (a user may set mtime back with `utime`, never ctime),
 * and the same inode under another object name is another question. A ctime change from any cause re-hashes the file.
 */
export async function isVerifiedGitObject(path: string): Promise<boolean> {
  const identity = expectedIdentity(path);
  if (identity === null) return false;
  let key: string;
  try { const info = await stat(path); key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${identity}`; } catch { return false; }
  const cached = verified.get(key);
  if (cached !== undefined) return cached;
  const result = await verify(path).catch(() => false);
  if (verified.size >= CACHE_MAX) verified.clear();
  verified.set(key, result);
  return result;
}

/** One directory of Git metadata under the inode floor: which entries are suspect (another name of something: multi-linked and not
 * a verified object; or a file whose link count could not be read), which are clean regular files, which are directories. */
export interface GitDirectoryScan {
  readonly readable: boolean;
  readonly suspectFiles: readonly string[];
  readonly cleanFiles: readonly string[];
  readonly directories: readonly string[];
}
const UNREADABLE: GitDirectoryScan = Object.freeze({ readable: false, suspectFiles: [], cleanFiles: [], directories: [] });

/**
 * Scans one directory of Git metadata (names only; symbolic links and special files are neither clean nor listed). The security
 * verdict is taken afresh on every call: the directory is listed and every regular file's link count is read (`lstat`) each time
 * (Astra 2158 R1 — a directory-level cache cannot carry a child's verdict: a single-link file can gain another name elsewhere and be
 * rewritten through it without the directory's times changing). Only the content hash of a verified object is cached, under the
 * inode's ctime and expected identity (`isVerifiedGitObject`). Timestamp bounds: ctime is kernel-set at nanosecond resolution; a
 * change landing in the same tick as the cached ctime, or a component swapped between this scan and the mount, is outside what
 * the scan can see. The reads are synchronous on a local file system and asynchronous otherwise (`fsOpsFor`); the verdict is the same.
 */
export async function scanGitDirectory(dir: string, ops: FsOps = fsOpsFor(dir)): Promise<GitDirectoryScan> {
  let entries;
  try { entries = await ops.readdir(dir); } catch { return UNREADABLE; }
  const suspectFiles: string[] = [], cleanFiles: string[] = [], directories: string[] = [];
  await Promise.all(entries.map(async entry => {
    if (entry.isDirectory()) { directories.push(entry.name); return; }
    if (!entry.isFile()) return;
    const path = join(dir, entry.name);
    const links = await ops.nlink(path);
    (links === 1 || await isVerifiedGitObject(path) ? cleanFiles : suspectFiles).push(entry.name);
  }));
  return Object.freeze({ readable: true, suspectFiles: suspectFiles.sort(), cleanFiles: cleanFiles.sort(), directories: directories.sort() });
}
