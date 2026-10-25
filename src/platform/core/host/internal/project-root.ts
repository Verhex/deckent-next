import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { PRODUCT_LAYOUT_REGISTRY as registry } from '#platform/core/common/index.js';
import { ErrorRegistry } from '#platform/core/errors/index.js';
import { productRootOverride, type Environment } from './env.js';
import { normalizeGlobalScopePlatform, resolveGlobalScopePaths } from './global-scope.js';

/** The entry facts the resolver reads (an lstat never follows a link; null = absent). */
export interface ProjectRootEntry { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; readonly uid: number; readonly mode: number; readonly nlink: number; readonly dev: number }
export interface ProjectRootPorts {
  readonly realpath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<ProjectRootEntry | null>;
  readonly uid: number | undefined;
  readonly platform: string;
  /** Whether Git tracks any of `paths` (relative to `directory`); null = could not tell (no Git, timeout, refusal): the walk-up then refuses. */
  readonly tracked: (directory: string, paths: readonly string[]) => Promise<boolean | null>;
}
/** `folder`: the launch folder relative to `root` ('' at the root, POSIX separators); `gitTop`: the nearest folder holding `.git` when nothing was found. */
export type ProjectRootResolution = Readonly<{ root: string; folder: string; found: boolean; gitTop: string | null }>;

const HOST_PORTS: ProjectRootPorts = Object.freeze({
  realpath: (path: string) => realpath(path),
  lstat: (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }),
  uid: process.getuid?.(), platform: process.platform, tracked: async () => null,
});
/** The identity record inside the installation identity resource (the installation-files adapter's `identity.json`, as backup reads it). */
const IDENTITY_RECORD = 'identity.json';
const refuse = (code: string, params: Record<string, string>) => ErrorRegistry.createError(code, { params });
const inside = (parent: string, path: string) => path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * U7 (İ-6): the project a command started in a subfolder belongs to — the one reader of the launch folder for product commands. Walks up from
 * the physical start (never through a link, never across a mount, never adopting the global state root) to the nearest folder whose data root
 * holds the policy file, the product's own "installation exists" (J2d). The start itself keeps today's exact behavior; a folder found ABOVE it is
 * adopted only when its policy passes the managed-file checks, no Git work tree tracks its policy or configuration (a clone can carry them,
 * `git add -f`) and its installation identity already exists — read only, nothing is created. Anything else is a typed refusal, never a silent
 * fallback; an identity that does not exist yet reads as "no installation" (the setup offer follows). `exact` (`--project`, `init --here`) and
 * the data-root override skip the walk.
 */
export async function resolveProjectRoot(start: string, env: Environment, options: Readonly<{ exact?: boolean; ports?: Partial<ProjectRootPorts> }> = {}): Promise<ProjectRootResolution> {
  const ports: ProjectRootPorts = { ...HOST_PORTS, ...options.ports };
  if (options.exact || productRootOverride(env) !== undefined) return { root: start, folder: '', found: false, gitTop: null };
  const physical = await ports.realpath(start), device = (await ports.lstat(physical))?.dev;
  let globalRoot: string | null = null;
  try { globalRoot = resolveGlobalScopePaths(normalizeGlobalScopePlatform(ports.platform, env), env).stateDir; globalRoot = await ports.realpath(globalRoot).catch(() => globalRoot); } catch { /* no home: nothing to exclude */ }
  let gitTop: string | null = null;
  for (let directory = physical; ; directory = dirname(directory)) {
    const entry = await ports.lstat(directory);
    if (!entry || entry.dev !== device) break; // a mount boundary ends the walk, as Git's discovery does by default
    const data = join(directory, registry.rootName), policy = join(data, registry.resources.policy);
    const candidate = data !== globalRoot && await ports.lstat(policy) !== null;
    if (candidate && directory === physical) return { root: start, folder: '', found: true, gitTop: null };
    const adopted = candidate ? await adopt(directory, physical, data, ports) : null;
    if (adopted) return adopted;
    gitTop ??= await ports.lstat(join(directory, '.git')) ? directory : null;
    // A folder that looks installed but has no identity yet is not an installation, and nothing above it is adopted in its place.
    if (candidate || dirname(directory) === directory) break;
  }
  return { root: physical, folder: '', found: false, gitTop };
}

async function adopt(directory: string, physical: string, data: string, ports: ProjectRootPorts): Promise<ProjectRootResolution | null> {
  // A worker clone under the data root (workspaces) never resolves the installation that holds it.
  if (inside(data, physical)) throw refuse('INSTALLATION_ROOT_INSIDE_DATA_ROOT', { path: data });
  if (ports.platform === 'win32' || ports.uid === undefined) throw refuse('INSTALLATION_ROOT_WALK_UNSUPPORTED', { root: directory });
  const policyPath = join(data, registry.resources.policy), [root, policy] = await Promise.all([ports.lstat(data), ports.lstat(policyPath)]);
  if (!root || !policy || root.isSymbolicLink() || policy.isSymbolicLink()) throw refuse('INSTALLATION_ROOT_UNSAFE', { path: data, reason: 'symlink' });
  // The managed-file rules the policy reader itself applies: the person's own data folder, writable by nobody else; a private single-link file.
  if (!root.isDirectory() || root.uid !== ports.uid || (root.mode & 0o022) !== 0 || policy.uid !== ports.uid) throw refuse('INSTALLATION_ROOT_FOREIGN', { path: data });
  if ((root.mode & 0o777) !== 0o700 || !policy.isFile() || policy.nlink !== 1 || (policy.mode & 0o777) !== 0o600) throw refuse('INSTALLATION_ROOT_UNSAFE', { path: policyPath, reason: 'mode' });
  const identity = await ports.lstat(join(data, registry.resources.installationIdentity, IDENTITY_RECORD));
  if (!identity?.isFile()) return null;
  if (await insideWorkTree(directory, ports)) {
    const tracked = await ports.tracked(directory, [registry.resources.policy, registry.resources.config].map(name => posix.join(registry.rootName, name)));
    if (tracked !== false) throw refuse('INSTALLATION_ROOT_TRACKED', { path: data, reason: tracked === null ? 'unknown' : 'tracked' });
  }
  return { root: directory, folder: relative(directory, physical).split(sep).join('/'), found: true, gitTop: null };
}
/** A `.git` entry in the folder or above it (same device): only then can Git track the installation's files. */
async function insideWorkTree(directory: string, ports: ProjectRootPorts): Promise<boolean> {
  const device = (await ports.lstat(directory))?.dev;
  for (let current = directory; ; current = dirname(current)) {
    if ((await ports.lstat(current))?.dev !== device) return false;
    if (await ports.lstat(join(current, '.git'))) return true;
    if (dirname(current) === current) return false;
  }
}
