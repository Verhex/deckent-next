# CI preparation checks

Linux jobs pull the official Node fixture by digest with `bash scripts/ci-docker-fixture.sh`.
`GITHUB_ENV` must name the environment file for subsequent steps. A failed daemon, pull,
image identity check or unprivileged container run fails preparation; tests are not skipped.

Build bubblewrap in check mode, stage it, then build the product before the realm preflight:

```sh
node scripts/build-bwrap.mjs --arch x86_64 --out "$RUNNER_TEMP/bwrap-x86_64"
node scripts/build-bwrap.mjs --stage-dev "$RUNNER_TEMP/bwrap-x86_64"
node scripts/build.mjs
DECKENT_GLOBAL_HOME="$RUNNER_TEMP/deckent-global" node scripts/ci-shell-realm.mjs
```

The preflight checks both staged trees against the lock, invokes the service's launcher
placement/probe path, and requires the compiled CLI's `doctor.shellRealm` to select usable
bubblewrap. Doctor alone does not place the bundled executable on a fresh machine.
Only the ephemeral GitHub runner enables user namespaces via its AppArmor sysctl; this is
not a product installation instruction. `realm-arm64` remains disabled.

For local workflow expression/type validation, use the official actionlint v1.7.7 binary
(or install that version into a disposable tool directory with Go):

```sh
ci_tools=$(mktemp -d)
GOBIN="$ci_tools" go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
"$ci_tools/actionlint" -shellcheck= -pyflakes= .github/workflows/ci.yml .github/workflows/bwrap-bundle.yml
```

The command disables optional external shell/Python linters, not workflow context checks.
No npm dependency is required. Installation and actionlint execution require tooling/network
outside the restricted lane sandbox. See https://github.com/rhysd/actionlint/blob/v1.7.7/docs/install.md
and https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
(checked 2026-09-30).

For the invocation-process timeout investigation, collect content-free phase timings:

```sh
CI=true DECKENT_TEST_STARTUP_COST=1 VITEST_MAX_FORKS=2 npx vitest run tests/contracts/surfaces/model-invocation-process.test.ts
```

The existing 30-second test deadline and per-operation bounds remain intact. `STARTUP-COST`
records SDK/CLI client execution, SDK import, runtime ready/stop, provider arrival,
durable settlement, MCP ready/call/close and cleanup.
This test needs local loopback and Unix sockets. A socket permission failure is not evidence
about the hosted runner's startup cost.
