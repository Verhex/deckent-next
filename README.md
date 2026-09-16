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
node dist/surfaces/core/cli/internal/entry.js --version
```

## Develop

```sh
npm run verify   # typecheck + eslint + lint-arch + build + tests + smoke — the landing gate
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing anything: package direction, size limits,
i18n, and the markdown policy are enforced by `scripts/lint-arch.mjs` and fail the build.

## License

MIT
