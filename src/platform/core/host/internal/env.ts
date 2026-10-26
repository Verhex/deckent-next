import { PRODUCT_LAYOUT_REGISTRY } from '#platform/core/common/index.js';
export type Environment = Readonly<Record<string, string | undefined>>;
/** Documented call-time inputs; NO_COLOR is deliberately presence-based. */
export const ENVIRONMENT_KEYS = Object.freeze([
  'DECKENT_CONFIG_RELOAD',
  'DECKENT_LANGUAGE', 'DECKENT_LANG',
  PRODUCT_LAYOUT_REGISTRY.rootEnvironmentKey, PRODUCT_LAYOUT_REGISTRY.globalRootEnvironmentKey, 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'HOME', 'WSL_DISTRO_NAME', 'WSL_INTEROP', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
  'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'VSCODE_PID', 'VSCODE_CWD',
  'TERM_PROGRAM', 'CURSOR_SESSION', 'CODEX_SESSION', 'GEMINI_CLI', 'TMUX',
  'NODE_ENV', 'VITEST', 'FORCE_COLOR', 'NO_COLOR', 'TERM', 'COLORFGBG',
  'COLORTERM', 'DECKENT_CRASH_RETENTION_MAX_AGE_DAYS', 'DECKENT_CRASH_RETENTION_MAX_COUNT',
  'DECKENT_CRASH_RETENTION_MAX_SIZE_MB', 'LC_ALL', 'LANG',
] as const);
export function envValue(env: Environment, name: string): string | undefined {
  const value = env[name];
  return value === '' ? undefined : value;
}

export function productRootOverride(env: Environment): string | undefined { return envValue(env, PRODUCT_LAYOUT_REGISTRY.rootEnvironmentKey); }

/** NODE_ENV as the caller started this process, kept by `adoptProductionReact` (`value` undefined: unset); null until adopted. */
let callerNodeEnv: { readonly value: string | undefined } | null = null;
/** FIX8a R27: the CLI entry runs production React (React picks its build from NODE_ENV on first load); a mode the caller set is kept. */
export function adoptProductionReact(env: NodeJS.ProcessEnv = process.env): void {
  if (callerNodeEnv) return;
  callerNodeEnv = { value: env.NODE_ENV }; env.NODE_ENV ||= 'production';
}
/** The environment for a process Deckent starts from its own: the caller's NODE_ENV comes back (unset stays unset), never the production
 * mode chosen for this process's React — a worker's `npm ci` must not silently skip devDependencies. Other values pass unchanged. */
export function callerEnvironment<T extends Environment>(env: T): T {
  if (!callerNodeEnv || env.NODE_ENV !== process.env.NODE_ENV || env.NODE_ENV === callerNodeEnv.value) return env;
  const own: Record<string, string | undefined> = { ...env };
  if (callerNodeEnv.value === undefined) delete own.NODE_ENV; else own.NODE_ENV = callerNodeEnv.value;
  return own as T;
}
