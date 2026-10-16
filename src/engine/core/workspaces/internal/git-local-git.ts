/** Git argument/environment construction shared by every invocation this package runs directly against a
 * repository it does not itself allocate (the caller's real source root, a configured work target, or a Deckent reference namespace
 * inside it): bounded read or ref-write access, never a network transport, a repository hook, an fsmonitor
 * helper, a system/global config file, an interactive prompt, or an opportunistic lock refresh. None of the
 * subcommands run through here (ls-tree, cat-file, rev-parse, ls-files, hash-object, update-ref, commit-tree,
 * write-tree, read-tree, update-index, for-each-ref, check-ref-format, worktree list) ever legitimately needs
 * a transport of its own; the belt-and-braces below exists only against a hostile or misconfigured target
 * repository, not because any of these operations wants to reach a remote.
 *
 * Three independent layers deny network transport, each closing a gap the others leave open:
 *
 * `-c protocol.allow=never` denies every named git protocol (file, git, ssh, http, https, ext) for any
 * transport this process might invoke directly. Documented since Git 2.12 (git-config(1) `protocol.allow`,
 * Context7 `/git/htmldocs`, checked 2026-09-29); the installed 2.43.0 supports it. Owner decision 2026-09-29
 * (P1): `protocol.allow=never` is the named mechanism. Gap: a repository-local config value (not suppressed
 * by `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL`, which only cover system/global scope) can set the more
 * specific `protocol.file.allow=always`, which takes precedence over the generic `protocol.allow` regardless
 * of source — measured 2026-09-29 (proof/GIT-NET-2026-09-29/protocol-matrix.log): a hostile source repo's own
 * `.git/config` re-permits exactly the transport `-c protocol.allow=never` was meant to deny.
 *
 * `GIT_ALLOW_PROTOCOL=''` (lead decision, follow-up to the residual above): "behave as if `protocol.allow` is
 * set to `never`... **overriding any existing configuration**" (git(1); quote verified identical in the
 * Documentation shipped with the installed git 2.43.0 tag and in current upstream docs, checked 2026-09-29 —
 * unchanged since its introduction in 2015, CVE-2015-7545 hardening, long before `protocol.allow` config
 * existed). Being an environment variable, not a config value, the target repository cannot override it —
 * measured 2026-09-29 to close the `protocol.file.allow=always` residual on its own, independent of
 * `GIT_NO_LAZY_FETCH`. This is the actual, version-robust backstop for that residual; `-c protocol.allow=never`
 * is kept alongside it as the owner-named mechanism and as defense-in-depth (each layer is independently
 * sufficient against a plain, non-config-carrying network attempt).
 *
 * `GIT_NO_LAZY_FETCH=1` closes the specific partial-clone/promisor lazy-object-fetch path even if some future
 * change dropped one of the two protocol layers above; also environment-based, so likewise not overridable by
 * repository-local config. It is now a first-class, documented variable (`--no-lazy-fetch`, git(1), checked
 * 2026-09-29 against current upstream docs); the man page shipped with 2.43.0 predates that documentation, but
 * the variable is compiled into the 2.43.0 binary and measured effective here. The `--no-lazy-fetch` CLI flag
 * itself is Git 2.45+ ("unknown option" on 2.43.0) and is not used; only the underlying env var is. */
export const GIT_LOCAL_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: '',
  GIT_NO_LAZY_FETCH: '1',
  GIT_OPTIONAL_LOCKS: '0',
});

/** Full, ordered argument list for a bounded local Git invocation against `root`: no replaced objects, no
 * repository hooks, no fsmonitor helper, no protocol transport, then the caller's own subcommand and args. */
export function localGitArgs(root: string, args: readonly string[]): string[] {
  return ['--no-replace-objects', '-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args];
}
