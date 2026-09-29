/** Git argument/environment construction shared by every invocation this package runs directly against a
 * repository it does not itself allocate (the caller's real source root, or a Deckent reference namespace
 * inside it): bounded read or ref-write access, never a network transport, a repository hook, an fsmonitor
 * helper, a system/global config file, an interactive prompt, or an opportunistic lock refresh.
 *
 * `-c protocol.allow=never` denies every named git protocol (file, git, ssh, http, https, ext) for any
 * transport this process might invoke directly, regardless of what the target repository's own local
 * `.git/config` requests. Documented since Git 2.12 (git-config(1) `protocol.allow`, Context7 `/git/htmldocs`,
 * checked 2026-09-29); the installed 2.43.0 supports it. Owner decision 2026-09-29 (P1): `protocol.allow=never`.
 *
 * `GIT_NO_LAZY_FETCH=1` closes the one path `protocol.allow=never` alone does not: partial-clone/promisor lazy
 * object fetch consults the more specific `protocol.<name>.allow` first, and a repository-local config value
 * (not suppressed by `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL`, which only cover system/global scope) can set
 * `protocol.file.allow=always` there, re-permitting it ahead of the generic `protocol.allow=never` — measured
 * 2026-09-29 against a `--filter=blob:none` clone with a `file://` promisor remote on this machine's git
 * 2.43.0 (proof/GIT-NET-2026-09-29/protocol-matrix.log). `GIT_NO_LAZY_FETCH` still blocks that case because it
 * is an environment variable, not a config value the repository can override. It is now a first-class,
 * documented variable (`--no-lazy-fetch`, git(1), checked 2026-09-29 against current upstream docs); the man
 * page shipped with 2.43.0 predates that documentation, but the variable is compiled into the 2.43.0 binary
 * and measured effective here. The `--no-lazy-fetch` CLI flag itself is Git 2.45+ ("unknown option" on 2.43.0)
 * and is not used.
 *
 * `GIT_ALLOW_PROTOCOL=''` was also measured (same log) to close the repository-local-config residual above on
 * its own ("overriding any existing configuration" per git(1)); it is recorded in review.md as a follow-up
 * option and not adopted here, since it would change the enforcement mechanism away from the owner-decided
 * `protocol.allow=never` and needs its own sign-off. */
export const GIT_LOCAL_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_OPTIONAL_LOCKS: '0',
});

/** Full, ordered argument list for a bounded local Git invocation against `root`: no replaced objects, no
 * repository hooks, no fsmonitor helper, no protocol transport, then the caller's own subcommand and args. */
export function localGitArgs(root: string, args: readonly string[]): string[] {
  return ['--no-replace-objects', '-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args];
}
