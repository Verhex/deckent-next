import { createRequire } from 'node:module';

export interface NativeFilesystemStat { readonly type: number; readonly fsid: string; readonly device: string; readonly inode: string }
/** Optional reader capability: older or unloadable native artifacts are unavailable, never a subprocess fallback. */
export function nativeFilesystemIdentity(root: string): NativeFilesystemStat | null {
  try {
    const native = createRequire(import.meta.url)('../native/build/Release/peer_credentials.node') as { filesystemIdentity(root: string): NativeFilesystemStat | null };
    return native.filesystemIdentity(root);
  } catch { return null; }
}
