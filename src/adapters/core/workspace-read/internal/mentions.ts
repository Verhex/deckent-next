import type { FileHandle } from 'node:fs/promises';
import { sliceUtf8 } from './bounded.js';
import { walkWorkspaceFiles, type WorkspacePathError, type WorkspaceScope } from './scope.js';

/**
 * Composer `@file` support (T-L5): a bounded file index over the same descriptor walk as the read tools (Core deny floor, ignored
 * directories, no symlink followed), a fuzzy ranking, and one file's content as a bounded UTF-8 prefix through `scope.open`
 * (no-follow per component, regular single-link files only). Nothing here decides authority; the service authorizes the caller.
 */
export interface WorkspaceFileIndex {
  readonly paths: readonly string[];
  /** The walk stopped at the path bound. */
  readonly truncated: boolean;
  /** Some directories could not be covered (depth, unreadable, changed, special files). */
  readonly incomplete: boolean;
}
export const WORKSPACE_INDEX_MAX_FILES = 50_000;

export async function indexWorkspaceFiles(scope: WorkspaceScope, maxFiles = WORKSPACE_INDEX_MAX_FILES, signal?: AbortSignal): Promise<WorkspaceFileIndex> {
  const paths: string[] = [];
  let truncated = false;
  const incomplete = await walkWorkspaceFiles(scope, '', rel => {
    if (paths.length >= maxFiles) { truncated = true; return false; }
    paths.push(rel); return true;
  }, signal);
  return Object.freeze({ paths: Object.freeze(paths), truncated,
    incomplete: incomplete.depthLimited + incomplete.unreadable + incomplete.changed + incomplete.special > 0 });
}

function subsequence(query: string, text: string): boolean {
  let at = 0;
  for (const char of query) { at = text.indexOf(char, at); if (at < 0) return false; at += char.length; }
  return true;
}
/**
 * Rank of one path for a query (lower is better; null: no match). Case-insensitive. A file-name match beats a path match; within
 * each, exact (with or without extension) > prefix > substring > subsequence. A query with `/` is matched against the path (segments), never the name alone.
 */
export function workspacePathRank(path: string, query: string): number | null {
  const q = query.toLowerCase(), lower = path.toLowerCase(), name = lower.slice(lower.lastIndexOf('/') + 1);
  if (!q.includes('/')) {
    // The name without its extension counts as exact too: `compose` finds `compose.ts` first.
    if (name === q || name.slice(0, name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length) === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
  }
  if (lower.startsWith(q) || lower.includes(`/${q}`)) return 3;
  if (lower.includes(q)) return 4;
  if (!q.includes('/') && subsequence(q, name)) return 5;
  return subsequence(q, lower) ? 6 : null;
}
/** Best `limit` matches: rank, then fewer segments, then shorter path, then name order. An empty query lists shallow files first. */
export function rankWorkspacePaths(paths: readonly string[], query: string, limit: number): string[] {
  const depth = (path: string) => path.split('/').length;
  return paths.flatMap(path => { const rank = query ? workspacePathRank(path, query) : 0; return rank === null ? [] : [{ path, rank }]; })
    .sort((left, right) => left.rank - right.rank || depth(left.path) - depth(right.path) || left.path.length - right.path.length
      || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .slice(0, limit).map(entry => entry.path);
}

export type WorkspaceAttachmentRead =
  | { readonly status: 'attached'; readonly path: string; readonly content: string; readonly bytes: number; readonly totalBytes: number; readonly truncated: boolean }
  | { readonly status: 'refused'; readonly path: string; readonly reason: WorkspacePathError | 'binary' | 'read-error' | 'cancelled' };
const BINARY_PROBE_BYTES = 8192;

/** Reads at most `maxBytes` of text from an opened, checked regular file; a file changed while reading is refused. Always closes. */
async function readPrefix(handle: FileHandle, maxBytes: number, signal?: AbortSignal): Promise<{ ok: true; text: string; total: number; cut: boolean } | { ok: false; reason: 'binary' | 'read-error' | 'cancelled' }> {
  try {
    const before = await handle.stat();
    const want = Math.min(before.size, Math.max(maxBytes + 3, BINARY_PROBE_BYTES));
    const buf = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      if (signal?.aborted) return { ok: false, reason: 'cancelled' };
      const { bytesRead } = await handle.read(buf, read, want - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const after = await handle.stat();
    if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { ok: false, reason: 'read-error' };
    const body = buf.subarray(0, read);
    if (body.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { ok: false, reason: 'binary' };
    // The raw prefix ends on a UTF-8 boundary; invalid bytes decode to U+FFFD (3 bytes), so the decoded text is cut to the bound again.
    let end = Math.min(read, maxBytes);
    while (end > 0 && end < read && (body[end]! & 0xc0) === 0x80) end--;
    const decoded = body.subarray(0, end).toString('utf8');
    const text = Buffer.byteLength(decoded, 'utf8') > maxBytes ? sliceUtf8(Buffer.from(decoded, 'utf8'), maxBytes) : decoded;
    return { ok: true, text, total: before.size, cut: end < before.size || text !== decoded };
  } catch { return { ok: false, reason: 'read-error' }; }
  finally { await handle.close().catch(() => undefined); }
}

/** One mentioned file as bounded text: resolved inside the workspace (deny floor, real path), opened without following links. */
export async function readWorkspaceAttachment(scope: WorkspaceScope, requested: string, maxBytes: number, signal?: AbortSignal): Promise<WorkspaceAttachmentRead> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('WORKSPACE_ATTACHMENT_LIMIT_INVALID');
  const target = await scope.resolve(requested);
  if (!target.ok) return { status: 'refused', path: requested, reason: target.error };
  const opened = await scope.open(target.rel, 'file');
  if (!opened.ok) return { status: 'refused', path: target.rel, reason: opened.error };
  const read = await readPrefix(opened.handle, maxBytes, signal);
  if (!read.ok) return { status: 'refused', path: target.rel, reason: read.reason };
  const bytes = Buffer.byteLength(read.text, 'utf8');
  return { status: 'attached', path: target.rel, content: read.text, bytes, totalBytes: read.total, truncated: read.cut };
}
