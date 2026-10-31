import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import module from 'node:module';
import { posix, win32 } from 'node:path';
import { PRODUCT_LAYOUT_REGISTRY as registry, hasGlobWildcard } from '#platform/core/common/index.js';

type Env = Readonly<Record<string, string | undefined>>;
export type GlobalStateRoot = { readonly ok: true; readonly root: string; readonly home: string | null; readonly override: string | undefined }
  | { readonly ok: false; readonly code: 'UNSUPPORTED_PLATFORM' | 'HOME_NOT_RESOLVED' | 'LAYOUT_ROOT_INVALID' | 'LAYOUT_PATH_UNEXPRESSIBLE' };
const value = (env: Env, name: string) => env[name] === '' ? undefined : env[name];
const hasControl = (text: string) => [...text].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/**
 * The installation's global state root for an environment and platform, with node: built-ins and the layout registry only (P5a, owner
 * 2026-10-31): the CLI bootstrap resolves the compile cache with it before any other module loads, and the host unit's `globalStateRoot` /
 * `resolveGlobalScopePaths` take their root from it, so the two can never name different roots. `DECKENT_GLOBAL_HOME`, else `DECKENT_HOME`
 * (unless `ignoreProjectOverride`), else `<home>/.deckent`; refused like the product layout refuses a root (relative, control characters, `*`/`?`).
 */
export function resolveGlobalStateRoot(env: Env, platform: string, options: { readonly ignoreProjectOverride?: boolean } = {}): GlobalStateRoot {
  if (!['linux', 'wsl', 'darwin', 'win32'].includes(platform)) return { ok: false, code: 'UNSUPPORTED_PLATFORM' };
  const api = platform === 'win32' ? win32 : posix, drive = value(env, 'HOMEDRIVE'), homePath = value(env, 'HOMEPATH');
  const home = platform === 'win32' ? value(env, 'USERPROFILE') ?? (drive && homePath ? win32.join(drive, homePath) : null) : value(env, 'HOME') ?? null;
  const override = value(env, registry.globalRootEnvironmentKey) ?? (options.ignoreProjectOverride ? undefined : value(env, registry.rootEnvironmentKey));
  const base = home ?? override;
  if (!base) return { ok: false, code: 'HOME_NOT_RESOLVED' };
  if (!api.isAbsolute(base) || hasControl(base) || (override !== undefined && (!api.isAbsolute(override) || hasControl(override)))) return { ok: false, code: 'LAYOUT_ROOT_INVALID' };
  const root = api.normalize(override ?? api.join(base, registry.rootName));
  if (hasGlobWildcard(base) || hasGlobWildcard(root)) return { ok: false, code: 'LAYOUT_PATH_UNEXPRESSIBLE' };
  return { ok: true, root, home, override };
}

/** The calls that fill the cache: the runtime service and the bare interactive terminal. Every other command only reads it (Node's
 * `readOnly`, v26.8.0+), so a read-only command never writes the global root; without `readOnly` (Node 24) it runs without the cache. */
const fills = (argv: readonly string[]) => argv.length === 0 || argv[0] === 'runtime' && argv[1] === 'serve';
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number), readOnlyCache = major > 26 || major === 26 && minor >= 8;

/**
 * P5a (owner 2026-10-31): Node's compile cache for this process in the registered `compileCache` resource under the global state root — never
 * a user cache directory: in a full-access agent shell that root is hidden or sealed read-only (agentShellHardFloor), and uninstall removes it.
 * Only at the conventional global root (a non-default DECKENT_GLOBAL_HOME/DECKENT_HOME runs without it: no floor seals every such root). Only
 * a filling call (`fills`) creates it, and only below an existing global root of this user (a call before any installation writes nothing in HOME). Used only when root, `state`, the cache and its per-version directories are real directories of this user (no link; root without
 * group/other write, the rest owner-only) and the cache's real path is its own; otherwise, on `NODE_DISABLE_COMPILE_CACHE`
 * or the registry's off switch, or without POSIX ownership (Windows), the process runs without it. Never throws. Enterprise distributions call
 * it first in their own executable with the same argv (`deckent/extensions`); modules loaded before the call are not cached.
 */
export function enableDeckentCompileCache(argv: readonly string[] = process.argv.slice(2), env: Env = process.env, platform: string = process.platform): 'enabled' | 'off' | 'unavailable' {
  const off = (name: string) => { const set = value(env, name)?.trim().toLowerCase(); return set !== undefined && set !== '0' && set !== 'false'; };
  if (off('NODE_DISABLE_COMPILE_CACHE') || off(registry.compileCacheOffEnvironmentKey)) return 'off';
  const uid = process.getuid?.(), found = resolveGlobalStateRoot(env, platform), write = fills(argv);
  // Only the conventional root (the one without DECKENT_GLOBAL_HOME/DECKENT_HOME) is sealed by every agent floor, also before it exists (lead 2026-10-31).
  const conventional = resolveGlobalStateRoot({ HOME: env['HOME'], USERPROFILE: env['USERPROFILE'], HOMEDRIVE: env['HOMEDRIVE'], HOMEPATH: env['HOMEPATH'] }, platform);
  if (uid === undefined || !found.ok || !conventional.ok || found.root !== conventional.root || !write && !readOnlyCache) return 'unavailable';
  try {
    // Astra A-R1: the whole chain is checked with lstat (a link anywhere refuses): the root without group/other write, `state`, the cache and each
    // per-version directory owner-only, and the cache's real path is its own path; a missing part is made 0700 and then checked like an existing one.
    const owned = (path: string, mask: number) => { const info = lstatSync(path); return info.isDirectory() && info.uid === uid && (info.mode & mask) === 0; };
    if (!owned(found.root, 0o022)) return 'unavailable';
    const api = platform === 'win32' ? win32 : posix;
    let directory = found.root;
    for (const segment of registry.resources.compileCache.split('/')) {
      directory = api.join(directory, segment);
      if (write) try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'unavailable'; }
      if (!owned(directory, 0o077)) return 'unavailable';
    }
    if (realpathSync(directory) !== directory || !readdirSync(directory).every(name => owned(api.join(directory, name), 0o077))) return 'unavailable';
    const { status } = module.enableCompileCache(write ? directory : { directory, readOnly: true } as module.EnableCompileCacheOptions);
    // ALREADY_ENABLED: the person's own NODE_COMPILE_CACHE directory is in use; it is left as it is.
    if (status === module.constants.compileCacheStatus.ALREADY_ENABLED) return 'enabled';
    if (status !== module.constants.compileCacheStatus.ENABLED) return 'unavailable';
    // Node makes its per-version directory with the process umask; owner-only keeps it a member uninstall may remove.
    const versioned = write ? module.getCompileCacheDir() : undefined, made = versioned ? lstatSync(versioned) : null;
    if (versioned && made?.isDirectory() && made.uid === uid && (made.mode & 0o077) !== 0) chmodSync(versioned, 0o700);
    return 'enabled';
  } catch { return 'unavailable'; }
}
