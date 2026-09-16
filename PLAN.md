# Port ledger

Single source of work for the clean-room port. One row per card; status is one of `TODO`, `CARD` (port card
written, not started), `WIP`, `REVIEW`, `DONE`. Roles: **Astra** implements product code; **Fable** writes port
cards, tooling/gates, golden/parity runs and reviews every card. Full rationale, inventory and kill record:
`/home/alperen/deckent-refactor-work/PLAN-APPROVED-2026-09-16.md` (outside the repo).

Critical path: K0 → K1 → R1 → R2 → O1 → S1 (M1) → O2 (M2) → O3 (M3).

Port cards (responsibility map, decisions, invariants, proof) live outside the repo at
`/home/alperen/deckent-refactor-work/cards/<CARD>.md`; a row moves to `CARD` when its card is written.

| Card | Scope | Depends | Legacy→target lines | Lane | Milestone / proof | Status |
|---|---|---|---|---|---|---|
| K0 | skeleton, arch.json, lint-arch, eslint, build, CI, i18n kernel, CLI `--version` | — | →1.5k | Fable | `deckent --version` from dist | DONE |
| K1 | kernel: types/errors/constants, host/platform, config v2 (+ registered sections), output, principal/tenant | K0 | 13k→6k | Astra | `deckent config get` | CARD |
| K2 | kernel/i18n: 3,257 reachable keys → 10 family JSONs per locale, `t()`, one locale resolver (calibration card 1) | K0 | 15.4k→0.3k + data | Astra | catalog parity vs legacy | CARD |
| K3 | kernel/store: SQLite primitive, artifact schema/versioning, locks | K1 | 10k→1.5k | Astra | contract | TODO |
| K4 | kernel/docs-authority: markdown write gate + DECKENT/CLAUDE/AGENTS injection | K1 | →0.4k | Astra | contract | TODO |
| R1 | native: C sources + ABI ids verbatim; TS loader ≤1.8k (TOCTOU snapshot kept); artifact v2; prebuild matrix linux x64/arm64 + darwin | K1 | 7.8k→1.6k | Astra | `doctor` native section; UNAVAILABLE path exit 0 | CARD |
| W1 | win32 trusted native loader authority (owner-only DACL proof) → enables R2 win32 custody; until then win32 reports typed DEGRADED | R1 | new | Astra | win32 CI local-backend smoke | TODO |
| P1 | providers + model registry/catalog, auth probe, limit policy | K1,K2 | 20k→7k | Astra | `models`, `doctor` provider | TODO |
| S0 | surfaces/commands core + `doctor`,`status`,`config`,`init`,`sync`,`help` | K1–K4,R1,P1 | 15k→6k | Astra | **M0** | TODO |
| R2 | runtime/exec: spawn backend, exact-docker lifecycle, custody (posix+win32), worker image, `worker/` | K3,R1 | 56k→12–15k | Astra | fixed shell task under custody | TODO |
| O1 | orchestration ring A: scheduler reducer/journal/effects, task builder, prompt template, result collector, settlement | R2,P1 | 30k→8k | Astra | structural parity | TODO |
| S1 | `deckent run` + `deckent-mcp` (run/doctor/status/config) + stub provider | S0,O1 | 6k→2.5k | Astra | **M1** one task in Docker under custody | TODO |
| M1 | memory: FTS5 schema verbatim, query/import (calibration card 2) | K3 | 5.5k→3k | Astra | `memory query` on copied memory.db | TODO |
| O2 | ring B: sprint controller/phases/spawner/checkpoint/lifecycle/recovery + live status + monitor | O1 | 29k→9k | Astra | **M2** `start/status/attach/kill/recover` | TODO |
| O3 | planner + run-flow + `do` | O2 | 20k→7k | Astra | **M3** `do` | TODO |
| O4 | ring C: evaluator, finalizer, retro, cross-verify, reporter → `.deckent/runs/<id>/` | O2 | 18k→6k | Astra | `review/retro/xverify` | TODO |
| G1 | DIRECTIVES reader + `init --host` (pointer section only) | K4,S0 | 4k→1k | Astra | `set-directives`, `init --host` | TODO |
| A1 | agent runtime + permission policy + skills + plugins | O1 | 21k→8k | Astra | `agent`,`skill`,`plugin` | TODO |
| S2 | surfaces/api (HTTP/WS, live events, auth, tenant) + `serve` | O2 | 11.7k→6k | Astra | `serve` + dashboard smoke | TODO |
| APP | apps/dashboard (lift) + apps/desktop (4 imports → surfaces type API) | S2 | 41k→38k | Astra | `dashboard` | TODO |
| S3 | MCP full catalog (tool names are an external contract), writer-lease | S1,O3 | 10.2k→4k | Astra | tool list = registry | TODO |
| N1 | observability/nervous | O2 | 7.9k→4k | Astra | `nervous` | TODO |
| C1 | connectors, bot/gateway | S2 | 10.2k→5k | Astra | `connect`,`bot` | TODO |
| AU | autonomous missions | O3 | 8k→4k | Astra | `autonomous` | TODO |
| CH | chat/REPL (ink, node-pty) | S1,A1 | 20k→8k | Astra | `chat` | TODO |
| X | kpi, cost, traces, audit, explain, history | K3,O2 | 10k→4k | Astra | `kpi`,`audit verify` | TODO |
| GOLD | golden corpus: 3 fixture projects, legacy D-class outputs, parity runner | K0 | tooling | Fable | `tests/golden/` populated | TODO |
| Z | not ported (DEFERRED unless a consumer is proven): core/catalog, notification-providers, operation-catalog, task-execution-admission, legacy win32 TS adapter, intelligence, training, extensions, sdk | — | ~30k→0 | — | — | DEFERRED |

## Velocity (measured, updated per card)

| Card | Legacy lines consumed | New lines | Contract cases | Lane-hours | Review rounds | Parity defects |
|---|---|---|---|---|---|---|
| K0 | — | (see lint-arch summary) | 7 | — | — | — |

Projection `T = Σ(legacyLines ÷ rate) × (1 + rework) + fixed` is published here after K2 and M1; no
calendar estimate is stated before those two measurements exist.
