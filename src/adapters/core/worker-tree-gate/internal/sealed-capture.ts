import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, readlink, type FileHandle } from 'node:fs/promises';
import { basename, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { CodedError, ErrorRegistry, openPinnedParent, writePinnedFile } from '#platform/index.js';
import { MAX_WALK_DEPTH } from '#adapters/core/workspace-read/index.js';
import type { WorkerTreeGateOptions } from './scan.js';

export class SealedFileSizeError extends CodedError {
  constructor(readonly size: number, readonly bound: number) { super('NATIVE_WORKER_DEPENDENCIES_REFUSED'); }
}
export type TreeLimits = Pick<WorkerTreeGateOptions, 'maxFiles' | 'maxFileBytes' | 'maxTotalBytes' | 'timeoutMs'>;
export type Entry = Readonly<{ path: string; mode: number } & (
  { kind: 'directory'; size: 0; digest: null } |
  { kind: 'file'; size: number; digest: string } |
  { kind: 'link'; size: number; digest: string; target: string })>;
export type TreeSelectionEntry = Readonly<{ kind: Entry['kind']; digest?: string; targets?: readonly string[]; sameAs?: string; check?: (bytes: Buffer) => void }>;
export type TreeSelection = ReadonlyMap<string, TreeSelectionEntry>;
export const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const at = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`;
export const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const refused = () => ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
const name = (bytes: Buffer) => {
    const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw refused();
  return text;
};
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
  a.uid === b.uid && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Walk each component in order to catch links that leave and then re-enter the tree. */
function linkTargets(entries: readonly Entry[], selection?: TreeSelection) {
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const targets = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== 'link') continue;
    const parent = posix.dirname(entry.path), walked = parent === '.' ? [] : parent.split('/'), parts = entry.target.split('/');
    for (const [index, part] of parts.entries()) {
      if (!part) throw refused();
      if (part === '..') { if (!walked.length) throw refused(); walked.pop(); }
      else if (part !== '.') walked.push(part);
      const kind = walked.length ? byPath.get(walked.join('/'))?.kind : 'directory';
      if (index === parts.length - 1 ? kind !== 'file' : kind !== 'directory') throw refused();
    }
    const target = walked.join('/');
    if (selection && (!selection.get(entry.path)?.targets?.includes(target) || !(byPath.get(target)!.mode & 0o111))) throw refused();
    targets.set(entry.path, target);
  }
  return targets;
}

async function directory(path: string) {
  const dir = await open(path, readFlags | constants.O_DIRECTORY);
  try {
    const info = await dir.stat({ bigint: true });
    if (!same(info, await lstat(path, { bigint: true }))) throw refused();
    return { dir, info };
  } catch (error) { await dir.close(); throw error; }
}

async function readBytes(path: string, expected: BigIntStats, size: number, tick: () => void) {
  const file = await open(path, readFlags);
  try {
    if (!same(expected, await file.stat({ bigint: true }))) throw refused();
    const bytes = Buffer.alloc(size + 1);
    let length = 0;
    while (length < bytes.length) {
      tick();
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== size || !same(expected, await file.stat({ bigint: true }))) throw refused();
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

async function verifyHardName(root: string, path: string, expected: BigIntStats, parents: ReadonlyMap<string, BigIntStats>, tick: () => void) {
  const parts = path.split('/'), leaf = parts.pop()!;
  const walk = async (loc: string, depth: number): Promise<void> => {
    const { dir, info } = await directory(loc);
    try {
      tick();
      if (!same(parents.get(parts.slice(0, depth).join('/'))!, info)) throw refused();
      if (depth < parts.length) await walk(at(dir, parts[depth]!), depth + 1);
      else {
        const child = at(dir, leaf), file = await open(child, readFlags);
        try {
          if (!same(expected, await file.stat({ bigint: true })) || !same(expected, await lstat(child, { bigint: true }))) throw refused();
        } finally { await file.close(); }
      }
      if (!same(info, await lstat(loc, { bigint: true }))) throw refused();
    } finally { await dir.close(); }
  };
  await walk(root, 0);
}

/** The copier receives the bytes read through the pinned handle. The caller later reads back the written bytes. */
export async function capture(source: string, limits: TreeLimits, options: Readonly<{
  copy?: (entry: Entry, bytes?: Buffer) => Promise<void>; selection?: TreeSelection; independent?: boolean;
}> = {}) {
  const entries: Entry[] = [], start = performance.now(), parents = new Map<string, BigIntStats>();
  const hard = new Map<string, Map<string, BigIntStats>>(), hardIdentity = new Map<string, string>();
  let total = 0;
  const tick = () => { if (performance.now() - start >= limits.timeoutMs) throw refused(); };
  const charge = (bytes: number) => {
    if (bytes > limits.maxFileBytes) throw new SealedFileSizeError(bytes, limits.maxFileBytes);
    if (!Number.isSafeInteger(bytes) || (total += bytes) > limits.maxTotalBytes) throw refused();
  };
  const recordHardName = (path: string, info: BigIntStats) => {
    if (info.nlink === 1n) return;
    if (options.independent) throw refused();
    const key = `${info.dev}:${info.ino}`, group = hard.get(key) ?? new Map<string, BigIntStats>();
    const first = group.values().next().value;
    if (first && !same(first, info) || group.has(path)) throw refused();
    group.set(path, info); hard.set(key, group); hardIdentity.set(path, key);
  };
  const visit = async (loc: string, path: string, depth: number, expected: BigIntStats): Promise<void> => {
    const { dir, info } = await directory(loc);
    try {
      if (!same(expected, info) || depth > MAX_WALK_DEPTH) throw refused();
      parents.set(path, info);
      for (const leaf of (await readdir(at(dir, '.'), { encoding: 'buffer' })).map(name).sort()) {
        tick();
        const entryPath = path === '' ? leaf : `${path}/${leaf}`, selected = options.selection?.get(entryPath);
        if (options.selection && !selected) continue;
        if (entries.length >= limits.maxFiles) throw refused();
        const child = at(dir, leaf), item = await lstat(child, { bigint: true }), mode = Number(item.mode & 0o7777n);
        if (item.isDirectory()) {
          if (selected && selected.kind !== 'directory') throw refused();
          const row = { path: entryPath, kind: 'directory', mode, size: 0, digest: null } as const;
          entries.push(row); await options.copy?.(row); await visit(child, entryPath, depth + 1, item); continue;
        }
        if ((!item.isFile() && !item.isSymbolicLink()) || (item.isSymbolicLink() && item.nlink !== 1n)) throw refused();
        if (item.isFile()) { recordHardName(entryPath, item); charge(Number(item.size)); }
        const bytes = await (item.isFile() ? readBytes(child, item, Number(item.size), tick) : readlink(child, { encoding: 'buffer' }));
        if (item.isSymbolicLink()) charge(bytes.length);
        if (!same(item, await lstat(child, { bigint: true }))) throw refused();
        const details = { path: entryPath, mode, size: bytes.length, digest: digest(bytes) };
        const row: Entry = item.isFile() ? { ...details, kind: 'file' } : { ...details, kind: 'link', target: name(bytes) };
        if (selected && (selected.kind !== row.kind || selected.digest !== row.digest)) throw refused();
        selected?.check?.(bytes);
        entries.push(row); await options.copy?.(row, bytes);
      }
      if (!same(info, await dir.stat({ bigint: true })) || !same(info, await lstat(loc, { bigint: true }))) throw refused();
    } finally { await dir.close(); }
  };
  const parent = await openPinnedParent(source);
  if (!parent) throw refused();
  try {
    const root = at(parent, basename(source)), expected = await lstat(root, { bigint: true });
    await visit(root, '', 0, expected);
    if (options.selection) {
      if (entries.length !== options.selection.size) throw refused();
      for (const [path, row] of options.selection) if (row.sameAs !== undefined &&
        (!hardIdentity.has(path) || hardIdentity.get(path) !== hardIdentity.get(row.sameAs))) throw refused();
    }
    for (const group of hard.values()) for (const [path, info] of group) {
      if (BigInt(group.size) !== info.nlink) throw refused();
      await verifyHardName(root, path, info, parents, tick);
    }
    const reopened = await openPinnedParent(source);
    if (!reopened) throw refused();
    try { if (!same(expected, await lstat(at(reopened, basename(source)), { bigint: true }))) throw refused(); }
    finally { await reopened.close(); }
    const targets = linkTargets(entries, options.selection);
    tick();
    return { entries, targets };
  } finally { await parent.close(); }
}

export async function readPreparedInputFile(path: string, limit: number) {
  const parent = await openPinnedParent(path);
  if (!parent) return null;
  try { return await readOwnedEntry(parent, basename(path), limit); }
  finally { await parent.close(); }
}

async function readOwnedEntry(parent: FileHandle, name: string, limit: number) {
  const entry = at(parent, name), info = await namedEntry(entry);
  if (!info) return null;
  if (!info.isFile() || info.uid !== BigInt(process.getuid!()) || info.size > BigInt(limit)) throw refused();
  const bytes = await readBytes(entry, info, Number(info.size), () => {});
  if (!same(info, await lstat(entry, { bigint: true }))) throw refused();
  return bytes;
}

const namedEntry = (path: string) => lstat(path, { bigint: true }).catch((error: unknown) => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  throw error;
});

/** Only the locked candidate name is examined, from its no-follow directory chain. */
export async function inspectPreparedInputEntry(path: string, linkText = false) {
  const parent = await openPinnedParent(path);
  if (!parent) return null;
  try {
    const entry = at(parent, basename(path)), info = await namedEntry(entry);
    if (!info) return null;
    const target = linkText && info.isSymbolicLink() ? await readlink(entry, { encoding: 'buffer' }) : null;
    if (target && !same(info, await lstat(entry, { bigint: true }))) throw refused();
    return { info, target };
  }
  finally { await parent.close(); }
}

export async function writePreparedInputFile(path: string, bytes: Buffer, maxBytes: number) {
  try {
    const parent = await openPinnedParent(path);
    if (!parent) throw refused();
    try {
      const current = await readOwnedEntry(parent, basename(path), maxBytes);
      if (current?.equals(bytes)) return;
      await writePinnedFile(path, bytes, undefined, previous => current?.equals(previous) ?? false, parent);
    } finally { await parent.close(); }
  } catch { throw refused(); }
}
