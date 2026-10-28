import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
/** Owner-only file mode: a private file or directory has none of these bits. */
export const PRIVATE_PERMISSION_MASK = 0o077;
/** Lexical containment of normalized absolute paths: `child` is `parent` or lies below it. */
export const pathWithin = (parent: string, child: string) => { const path = relative(parent, child); return !path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)); };

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
/** A location whose existing part is canonical (no link anywhere on its real path) and which, when it exists, is a directory private to this
 * user; the deepest existing ancestor of a missing one is canonical too. */
export async function privateLocationSafe(path: string): Promise<boolean> {
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current).catch(() => null);
    if (info) return info.isDirectory() && await realpath(current).catch(() => '') === current
      && (current !== path || info.uid === process.getuid?.() && !(info.mode & PRIVATE_PERMISSION_MASK));
    if (dirname(current) === current) return false;
  }
}
