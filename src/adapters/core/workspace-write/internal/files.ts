import { constants } from 'node:fs';
import { lstat, open, readlink, rename, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { WorkspaceScope } from '#adapters/core/workspace-read/index.js';

/** Largest file an agent edit reads or writes (the effect input must also fit its catalog bound). */
export const WORKSPACE_WRITE_MAX_FILE_BYTES = 900_000;
/** Record version of a file that does not exist; every other version is the sha256 of the file's bytes. */
export const ABSENT_FILE_VERSION = 'absent';
export const fileContentVersion = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export type WritablePath = { readonly ok: true; readonly rel: string; readonly parentRel: string; readonly name: string } | { readonly ok: false; readonly error: string };
export type CurrentFile = { readonly ok: true; readonly version: string; readonly bytes: Buffer | null; readonly mode: number } | { readonly ok: false; readonly error: string };
export class WorkspaceWriteError extends Error {
  constructor(readonly code: 'precondition' | 'rejected' | 'changed', message: string) { super(message); this.name = 'WorkspaceWriteError'; }
}

const proc = (handle: FileHandle, name: string) => `/proc/self/fd/${handle.fd}/${name}`;

/**
 * A workspace path an edit may write: normalized, inside the root, not denied, a plain file name under an existing parent that is
 * its own real path (no symlinked directory). The file itself may not exist yet.
 */
export async function resolveWritable(scope: WorkspaceScope, requested: unknown): Promise<WritablePath> {
  if (typeof requested !== 'string' || !requested || requested.length > 4096 || requested.includes('\0')) return { ok: false, error: 'invalid-path' };
  let path = posix.normalize(requested.replace(/\\/g, '/'));
  if (path.startsWith('/')) {
    if (!path.startsWith(`${scope.root}/`)) return { ok: false, error: 'outside-workspace' };
    path = path.slice(scope.root.length + 1);
  }
  path = path.replace(/^(\.\/)+/, '');
  if (path === '' || path === '.' || path === '..' || path.startsWith('../') || path.endsWith('/')) return { ok: false, error: 'invalid-path' };
  const name = posix.basename(path), parent = posix.dirname(path), parentRel = parent === '.' ? '' : parent;
  if (scope.denied(path)) return { ok: false, error: 'denied' };
  if (parentRel) {
    const resolved = await scope.resolve(parentRel);
    if (!resolved.ok) return { ok: false, error: `parent-${resolved.error}` };
    if (resolved.rel !== parentRel) return { ok: false, error: 'parent-is-link' };
  }
  return { ok: true, rel: path, parentRel, name };
}

async function openParent(scope: WorkspaceScope, target: Extract<WritablePath, { ok: true }>) {
  const opened = await scope.open(target.parentRel, 'dir');
  if (!opened.ok) throw new WorkspaceWriteError('rejected', `parent ${opened.error}`);
  return opened.handle;
}

/** The current bytes and version of the file under an opened parent: absent, or a single-link regular file within the size limit. */
async function currentUnder(dir: FileHandle, name: string): Promise<CurrentFile> {
  let info;
  try { info = await lstat(proc(dir, name)); } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, version: ABSENT_FILE_VERSION, bytes: null, mode: 0o644 } : { ok: false, error: 'unreadable' };
  }
  if (info.isSymbolicLink()) return { ok: false, error: 'is-link' };
  if (!info.isFile()) return { ok: false, error: 'not-a-file' };
  if (info.nlink > 1) return { ok: false, error: 'hard-linked' };
  if (info.size > WORKSPACE_WRITE_MAX_FILE_BYTES) return { ok: false, error: 'too-large' };
  const handle = await open(proc(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (before.ino !== info.ino || !before.isFile()) return { ok: false, error: 'changed' };
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== bytes.length || after.mtimeMs !== before.mtimeMs) return { ok: false, error: 'changed' };
    return { ok: true, version: fileContentVersion(bytes), bytes, mode: before.mode & 0o777 };
  } finally { await handle.close(); }
}

export async function readWritableFile(scope: WorkspaceScope, target: Extract<WritablePath, { ok: true }>): Promise<CurrentFile> {
  const dir = await openParent(scope, target);
  try { return await currentUnder(dir, target.name); } finally { await dir.close(); }
}

/** Phases of one write attempt, reported to its effect journal in order (T-L4, Astra 2094 R1/R2). `escaped`: the rename happened but
 * the parent was no longer under the workspace root afterwards (moved by another process); `where` is its path then. */
export type WritePhase = { readonly state: 'prepared' | 'committed' | 'aborted' } | { readonly state: 'escaped'; readonly where: string | null };
export interface WriteAttempt {
  /** Unique temporary file name of this attempt (its presence is evidence that the rename did not happen). */
  readonly temporary: string;
  /** A temporary file an earlier attempt of the same effect may have left; removed before this attempt starts. */
  readonly stale?: string | null;
  readonly phase: (phase: WritePhase) => Promise<void>;
}
export const writeAttemptTemporary = (name: string) => `.${name}.deckent-${randomBytes(6).toString('hex')}.tmp`;

/**
 * Conditional atomic write: the file must still be at `expectedVersion`; the attempt is journaled `prepared` (with its temporary name)
 * before the temporary file exists; the new bytes go to that exclusive file in the same directory (fsync), the directory is
 * re-verified, the version is checked once more, and a rename replaces the file (directory fsync), then `committed`. Any failure
 * before the rename journals `aborted` before the temporary file is removed. After the rename the parent is verified again: a
 * directory moved out of the workspace meanwhile is journaled `escaped` and reported as `changed` (the write happened outside; it is
 * never reported as done, and nothing is written again to undo it). Not excluded: another writer between the last check and the
 * rename, or a same-user process moving the directory during the write (no advisory locks; Node has no openat2/renameat).
 */
export async function writeWorkspaceFile(scope: WorkspaceScope, target: Extract<WritablePath, { ok: true }>, expectedVersion: string, content: Buffer,
  attempt: WriteAttempt = { temporary: writeAttemptTemporary(target.name), phase: async () => undefined }): Promise<string> {
  if (content.length > WORKSPACE_WRITE_MAX_FILE_BYTES) throw new WorkspaceWriteError('rejected', 'too-large');
  const dir = await openParent(scope, target);
  const temporary = attempt.temporary;
  let pending = false;
  try {
    if (attempt.stale) await unlink(proc(dir, attempt.stale)).catch(() => undefined);
    const current = await currentUnder(dir, target.name);
    if (!current.ok) throw new WorkspaceWriteError('rejected', current.error);
    if (current.version !== expectedVersion) throw new WorkspaceWriteError('precondition', 'file changed since it was read');
    await attempt.phase({ state: 'prepared' });
    pending = true;
    const out = await open(proc(dir, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, current.mode);
    try { await out.writeFile(content); await out.sync(); } finally { await out.close(); }
    if (!(await scope.verify(dir, target.parentRel))) throw new WorkspaceWriteError('changed', 'directory moved during the write');
    const again = await currentUnder(dir, target.name);
    if (!again.ok || again.version !== expectedVersion) throw new WorkspaceWriteError('precondition', 'file changed during the write');
    await rename(proc(dir, temporary), proc(dir, target.name));
    pending = false;
    await dir.sync();
    if (!(await scope.verify(dir, target.parentRel))) {
      await attempt.phase({ state: 'escaped', where: await readlink(`/proc/self/fd/${dir.fd}`).catch(() => null) });
      throw new WorkspaceWriteError('changed', 'directory moved out of the workspace during the write; the file was written there');
    }
    await attempt.phase({ state: 'committed' });
    return fileContentVersion(content);
  } finally {
    if (pending) {
      // Journal first: once `aborted` is durable, a missing temporary file can no longer be mistaken for a completed rename.
      await attempt.phase({ state: 'aborted' }).catch(() => undefined);
      await unlink(proc(dir, temporary)).catch(() => undefined);
    }
    await dir.close();
  }
}

/** Whether an attempt's temporary file is still in the target's parent: true, false, or null when the parent cannot be opened. */
export async function temporaryPresent(scope: WorkspaceScope, target: Extract<WritablePath, { ok: true }>, temporary: string): Promise<boolean | null> {
  const opened = await scope.open(target.parentRel, 'dir');
  if (!opened.ok) return null;
  try { await lstat(proc(opened.handle, temporary)); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null; }
  finally { await opened.handle.close(); }
}
