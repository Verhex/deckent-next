import type { AttemptIdentity } from '#domain/index.js';
import type { WorkspaceSource } from '#engine/core/workspaces/index.js';
import { createHash } from 'node:crypto';
import { patchExclusions, workspacePatchSchema, patchPathSchema, isPatchExcluded, patchDigest, WorkspacePatchError, type WorkspacePatch, type PatchFile, type PatchLimits } from './contract.js';
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

/** Git object id of a blob with the repository's hash algorithm (inferred from the base commit id length). */
export function gitBlobOid(bytes: Uint8Array, algorithm: 'sha1' | 'sha256'): string {
  return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}
export const hashAlgorithmOf = (commit: string): 'sha1' | 'sha256' => commit.length === 64 ? 'sha256' : 'sha1';
/** Paths whose workspace content or mode differs from the base listing, plus additions and removals. Unchanged blobs are never read from Git. */
/** Entries readWorkspace verified byte-identical (mode and blob id) to a base entry without retaining content: the base oid they matched. */
export const baseIdentical = new WeakMap<PatchFile, string>();
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

export function snapshotDigest(snapshot: Snapshot) {
  return patchDigest(JSON.stringify([...snapshot].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, file]) => ({ path, mode: file.mode, digest: file.digest }))));
}

export function parseBaseListing(listing: string, budget: SnapshotBudget): BaseListing {
  const entries: BaseListing = new Map();
  for (const entry of listing.split('\0').filter(Boolean)) {
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

/** Distinguishes an exhausted output/time bound (typed limit) from Git being unavailable or refusing the command. */
export function gitFailure(error: unknown): WorkspacePatchError {
  const failure = error as { code?: unknown; killed?: boolean; signal?: unknown } | null;
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new WorkspacePatchError('PATCH_LIMIT', 'git-output');
  if (failure?.killed || failure?.signal === 'SIGTERM') return new WorkspacePatchError('PATCH_LIMIT', 'git-timeout');
  return new WorkspacePatchError('PATCH_UNAVAILABLE');
}

export function parseIntegrationDiffStats(output: string) {
    let added = 0, removed = 0; const files: string[] = [];
    for (const row of output.split('\0').filter(Boolean)) {
      const [a, r, ...path] = row.split('\t');
      if (!a || !r || !/^(?:[0-9]+|-)$/u.test(a) || !/^(?:[0-9]+|-)$/u.test(r) || !path.length) throw new WorkspacePatchError('PATCH_CORRUPT');
      added += a === '-' ? 0 : Number(a); removed += r === '-' ? 0 : Number(r); files.push(path.join('\t'));
    }
    return { files, added, removed };
  }
  /** The candidate must be exactly base + patch: the same changed path set and the patch's `after` content, nothing else. */
export function assertIntegrationSnapshot(listing: BaseListing, algorithm: 'sha1' | 'sha256', patch: WorkspacePatch, current: Snapshot) {
    if (JSON.stringify(diffAgainstBase(listing, current, algorithm)) !== JSON.stringify(patch.changes.map(change => change.path))) throw new WorkspacePatchError('PATCH_CONFLICT');
    for (const change of patch.changes) {
      if (JSON.stringify(current.get(change.path) ?? null) !== JSON.stringify(change.after)) throw new WorkspacePatchError('PATCH_CONFLICT');
    }
  }

export function assertIntegrationBefore(listing: BaseListing, algorithm: 'sha1' | 'sha256', patch: WorkspacePatch): void {
    for (const change of patch.changes) {
      const entry = listing.get(change.path) ?? null;
      if ((entry === null) !== (change.before === null)) throw new WorkspacePatchError('PATCH_CORRUPT');
      if (entry && change.before && (entry.mode !== change.before.mode || gitBlobOid(Buffer.from(change.before.text, 'utf8'), algorithm) !== entry.oid)) throw new WorkspacePatchError('PATCH_CORRUPT');
    }
}

export function capturedWorkspacePatch(identity: AttemptIdentity, source: WorkspaceSource, baseCommit: string, changedPaths: readonly string[], base: Snapshot, after: Snapshot) {
      const changes = changedPaths.flatMap(path => {
        const before = base.get(path) ?? null; const next = after.get(path) ?? null;
        return JSON.stringify(before) === JSON.stringify(next) ? [] : [{ path, before, after: next }];
      });
      return workspacePatchSchema.parse({ schemaVersion: 1, kind: 'workspace-patch', identity: identity,
        source: source, baseCommit: baseCommit, snapshotDigest: snapshotDigest(after), exclusions: patchExclusions, changes });
}

export function prepareIntegrationSnapshot(listing: BaseListing, algorithm: 'sha1' | 'sha256', patch: WorkspacePatch, initial: Snapshot): Snapshot {
    if (diffAgainstBase(listing, initial, algorithm).length) throw new WorkspacePatchError('PATCH_CONFLICT');
    for (const change of patch.changes) {
      if (JSON.stringify(initial.get(change.path) ?? null) !== JSON.stringify(change.before)) throw new WorkspacePatchError('PATCH_CONFLICT');
    }
    // Expected content is the fresh base checkout plus the patch; the manifest digest never depends on Git blob reads.
    const snapshot: Snapshot = new Map(initial);
    for (const change of patch.changes) { if (change.after) snapshot.set(change.path, change.after); else snapshot.delete(change.path); }
    return snapshot;
}
