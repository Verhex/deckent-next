import { lstat, mkdir, realpath } from 'node:fs/promises';
/** Short Linux IPC root. Open sandboxes mask this root before spawn, including sockets created after their mount namespace. */
export async function privateIpcRoot(): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error();
  const root = `/tmp/dk-ipc-${uid}`;
  await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(root);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0 || await realpath(root) !== root) throw new Error();
  return root;
}
