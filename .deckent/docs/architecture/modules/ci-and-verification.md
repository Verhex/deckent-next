# CI and verification tooling — module note

CI-FULL, CI-FIX, SOCKET-PUBLICATION, CI-WINDOWS-MACOS (moved from ARCHITECTURE.md Packages 2026-10-05).
Kaynak/Source: ARCHITECTURE.md @58537c7f lines 1327–1406; text below is verbatim.

**CI-FULL build inputs (owner 2026-10-01; developer tooling only).** The bubblewrap driver constrains every
resolved host and per-architecture sysroot package to its locked version before installing, in addition to the direct requests;
the complete installed inventories and source/image/license/binary hashes are still checked afterwards. Missing repository
versions refuse the build; a deliberate audited lock refresh is required, never a silent refresh. The CI-FULL refresh changes
five host dependency entries only; both existing binary hashes remain unchanged. Source/artifact mirrors and a real arm64 realm
remain separate unproven work. The TypeScript build runs the checkout's installed `typescript/bin/tsc` using `process.execPath`,
without `npx`, a command shell or a Windows `.cmd` launcher; an absent compiler or compiler error fails the build.
The test harness canonicalizes only the OS temporary parent before fixture allocation and propagates it to descendants;
explicit test global homes and product roots are unchanged. Successful descriptor-relative workspace read/edit cases run only
when the existing Linux `/proc/self/fd` capability is available. Portable policy/grammar and typed unsupported-refusal tests
remain active; this partition does not implement macOS/Windows custody or grant platform acceptance.
**CI-FIX signal (owner 2026-10-03; source candidate, hosted acceptance pending).** All six matrix cells
are required workflow failures, named `required verify (<os>, node <24|26>)`; `continue-on-error` is absent.
Workflow YAML does not implement branch protection; the owner reports the main ruleset active (2026-10-03).
Same-ref concurrency cancels superseded runs. Existing pull_request remains secret-free with read-only contents
and no persisted checkout credential. Full history prevents source-history ratchets from silently losing CI coverage;
Windows disables Git line-ending conversion before checkout so locked license/golden bytes remain exact.
After setup-node, the workflow canonicalizes only the OS temporary parent into TMPDIR/TMP/TEMP through GITHUB_ENV;
Vitest, standalone host node:test and native children then allocate fixtures under the same real path.
Explicit product roots and the managed-file symlink/permission floor remain unchanged.
The existing job bound stays 30 minutes; verify has a 20-minute step bound, preserving time for always-run summary
and SHA-pinned official upload-artifact v7.0.1. Host node:test replaces Infinity with a 180-second
execution bound (existing fixture subprocess ceiling); native node:test uses the existing 30-second Vitest ceiling,
and each native compile/test invocation is capped at 180 seconds. Host/native test concurrency is two and their reporter is explicitly TAP so failed names/skip notes reach the collector. These bounds
reduce unbounded defaults; they do not increase existing fixture or Vitest timeouts. Each job retains the original verify exit through bash pipefail,
raw log, collected `verify-evidence`, failed Vitest/collection and Node host-test names and actual `verify-not-run` notes.
Missing Vitest outcomes are `VERIFY_OUTCOMES_UNAVAILABLE`, never zero passing tests; summary is not whole-job acceptance.
Native manifest exclusions now emit `verify-not-run` with `NATIVE_PLATFORM_UNSUPPORTED`.
The config file adapter defaults its bootstrap layout to the actual host platform; explicit simulations remain explicit.
The detached runtime launcher refuses Windows/missing O_NOFOLLOW before log I/O as RUNTIME_LAUNCH_UNSUPPORTED.
Windows rendering fixtures exercise bounded stdin with visible file-variant exclusions and a separate file-refusal negative.
Packaging evidence normalizes metadata separators and canonicalizes only declaration build roots.
No new native macOS/Windows custody is claimed; typed refusal tests and portable behavior stay separate.
Sources/versions dated 2026-10-03 and fresh proof limits live in external `proof/CI-FIX-2026-10-03/`.
R2 starts from the first all-required run `37111243380` on `38c9dae1`: all six cells failed, so R1 review
and local checks do not establish hosted acceptance. Fixture roots must satisfy the current architecture
registry, including required Markdown documents; full history/canonical temp alone cannot repair a stale fixture.
New or materially changed contract tests must exercise portable behavior on every matrix OS, or declare an
existing typed platform capability, assert its refusal before effects and retain a `verify-not-run` record for
the unavailable positive variant. Linux positives remain active; no untyped platform skip or security-floor
relaxation admits a green result. Config-lock owner-metadata and directory-enumeration EPERM/EACCES is bounded contention, never
evidence of a dead owner; only a successful later exclusive mkdir admits work, and persistent unreadability
ends in CONFIG_WRITE_LOCKED. Tracked-file unavailability carries a typed execution diagnostic without
changing its measurement/security bounds. Build/declaration/CI temp identities use native canonical paths;
the fast architecture scanner waits for stdout delivery before exiting, including large inventories.
R2 implementation/verification evidence: external `proof/CI-FIX-R2-2026-10-03/`.
CI-FIX-R3 (owner 2026-10-03, source candidate on `9740baae`) extends the same unreadability rule to
`readdir(lock)`: no empty/stale-owner claim, no entry/reclaim, bounded retry; other IO failures propagate.
Injected EPERM/EACCES → typed lock timeout and unchanged owner metadata is the RED/green contract;
real Windows contention and the separate duplicate-reclaim warning still require native evidence.
External exact candidate/checks/open limits: `proof/CI-FIX-R3-2026-10-03/review.md`.
**SOCKET-PUBLICATION (owner 2026-10-03; source candidate).** The Linux native runtime listener binds inside a pinned
0700 staging directory in the final parent, pins the socket inode, chmods that inode through `/proc/self/fd` and fstats
0600, listens, then publishes with descriptor-relative `renameat2(RENAME_NOREPLACE)`. The final name is absent until
a private listening socket is ready; existing files/symlinks/sockets are never overwritten. No process-wide umask
change or post-publication JS chmod; `MANAGED_FILE_UNSAFE` remains strict. Unsupported NOREPLACE is a typed
`LOCAL_PEER_PUBLICATION_UNSUPPORTED` / `LOCAL_RUNTIME_UNSUPPORTED` refusal without fallback. Both final and
staging paths must fit Linux's 108-byte `sun_path` including NUL (`LOCAL_PEER_OPTIONS` / `LOCAL_RUNTIME_OPTIONS`);
staging uses parent + `/.sXXXXXX/s` (11 bytes). Failure cleanup removes only the pinned socket identity and empty
pinned staging directory, preserving replacements. Crash orphan pruning and hostile same-UID isolation are not
claimed. Official [rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html) and
[unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html) verified 2026-10-03; author/hosted/review evidence is
separate in external `proof/SOCKET-PUBLICATION-2026-10-03/`.

**CI-WINDOWS-MACOS (owner 2026-10-01; verification tooling).** Each CI matrix job has a 30-minute ceiling,
with ~2.1x headroom over run36884716187's successful Linux jobs (14m05s/14m20s); cells cannot inherit
the 360-minute GitHub default. Linux-only local runtime socket/live OS-session tests name their capability in
collected test titles and skip only cases requiring it; portable policy/grammar and existing typed refusals stay
active. Bubblewrap ancestor traversal stops when dirname reaches its fixed point, including a Windows drive root;
Linux protection-pin placement and all security bounds remain unchanged. A subprocess regression owns a 2-second
OS kill deadline because a synchronous loop prevents an in-process test timer from firing. Host-platform guard
simulations are labelled; they do not establish native Windows/macOS custody or runtime support. Actual hosted
post-fix evidence and independent review remain lead gates; sources/inventories in external CI-WINDOWS proof.
Windows fixture homes explicitly carry USERPROFILE with their temporary HOME. Developer SBOM/ajv bundle guards
normalize metadata separators before package/forbidden-provider checks, and fixture imports use file URLs; no package
or dependency version changes. Shared CLI JSON file input refuses Windows or absent O_NOFOLLOW/O_NONBLOCK using
the caller's existing typed *_INPUT_UNAVAILABLE error before opening a path; bounded stdin stays available. Terminal
history/session file factories similarly refuse Windows or absent O_NOFOLLOW with existing MANAGED_FILE_UNSUPPORTED,
before reading/writing any state. They retain POSIX permission/link guarantees instead of claiming a Windows private
store. Terminal-history declares exactly the public platform managed-files error dependency; no contract schema changes.

**Gecikme kapısı (W1-LATENCY, 2026-10-06).** `tests/perf/` ayrı `vitest.config.ts` ile `*.perf.ts` serisidir (ledger, worker, approval yolları; p95 ≤ 500 ms, taban JSON); varsayılan paket etkilenmez; eşik ölçüm girdisidir, ürün config'i değildir. CI'ya ayrı perf job/script bağlanması owner kararı bekler.

**Verify ortamı (VERIFY-ENV, 2026-10-06).** `/etc/machine-id` yoksa (Docker konteyneri) makine bağı yeteneği düşer ve ilgili testler tipli not-run olur; `noexec` tmpdir altında `pr.test.mjs` tipli not-run verir, gerçek `PR_GIT` ret iddiası korunur; `doctor` makine bağını proje dizinine karşı yoklar.

**Yerel CI eşleniği (CI-LOCAL, owner 2026-10-06; developer tooling).** `npm run ci:local -- [--ref <ref|HEAD>] [--node 24|26] [--keep]`
(`scripts/ci-local.mjs`) runs the ubuntu job of `.github/workflows/ci.yml` in its order, using the repository's own
`scripts/ci-*` files unchanged: temporary parent, `npm ci`, pinned Docker fixture, locked bubblewrap build and stage,
`build.mjs` + `ci-shell-realm.mjs`, `npm run verify` (`DECKENT_TEST_STARTUP_COST=1`, `DECKENT_TEST_TIMEOUT_MS=30000`, default
4 workers) and `ci-verification-summary.mjs`. It works on a clean detached `git worktree` of the exact SHA in a scratch
directory; HOME/USERPROFILE/XDG_*/TMPDIR/`DECKENT_GLOBAL_HOME` are empty temporary directories, `DECKENT_*`/`GITHUB_*`/`LC_*`/`LANG*`
are not inherited, and `GITHUB_ENV`/`RUNNER_TEMP` are provided locally. Only npm's download cache and the docker client config
are shared (bytes, no user settings). A local copy of the locked bubblewrap download cache seeds the run; when the pinned image digest
is already local only the `docker pull` is skipped. One run at a time per repository (lock in the git common dir, published atomically, owned by a token; it stays held while the run pid or its step process group lives, and an unreadable lock refuses). Steps run in their own process groups; cancellation (SIGINT/SIGTERM) and the whole-run `--deadline <minutes>` (default 30, the job bound; verify step 20) stop the group with SIGTERM, bounded wait, SIGKILL, record `cancel.json`, and remove the worktree/lock only after the group is gone. The same holds after every normal step exit: a group that cannot be proven empty makes the step and the run FAILED, stops further steps and the summary, and keeps the lock and worktree. Windows is refused with `CI_LOCAL_UNSUPPORTED_PLATFORM`; the group tests are POSIX-only and report a typed `verify-not-run` elsewhere. The mirror drops inherited `VITEST_*`, `NODE_OPTIONS`, `GIT_*` and `npm_*` variables.
Logs and `result.json` go to `.pack/ci-local/<sha12>-node<N>/` (gitignored). `--node` resolves the running node, then nvm/fnm
installs, and otherwise fails with `CI_LOCAL_NODE_UNAVAILABLE`.
Not covered: macOS, Windows, the runner's `sudo sysctl` AppArmor step, hosted-runner differences. It does not replace hosted CI.
`npm run precommit:fast` (typecheck, eslint on changed `.ts|.mjs`, lint-arch, lint-docs; no tests) backs the tracked
`scripts/git-hooks/pre-commit`. Landing (owner 2026-10-06): `npm run land:check [-- --ref <sha>] [--force]` runs `ci:local --node 24`
and, on PASS only, writes the receipt `.pack/ci-local/passed/<sha>`; a receipt for the same SHA returns PASS without re-running.
Required before merging a PR. Fail closed: an existing receipt is removed before any re-run, so a failed, cancelled or running `--force` leaves none; the receipt is written atomically from `ci:local`'s own `result.json` (SHA, node, outcomes, counts, log path) and validated on read, not by existence. The test seam `DECKENT_CI_LOCAL_SCRIPT` writes only `passed-test/`, which no production reader uses. `pre-push` runs `land:check` only for `refs/heads/main` and `refs/heads/wave/*` pushes marked
`DECKENT_LANDING=1 git push ...`; unmarked pushes print a note and pass (not a skip, no log). Git push options are not used: they
reach only server-side hooks and the server must advertise them. Skipping a marked landing needs
`DECKENT_CI_LOCAL_SKIP="<reason>"` (>= 8 characters), logged to `.pack/ci-local/skips.log`.
`npm run hooks:install` sets relative `core.hooksPath=scripts/git-hooks` (shared `.git/config` unless
`extensions.worktreeConfig` is on, then per worktree); each worktree resolves it against its own root, so branches without
the directory run no hooks, and clones do not inherit the setting. Measured times: external `proof/CI-LOCAL-2026-10-06/review.md`.
