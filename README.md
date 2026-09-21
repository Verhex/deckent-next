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
