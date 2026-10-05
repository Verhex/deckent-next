import { constants } from 'node:fs';
import { open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { patchPathSchema, patchFile, patchDigest, isPatchExcluded, WorkspacePatchError, type PatchFile, type PatchLimits } from '#engine/index.js';
import type { GitWorkspaceLease, GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { GIT_LOCAL_ENV, localGitArgs } from './local-git.js';
const exec = promisify(execFile);
export type Snapshot = Map<string, PatchFile>;
/** Base tree entry from the trusted source repository: identity only, no content read. */
export type BaseEntry = Readonly<{ mode: PatchFile['mode']; oid: string; size: number }>;
export type BaseListing = Map<string, BaseEntry>;
/** Scan bounds (entries, depth, path bytes, time) cover every directory entry; the byte bound covers only content carried into the
 * patch (changed or added files, base blobs of changed paths) — never the unchanged repository. Each refusal names its limit and value. */
export class SnapshotBudget {
  bytes = 0; entries = 0; readonly started = Date.now();
  constructor(readonly limits: PatchLimits, readonly deadline: number) {}
  time() { if (Date.now() >= this.deadline) throw new WorkspacePatchError('PATCH_LIMIT', 'time', { observed: Date.now() - this.started, limit: this.deadline - this.started }); }
  path(path: string) {
    this.time();
    const depth = path.split('/').length;
    if (depth > this.limits.maxDepth) throw new WorkspacePatchError('PATCH_LIMIT', 'depth', { observed: depth, limit: this.limits.maxDepth });
    const bytes = Buffer.byteLength(path);
    if (bytes > this.limits.maxPathBytes) throw new WorkspacePatchError('PATCH_LIMIT', 'path', { observed: bytes, limit: this.limits.maxPathBytes });
    if (!patchPathSchema.safeParse(path).success) throw new WorkspacePatchError('PATCH_UNSAFE');
  }
  entry() { this.time(); if (++this.entries > this.limits.maxEntries) throw new WorkspacePatchError('PATCH_LIMIT', 'entries', { observed: this.entries, limit: this.limits.maxEntries }); }
  size(size: number) {
    this.time(); this.bytes += size;
    if (!Number.isSafeInteger(size) || size < 0) throw new WorkspacePatchError('PATCH_LIMIT', 'bytes');
    if (this.bytes > this.limits.maxBytes) throw new WorkspacePatchError('PATCH_LIMIT', 'bytes', { observed: this.bytes, limit: this.limits.maxBytes });
  }
}
/** Distinguishes an exhausted output/time bound (typed limit) from Git being unavailable or refusing the command. */
export function gitFailure(error: unknown): WorkspacePatchError {
  const failure = error as { code?: unknown; killed?: boolean; signal?: unknown } | null;
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new WorkspacePatchError('PATCH_LIMIT', 'git-output');
  if (failure?.killed || failure?.signal === 'SIGTERM') return new WorkspacePatchError('PATCH_LIMIT', 'git-timeout');
  return new WorkspacePatchError('PATCH_UNAVAILABLE');
}
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
  const entries: BaseListing = new Map();
  for (const entry of decode(listing).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'); const path = entry.slice(tab + 1);
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64}) +(-|BAD|\d+)$/u.exec(entry.slice(0, tab));
    if (!match) throw new WorkspacePatchError('PATCH_UNSAFE');
    const [, mode, type, oid, sizeText] = match as unknown as [string, string, string, string, string];
    budget.entry();
    if (isPatchExcluded(path)) continue;
    budget.path(path);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new WorkspacePatchError('PATCH_UNSUPPORTED');
    // Git ls-tree -l can succeed while a blob is unavailable (for example an unfetched
    // promisor object with lazy fetching disabled). BAD is its size sentinel, not tree corruption.
    if (sizeText === 'BAD') throw new WorkspacePatchError('PATCH_UNAVAILABLE');
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) throw new WorkspacePatchError('PATCH_UNSAFE');
    entries.set(path, Object.freeze({ mode: mode as PatchFile['mode'], oid, size }));
  }
  return entries;
}
/** Git object id of a blob with the repository's hash algorithm (inferred from the base commit id length). */
export function gitBlobOid(bytes: Uint8Array, algorithm: 'sha1' | 'sha256'): string {
  return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}
export const hashAlgorithmOf = (commit: string): 'sha1' | 'sha256' => commit.length === 64 ? 'sha256' : 'sha1';
/** Paths whose workspace content or mode differs from the base listing, plus additions and removals. Unchanged blobs are never read from Git. */
/** Entries readWorkspace verified byte-identical (mode and blob id) to a base entry without retaining content: the base oid they matched. */
const baseIdentical = new WeakMap<PatchFile, string>();
export function diffAgainstBase(base: BaseListing, after: Snapshot, algorithm: 'sha1' | 'sha256'): string[] {
  const changed = new Set<string>();
  for (const [path, entry] of base) {
    const file = after.get(path);
    if (!file) { changed.add(path); continue; }
    if (file.mode === entry.mode && baseIdentical.get(file) === entry.oid) continue;
    if (file.mode !== entry.mode || gitBlobOid(Buffer.from(file.text, 'utf8'), algorithm) !== entry.oid) changed.add(path);
  }
  for (const path of after.keys()) if (!base.has(path)) changed.add(path);
  return [...changed].sort();
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
export function snapshotDigest(snapshot: Snapshot) {
  return patchDigest(JSON.stringify([...snapshot].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, file]) => ({ path, mode: file.mode, digest: file.digest }))));
}
