# CI and verification tooling — module note

**CI-SPEED amendment (owner approved 2026-10-06; isolated author candidate, hosted acceptance pending).**
The required Ubuntu Node24/26 check names stay unchanged for PR/integration verification. Each Node builds once,
then all Vitest files run in eight duration-balanced shards with normal fork/file isolation and four workers per runner.
The complete inventory comes from Vitest itself, not a changed-file filter. New files always enter the partition.
The required collector rejects missing/duplicate shards or files, wrong SHA/Node/run/attempt, failed/cancelled/pending
execution, collection/unhandled errors and missing native/host/smoke success. Native binaries and dist are bound to
Node major, platform, source/build-input hashes and artifact bytes; they are never shared across Node24 and Node26.
Preparation runs lint checks; the installed compiler's normal build performs strict source typechecking once.
`npm run lint` still includes explicit typecheck; standalone `npm run verify` builds once and keeps every test pack.
The local mirror validates its sealed build before `verify:built` and never rebuilds during a suite.
Explicit older refs retain their own original verification protocol; current helpers are not overlaid onto old source.
The six installation apply scenarios and four installed-runtime modes keep every assertion, permission variant and
existing timeout; separate files with the same fixture behavior remove the measured 176.927s/129.711s serial tails.
The two known-identity cleanup faults and two contention witness faults also keep their exact callbacks/timeouts
in separate files, removing the measured 105.298s/98.741s serial sums. The cleanup oracle stays once.
Architecture scenario tests call the same fresh-state scanner as the CLI; genuine CLI exit/pipe tests and Git
admission/negative ratchet history remain. Scanner imports perform no execution or process/environment mutation.
`land:check` reads the latest GitHub Actions required checks for an exact SHA, refuses missing/non-success outcomes
and never runs a local full suite or reuses a cached PASS. Both Node checks must belong to one workflow run whose latest
attempt passed at that SHA, and the run event must check out that SHA (push, workflow_dispatch, merge_group): a
pull_request run tested `refs/pull/N/merge`, so it is refused as `HOSTED_SOURCE_NOT_EXACT` (Astra REVIEW2402 P1). `land:check:local` retains the explicit diagnostic mirror
and its receipts. Marked pre-push uses the hosted reader; unmarked author pushes stay lightweight.
PR and manual integration runs keep the full Ubuntu suite. `merge_group` is supported, but this candidate does not
activate/change a remote merge queue or ruleset. Main push runs the same full sharded suite
(owner 2026-10-06): admin merges bypass the PR gate, so this is main's post-merge full signal; on this public repository
standard runners are free (billing usage 2026-10-06: $0 net), the limit is 60 concurrent jobs and one run opens 20. Native macOS/Windows full suites stay in a separate daily/manual
workflow with visible failures; this scheduling does not resolve existing platform debt or claim platform acceptance.
The full author scan exposed a genuine first integrity-key creation race during concurrent secret changes.
Write-mode key custody now holds the existing bounded configuration path lock through create/read/fsync/close;
read-only calls perform no lock writes. UID,0600,nlink1,O_NOFOLLOW,inode and32-byte checks stay unchanged.
A deterministic real-file pause retains RED before the fix and verifies that another creator waits; read-under-held-lock
and partial-key refusal remain explicit tests. Existing partial keys are never repaired; crashes and hostile same-UID
isolation are not newly solved. Write-mode opens incur bounded lock contention; no throughput claim is made.
Author evidence: 671-file full scan retained 5361 passes, two failures and three existing skips. The two failures
were repaired with targeted evidence; final additions/splits produce a 682-file inventory with no missing/duplicate
assignments. Targeted repair/split checks passed 33 cases, latest key source checks 14, and final service splits five;
these overlap and are not a new whole-suite PASS. The updated timing profile labels its mixed four/two-worker sources.
Target: 120–180 seconds for the required integration path. Configuration/estimated loads are not a measured latency
result; fresh exact-SHA hosted wall time, cold-cache/queue behavior and independent review remain open.
Checkout/setup-node use pinned v7.0.1/v7.0.0 commits with Node24 action runtime; the retained hosted runner
2.337.0 exceeds the documented minimum 2.327.1. Credentials stay disabled and npm caching explicit.
Reruns need the complete run attempt: earlier successful shard/build artifacts cannot satisfy a later attempt.
Sources checked 2026-10-06: [checkout v7](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-node v7](https://github.com/actions/setup-node/releases/tag/v7.0.0), [Node24 file handles](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesopenpath-flags-mode), [Vitest sequencing](https://vitest.dev/config/sequence.html),
[reporter API](https://vitest.dev/guide/advanced/reporters), installed Vitest 5.0.1 declarations,
[TypeScript noEmit](https://www.typescriptlang.org/tsconfig/noEmit.html),
[GitHub check runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference).
Author proof and scope: external `proof/CI-SPEED-2026-10-06/`. The following dated notes are historical where
this amendment changes workflow scheduling or local landing requirements.

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
(`scripts/ci-local.mjs`) runs the explicit serial Ubuntu diagnostic equivalent (not the hosted shard topology), using the repository's own
`scripts/ci-*` files unchanged: temporary parent, `npm ci`, pinned Docker fixture, locked bubblewrap build and stage,
`build.mjs` + sealed build identity + `ci-shell-realm.mjs`, `npm run verify:built` (`DECKENT_TEST_STARTUP_COST=1`, `DECKENT_TEST_TIMEOUT_MS=30000`, default
4 workers) and `ci-verification-summary.mjs`. It works on a clean detached `git worktree` of the exact SHA in a scratch
directory; HOME/USERPROFILE/XDG_*/TMPDIR/`DECKENT_GLOBAL_HOME` are empty temporary directories, `DECKENT_*`/`GITHUB_*`/`LC_*`/`LANG*`
are not inherited, and `GITHUB_ENV`/`RUNNER_TEMP` are provided locally. Only npm's download cache and the docker client config
are shared (bytes, no user settings). A local copy of the locked bubblewrap download cache seeds the run; when the pinned image digest
is already local only the `docker pull` is skipped. One run at a time per repository (lock in the git common dir, published atomically, owned by a token; it stays held while the run pid or its step process group lives, and an unreadable lock refuses). Steps run in their own process groups; cancellation (SIGINT/SIGTERM) and the whole-run `--deadline <minutes>` (default 30, the job bound; verify step 20) stop the group with SIGTERM, bounded wait, SIGKILL, record `cancel.json`, and remove the worktree/lock only after the group is gone. The same holds after every normal step exit: a group that cannot be proven empty makes the step and the run FAILED, stops further steps and the summary, and keeps the lock and worktree. Windows is refused with `CI_LOCAL_UNSUPPORTED_PLATFORM`; the group tests are POSIX-only and report a typed `verify-not-run` elsewhere. The mirror drops inherited `VITEST_*`, `NODE_OPTIONS`, `GIT_*` and `npm_*` variables.
Logs and `result.json` go to `.pack/ci-local/<sha12>-node<N>/` (gitignored). `--node` resolves the running node, then nvm/fnm
installs, and otherwise fails with `CI_LOCAL_NODE_UNAVAILABLE`.
Not covered: macOS, Windows, the runner's `sudo sysctl` AppArmor step, hosted-runner differences. It does not replace hosted CI.
`npm run precommit:fast` (typecheck, eslint on changed `.ts|.mjs`, lint-arch, lint-docs; no tests) backs the tracked
`scripts/git-hooks/pre-commit`. Explicit local mirror (owner 2026-10-06, renamed by CI-SPEED): `npm run land:check:local [-- --ref <sha>] [--force]` runs
`ci:local --node 24` and, on PASS only, writes the receipt `.pack/ci-local/passed/<sha>`; it is a diagnostic, not a merge
precondition. Fail closed: an existing receipt is removed before any re-run, and the receipt is written atomically from
`ci:local`'s own `result.json` and validated on read. `pre-push` runs the hosted `land:check` only for `refs/heads/main`
and `refs/heads/wave/*` pushes marked `DECKENT_LANDING=1 git push ...`; unmarked pushes print a note and pass. Owner
landing practice: Astra PASS → admin merge; hosted CI is a post-merge signal.
`npm run hooks:install` sets relative `core.hooksPath=scripts/git-hooks` (shared `.git/config` unless
`extensions.worktreeConfig` is on, then per worktree); each worktree resolves it against its own root, so branches without
the directory run no hooks, and clones do not inherit the setting. Measured times: external `proof/CI-LOCAL-2026-10-06/review.md`.
