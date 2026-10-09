import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ErrorRegistry } from '#platform/index.js';
export const refuse = (code: string, params?: Record<string, string>): never => { throw ErrorRegistry.createError(code, params ? { params } : undefined); };
export const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
/** Reject links in every existing ancestor, special files and foreign owners. Same-uid path swapping is outside the trusted host boundary. */
export async function safePath(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0')) return refuse('BACKUP_PATH_UNSAFE');
  const normalized = resolve(path); let cursor = parse(normalized).root;
  for (const part of normalized.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) continue;
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile() && !info.isSocket())) return refuse('BACKUP_PATH_UNSAFE');
  }
  return normalized;
}
/**
 * A directory backup writes into: created 0700; an existing one must be this user's and not writable by group/other (S1 D2, the rule of
 * the policy, artifact and installation-file owners). Files inside stay 0600; a loose mode is reported by doctor, never chmod'ed here.
 */
export async function privateDirectory(path: string): Promise<void> {
  await safePath(path);
  const found = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!found) { await privateDirectoryParent(path); await mkdir(path, { mode: 0o700 }); }
  await ownerOnlyWritable(path);
}
/** Refuses before any write with the exact path and its `chmod 700` next step; an absent directory passes (it is created 0700). */
export async function ownerOnlyWritable(path: string): Promise<void> {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return;
  if (!info.isDirectory()) return refuse('BACKUP_PATH_UNSAFE');
  if (info.uid !== process.getuid?.() || (info.mode & 0o022)) return refuse('BACKUP_DIRECTORY_UNSAFE', { path });
}
async function privateDirectoryParent(path: string) {
  const parent = dirname(path);
  if (!await lstat(parent).catch(() => null)) await privateDirectory(parent);
}
export async function readPrivate(path: string, maxBytes: number): Promise<Buffer> {
  await safePath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077)) refuse('BACKUP_PATH_UNSAFE');
    if (info.size > maxBytes) refuse('BACKUP_LIMIT');
    const bytes = Buffer.alloc(info.size + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) return refuse('BACKUP_STATE_CHANGED');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
export async function writePrivate(path: string, value: string | Uint8Array): Promise<void> {
  await privateDirectory(dirname(path));
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  await chmod(path, 0o600); await syncDirectory(dirname(path));
}
export async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function digestFile(path: string): Promise<string> {
  await safePath(path); const hash = createHash('sha256');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077)) return refuse('BACKUP_PATH_UNSAFE');
    let bytes = 0;
    for await (const chunk of createReadStream(path, { fd: handle.fd, autoClose: false, end: Math.max(0, before.size - 1) })) { bytes += chunk.length; hash.update(chunk); }
    const after = await handle.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return refuse('BACKUP_STATE_CHANGED');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
export async function canonical(path: string) { await safePath(path); return realpath(path); }
