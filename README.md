# Deckent

Türkçe: [README.tr.md](README.tr.md)

[![CI](https://img.shields.io/github/actions/workflow/status/Verhex/deckent-next/ci.yml?branch=main&label=CI)](https://github.com/Verhex/deckent-next/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Verhex/deckent-next)](LICENSE)
[![Node engines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FVerhex%2Fdeckent-next%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node&color=43853d)](package.json)
[![Pre-release](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FVerhex%2Fdeckent-next%2Fmain%2Fpackage.json&query=%24.version&label=pre-release&color=orange)](CHANGELOG.md)

<!-- Node and pre-release badges read public main package.json, not this local branch.
Keep package.json version and CHANGELOG.md release line together at each release.
npm badges: enable only after first publish of deckent to npm; verify package identity first.
[![npm version](https://img.shields.io/npm/v/deckent)](https://www.npmjs.com/package/deckent)
[![npm downloads](https://img.shields.io/npm/dm/deckent)](https://www.npmjs.com/package/deckent)
-->

Deckent is a customer-installed Agent OS for authorized, coordinated and verifiable human, AI and
tool-driven work, from solo use to enterprise. Core is open source under Apache-2.0 and stands alone;
proprietary Enterprise is separately distributed. Provider-neutral, local-first AI agent orchestration runtime.
One core and one typed application contract,
used today by the CLI, the interactive terminal (streamed agent turns with approvals, file edits and a host shell
that is not a sandbox), the MCP server and the SDK (`import … from 'deckent'`). Runtime-backed operations
use the installed runtime service; installation, observation and some SDK/patch operations call composition
directly. There is no HTTP API yet; Dashboard and Desktop are planned observer/operator apps on the same services
(only a versioned terminal–desktop bridge contract exists).

## Status

**1.0.0-alpha.4 (live 2026-10-03), clean-room port in progress.** Completed capabilities are recorded in
[COMPLETED-PLAN.md](COMPLETED-PLAN.md); remaining work is in [PLAN.md](PLAN.md); who holds what and what comes next is on the host
process board (`node .agents/refactor/board.mjs show`). Live observation: `deckent monitor` (one read-only snapshot of every installation).
Development dogfood (Deckent workers writing Deckent cards in an isolated installation) runs as bounded trials; DOGFOOD is officially off. Everything else is being ported from the legacy codebase
one capability at a time, each landing with contract tests and a real-binary proof.

The `deckent` package is not published on npm (registry E404 verified 2026-10-03); use the source
checkout below. The live alpha.4 status is the recorded release state, not a fresh runtime check
from this documentation lane. All six CI cells (Linux, macOS, Windows × Node 24/26) are required (owner 2026-10-03), so the CI badge stays red
until the open macOS/Windows platform debts close; a red badge means a real failing cell, not noise.

## Features that exist today

The current scope below comes from the [capability map](.deckent/docs/plan/capability-map.md#bugün-ne-var-ne-eksik) and
[alpha.3 release record](CHANGELOG.md). Availability is bounded by each installed profile and policy.

- Run/Task/Attempt admission, dependency scheduling, reservations and a durable SQLite ledger;
  governed local runtime service, cancellation and recovery.
- Git-backed attempt checkouts and Docker workers, including native Claude/Codex profiles and
  packaged bootstrap; retained patches, isolated integration candidates, delivery, adoption and release.
- Local OS identity, company-scoped policy, audit and a shared approval broker; attested human
  assurance, parked Runs with timeouts and human acceptance/rejection of unverified evidence.
  MCP offers approval observation, with no approval decisions.
- Model catalog v3 with client × billing channels, exact activation, provider invocation,
  spending/allocation audit and local vLLM chat. Catalog membership does not prove native support.
- Interactive terminal with streamed turns, tools, permission modes, MCP client and compaction;
  read-only installation monitor, registry-derived configuration and bilingual CLI help.
- Advisory `deckent decide` port; advice grants no execution authority. Architecture budgets,
  dependency/i18n gates and a shrink-only hardcode ratchet protect the development contract.

Mission/`do`/autonomous business-process coordination, complete Brain/Auditor/Nervous loops,
Enterprise SSO/fleet/HA, remote HTTP API, Desktop and Dashboard remain open work. A shared-kernel
Docker worker is not a VM guarantee; the interactive terminal's host shell is not a sandbox.

### Worker toolchain currency

`deckent doctor --toolchains` compares the CLI versions pinned by prepared native profiles with the published
npm `latest` tag of `@openai/codex` and `@anthropic-ai/claude-code` (one bounded read per package, no credentials).
It runs only with the flag and only when `toolchains.currency.mode` is `report`; `registryEndpoint` may point at a
private registry, and unreachable registries report `unknown-offline`. Cursor has no documented version endpoint and
is reported `unsupported`. The report never updates, rebuilds or activates a worker. The same report is available as
the MCP tool `inspect_toolchain_currency` and the SDK function `inspectToolchainCurrency`.

`deckent toolchains update [--apply]` turns a stale report into the next worker image version under
`toolchains.update.mode` (`off | propose | auto`, default `propose`): a typed plan is written under
`<data root>/workspaces/toolchains/plans/`; with `auto` or `--apply` the shipped builder is copied into
`workspaces/toolchains/builds/<version>/`, built with a bounded timeout, and its receipt produces a
`not-applied` profile-revision proposal (`proposals/<version>.json`). Installed config is never rewritten;
apply the proposal as a new installation profile revision. Running work keeps its image; old versions stay for
rollback. `toolchains.update.atStartup` makes `runtime serve` emit the currency report (report only).

### Worker image versions

`npm run worker:image -- /abs/path/worker-images/<version>.json` builds the three-provider
`deckent/worker` image from `assets/worker-image`. `recipe.json` (schema 2) names `imageVersion`
(`r<N>-<YYYYMMDD>`) and `previousVersion`; the Dockerfile keeps a newest-first `# version …` comment
history that must match the recipe and is copied into the image at `/opt/deckent-worker/Dockerfile`.
Each version maps to one immutable imageId tagged `deckent/worker:<version>` with OCI labels; a version
whose tag already names another image is refused. To update: add a new history line, bump
`imageVersion`/`previousVersion`, rebuild, then reference the receipt's `imageId` in a new execution
profile revision. Keep old images, tags and archived receipts (`worker-images/archive/`) for active
Runs and rollback; the product binds by `imageId` only and never pulls, tags or deletes images.

### Native coding profiles

`coding prepare --input <file|-> --json` and SDK `prepareNativeCodingProfile` author a profile;
preparation does not activate it or grant execution permission. The outer request remains
`{schemaVersion: 1, template, invocation}`. New `invocation` data requires `schemaVersion: 2`,
`provider`, `cliVersion`, `permissionMode: "unattended"`, `model` and either `prompt` or `composition`. Use the exact
CLI version string measured in the selected image's preflight receipt, not the host CLI version.

Structured `composition` v1 requires `task`, `scope` and `acceptance` text. It accepts an optional
`core`, optional `persona`, and `skills`/`context` arrays; each selected part has `{id, version, text}`.
Omitting `core` selects the packaged, versioned common worker instructions. Selection is explicit:
no persona/skill catalog or host file is searched. Duplicate persona/skill IDs are rejected.
Each text is limited to 16 KiB; the serialized composition to 32 KiB, with at most 16 skills and
8 context parts. Prompts persist as task data: never include credentials in either input form.

The compiler binds content, selected-part hashes and command arguments in the prepared profile.
The worker verifies the binding, then supplies Claude's core via `--system-prompt`, Codex's via
an instruction file in private tmpfs, and Cursor's inline with the task. Codex additionally disables
automatic project-document loading; this does not establish complete discovery suppression.
Docker command arguments contain placeholders for composed prompt bodies. A bounded
`native-prompt-delivery` output records hashes and selection metadata when the native process
spawns, without prompt bodies or credentials. This proves process input handoff, not model
compliance; acceptance still needs observed task results. Persona and skill content grants no authority.

`discovery` is versioned data: `{schemaVersion: 1, mode: "disabled"}` is the default.
Claude maps it to subscription-compatible `--safe-mode`. Codex and Cursor currently reject
that mode because complete discovery suppression has not been established for their adapters.
For an explicitly authorized repository-discovery profile, select
`{schemaVersion: 1, mode: "repository"}`; this permits repository instructions/configuration
and can start repository hooks or MCP processes. It does not grant additional host/network access.
Discovery suppression controls automatic loading; native tools can still read files inside the workspace.

Only Claude repository mode currently accepts `discovery.settings`, with the typed field
`disableAllHooks: boolean`. This becomes explicit `--settings` JSON; arbitrary settings files,
helpers, environment variables and credentials are rejected. Disabling hooks alone does not
suppress repository MCP or instructions. Settings with discovery-disabled mode are rejected.

The worker checks its CLI version and required flags in an empty temporary directory before
writing its credential file and launching the task. A mismatch exits with a sanitized `preflight`
failure; there is no API/authentication fallback. Image re-probing uses the current inspector
and records its hashes even for an existing image. Capability help is not authenticated proof.
Old invocation-v1 authoring requests are rejected, rather than silently changing their meaning.
Already persisted execution profiles keep their exact behavior and replay; migration means
preparing and admitting a new profile revision explicitly.

### Patch custody and integration

Patch capture compares the workspace with the base tree by Git object id and reads only changed base blobs;
exhausted Git output/time or scan budgets fail as `PATCH_LIMIT` with a `detail` param (`git-output`,
`git-timeout`, `time`, `bytes`, `entries`, `depth`, `path`). `execution.git.outputBytes` defaults to 4 MiB.

For a retained workspace patch, `deckent task integration-check` checks the recorded base
against HEAD and the affected index/worktree files. Use the same identity flags as
`task patch-preview`. `task integration-prepare` additionally takes `--command-id <id>`
and the check's `--proposal <code>`, and requires `prepare-integration` policy permission.
Both commands support `--json` and use local storage without a runtime service.

Preparation creates a separate Git candidate under the configured workspaces resource's
`integrations` directory. It contains the recorded base plus patch and leaves source files,
HEAD and index unchanged. A prepared candidate is not Task acceptance or live delivery.
Repeating a completed command verifies its candidate; an interrupted command reports
`PATCH_INTEGRATION_PENDING` and preserves its files without automatic repair or takeover.
Existing ledgers require explicit installation/storage migration to version 30 before prepare;
read-only check and ordinary preparation never silently migrate them.

`task integration-inspect` takes the same identity flags plus `--command-id <id>`
and requires only `read-output`. It reports `absent`, `pending`, or `manifest-recorded`
from the existing ledger and immutable manifest. It works without execution configuration
and does not migrate storage, repair candidates, or recheck their current files.

## Requirements

- Node.js ≥ 24.15.0 (bundles SQLite ≥ 3.51.3; Node 24 and 26 are supported) on Linux or Windows WSL2
- Docker (exact-docker worker execution; worker image recipe in `assets/worker-image/`)

## Install and run

From a source checkout:

```sh
git clone https://github.com/Verhex/deckent-next.git
cd deckent-next
```

```sh
npm ci
npm run build
node dist/composition/core/cli/internal/entry.js --version
```

Installation accepts owned group-writable project and bootstrap journal directories (for example,
`0775`), but rejects directories writable by other users. Group members can alter directory entries;
this shares custody of the journal namespace with that group. Journal files still require the current
owner, a single hard link and private `0400`/`0600` permissions. New directories default to `0700`.
Config publication, policy, artifacts and worker resources retain their separate stricter checks;
a group-writable project does not imply support for a shared writable product-data root.

## Development host

This checkout is the execution workspace. `deckent-dev` is a read-only refactor reference;
its runtime and workers must not be launched. Local development entry points are:

```sh
node .agents/refactor/next-entry.mjs cli --version
node .agents/refactor/next-entry.mjs cli workers watch --scope pilot
node .agents/refactor/next-entry.mjs mcp
# For local SDK scripts, use the same environment and cwd:
node .agents/refactor/next-entry.mjs node /absolute/path/to/script.mjs
```

The host entry pins cwd to this checkout and `DECKENT_GLOBAL_HOME` to
`~/.local/state/deckent-next-dev`, outside the checkout (the runtime copies the bundled bubblewrap there,
and a launcher inside the project is refused). It drops an inherited `DECKENT_HOME` to avoid redirecting project
runtime data. Each project's `.deckent/config.json` still chooses its own `layout.root`.
`DECKENT_GLOBAL_HOME` is a shared CLI/MCP/SDK configuration input; it selects the global
configuration/state directory independently of project data. Without it, installed product
defaults remain unchanged. It contains no provider credentials and does not migrate legacy state.

The local observer reads only explicitly configured `inspection.workers.sources` and preserves
source policy checks. Docker workers see their attempt checkout at `/workspace`; host storage
is `<layout.root>/workspaces/<attempt-hash>/tree`. `worker.hb`, `worker.log` and `worker.result`
are host-owned observations beside `tree`, outside the worker mount. Log summaries expose
safe state/diagnostic fields, not arbitrary provider output. `Ctrl+C` stops the view only.
The `pilot` scope and local source catalog are development fixtures, not an installed default.
DOGFOOD remains off. Changing MCP configuration requires reconnecting already-open clients.

The process board (`node .agents/refactor/board.mjs show`) owns who holds what and the next step;
[PLAN.md](PLAN.md) owns admitted work. The board is host coordination data outside Git/npm,
not authority or liveness proof. `deckent monitor` observes installations without admitting work.
If a lane lacks the shared host board, leave the lead a handoff instead of creating a competing board.

### Development duration measurement (A02/W0-3)

`node .agents/refactor/effort.mjs` records how long development slices actually take. It is
host tooling for M1–M5 forecast updates, not a product feature or a second work ledger.

```sh
node .agents/refactor/effort.mjs start A02-my-slice --milestone M1 --title "…" --actor "…" --kind active
node .agents/refactor/effort.mjs phase A02-my-slice blocked --reason owner-decision   # active|blocked|verification|rework
node .agents/refactor/effort.mjs pause A02-my-slice        # time until the next event is unknown, never active
node .agents/refactor/effort.mjs end A02-my-slice done     # done|canceled|handed-off
node .agents/refactor/effort.mjs report --format table     # observed hours per kind and milestone
```

Events are immutable private files under `.deckent/host/effort/<slice>/` (Git-ignored). Time is
counted only between explicit events; unobserved time is reported as unknown and never estimated.
`--at <ISO>` records an operator-supplied timestamp and is counted separately in reports.

### Checks before landing

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing anything: package direction, size limits,
i18n, and the markdown policy are enforced by `scripts/lint-arch.mjs` and fail the build.

Use targeted checks per slice: typecheck, ESLint on changed source files, `lint-arch`, core-memory
validation and touched test files where relevant (see [CONTRIBUTING.md](CONTRIBUTING.md)).
Full `npm run verify` runs only for batches that add broad features and only on owner request
(owner 2026-10-03); it is not a repeated per-slice gate. `npm run lint` is the aggregate lint command.
Targeted/lane Vitest runs use `VITEST_MAX_FORKS=2`; full verify uses four workers by default and
local tests stay within 16 GB. Do not build during an active test suite. Author checks are separate
from independent review and the lead's landing gate.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for owner-admitted cards, human and worker branch/PR
workflows, checks and independent review. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Report Core vulnerabilities privately using [SECURITY.md](SECURITY.md).

## License

Apache-2.0 (see [LICENSE](LICENSE); DEPS-P0, owner 2026-09-29).
