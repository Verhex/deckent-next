import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Whether two host paths share a tree (one is the other or lies inside it), judged by device and inode along each real path's ancestors: a
 * case-folded, Unicode-normalized or bind-aliased spelling of the same directory counts as the same directory. A path that cannot be
 * resolved counts as sharing (fail closed: the caller keeps its stricter rule).
 */
export async function pathsShareTree(a: string, b: string): Promise<boolean> {
  const chain = async (path: string) => {
    const ids: string[] = [];
    for (let current = await realpath(path); ; current = dirname(current)) {
      const info = await stat(current, { bigint: true }); ids.push(`${info.dev}:${info.ino}`);
      if (dirname(current) === current) return ids;
    }
  };
  try { const [left, right] = await Promise.all([chain(a), chain(b)]); return left.includes(right[0]!) || right.includes(left[0]!); } catch { return true; }
}
