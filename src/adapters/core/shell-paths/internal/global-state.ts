import { realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { JSON_SCHEMA_LIMITS, StepBudgetExceeded } from '#platform/index.js';
import { expandGlob, segmentMatcher, SHELL_GLOB_MAX_MATCHES } from './paths.js';

const GLOB = /[*?[]/u;
const within = (root: string, path: string) => root === '/' || path === root || path.startsWith(`${root}/`);

/** Names, not contents: resolve existing ancestors without dropping `link/..`; absent children still inherit their real parent. */
async function realName(path: string): Promise<string> {
  try { return await realpath(path); }
  catch {
    const parent = posix.dirname(path);
    return parent === path ? path : posix.join(await realName(parent), posix.basename(path));
  }
}

/** K15 closes global-state names before approval, using the shared bounded glob grammar; sandbox isolation still bounds computed paths/races. */
export async function createShellGlobalStateCheck(projectRoot: string, roots: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): Promise<(text: string) => Promise<boolean>> {
  const protectedRoots = [...new Set([...roots, ...await Promise.all(roots.map(realName))])];
  const protectedPath = (path: string) => protectedRoots.some(root => within(root, path));
  const home = env['HOME'];
  return async text => {
    if (['[', '[[', ']', ']]'].includes(text)) return false;
    text = text.replace(/^[A-Za-z_][A-Za-z0-9_]*=/u, '');
    // Conservatively recognize HOME spellings even when quoted: quotes never open a protected name.
    const expanded = text.replace(/^~(?=\/|$)/u, home ?? '~').replace(/^\$(?:\{(HOME|DECKENT_GLOBAL_HOME)\}|(HOME|DECKENT_GLOBAL_HOME))(?=\/|$)/u, (value, braced: string | undefined, plain: string | undefined) => env[braced ?? plain!] ?? value);
    const raw = posix.isAbsolute(expanded) ? expanded : `${projectRoot}/${expanded}`;
    if (protectedPath(posix.normalize(raw))) return true;
    const globAt = raw.search(GLOB);
    if (globAt < 0) {
      const real = await realName(raw);
      if (protectedPath(real)) return true;
      // An innocent alias can name a credential inode. As with file tools, no multi-link regular file is opened by the shell.
      const info = await stat(raw).catch(() => null);
      return within(projectRoot, real) && info?.isFile() === true && info.nlink > 1;
    }
    const slash = raw.lastIndexOf('/', globAt), base = await realName(raw.slice(0, slash) || '/'), pattern = raw.slice(slash + 1);
    if (protectedPath(base)) return true;
    // Check intersection with the known roots before expansion, including absent roots and globs above their names.
    const segments = posix.join(base, pattern).split('/').filter(Boolean), budget = { remaining: JSON_SCHEMA_LIMITS.validationSteps };
    try {
      for (const root of protectedRoots) {
        const names = root.split('/').filter(Boolean);
        let intersects = true;
        for (let i = 0; i < Math.min(segments.length, names.length); i++) {
          const segment = segments[i]!, match = GLOB.test(segment) ? segmentMatcher(segment) : null;
          if (GLOB.test(segment) && match === null) return true;
          if (match ? !match(names[i]!, budget) : segment !== names[i]) { intersects = false; break; }
        }
        if (intersects) return true;
      }
    } catch (error) { if (error instanceof StepBudgetExceeded) return true; throw error; }
    const matches = await expandGlob(base, pattern, SHELL_GLOB_MAX_MATCHES, JSON_SCHEMA_LIMITS.validationSteps);
    if (matches === null || matches === 'unsupported') return true;
    for (const match of matches) {
      if (protectedPath(await realName(match))) return true;
      const info = await stat(match).catch(() => null);
      if (info?.isFile() && info.nlink > 1) return true;
    }
    return false;
  };
}
