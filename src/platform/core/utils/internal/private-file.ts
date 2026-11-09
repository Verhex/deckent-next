import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { PRIVATE_PERMISSION_MASK } from './tree.js';
/**
 * KG12 F1: the one private-file custody rule. `mask`: no group or other bits (owner decision A28, the default); `exact0600`: key material.
 * The owner is `process.getuid()`; where it is missing nothing is private (owner decision A23: refuse, never skip the check).
 */
export type PrivateFileMode = 'mask' | 'exact0600';
/** `unsafe`: a link, a non-regular, shared or foreign file, or a wrong mode; `too-large`: over the bound; `changed`: it changed while read. */
export class PrivateFileError extends Error { constructor(readonly reason: 'unsafe' | 'too-large' | 'changed') { super(reason); } }
type FileInfo = { isFile(): boolean; readonly mode: number; readonly nlink: number; readonly uid: number };
export const privateFile = (info: FileInfo, mode: PrivateFileMode = 'mask') => info.isFile() && info.nlink === 1 && info.uid === process.getuid?.()
  && (mode === 'mask' ? (info.mode & PRIVATE_PERMISSION_MASK) === 0 : (info.mode & 0o777) === 0o600);
/** An existing canonical directory (no link on its real path) of this user with no group or other bits; null when absent. */
export async function privateDirectory(path: string): Promise<boolean | null> {
  const info = await lstat(path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  return info.isDirectory() && info.uid === process.getuid?.() && (info.mode & PRIVATE_PERMISSION_MASK) === 0 && await realpath(path).catch(() => '') === path;
}
/**
 * At most `maxBytes` of one private file, null when absent. Opened without following a link and without blocking (a FIFO never hangs); the
 * open descriptor and the path name the same inode before and after the read. The buffer is the size seen plus one byte, never the bound: a
 * file that changed while read is `changed`, or `too-large` once it is over the bound, and is never read whole; the buffer of a refused read
 * is zeroed. A path gone after the open is `changed`, never absent. Other I/O errors are raw.
 */
export async function readPrivateFile(path: string, maxBytes: number, options: { readonly mode: PrivateFileMode }): Promise<Buffer | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw code === 'ELOOP' || code === 'ENXIO' ? new PrivateFileError('unsafe') : error;
  });
  if (!handle) return null;
  const named = () => lstat(path).catch(() => { throw new PrivateFileError('changed'); });
  try {
    const info = await handle.stat(), linked = await named();
    if (!privateFile(info, options.mode) || linked.isSymbolicLink() || linked.dev !== info.dev || linked.ino !== info.ino) throw new PrivateFileError('unsafe');
    if (info.size > maxBytes) throw new PrivateFileError('too-large');
    const bytes = Buffer.alloc(info.size + 1);
    try {
      let length = 0;
      for (let read = 1; read && length < bytes.length;) { read = (await handle.read(bytes, length, bytes.length - length, length)).bytesRead; length += read; }
      const after = await handle.stat(), still = await named();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || length !== info.size || still.dev !== info.dev || still.ino !== info.ino)
        throw new PrivateFileError(after.size > maxBytes ? 'too-large' : 'changed');
      return bytes.subarray(0, length);
    } catch (error) { bytes.fill(0); throw error; }
  } finally { await handle.close(); }
}
