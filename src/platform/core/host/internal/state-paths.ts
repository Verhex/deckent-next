import { productRootOverride, type Environment } from './env.js';
import { normalizeGlobalScopePlatform, resolveGlobalScopePaths } from './global-scope.js';
import { resolveProductLayout, type ProductLayout } from './layout/resolve.js';

export interface PathContext { env?: Environment; platform?: string; layout?: ProductLayout }
/** Bootstrap before config can be read: one root, never an independent memory override. */
export function resolveProductPaths(projectRoot?: string, options: PathContext = {}): ProductLayout {
  if (options.layout) return options.layout;
  const env = options.env ?? process.env;
  const platform = normalizeGlobalScopePlatform(options.platform ?? process.platform, env);
  const override = productRootOverride(env);
  const root = override ?? (projectRoot ? undefined : resolveGlobalScopePaths(platform, env).stateDir);
  return resolveProductLayout({ projectRoot: projectRoot ?? root!, ...(root ? { root } : {}), platform: platform === 'win32' ? 'win32' : 'posix' });
}
