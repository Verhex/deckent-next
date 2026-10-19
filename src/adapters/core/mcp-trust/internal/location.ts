import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ErrorRegistry } from '#platform/index.js';
/** The directory of the Deckent global root that holds one trust directory per project (SEC-2, F29). */
export const MCP_PROJECT_TRUST_DIR = 'mcp-project-trust';
const unavailable = (reason: string) => ErrorRegistry.createError('MCP_TRUST_STORE_UNAVAILABLE', { params: { reason } });
const exists = (error: unknown) => { if ((error as { code?: unknown })?.code !== 'EEXIST') throw error; };
/** The real path of `path`, or of its nearest existing ancestor with the rest appended (links resolved before anything is created). */
const realOf = async (path: string): Promise<string> => realpath(path).catch(() => dirname(path) === path ? resolve(path) : realOf(dirname(path)).then(at => join(at, basename(path))));

/** SEC-2 (F29): the project and local trust of one project: `<global root>/mcp-project-trust/<key>/`, keyed by the project's real path and
 * directory identity (a re-created project asks again), like instruction trust. Never inside the project tree (a repository cannot ship it),
 * this user's private directory (0700, not a link), else unavailable: nothing trusted. `prepare` creates it for a writer; a reader never. */
export async function mcpProjectTrustDirectory(projectRoot: string, globalRoot: string, prepare: boolean): Promise<string> {
  const root = await realpath(projectRoot), identity = await stat(root);
  const key = createHash('sha256').update(`mcp-project-trust:1\0${root}\0${identity.dev}\0${identity.ino}`).digest('hex');
  const parent = join(globalRoot, MCP_PROJECT_TRUST_DIR), directory = join(parent, key);
  const outside = async () => { const rel = relative(root, await realOf(directory)); return rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)); };
  // Checked before anything is created (nothing is made inside the project) and again after (a link swapped in meanwhile).
  if (!(await outside())) throw unavailable('trust-store-in-project');
  if (prepare) {
    await mkdir(globalRoot, { recursive: true, mode: 0o700 });
    for (const path of [parent, directory]) await mkdir(path, { mode: 0o700 }).catch(exists);
    if (!(await outside())) throw unavailable('trust-store-in-project');
  }
  const info = await lstat(directory).catch(() => null), uid = process.getuid?.();
  if (info && (!info.isDirectory() || (info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid))) throw unavailable('trust-store-unsafe');
  return directory;
}
