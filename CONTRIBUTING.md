# Contributing to Deckent

Contributions in English or Turkish are welcome. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

Start with a small fix, test or documentation improvement. For a larger change, open an
[issue](https://github.com/Verhex/deckent-next/issues) describing the problem, expected behavior
and an example before investing in an implementation. Fork the repository, create a descriptive
branch and submit a pull request against `main`.

## Prerequisites

| Requirement | Why it is needed |
|---|---|
| Linux or Windows WSL2 | Current execution and sandbox development path. macOS and native Windows have platform verification but are not equivalent execution targets yet. |
| Node.js 24.22.1+ or 26.12.1+ and its npm | See [package.json](package.json). Use Node 24 or 26 for the supported CI versions. |
| Git and a C compiler/build toolchain | Git-backed fixtures and the native Linux sandbox helper built by `npm run build`. On Debian/Ubuntu, the toolchain is provided by `build-essential`. |
| A running Docker daemon, accessible to your user | Builds the pinned bubblewrap binary; also required by Docker worker tests. Access to the daemon is privileged: use a development machine. |
| Internet access for setup | Downloads locked npm dependencies, bubblewrap sources and the pinned build image. No provider API key is needed for the quickstart test. |
| Memory for the selected tests | Keep aggregate local test use within 16 GB; use two workers for targeted runs. This is a development resource limit, not a product capacity claim. |

Linux sandbox tests additionally need kernel support and permission for user namespaces;
Landlock tests need a supported kernel. A binary on disk alone does not prove sandbox support.
Read the test's setup and skip conditions before choosing an integration test.

## A 30-minute quickstart

Use the first half hour to install, build and run one test. This is a suggested session plan,
not a timing guarantee: downloads, Docker access and native compilation vary by machine.

```sh
git clone https://github.com/Verhex/deckent-next.git
cd deckent-next
npm ci

# Build the lock-verified bubblewrap binary, then stage it for source tests.
# Use a fresh output directory; build-bwrap refuses a non-empty destination.
node scripts/build-bwrap.mjs --arch all --out .pack/bwrap/contributor
node scripts/build-bwrap.mjs --stage-dev .pack/bwrap/contributor
npm run build

# A policy contract test: no Docker fixture or provider key is needed.
VITEST_MAX_FORKS=2 node_modules/.bin/vitest run --configLoader runner \
  tests/contracts/policy/permission-mode.test.ts
```

[`npm ci`](https://docs.npmjs.com/cli/v11/commands/npm-ci/) installs the dependency lockfile;
it replaces an existing `node_modules`. Do not update dependencies just to get started.
If installation reports a lockfile mismatch, include the error in your issue.

The bubblewrap recipe and hashes live in [packaging/bwrap/bwrap.lock.json](packaging/bwrap/bwrap.lock.json).
Linked license texts are committed in [packaging/bwrap/licenses](packaging/bwrap/licenses) and must match the lock hashes.
The explicit staging step supplies the sandbox to source-mode tests and the subsequent build.
Do not use `--record` to bypass a hash mismatch. For another build, choose a new `--out` path.
A successful build ends with `bubblewrap=present` or `bubblewrap=staged from …`. On Linux a build that cannot stage the locked
bubblewrap stops with `BUBBLEWRAP_BUILD_REQUIRED`; only off Linux does it print `bubblewrap=absent (not Linux)`, which means no
sandbox was supplied. Fix staging before testing sandbox behavior.

### Bubblewrap cache and Alpine pin refresh

CI restores `.pack/bwrap/cache` with an exact key covering the lock, build recipe, build driver,
cache verifier and target/runner architectures. It stores the built outputs and fetched APKs.
`node scripts/build-bwrap.mjs --reuse --arch x86_64 --out <fresh-directory>` verifies the input
identity, all recorded file/APK SHA256 values, complete installed package inventories, source,
license texts and binary SHA256 against the lock before using a hit. Only a missing build cache
runs Docker. `--verify-cache --arch x86_64` checks it without staging. APK signature verification
remains enabled during installation. A corrupt cache fails; it is never silently trusted or retried.
The cache checksum manifest detects corruption; the committed lock remains the binary authority.
Actions caches can expire or be evicted: this is not a permanent Alpine mirror.

On a miss, unavailable Alpine pins fail with `BWRAP_PIN_REFRESH_REQUIRED` / `BWRAP_BUILD_FAILED`
and point here. The weekly/manual **platform verification → deps-watch** job runs
`node scripts/refresh-bwrap.mjs <fresh-evidence-directory>` in the digest-pinned image. It resolves
a candidate host closure and every sysroot, updates the direct pins, builds once to record hashes
and again in check mode to compare them, and retains the inventories, logs, lock delta and
`PR-BODY.md`. It modifies the checkout's lock/runtime identity only after both builds succeed.
Linked-library version changes that need a new verified license text stop for maintainer review.
It never updates the build image, source tarball, shipped architectures or source/license pins silently.

The watch job itself stays read-only. A separate `deps-publish` job, the only one with
`contents: write` and `pull-requests: write`, runs only when the watch verified a refresh and found
no integrity problem. It installs no packages, builds nothing and runs no candidate code: it checks
out the base the watch resolved, re-verifies the uploaded `deps-watch-<attempt>` candidate and runs
`scripts/publish-bwrap-refresh.mjs` to open a draft `build(bwrap): refresh pins (Alpine <release>)`
pull request. It changes only the lock and generated runtime identity, reuses an existing PR and
never force-updates or merges.
Independent maintainer review and hosted CI remain mandatory. GitHub-token-created PRs need an explicit maintainer
CI dispatch on the candidate branch; their creation does not itself trigger the normal PR workflow.
Hosted CI runs the full suite in 20 duration-balanced shards per Node version. A separate, non-required
`duration weight drift` job turns red when a test file runs far over its recorded weight, which means the
generated duration weights are stale
([CI and verification](.deckent/docs/architecture/modules/ci-and-verification.md)).

Check the compiled entry without linking a global executable:

```sh
node dist/composition/core/cli/internal/entry.js --version
```

## Run one test file

From the repository root, pass its path to Vitest. `run` exits after the selected tests;
[`--configLoader runner`](https://vitest.dev/guide/cli.html) loads this repository's configuration.

```sh
VITEST_MAX_FORKS=2 node_modules/.bin/vitest run --configLoader runner \
  tests/contracts/policy/permission-mode.test.ts

# Narrow further by test name.
VITEST_MAX_FORKS=2 node_modules/.bin/vitest run --configLoader runner \
  tests/contracts/policy/permission-mode.test.ts -t 'never lowers deny'
```

Replace the path with the file relevant to your change. Most contract tests use temporary
project and global state; they do not require a configured personal installation. Source-mode
sandbox tests still need the staged bundle; tests that spawn `dist` entries need the build.

| Check | Runtime and environment notes |
|---|---|
| One contract test file | Start here. Time and memory depend on the file; report the duration printed by Vitest, rather than assuming a suite-wide estimate. |
| Docker integration tests | Need Docker and `DECKENT_TEST_DOCKER_IMAGE` pointing to a locally available image ID. Without it, some files skip; inspect the skipped count. |
| Sandbox integration tests | Need staged bubblewrap and host kernel capabilities. An unsupported-host skip does not verify isolation. |
| Full test suite / `npm run verify` | Broad, resource-intensive checks coordinated by maintainers. The configuration defaults to four workers; use targeted tests for a normal PR. Do not run a build while a test suite is active. |

A sample of the quickstart policy test on 2026-10-09 (Linux x64, Node 24.21.0 before the floor was
raised to 24.22.0, Vitest 5.0.1, two-worker limit) passed 9 tests with no skips in 2.59 seconds. GNU `time -v` reported a maximum
process RSS of about 464 MiB; this is not aggregate suite memory. It is one local sample, not a
setup-time or full-suite estimate. Docker and sandbox execution were not exercised by that test.

To prepare the Docker test fixture on a Linux amd64 development host:

```sh
docker pull --platform linux/amd64 \
  node@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
export DECKENT_TEST_DOCKER_IMAGE="$(docker image inspect --format '{{.Id}}' \
  node@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea)"
VITEST_MAX_FORKS=2 node_modules/.bin/vitest run --configLoader runner \
  tests/contracts/adapters/docker-image.test.ts
```

The pull reference pins the image content. The environment variable uses the resolved local
image ID, which can differ from the pull digest. This is the test fixture, not a coding-worker
image. Other host architectures need a compatible fixture; do not assume amd64 coverage proves
their behavior. See [scripts/ci-docker-fixture.sh](scripts/ci-docker-fixture.sh) for CI's preflight;
that script expects `GITHUB_ENV` and is not a local setup command.

## Design and checks

Read the [architecture overview](docs/architecture-overview.md) and [glossary](docs/glossary.md).
Use the existing typed application contract, keep domain logic pure, put external I/O behind
ports and carry identity, scope and policy through operations. Preserve negative tests for denied,
stale, cancelled or uncertain work when they are relevant to your change.

For source changes, run typecheck, ESLint on changed source files, the architecture check and
relevant test files. Replace `src/path/to/changed.ts` below with the actual changed file.
For documentation changes, run the architecture and documentation checks and check relative links.

```sh
npm run --silent typecheck
node_modules/.bin/eslint src/path/to/changed.ts
node scripts/lint-arch.mjs
node scripts/lint-docs.mjs
```

| If a check reports… | What to do |
|---|---|
| A dependency direction or private import violation | Import the unit's public entry and move the responsibility to the correct layer; see [ARCHITECTURE.md](ARCHITECTURE.md) for detailed contracts. |
| A new mutable policy literal | Reuse the registry or configuration contract. Protocol and security invariants remain versioned code. |
| A missing translation | Add matching `en` and `tr` catalog entries through the shared renderer. Mention translation help needed in the PR. |
| An unapproved Markdown path | Propose the exact new documentation path in `arch.json`'s Markdown allowlist; explain its purpose. |
| A file or unit size violation | Split by responsibility, preserving behavior and coverage; do not remove capabilities to satisfy the limit. |

The root `README` files introduce the product, `docs/` explains public concepts and
`ARCHITECTURE.md` contains detailed engineering contracts. `PLAN.md` and the hidden development
folders contain maintainer coordination and historical notes, which can include Turkish text.
You do not need a private development dashboard to submit a contribution.

## AI-assisted contributions

AI-assisted contributions follow the same review bar as every other contribution.
You must be able to explain the change, run the relevant checks and take responsibility
for its correctness, security and suitability for the project.

Material AI assistance means AI-generated or AI-directed code, tests, documentation or
design decisions that substantially shape the submitted change, beyond spelling fixes
or routine autocomplete.

Briefly disclose material AI assistance in the PR description and identify what it helped
with; if there was none, say so. Prompt or transcript uploads are not required.
For example: “AI assistance: helped draft the parser tests; I reviewed the assertions
and ran the targeted checks.” A disclosure does not replace an explanation or test evidence.

Bulk automated PRs require prior agreement with maintainers in an issue before submission.

## Pull request expectations

- Explain the problem, resulting behavior and affected paths. Link an issue when available.
- Keep the change focused, preserve existing behavior and include relevant failure-path coverage.
- List exact commands and results, including skipped tests, missing prerequisites and unverified platforms.
- Update affected documentation and both English and Turkish product strings.
- Keep secrets, local state and separately distributed proprietary Enterprise code out of the PR.
- Use descriptive commits; `docs: clarify the scope example` or `fix(policy): preserve a deny` follows existing practice.

The current PR template includes maintainer tracking fields. External contributors can mark private
tracking, deployment and reviewer fields **not applicable**; describe your branch, base revision,
changes and checks in the public sections. Do not invent a review result. Maintainers handle review,
integration and release; a passing local test alone does not establish that a change is ready to merge.
