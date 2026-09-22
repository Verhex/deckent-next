# deckent

Provider-neutral, local-first AI agent orchestration runtime. One core, three surfaces: Terminal (CLI/TUI),
MCP server, HTTP API; Dashboard and Desktop are observer/operator apps on the same services.

Status: **1.0.0-alpha, clean-room port in progress.** Only the capabilities listed as `DONE` in
[PLAN.md](PLAN.md) exist in this repository. Everything else is being ported from the legacy codebase
one capability at a time, each landing with contract tests and a real-binary proof.

## Requirements

- Node.js ≥ 24
- Docker (for exact-docker worker execution; lands with card R2)

## Install and run

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

## Next development host

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
`.deckent/host/global`. It drops an inherited `DECKENT_HOME` to avoid redirecting project
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

## Native coding profiles

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

## Develop

```sh
npm run verify   # typecheck + eslint + lint-arch + build + tests + smoke — the landing gate
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing anything: package direction, size limits,
i18n, and the markdown policy are enforced by `scripts/lint-arch.mjs` and fail the build.

## License

MIT

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
