import { posix, win32, type PlatformPath } from 'node:path';
import { resolveProductLayout, productResourcePath, LayoutError } from './layout/resolve.js';
import { PRODUCT_LAYOUT_REGISTRY } from '#platform/core/common/index.js';
import { resolveGlobalStateRoot } from '#platform/core/state-root/index.js';
import { ErrorRegistry } from '#platform/core/errors/index.js';
import { envValue, type Environment } from './env.js';
import { detectWslLinux, type KernelIdentityReader } from './wsl-detect.js';

export type GlobalScopePlatform = 'linux' | 'wsl' | 'darwin' | 'win32';
export interface GlobalScopePaths {
  readonly platform: GlobalScopePlatform;
  readonly source: 'env-override' | 'platform-convention';
  readonly home: string | null;
  readonly configDir: string;
  readonly dataDir: string;
  readonly cacheDir: string | null;
  readonly stateDir: string;
}
export function normalizeGlobalScopePlatform(platform: string, env: Environment, kernel?: KernelIdentityReader): GlobalScopePlatform {
  if (platform === 'linux') return detectWslLinux(env, kernel) ? 'wsl' : 'linux';
  if (platform === 'win32' || platform === 'darwin' || platform === 'wsl') return platform;
  throw ErrorRegistry.createError('UNSUPPORTED_PLATFORM', { params: { platform } });
}
// Explicit return type: an inferred one is emitted as `import("path").PlatformPath`, a bare specifier the published declarations refuse.
export function pathApi(platform: string): PlatformPath { return platform === 'win32' ? win32 : posix; }
export function resolveGlobalScopePaths(platform: GlobalScopePlatform, env: Environment, options: { readonly ignoreProjectOverride?: boolean } = {}): GlobalScopePaths {
  platform = normalizeGlobalScopePlatform(platform, env);
  // Global installation state can be isolated without relocating every project workspace. P5a: the one resolver the CLI bootstrap uses too.
  const found = resolveGlobalStateRoot(env, platform, options);
  if (!found.ok) throw found.code === 'LAYOUT_ROOT_INVALID' || found.code === 'LAYOUT_PATH_UNEXPRESSIBLE' ? new LayoutError(found.code) : ErrorRegistry.createError('HOME_NOT_RESOLVED');
  const { home, override, root } = found;
  // No host home means no implicit scratch location: callers must supply a platform-local location.
  const cacheDir = !home ? null : platform === 'win32'
    ? win32.join(envValue(env, 'LOCALAPPDATA') ?? win32.join(home, 'AppData', 'Local'), 'deckent')
    : platform === 'darwin' ? posix.join(home, 'Library', 'Caches', 'deckent')
      : posix.join(envValue(env, 'XDG_CACHE_HOME') ?? posix.join(home, '.cache'), 'deckent');
  return { platform, source: override ? 'env-override' : 'platform-convention', home,
    configDir: root, dataDir: root, stateDir: root, cacheDir };
}
/** The installation's global state root for this process environment; null when neither HOME nor an override names one (BWRAP-SELECT:
 * the bundled bubblewrap's verified copy lives in its `bin/`). The same resolver places the CLI's compile cache (P5a). */
export function globalStateRoot(env: Environment = process.env, platform: string = process.platform): string | null {
  const found = resolveGlobalStateRoot(env, platform);
  return found.ok ? found.root : null;
}
export function resolveGlobalConfigPaths(env: Environment = process.env, platform: string = process.platform) {
  const scope = resolveGlobalScopePaths(normalizeGlobalScopePlatform(platform, env), env);
  const api = pathApi(platform);
  const layout = resolveProductLayout({ projectRoot: scope.stateDir, root: scope.stateDir,
    bootstrapConfigPath: api.join(scope.stateDir, PRODUCT_LAYOUT_REGISTRY.resources.config), platform: platform === 'win32' ? 'win32' : 'posix' });
  return { platformPath: productResourcePath(layout, 'config') };
}

export async function resolveGlobalConfigReadPath(env: Environment = process.env, platform: string = process.platform): Promise<string> {
  return resolveGlobalConfigPaths(env, platform).platformPath;
}
