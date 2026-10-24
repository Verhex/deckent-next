/**
 * The only ambient variables a spawned test child inherits: the executable search path, the canonical temporary root (vitest.config.ts), the
 * suite's time zone, locale and terminal type (unchanged from the ambient run, never secrets), the per-run DECKENT_GLOBAL_HOME (vitest.config.ts:
 * a child must never write the owner's ~/.deckent) and the gc/maintenance-off Git config. Credentials, agent/CI markers, FORCE_COLOR (NO_COLOR
 * must stay silent), DECKENT_HOME, DOCKER_* and NODE_OPTIONS are never inherited; HOME comes from the caller (os.homedir() still falls back to
 * the account's directory, so a test that needs isolation passes its own). Windows children keep their system-root variables.
 */
const INHERITED = /^(?:PATH|TMPDIR|TMP|TEMP|TZ|LANG|LANGUAGE|LC_[A-Z]+|TERM|DECKENT_GLOBAL_HOME|GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT)$/iu;

/** Environment for a spawned test child: the allowlisted ambient variables plus the caller's overrides (an override may also drop one). */
export function childEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) => INHERITED.test(name));
  return { ...Object.fromEntries(inherited), ...overrides };
}
