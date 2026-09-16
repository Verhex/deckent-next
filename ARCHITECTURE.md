# Architecture

This document and `arch.json` are the same contract: prose here, machine rules there. `scripts/lint-arch.mjs`
fails any landing that breaks them. There is no baseline and no exception file; a rule change is a change to
`arch.json` recorded in the decision log below.

## Packages

```
src/
  kernel/          types · errors · config · i18n catalog · registries · store primitives · docs-authority
  providers/       provider adapters, model registry (the only place model/provider identifiers may appear)
  runtime/         execution: spawn backends, exact-docker lifecycle, custody (posix + win32), effects, locks, worker
  orchestration/   planner · scheduler · sprint lifecycle · evaluation · routing · agent session · autonomous
  surfaces/        cli · mcp · api · sdk · connectors — thin adapters over orchestration/runtime services
  observability/   monitor · nervous · read-models — reads everything, is imported by nobody
apps/
  dashboard/       web observer (HTTP only; no source imports)
  desktop/         native operator app (imports the published surfaces type API only)
native/            exec-authority N-API addon (C), sibling of dist/ — load path is a runtime contract
worker/            container-side mini package (runtime-only dependencies)
```

Dependency direction (fail-closed): `kernel ← providers ← runtime ← orchestration ← surfaces`.
`observability` may import kernel/runtime/orchestration read-models and is never imported.
`apps/*` import only `surfaces`. Cross-package imports target the package `index.ts` and nothing else;
`internal/` is package-private.

## Package contract

- Public API is `index.ts`; everything else is internal.
- Every file ≤ 800 lines (eslint + lint-arch), functions ≤ 150 lines (warning).
- Package line budgets and the total budget live in `arch.json` (`budgets`); growth past a budget is a
  design decision, not a lint fix.
- Mechanism code is string-free: user-facing text comes from `kernel/core/i18n/{en,tr}.json` through `t('key')`.
  Keys are literals (lint), catalogs have identical key sets (lint), surfaces never print literals (lint).
- Model, provider and flow identifiers appear only in `providers/core/registry/` (lint).
- The product writes markdown only through `kernel/core/docs-authority`, and only `DECKENT.md` plus a bounded
  section in `CLAUDE.md`/`AGENTS.md`. No README/CHANGELOG/vision/sprint-log writers exist.
- Every environment: Linux, macOS, Windows native, Windows WSL, Docker. A platform without proof reports a
  typed `UNSUPPORTED`/`DEGRADED`, never a silent fallback.
- State lives under the project's `.deckent/` (v2 schemas) and `.brain/memory.db` (FTS5); both gitignored.

## Testing policy

- `tests/contracts/<package>/` — public API and invariant tests only; no internal-function tests.
- `tests/e2e/` — real binary journeys (`doctor`, `run`, `start`, `do`, …) on fixture projects under `tests/fixtures/`.
- `tests/golden/` — normalized outputs of deterministic commands, captured from the legacy binary and
  diffed against the new one during the port.
- Budget: ≤ 8,000 test cases total, every test file ≤ 800 lines (lint). Legacy invariant titles are in
  `tests/contracts/HARVEST.json`; each port card lists which titles it honours.

## Documents

Exactly four tracked markdown files: `README.md`, `ARCHITECTURE.md`, `PLAN.md`, `CHANGELOG.md`, plus
`CLAUDE.md`/`AGENTS.md` as ≤ 5-line pointers. Anything else fails `lint-arch`. Design reasoning goes into
the decision log below, not into new files.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-09-16 | Clean-room port into this repository instead of in-place refactor of the legacy codebase (587k lines, 24.8k-line spawn backend, 40.9k tests, 5,535 path-keyed lint baselines). | Every in-place move broke 8+ gates and preserved dead code; the owner chose deletion over archive. |
| 2026-09-16 | File size is a mechanical gate (800 lines) in addition to cohesion-based boundaries. | Cohesion alone did not hold: one file tripled in two weeks. Supersedes legacy ADR-D-006 §2 wording. |
| 2026-09-16 | Layer direction `kernel ← providers ← runtime ← orchestration ← surfaces`, observability read-only, public-API-only imports. | Carries the legacy ADR-D-004 invariant (lower layers never import upward) into named packages; the legacy graph had only 138 violations out of ~3,400 edges, half of them caused by the i18n catalog living in cli. |
| 2026-09-16 | Spawn backends, exact-docker custody, effects and locks are `runtime`, not orchestration. | They were consumed only by orchestration but lived in core/orchestra with a 24.8k-line monolith; a runtime package with a `SpawnBackend` façade of 17 methods is the contract (legacy ADR-G-014). |
| 2026-09-16 | Zero hardcoded model/provider/flow identifiers outside `providers/core/registry/`. | Legacy ADR-G-036; enforced by lint instead of a ratchet. |
| 2026-09-16 | Memory is DB-first (`.brain/memory.db`, FTS5) and the only legacy state imported verbatim; all other `.deckent` state is v2 with a one-shot `import-legacy-state`. | 80 schema constants and 7 SQLite files could not be kept byte-compatible through a rewrite (legacy ADR-G-035 kept; rest re-declared). |
| 2026-09-16 | The product no longer writes README/CHANGELOG/vision/release/sprint-log or host rule files. | Document sprawl was partly product-generated; the owner removed the feature. |
| 2026-09-16 | Windows native custody is ported and wired (`runtime/custody/win32`), reported `DEGRADED` until CI proof. | Legacy had an unreferenced 1.8k-line win32 adapter: support that only appeared to exist. |
| 2026-09-16 | K1: top-level `schema_version: 2`; kernel owns selection/identity/presentation fields and config IO. Package sections register strict Zod schemas and optional authored-layer validators before resolution. Provider limit policy is owned by `providers/core/contract` and registered by CLI ingress. | Prevents another god-config and keeps parent quota authority outside generic deep merge. Unknown top-level keys are preserved with warnings; registered sections reject unknown fields. |
| 2026-09-16 | K1: defaults → platform-global (legacy fallback) → project → env → exact `$DECK:` references; global writes target the platform path. Migration uses an exclusive writer lock, revision checks, private atomic writes and three retained backups. | IO failures never quarantine healthy files; dry-run performs no writes. Provider selections default to null until an authored selection or provider policy resolves them. |
| 2026-09-16 | K1: preserve the 81 legacy error codes and their gaps; freeze registry authority, validate it at CLI startup, localize messages/remedies and centralize exits 0/1/2/78 and emission. `doctor` reports `scope: kernel` in this card. | Config/host proof must not claim provider/native/runtime readiness before their cards. K1 shares the locale resolver with the upcoming K2 catalog port. |
| 2026-09-16 | ARCH tiers gate: every package uses data-driven `core ← base ← enterprise ← custom ← user` tiers and ≤4,000-line units with `index.ts` + `internal/`. Package indexes compose shipped core/base; future enterprise/custom/user units must load lazily through edition/policy ingress. `tiers.enforce=true`. | Unit imports and tier direction are checked without a baseline. Kernel config defaults register from base into a core extension seam. Provider credential env literals are confined to the provider registry. |
| 2026-09-16 | K1 review B1: runtime retains resolved secrets with RFC 6901 provenance; `config get` masks paths (including provider projections) and sensitive keys before selecting/formatting output, and filters string values through `redactSensitive`. | Human and JSON views must never expose resolved `.deck` credentials. |
| 2026-09-16 | K1 review B2: writer lock uses an exclusive directory plus private `owner.json` (pid/hostname/nonce/time); legacy file locks remain readable. Dead local owners and >10-minute malformed/unpublished local locks recover with a typed warning; live, permission-denied and foreign owners HOLD. Nonempty generation tombstones remain after atomic rename; empty unpublished directories use atomic `rmdir`. | Deterministic retained destinations fence delayed reclaimers from moving a newer live lock; age alone cannot prove a valid process on another host dead. Errors carry path/pid/age. Tombstones are recovery evidence, not ordinary-write artifacts. |
