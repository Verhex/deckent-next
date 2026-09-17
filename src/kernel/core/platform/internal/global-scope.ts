import { posix, win32 } from 'node:path';
import { CONFIG_FILE, DECKENT_DIR } from '#kernel/core/common/index.js';
import { ErrorRegistry } from '#kernel/core/errors/index.js';
import { envValue, type Environment } from './env.js';

export type GlobalScopePlatform = 'linux' | 'wsl' | 'darwin' | 'win32';
export interface GlobalScopePaths {
  readonly platform: GlobalScopePlatform;
  readonly source: 'env-override' | 'platform-convention';
  readonly home: string | null;
  readonly configDir: string;
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly stateDir: string;
  readonly legacyDir: string | null;
}
export function normalizeGlobalScopePlatform(platform: string, env: Environment): GlobalScopePlatform {
  if (platform === 'linux') return envValue(env, 'WSL_DISTRO_NAME') || envValue(env, 'WSL_INTEROP') ? 'wsl' : 'linux';
  if (platform === 'win32' || platform === 'darwin' || platform === 'wsl') return platform;
  throw ErrorRegistry.createError('UNSUPPORTED_PLATFORM', { params: { platform } });
}
export function pathApi(platform: string) { return platform === 'win32' ? win32 : posix; }
export function resolveGlobalScopePaths(platform: GlobalScopePlatform, env: Environment): GlobalScopePaths {
  platform = normalizeGlobalScopePlatform(platform, env);
  const api = pathApi(platform);
  const drive = envValue(env, 'HOMEDRIVE');
  const homePath = envValue(env, 'HOMEPATH');
  const home = platform === 'win32'
    ? envValue(env, 'USERPROFILE') ?? (drive && homePath ? win32.join(drive, homePath) : null)
    : envValue(env, 'HOME') ?? null;
  const legacyDir = home ? api.join(home, DECKENT_DIR) : null;
  const override = envValue(env, 'DECKENT_HOME');
  if (override) return { platform, source: 'env-override', home, legacyDir, configDir: override, dataDir: override, cacheDir: override, stateDir: override };
  if (!home) throw ErrorRegistry.createError('HOME_NOT_RESOLVED');
  const base = { platform, source: 'platform-convention' as const, home, legacyDir };
  if (platform === 'win32') {
    const roaming = win32.join(envValue(env, 'APPDATA') ?? win32.join(home, 'AppData', 'Roaming'), 'deckent');
    const local = win32.join(envValue(env, 'LOCALAPPDATA') ?? win32.join(home, 'AppData', 'Local'), 'deckent');
    return { ...base, configDir: roaming, dataDir: roaming, cacheDir: local, stateDir: local };
  }
  if (platform === 'darwin') {
    const support = posix.join(home, 'Library', 'Application Support', 'deckent');
    return { ...base, configDir: support, dataDir: support, stateDir: support, cacheDir: posix.join(home, 'Library', 'Caches', 'deckent') };
  }
  return { ...base,
    configDir: posix.join(envValue(env, 'XDG_CONFIG_HOME') ?? posix.join(home, '.config'), 'deckent'),
    dataDir: posix.join(envValue(env, 'XDG_DATA_HOME') ?? posix.join(home, '.local', 'share'), 'deckent'),
    cacheDir: posix.join(envValue(env, 'XDG_CACHE_HOME') ?? posix.join(home, '.cache'), 'deckent'),
    stateDir: posix.join(envValue(env, 'XDG_STATE_HOME') ?? posix.join(home, '.local', 'state'), 'deckent'),
  };
}
export function resolveGlobalConfigPaths(env: Environment = process.env, platform: string = process.platform) {
  const scope = resolveGlobalScopePaths(normalizeGlobalScopePlatform(platform, env), env);
  const api = pathApi(platform);
  const platformPath = api.join(scope.configDir, CONFIG_FILE);
  return { platformPath, legacyPath: scope.legacyDir ? api.join(scope.legacyDir, CONFIG_FILE) : platformPath };
}
export async function resolveGlobalConfigReadPath(env: Environment = process.env, platform: string = process.platform): Promise<string> {
  return resolveGlobalConfigPaths(env, platform).platformPath;
}
