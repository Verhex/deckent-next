import { constants } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import type { WorkspacePatch } from '#engine/index.js';
/** Shared descriptor-relative writer: callers preflight all before bytes and custody before writes. */
export async function applyWorkspacePatchChanges(workspace: string, changes: WorkspacePatch['changes']) {
  const root = await open(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const change of changes) {
      const parts = change.path.split('/'); let parentHandle = root; const handles = [];
      try {
        for (const part of parts.slice(0, -1)) {
          const path = `/proc/self/fd/${parentHandle.fd}/${part}`;
          try { await mkdir(path, { mode: 0o700 }); } catch (error) {
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
          }
          parentHandle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(parentHandle);
        }
        const path = `/proc/self/fd/${parentHandle.fd}/${parts.at(-1)}`;
        if (change.before) await unlink(path);
        if (change.after) {
          const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await file.writeFile(change.after.text); await file.chmod(change.after.mode === '100755' ? 0o755 : 0o644); await file.sync(); }
          finally { await file.close(); }
        }
        await parentHandle.sync();
      } finally { for (const handle of handles.reverse()) await handle.close(); }
    }
  } finally { await root.close(); }
}
