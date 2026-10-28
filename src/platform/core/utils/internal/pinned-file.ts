import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize } from 'node:path';
/** The exact file a removal was bound to: inode identity, size, modification time and content digest (ctime is not compared: a move changes it). */
export interface PinnedFileIdentity { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly digest: string }
/** `cut`: remove only the bytes [start, end) and expect `after` as the result's digest; without it the whole file goes. */
export interface PinnedRemoval { readonly cut?: readonly [number, number] | undefined; readonly after?: string | undefined }
/** `changed`: the file is not the bound one (kept); `unsafe`: a link, a foreign or shared file, or a path that is not canonical. */
export class PinnedFileError extends Error { constructor(readonly reason: 'changed' | 'unsafe') { super(reason); } }
const at = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const LF = '\n'.charCodeAt(0), CR = '\r'.charCodeAt(0);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/**
 * openat custody on Linux: the canonical parent directory opened component by component from `/` through the previous descriptor
 * (`/proc/self/fd/<fd>/<name>`), never following a symlink. Every later operation names the file through this descriptor, so a parent
 * swapped for a link or moved after the check cannot redirect it. Null when a component does not exist.
 */
export async function openPinnedParent(path: string, createBelow?: string): Promise<FileHandle | null> {
  if (process.platform !== 'linux' || !isAbsolute(path) || normalize(path) !== path) throw new PinnedFileError('unsafe');
  let dir = await open('/', constants.O_RDONLY | constants.O_DIRECTORY), walked = '';
  try {
    for (const part of dirname(path).split('/').filter(Boolean)) {
      walked += `/${part}`;
      // `createBelow`: a missing folder strictly below that root is created here, one level at a time (mkdir never follows a link).
      const opened = () => open(at(dir, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const next = await opened().catch(async (error: unknown) => {
        if (!missing(error)) throw new PinnedFileError('unsafe');
        if (!createBelow || walked === createBelow || !walked.startsWith(`${createBelow}/`)) return null;
        await mkdir(at(dir, part), 0o700).catch((made: unknown) => { if ((made as NodeJS.ErrnoException).code !== 'EEXIST') throw new PinnedFileError('unsafe'); });
        return opened().catch(() => { throw new PinnedFileError('unsafe'); });
      });
      await dir.close();
      if (!next) return null;
      dir = next;
    }
    return dir;
  } catch (error) { await dir.close().catch(() => undefined); throw error; }
}
/** One regular, single-link file of this user read through its pinned parent with no-follow; its identity comes from the same descriptor. */
async function readAt(dir: FileHandle, name: string) {
  const file = await open(at(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    if (missing(error)) return null; throw new PinnedFileError('unsafe'); });
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) throw new PinnedFileError('unsafe');
    const bytes = await file.readFile(), after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || bytes.length !== info.size) throw new PinnedFileError('changed');
    return { bytes, mode: info.mode & 0o777, identity: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, digest: digest(bytes) } };
  } finally { await file.close(); }
}
/** The name an interrupted removal moved the file aside to (it is resumed under that name, never left behind as a stray). */
const asideOf = async (dir: FileHandle, name: string) => (await readdir(at(dir, '.'))).find(entry => entry.startsWith(`.${name}.`) && entry.endsWith('.removing')) ?? null;
/** The file's bytes and identity through its pinned canonical parent (or under the aside name an interrupted removal left); null when absent. */
export async function readPinnedFile(path: string): Promise<{ readonly bytes: Buffer; readonly mode: number; readonly identity: PinnedFileIdentity } | null> {
  const dir = await openPinnedParent(path);
  if (!dir) return null;
  try { const aside = await asideOf(dir, basename(path)); return await readAt(dir, basename(path)) ?? (aside ? await readAt(dir, aside) : null); } finally { await dir.close(); }
}
const same = (a: PinnedFileIdentity, b: PinnedFileIdentity) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.digest === b.digest;
/**
 * Removes exactly the bound file, or cuts exactly the bound byte range out of it. The file is first moved aside inside its pinned parent (a
 * rename never follows a link), then its identity and bytes are checked on the moved name: a mismatch puts it back without replacing anything
 * that appeared meanwhile and refuses. A cut writes the result beside it and links it into place, never over a file that appeared meanwhile.
 * `absent`: nothing was there; `removed`: done.
 */
export async function removePinnedFile(path: string, expected: PinnedFileIdentity, removal: PinnedRemoval = {}): Promise<'absent' | 'removed'> {
  const dir = await openPinnedParent(path);
  if (!dir) return 'absent';
  const name = basename(path);
  let aside = `.${name}.${randomUUID()}.removing`;
  try {
    try { await rename(at(dir, name), at(dir, aside)); } catch (error) {
      if (!missing(error)) throw new PinnedFileError('unsafe');
      const earlier = await asideOf(dir, name); // a removal interrupted after its move: it is checked and finished like any other
      if (!earlier) return 'absent';
      aside = earlier;
    }
    const restore = async (reason: 'changed' | 'unsafe'): Promise<never> => {
      // Back under its own name only while nothing else took it; otherwise it stays beside it, never lost and never replacing anything.
      await link(at(dir, aside), at(dir, name)).then(() => unlink(at(dir, aside)), () => undefined);
      throw new PinnedFileError(reason);
    };
    const found = await readAt(dir, aside).catch((error: unknown) => restore(error instanceof PinnedFileError ? error.reason : 'unsafe'));
    if (!found || !same(found.identity, expected)) return await restore('changed');
    if (removal.cut) {
      const [start, end] = removal.cut, result = Buffer.concat([found.bytes.subarray(0, start), found.bytes.subarray(end)]);
      if (start < 0 || end <= start || end > found.bytes.length || digest(result) !== removal.after) return await restore('changed');
      const next = `.${name}.${randomUUID()}.next`, handle = await open(at(dir, next), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, found.mode);
      try { await handle.writeFile(result); await handle.sync(); } finally { await handle.close(); }
      try { await link(at(dir, next), at(dir, name)); } catch { await unlink(at(dir, next)); return await restore('changed'); }
      await unlink(at(dir, next));
    }
    await unlink(at(dir, aside)); await dir.sync();
    return 'removed';
  } finally { await dir.close(); }
}
/**
 * Restores one file's earlier bytes, never writing through a link: missing folders are created one level at a time below `root`, a missing file
 * is created exclusively, and an existing one is replaced only while it holds exactly `replace` (uninstall's result): it is moved aside, checked
 * on the moved name and the earlier bytes are linked into place, never over a file that appeared meanwhile. Anything else (another file, an
 * unreadable, linked or foreign one, a linked folder) is `kept` as it is.
 */
export async function restorePinnedFile(path: string, bytes: Uint8Array, mode: number, root: string, replace?: string): Promise<'restored' | 'kept'> {
  const dir = await openPinnedParent(path, root).catch(() => null);
  if (!dir) return 'kept';
  const name = basename(path), write = async (target: string) => { const handle = await open(at(dir, target), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } };
  try {
    const current = await readAt(dir, name).catch(() => 'kept' as const);
    if (current === 'kept') return current;
    if (!current) return await write(name).then(() => dir.sync()).then(() => 'restored' as const, () => 'kept' as const);
    if (!replace || current.identity.digest !== replace) return 'kept';
    const aside = `.${name}.${randomUUID()}.restoring`, next = `.${name}.${randomUUID()}.next`;
    if (!await rename(at(dir, name), at(dir, aside)).then(() => true, () => false)) return 'kept';
    const moved = await readAt(dir, aside).catch(() => null), back = () => link(at(dir, aside), at(dir, name)).then(() => unlink(at(dir, aside)), () => undefined);
    if (!moved || !same(moved.identity, current.identity) || !await write(next).then(() => true, () => false)) { await back(); return 'kept'; }
    if (!await link(at(dir, next), at(dir, name)).then(() => true, () => false)) { await unlink(at(dir, next)); await back(); return 'kept'; }
    await unlink(at(dir, next)); await unlink(at(dir, aside)); await dir.sync();
    return 'restored';
  } finally { await dir.close(); }
}
/** An emptied folder goes through its pinned parent; a non-empty or missing one stays as it is. */
export async function removeEmptyPinnedDirectory(path: string) {
  const dir = await openPinnedParent(path);
  if (!dir) return;
  try { await rmdir(at(dir, basename(path))).catch((error: unknown) => { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }); }
  finally { await dir.close(); }
}
/**
 * K1(f): the byte range of the one whole line equal to `line` (ended by LF, CRLF or the end of the file) and the result's digest. When the
 * result without the newline in front of the line has one of the `before` digests (the receipt's earlier versions: init added that newline
 * to a file without a final one), the newline goes too. Null when the line is absent or occurs more than once (a person's copy is never cut).
 */
export function lineCut(bytes: Buffer, line: string, before: readonly string[] = []): { readonly cut: readonly [number, number]; readonly after: string } | null {
  const ranges: [number, number][] = [], target = Buffer.from(line, 'utf8');
  for (let start = 0; start <= bytes.length;) {
    const newline = bytes.indexOf(LF, start), stop = newline < 0 ? bytes.length : newline, body = bytes.subarray(start, stop);
    const content = body.length && body[body.length - 1] === CR ? body.subarray(0, body.length - 1) : body;
    if (content.equals(target) && (newline >= 0 || stop > start)) ranges.push([start, newline < 0 ? stop : newline + 1]);
    if (newline < 0) break;
    start = newline + 1;
  }
  if (ranges.length !== 1) return null;
  const [start, end] = ranges[0]!, result = (from: number) => digest(Buffer.concat([bytes.subarray(0, from), bytes.subarray(end)]));
  const wide = start > 0 && bytes[start - 1] === LF && before.includes(result(start - 1));
  return { cut: [wide ? start - 1 : start, end], after: result(wide ? start - 1 : start) };
}
