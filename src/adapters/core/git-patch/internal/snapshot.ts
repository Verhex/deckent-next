import { constants } from 'node:fs';
import { open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { workspacePathHidden } from '#domain/index.js';
import { patchDigest, patchFile, isPatchExcluded, WorkspacePatchError, type PatchFile } from '#engine/index.js';
import type { GitWorkspaceLease, GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { GIT_LOCAL_ENV, localGitArgs } from './local-git.js';
const exec = promisify(execFile);
import { SnapshotBudget, parseBaseListing, baseIdentical, type Snapshot, type BaseEntry, type BaseListing } from '#engine/index.js';
export { SnapshotBudget, gitBlobOid, hashAlgorithmOf, diffAgainstBase, snapshotDigest } from '#engine/index.js';
export type { Snapshot, BaseEntry, BaseListing } from '#engine/index.js';
export { gitFailure } from '#engine/index.js';
import { gitFailure } from '#engine/index.js';
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
function sourceGit(lease: GitWorkspaceLease, options: GitWorkspaceOptions, budget: SnapshotBudget) {
  return async (args: string[], maxBuffer: number) => {
    budget.time();
    try {
      return (await exec(options.gitExecutable, localGitArgs(lease.sourceBase.source.repositoryRoot, args),
      { env: GIT_LOCAL_ENV, timeout: Math.max(1, budget.deadline - Date.now()), maxBuffer, encoding: 'buffer' })).stdout;
    } catch (error) { throw gitFailure(error); }
  };
}
/** Lists the base tree once (paths, modes, object ids, sizes) without reading any blob. */
export async function listBase(lease: GitWorkspaceLease, options: GitWorkspaceOptions, budget: SnapshotBudget): Promise<BaseListing> {
  const git = sourceGit(lease, options, budget);
  const listing = await git(['ls-tree', '-r', '-z', '-l', '--full-tree', lease.baseCommit], options.outputBytes);
  return parseBaseListing(decode(listing), budget);
}
/** Reads only the listed base blobs (the changed set), each bounded by its recorded size and the shared budget. */
export async function readBaseBlobs(lease: GitWorkspaceLease, options: GitWorkspaceOptions, budget: SnapshotBudget,
  entries: ReadonlyArray<readonly [string, BaseEntry]>): Promise<Snapshot> {
  const git = sourceGit(lease, options, budget);
  const snapshot: Snapshot = new Map();
  for (const [path, entry] of entries) {
    budget.size(entry.size);
    const bytes = await git(['cat-file', 'blob', entry.oid], Math.max(1, entry.size + 1));
    if (bytes.length !== entry.size) throw new WorkspacePatchError('PATCH_CONFLICT');
    snapshot.set(path, patchFile(bytes, entry.mode));
  }
  return snapshot;
}
/** C2: in a checkout shaped by the attempt's pinned `hiddenPaths`, a hidden base path the tree does not hold is unchanged, never a deletion.
 * Each one is completed from its base blob exactly as a full checkout's identical file reads (digest-only entry; full content for a `keep`
 * path), so both checkouts yield the same snapshot and patch. A hidden path the worker wrote is present, was read normally and stays a
 * visible change. Without `hiddenPaths` the snapshot is returned as read. */
export async function completeHiddenBase(lease: GitWorkspaceLease, options: GitWorkspaceOptions, budget: SnapshotBudget, base: WorkspaceBase,
  hiddenPaths: readonly string[] | null | undefined, snapshot: Snapshot): Promise<Snapshot> {
  if (!hiddenPaths?.length) return snapshot;
  const git = sourceGit(lease, options, budget), result: Snapshot = new Map(snapshot);
  for (const [path, entry] of base.listing) {
    if (result.has(path) || !workspacePathHidden(path, hiddenPaths)) continue;
    budget.entry(); budget.path(path);
    const bytes = await git(['cat-file', 'blob', entry.oid], Math.max(1, entry.size + 1));
    if (bytes.length !== entry.size) throw new WorkspacePatchError('PATCH_CONFLICT');
    if (base.keep?.has(path)) { budget.size(entry.size); result.set(path, patchFile(bytes, entry.mode)); continue; }
    const light: PatchFile = Object.freeze({ mode: entry.mode, text: '', digest: patchDigest(bytes) });
    baseIdentical.set(light, entry.oid); result.set(path, light);
  }
  return result;
}
/** Linux descriptor-relative traversal; worker metadata is never interpreted by Git on the host. */
export type WorkspaceBase = Readonly<{ listing: BaseListing; algorithm: 'sha1' | 'sha256'; keep?: ReadonlySet<string> }>;
const CHUNK = 65_536;
/** Streams a file through the patch digest and the Git blob id without retaining it; the scan budget is checked per chunk. */
async function hashStreaming(handle: FileHandle, size: number, algorithm: 'sha1' | 'sha256', budget: SnapshotBudget) {
  const digest = createHash('sha256'), oid = createHash(algorithm).update(`blob ${size}\0`), chunk = Buffer.alloc(Math.min(CHUNK, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    budget.time();
    const read = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (!read.bytesRead) break;
    digest.update(chunk.subarray(0, read.bytesRead)); oid.update(chunk.subarray(0, read.bytesRead)); offset += read.bytesRead;
  }
  return { offset, digest: digest.digest('hex'), oid: oid.digest('hex') };
}
/** With `base`, files identical to the base are only hashed (streamed, not retained, not charged to the byte budget) and appear as
 * digest-only entries that `diffAgainstBase` accepts against the same listing; only changed/added files (and `base.keep` paths) are loaded
 * and charged. Without `base` every file is loaded and charged. */
export async function readWorkspace(workspace: string, budget: SnapshotBudget, base?: WorkspaceBase): Promise<Snapshot> {
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
        const mode = before.mode & 0o111 ? '100755' : '100644';
        const known = base?.listing.get(path);
        if (base && known && known.mode === mode && known.size === before.size && !base.keep?.has(path)) {
          const hashed = await hashStreaming(handle, before.size, base.algorithm, budget);
          const settled = await handle.stat();
          if (hashed.offset !== before.size || settled.size !== before.size || settled.mtimeMs !== before.mtimeMs
            || settled.ctimeMs !== before.ctimeMs || settled.nlink !== 1) throw new WorkspacePatchError('PATCH_CONFLICT');
          if (hashed.oid === known.oid) {
            const light: PatchFile = Object.freeze({ mode, text: '', digest: hashed.digest });
            baseIdentical.set(light, known.oid); result.set(path, light); continue;
          }
        }
        budget.size(before.size);
        const bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) break; offset += read.bytesRead;
        }
        const after = await handle.stat();
        if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) throw new WorkspacePatchError('PATCH_CONFLICT');
        result.set(path, patchFile(bytes, mode));
      } finally { await handle.close(); }
    }
  }
  const root = await open(workspace, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { await visit(root, ''); } finally { await root.close(); }
  return result;
}
