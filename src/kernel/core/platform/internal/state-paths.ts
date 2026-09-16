import { BRAIN_DIR, DECKENT_DIR } from '../../common/index.js';
import { envValue, type Environment } from './env.js';
import { pathApi, normalizeGlobalScopePlatform, resolveGlobalScopePaths } from './global-scope.js';

export interface PathContext { env?: Environment; platform?: string }
function stateHome(kind: 'deckent' | 'brain', projectRoot?: string, options: PathContext = {}): string {
  const env = options.env ?? process.env;
  const platform = normalizeGlobalScopePlatform(options.platform ?? process.platform, env);
  const api = pathApi(platform);
  const override = envValue(env, kind === 'deckent' ? 'DECKENT_HOME' : 'BRAIN_HOME');
  if (override) return api.resolve(override);
  const segment = kind === 'deckent' ? DECKENT_DIR : BRAIN_DIR;
  if (projectRoot) return api.join(projectRoot, segment);
  const scope = resolveGlobalScopePaths(platform, env);
  if (kind === 'deckent') return scope.stateDir;
  // BRAIN_HOME remains independent of DECKENT_HOME.
  const brainScope = resolveGlobalScopePaths(platform, { ...env, DECKENT_HOME: undefined });
  return api.join(brainScope.home!, segment);
}
export function resolveDeckentHome(projectRoot?: string, options?: PathContext): string { return stateHome('deckent', projectRoot, options); }
export function resolveBrainHome(projectRoot?: string, options?: PathContext): string { return stateHome('brain', projectRoot, options); }
function statePath(kind: 'deckent' | 'brain', root: string | undefined, args: (string | PathContext)[]): string {
  const options = typeof args[0] === 'object' ? args.shift() as PathContext : {};
  return pathApi(options.platform ?? process.platform).join(stateHome(kind, root, options), ...args as string[]);
}
export function deckentPath(root: string | undefined, ...segments: string[]): string;
export function deckentPath(root: string | undefined, context: PathContext, ...segments: string[]): string;
export function deckentPath(root: string | undefined, ...args: (string | PathContext)[]): string { return statePath('deckent', root, args); }
export function brainPath(root: string | undefined, ...segments: string[]): string;
export function brainPath(root: string | undefined, context: PathContext, ...segments: string[]): string;
export function brainPath(root: string | undefined, ...args: (string | PathContext)[]): string { return statePath('brain', root, args); }
