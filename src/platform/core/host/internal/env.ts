import { PRODUCT_LAYOUT_REGISTRY } from '#platform/core/common/index.js';
export type Environment = Readonly<Record<string, string | undefined>>;
/** Documented call-time inputs; NO_COLOR is deliberately presence-based. */
export const ENVIRONMENT_KEYS = Object.freeze([
  'DECKENT_CONFIG_RELOAD', 'DECKENT_BRAIN_PROVIDER', 'DECKENT_WORKER_PROVIDER',
  'DECKENT_MODE', 'DECKENT_LANGUAGE', 'DECKENT_LANG', 'DECKENT_LIVE_TRACE',
  PRODUCT_LAYOUT_REGISTRY.rootEnvironmentKey, 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'HOME', 'WSL_DISTRO_NAME', 'WSL_INTEROP', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
  'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'VSCODE_PID', 'VSCODE_CWD',
  'TERM_PROGRAM', 'CURSOR_SESSION', 'CODEX_SESSION', 'GEMINI_CLI', 'TMUX', 'DECKENT_TENANT_ID',
  'DECKENT_DEBUG', 'NODE_ENV', 'VITEST', 'FORCE_COLOR', 'NO_COLOR', 'TERM', 'COLORFGBG',
  'COLORTERM', 'DECKENT_CRASH_RETENTION_MAX_AGE_DAYS', 'DECKENT_CRASH_RETENTION_MAX_COUNT',
  'DECKENT_CRASH_RETENTION_MAX_SIZE_MB', 'LC_ALL', 'LANG',
] as const);
export function envValue(env: Environment, name: string): string | undefined {
  const value = env[name];
  return value === '' ? undefined : value;
}

export function productRootOverride(env: Environment): string | undefined { return envValue(env, PRODUCT_LAYOUT_REGISTRY.rootEnvironmentKey); }
