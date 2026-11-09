import { PRODUCT_LAYOUT_REGISTRY } from '#platform/core/common/index.js';
import AUTOMATION from './automation.json' with { type: 'json' };
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

/** An AI agent or CI caller, marked by exact environment variable names (no prefix match; any non-empty value other than 0/false): `agent`
 * names come from the installation's `cli.agentEnvironment`, CI names from this registry. The CLI uses it to stay plain (INIT-D7); an
 * authority operation (uninstall) also uses it as a floor at its own composition boundary, so an SDK call is held to it too (review M13). */
export function automationMarker(env: Environment, agentNames: readonly string[]): 'agent' | 'ci' | null {
  const marked = (names: readonly string[]) => names.some(name => { const value = envValue(env, name)?.trim().toLowerCase(); return value !== undefined && value !== '0' && value !== 'false'; });
  return marked(agentNames) ? 'agent' : marked(AUTOMATION.ciEnvironment) ? 'ci' : null;
}
export function productRootOverride(env: Environment): string | undefined { return envValue(env, PRODUCT_LAYOUT_REGISTRY.rootEnvironmentKey); }

/** NODE_ENV as the caller started this process, kept by `adoptProductionReact` (`value` undefined: unset); null until adopted. */
let callerNodeEnv: { readonly value: string | undefined } | null = null;
/** FIX8a R27: the CLI entry runs production React (React picks its build from NODE_ENV on first load); a mode the caller set is kept. */
export function adoptProductionReact(env: NodeJS.ProcessEnv = process.env): void {
  if (callerNodeEnv) return;
  callerNodeEnv = { value: env.NODE_ENV }; env.NODE_ENV ||= 'production';
}
/** The environment a process Deckent starts INHERITS from its own: the caller's NODE_ENV comes back (unset stays unset), never the production
 * mode chosen for this process's React — a worker's `npm ci` must not silently skip devDependencies. Other values pass unchanged. Only for an
 * inherited environment (process.env or a pass-through of it): an explicit child environment (ProcessCommand.env, an explicit runner profile)
 * runs as given and never goes through here, because a value set on purpose cannot be told apart from the inherited one. */
export function callerEnvironment<T extends Environment>(env: T): T {
  if (!callerNodeEnv || env.NODE_ENV !== process.env.NODE_ENV || env.NODE_ENV === callerNodeEnv.value) return env;
  const own: Record<string, string | undefined> = { ...env };
  if (callerNodeEnv.value === undefined) delete own.NODE_ENV; else own.NODE_ENV = callerNodeEnv.value;
  return own as T;
}
/** A6-3 (owner 2026-11-08, alpha.63.2): a child process inherits only the names it needs, never the whole environment (arch guard `childEnv`). */
export function inheritedEnvironment(env: Environment, names: Iterable<string>): Record<string, string> {
  const own = callerEnvironment(env), result: Record<string, string> = {};
  for (const name of names) { const value = own[name]; if (typeof value === 'string') result[name] = value; }
  return result;
}
/** The fixed executable search path of a tool child that must not resolve a program from the caller's PATH (local Git, a sandbox-view probe). */
export const FIXED_TOOL_PATH = '/usr/bin:/bin';
/** The user manager's bus (`systemctl --user`, `busctl --user`): its runtime directory and address plus the names a caller adds; the callers'
 * variants stay parameters, since aligning them would inherit more (KG2 E2, owner A2). */
export const userBusEnvironment = (env: Environment, extra: readonly string[]): Record<string, string> =>
  inheritedEnvironment(env, [...extra, 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']);
/** What a Deckent tool child (git, a package query, a probe) needs; NODE_ENV is the caller's own (`callerEnvironment`), never this entry's production mode. */
export const CHILD_BASE_ENVIRONMENT: readonly string[] = Object.freeze(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TMPDIR', 'NODE_ENV']);
/** The runtime service's environment: the child base, the documented call-time inputs, the user and session bus, Node's CA file, the CI markers and
 * every DECKENT_ name; the launcher adds what its configuration names (agent markers, referenced secret names, tool home overrides). */
export function serviceEnvironment(env: Environment, extra: Iterable<string>): Record<string, string> {
  const names = new Set([...CHILD_BASE_ENVIRONMENT, ...ENVIRONMENT_KEYS, 'USER', 'LOGNAME', 'SHELL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
    'NODE_EXTRA_CA_CERTS', ...AUTOMATION.ciEnvironment, ...extra]);
  for (const name of Object.keys(env)) if (name.startsWith('DECKENT_')) names.add(name);
  return inheritedEnvironment(env, names);
}
/** Owner 2026-11-08: the person's own CLI process (their editor, the sign-in browser, the init first commit) keeps their environment by design. */
export const personProcessEnvironment = <T extends Environment>(env: T): T => callerEnvironment(env);
