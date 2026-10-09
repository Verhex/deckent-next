# Contributing to Deckent

Deckent is a customer-installed Agent Control & Execution Plane for human,
AI and tool-driven work, from solo use to enterprise teams. Secure Core runs
standalone; proprietary Enterprise components are distributed separately.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow,
[the architecture overview](docs/architecture-overview.md) for the product model
and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Setup and checks

Use a Node.js version supported by [package.json](package.json) and its npm.
Follow CONTRIBUTING's prerequisites and quickstart for native and Docker setup.
Install locked dependencies with `npm ci`; it replaces an existing `node_modules`.

For documentation changes, check relative links and run:

```sh
node scripts/lint-arch.mjs
node scripts/lint-docs.mjs
```

For source changes, also run `npm run --silent typecheck`, ESLint on each changed
source file and the relevant test files. See CONTRIBUTING for exact test commands.
Use `VITEST_MAX_FORKS=2` for targeted tests and keep aggregate local test memory
within 16 GB. Coordinate broad verification with maintainers; do not build while
a test suite is running. Report exact commands, results, skips and unverified paths.

## Engineering expectations

- Reuse one typed application contract across human, AI, CLI, SDK, MCP and terminal
  surfaces; give each state transition one responsible application component.
- Keep domain logic pure, external I/O behind ports and composition explicit.
  Version contracts and migrations; preserve existing failure-path coverage.
- Carry principal, scope, resource, policy and audit context through operations.
  Enforce filesystem, process, network and secret boundaries; workspace separation
  alone does not establish isolation.
- Preserve bounded resources, cancellation, recovery and uncertain-effect handling.
- Put mutable policy in registries and user-facing strings in matching English and
  Turkish i18n catalogs through the shared renderer. Keep invariants in versioned code.
- Keep secrets, credentials, private local state and proprietary Enterprise sources
  out of contributions, logs and public artifacts.
- Preserve concurrent work. Keep changes small, complete and reviewable; split by
  responsibility while preserving capabilities. Update affected documentation.
- Explain and test submitted changes, including material AI assistance as described
  in CONTRIBUTING. Apply the same review standard to every contribution.

Keep AGENTS.md and CLAUDE.md byte-identical and each at or below 70 lines.
