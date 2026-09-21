import { constants } from 'node:fs';
import { open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { patchPathSchema, patchFile, patchDigest, isPatchExcluded, WorkspacePatchError, type PatchFile, type PatchLimits } from '#engine/index.js';
import type { GitWorkspaceLease, GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
const exec = promisify(execFile);
export type Snapshot = Map<string, PatchFile>;
export class SnapshotBudget {
  bytes = 0; entries = 0;
  constructor(readonly limits: PatchLimits, readonly deadline: number) {}
  time() { if (Date.now() >= this.deadline) throw new WorkspacePatchError('PATCH_LIMIT'); }
  path(path: string) {
    this.time();
    if (path.split('/').length > this.limits.maxDepth
      || Buffer.byteLength(path) > this.limits.maxPathBytes) throw new WorkspacePatchError('PATCH_LIMIT');
    if (!patchPathSchema.safeParse(path).success) throw new WorkspacePatchError('PATCH_UNSAFE');
  }
  entry() { this.time(); if (++this.entries > this.limits.maxEntries) throw new WorkspacePatchError('PATCH_LIMIT'); }
  size(size: number) {
    this.time(); this.bytes += size;
    if (!Number.isSafeInteger(size) || size < 0 || this.bytes > this.limits.maxBytes) throw new WorkspacePatchError('PATCH_LIMIT');
  }
}
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
export async function readBase(lease: GitWorkspaceLease, options: GitWorkspaceOptions, budget: SnapshotBudget): Promise<Snapshot> {
  const git = async (args: string[], maxBuffer: number) => {
    budget.time();
    try {
      return (await exec(options.gitExecutable, ['--no-replace-objects', '-C', lease.sourceBase.source.repositoryRoot,
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
        timeout: Math.max(1, budget.deadline - Date.now()), maxBuffer, encoding: 'buffer' })).stdout;
    } catch { throw new WorkspacePatchError('PATCH_UNAVAILABLE'); }
  };
  const listing = await git(['ls-tree', '-r', '-z', '-l', '--full-tree', lease.baseCommit], options.outputBytes);
  const snapshot: Snapshot = new Map();
  for (const entry of decode(listing).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'); const path = entry.slice(tab + 1);
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64}) +(-|\d+)$/u.exec(entry.slice(0, tab));
    if (!match) throw new WorkspacePatchError('PATCH_UNSAFE');
    const [, mode, type, oid, sizeText] = match as unknown as [string, string, string, string, string];
    budget.entry();
    if (isPatchExcluded(path)) continue;
    budget.path(path);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new WorkspacePatchError('PATCH_UNSUPPORTED');
    const size = Number(sizeText); budget.size(size);
    const bytes = await git(['cat-file', 'blob', oid], Math.max(1, size + 1));
    if (bytes.length !== size) throw new WorkspacePatchError('PATCH_CONFLICT');
    snapshot.set(path, patchFile(bytes, mode as PatchFile['mode']));
  }
  return snapshot;
}
/** Linux descriptor-relative traversal; worker metadata is never interpreted by Git on the host. */
export async function readWorkspace(workspace: string, budget: SnapshotBudget): Promise<Snapshot> {
  if (process.platform !== 'linux' || await realpath(workspace) !== workspace) throw new WorkspacePatchError('PATCH_UNSAFE');
  const result: Snapshot = new Map();
  async function visit(directory: FileHandle, prefix: string) {
    const dir = await opendir(`/proc/self/fd/${directory.fd}`, { encoding: 'utf8' });
    for await (const entry of dir) {
      const path = prefix + entry.name;
      budget.entry();
    if (isPatchExcluded(path)) continue;
      budget.path(path);
      // Directory entry types are hints only. O_NOFOLLOW and fstat decide what was opened.
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (entry.isDirectory() ? constants.O_DIRECTORY : 0);
      const handle = await open(`/proc/self/fd/${directory.fd}/${entry.name}`, flags);
      try {
        const before = await handle.stat();
        if (before.uid !== process.getuid!()) throw new WorkspacePatchError('PATCH_UNSAFE');
        if (before.isDirectory()) { await visit(handle, path + '/'); continue; }
        if (!before.isFile() || before.nlink !== 1) throw new WorkspacePatchError('PATCH_UNSAFE');
        budget.size(before.size);
        const bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) break; offset += read.bytesRead;
        }
        const after = await handle.stat();
        if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) throw new WorkspacePatchError('PATCH_CONFLICT');
        result.set(path, patchFile(bytes, before.mode & 0o111 ? '100755' : '100644'));
      } finally { await handle.close(); }
    }
  }
  const root = await open(workspace, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { await visit(root, ''); } finally { await root.close(); }
  return result;
}
export function snapshotDigest(snapshot: Snapshot) {
  return patchDigest(JSON.stringify([...snapshot].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, file]) => ({ path, mode: file.mode, digest: file.digest }))));
}
