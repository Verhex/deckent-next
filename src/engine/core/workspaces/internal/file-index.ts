export interface WorkspaceFileIndex {
  readonly paths: readonly string[];
  /** The walk stopped at the path bound. */
  readonly truncated: boolean;
  /** Some directories could not be covered (depth, unreadable, changed, special files). */
  readonly incomplete: boolean;
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

export interface RuntimeWorkspaceFileHost {
  /**
   * The project's file list under `deny`. A first walk is awaited; afterwards the last list answers at once (TERM-UX-1 a): once it is older
   * than `ttlMs` one background walk refreshes it (single flight), so no keystroke waits for a walk again. A list older than `maxStaleMs` is
   * not served: the caller waits for a fresh walk. Ranking runs on the list per query.
   */
  index(projectRoot: string, deny: readonly string[]): Promise<WorkspaceFileIndex>;
}
export function createWorkspaceFileIndexCache(walk: (projectRoot: string, deny: readonly string[]) => Promise<WorkspaceFileIndex>,
  ttlMs: number, now: () => number, maxStaleMs: number): RuntimeWorkspaceFileHost {
  interface Entry { readonly at: number; readonly index: Promise<WorkspaceFileIndex>; refreshing: boolean }
  const cached = new Map<string, Entry>();
  return Object.freeze({
    index(projectRoot: string, deny: readonly string[]) {
      const key = [projectRoot, ...deny].join('\0'), hit = cached.get(key), at = now();
      if (hit && at - hit.at < ttlMs) return hit.index;
      if (hit && at - hit.at < maxStaleMs) {
        if (!hit.refreshing) {
          hit.refreshing = true;
          // A failed refresh keeps the older list and is retried by a later query.
          walk(projectRoot, deny).then(fresh => { cached.set(key, { at: now(), index: Promise.resolve(fresh), refreshing: false }); }, () => { hit.refreshing = false; });
        }
        return hit.index;
      }
      const index = walk(projectRoot, deny);
      cached.set(key, { at, index, refreshing: false });
      // A failed walk is not cached: the next query walks again.
      index.catch(() => { if (cached.get(key)?.index === index) cached.delete(key); });
      return index;
    },
  });
}
