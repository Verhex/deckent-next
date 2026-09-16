# Port ledger

Single source of work for the clean-room port. One row per card; status is one of `TODO`, `CARD` (port card
written, not started), `WIP`, `REVIEW`, `DONE`. Roles: **Astra** implements product code; **Fable** writes port
cards, tooling/gates, golden/parity runs and reviews every card. Full rationale, inventory and kill record:
`/home/alperen/deckent-refactor-work/PLAN-APPROVED-2026-09-16.md` (outside the repo).

Critical path: K0 → K1 → K1-F1 → R1 → R2 → O1 → S1 (M1) → O2 (M2) → O3 (M3). K1-F1 and ARCH-IMPORTS land before K2.

Port cards (responsibility map, decisions, invariants, proof) live outside the repo at
`/home/alperen/deckent-refactor-work/cards/<CARD>.md`; a row moves to `CARD` when its card is written.

| Card | Scope | Depends | Legacy→target lines | Lane | Milestone / proof | Status |
|---|---|---|---|---|---|---|
| K0 | skeleton, arch.json, lint-arch, eslint, build, CI, i18n kernel, CLI `--version` | — | →1.5k | Fable | `deckent --version` from dist | DONE |
| K1 | kernel: types/errors/constants, host/platform, config v2 (+ registered sections), output, principal/tenant | K0 | 13k→6k | Astra | `config get` / `migrate` / kernel `doctor`; 3 fixtures, 12/12 shared-value parity | DONE |
| K1-F1 | config schema-as-data: single field registry → derived zod/defaults/aliases/env/metadata; remove base/config-defaults; registry-fed literal lint | K1 | 0.6k→0.5k | Astra | `config get` byte-parity with K1; no flow-value literal outside registry | CARD |
| ARCH-IMPORTS | `#pkg/tier/unit` subpath-import aliases (package.json imports + tsconfig paths + lint import-style) | K1 | tooling | Fable (infra) + Astra (K1 conversion) | lint-arch import-style 0 violations | CARD |
| K2 | kernel/i18n: 3,257 reachable keys → 10 family JSONs per locale, `t()`, one locale resolver (calibration card 1) | K0 | 15.4k→0.3k + data | Astra | catalog parity vs legacy; exact Fable list pending | WIP |
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
| CL1 | closure: settlement/receipt/xverify/audit chain (host-scoped custody, ed25519 anchors, HMAC audit, §12.2 five-link closure) | K1,K3,R2,P1 | 15.2k→14.7k (29 units) | Astra | settlement verify / tamper FAIL / HOLD never closes (real binary) | CARD |
| GOLD | golden corpus: 3 fixture projects, legacy D-class outputs, parity runner | K0 | tooling | Fable | `tests/golden/` populated | TODO |
| Z | not ported (DEFERRED unless a consumer is proven): core/catalog, notification-providers, operation-catalog, task-execution-admission, legacy win32 TS adapter, intelligence, training, extensions, sdk | — | ~30k→0 | — | — | DEFERRED |

## Velocity (measured, updated per card)

| Card | Legacy lines consumed | New lines | Contract cases | Lane-hours | Review rounds | Parity defects |
|---|---|---|---|---|---|---|
| K0 | — | (see lint-arch summary) | 7 | — | — | — |
| K1 | not measured; card inventory ≈13k | repo total: 1,642 TS + 894 catalog lines | 57 K1/gate additions; 69 total | not timed (K2 is calibration 1) | round 1 REVISE; round 2 GO (Fable) | B1/B2 addressed; doctor scoped |

Projection `T = Σ(legacyLines ÷ rate) × (1 + rework) + fixed` is published here after K2 and M1; no
calendar estimate is stated before those two measurements exist.

## K1 review evidence

- Round 1: Fable REVISE; round 2: GO. K1 landed as `c84df39` and was pushed; the card is DONE.
- Public API flows through `src/kernel/index.ts`; CLI registers provider-owned limit validation before
  resolving config. Kernel never imports provider policy. `doctor` declares `scope: kernel`; native and
  provider readiness remain R1/P1 work.
- Legacy `config get` does not accept `--json`; normalized parity compares four shared keys in three
  fixture projects (12/12). The new JSON contract, migration dry-run, strict tenant ingress and locale
  errors are checked with the real binary. Legacy doctor has no equivalent host object: memory source
  and total GB are compared separately, and platform is compared at the supported OS-family level.
- Proofs: `/home/alperen/deckent-refactor-work/proof/K1-config-parity.json`,
  `K1-doctor-parity.json`, `K1-verify.log`, and `K1-review.json` in that same directory.
- Registered sections can be optional and validate authored layers before merge; globals migrate into
  the platform path while preserving the legacy source. Only selection/identity/presentation settings
  live in the core schema; unknown legacy package fields survive with warnings until their owners port.

- Round 2: B1 secret provenance + masked human/JSON views; B2 pid/host/time owner metadata, dead-owner
  recovery and live-lock diagnostics; B3 tier placement and all three requested arch switches enabled.
  New regressions exercise actual CLI output, a killed writer, an old live owner, parallel writer processes,
  escaped/array/projection secret paths, credential revocation on cache hits and injected Windows paths.
- B2 safety refinement: directory ownership with retained generation tombstones prevents a delayed stale
  reclaimer moving a new live lock. Foreign and permission-denied owners HOLD regardless of age; only
  dead local owners or >10-minute invalid/unpublished local records auto-recover. Legacy file locks work.
- Related notes 1–5 addressed; hand-parsed argv remains explicitly assigned to S0 (note 6).
  Local verify now builds before e2e, and CI uses that same gate, so proof cannot run a stale binary.
- Round-2 receipt: `/home/alperen/deckent-refactor-work/proof/K1-revision-review.json`;
  verification log: `K1-revision-verify.log` in the same directory. Original round-1 evidence is retained.

## Backlog (owner-admitted product outcomes not yet realized in legacy code)

Source: legacy MASTER-PLAN triage (`/home/alperen/deckent-refactor-work/backlog/MASTER-EXTRACT-2026-09-16.md`, 510 active rows →
286 product backlog · 124 realized-in-code · 63 legacy governance · 37 obsolete). Owner admitted these 25 on 2026-09-16.
Each becomes a card only after its `After` dependency has landed; `Legacy` lists the MASTER ids it absorbs.

| B# | Outcome | Package / tier | After | Legacy ids | Status |
|---|---|---|---|---|---|
| B01 | Tenant/project/session scope with one scoped capability decision, fail-closed on read/write/event/memory/run/flow/admin | kernel/enterprise | K1, K3 | TENANT-001, CAPABILITY-001 | TODO |
| B02 | One durable approval broker (CAS, expiry, relay, typed risk tier); every approval producer binds to it; decisions only via CLI | kernel/core + surfaces/core | K3, S0 | APPROVAL-001, APPROVAL-SURFACE-UNIFICATION-001 | TODO |
| B03 | A receipt per provider call and one admission→reservation→usage→landing→settlement ledger | providers/core | P1 | RECEIPT-001, LIMIT-001 | TODO |
| B04 | Tamper-evident, tenant-scoped causal audit with redaction and bounded retention | observability/enterprise | K3, B01 | AUDIT-001, OPERATION-EFFECT-CONTEXT-001 | TODO |
| B05 | Tenant-aware age/count/size retention, atomic rotation, legal hold, one archive location | kernel/enterprise | K3, B01 | STATE-RETENTION-001, TASK-RETENTION-001, ARCHIVE-PATH-AUTHORITY-001 | TODO |
| B06 | Transactional storage backend with a distributed adapter boundary; no unsafe full-file read-modify-write; classification, residency, export/delete | kernel/enterprise | K3 | STORAGE-001, DATA-GOV-001 | TODO |
| B07 | No silent provider, model, surface, billing or data-boundary substitution | providers/core | P1 | CM-03 | TODO |
| B08 | Secret-free adapter SPI, signed opaque session lease (scope/TTL/nonce/audience, replay fails closed), credential-less worker execution | providers/core + runtime/core | P1, R2 | P02-637, P02-638, P02-639 | TODO |
| B09 | Cross-platform credential custody | providers/core | B08 | P02-644 | TODO |
| B10 | Platform proof matrix incl. macOS and Windows custody (X axis proven, not `?`) | runtime/core | R1, R2, W1 | PLATFORM-PROOF-001, 8031, 8032 | TODO |
| B11 | One token-measurement authority for admission, tool results and checkpoints | surfaces/core | CH | TERMINAL-CONTEXT-CONTINUITY-001, TERMINAL-TOOL-BUDGET-UNITS-001 | TODO |
| B12 | Preamble bound to a window-proportional budget; lazy tool schemas | surfaces/core | CH | TERMINAL-PREAMBLE-BUDGET-001 | TODO |
| B13 | Deterministic read-only shell classifier + ranged/outline file reads (≈25 approvals → 0) | surfaces/core | CH, A1 | TERMINAL-READONLY-APPROVAL-001 | TODO |
| B14 | Checkpoints carry a tool trail; host forces interim answers | surfaces/core | CH | TERMINAL-CHECKPOINT-CONTINUITY-001, TERMINAL-INTERACTION-FLOW-001 | TODO |
| B15 | Worker prompt cost architecture (measured ≈80% reduction; stable cached prefix) | orchestration/core | O1 | WORKER-PROMPT-COST-ARCHITECTURE-001 | TODO |
| B16 | Evaluator honesty: unproven "tests passed" penalized; goCriteria and rubric one authority; typed residual debt | orchestration/core | O4 | EVALUATOR-HONESTY-GONOGO-001 | TODO |
| B17 | Provider-neutral canonical memory with revisioned sync, conflict journal, no silent delete, surface projections | kernel/base | M1 | MEMORY-AUTHORITY-001, MEMORY-SYNC-001, MEMORY-SURFACE-PROJECTION-001 | TODO |
| B18 | Bounded semantic working context for the brain (no fixed item cap / byte truncation) | kernel/core | M1 | BRAIN-MEMORY-LIFECYCLE-001 | TODO |
| B19 | Runtime i18n enforcement across TSX/MCP/connectors; six-language docs with freshness gate | kernel/base + docs lane | K2, S3, APP | I18N-SURFACE-001, DOCS-I18N-001 | TODO |
| B20 | Versioned API contracts, VerifiedPrincipal without raw-header trust, durable outbox with tenant isolation | surfaces/enterprise | S2, B01 | API-CONTRACT-001, API-IDENTITY-001, API-EVENT-001 | TODO |
| B21 | Enterprise auth: advisory vs enforced explicit; RBAC and org freeze share the core | kernel/enterprise | B01 | ENTERPRISE-AUTH-001 | TODO |
| B22 | Signed provenance for supply chain; plugin sandbox check invoked fail-closed | orchestration/enterprise + runtime/enterprise | A1, R2 | SUPPLY-CHAIN-001, PLUGIN-SANDBOX-WIRE-001, PLUGIN-SANDBOX-001 | TODO |
| B23 | One effective agent/skill catalog over shipped/override/learned/archive layers; sync never overwrites user content | orchestration/custom | A1 | 7011, 7012, 6011, 6012, 7013 | TODO |
| B24 | Per-agent/per-skill permission matrix; solo→team→enterprise profiles; OFF = today's behavior | orchestration/enterprise | A1, B02 | AGENT-PERMISSION-MATRIX-001 | TODO |
| B25 | SLO, HA, load/chaos thresholds and an assurance pack that names them | observability/enterprise + runtime/enterprise | O2, S2 | SLO-001, HA-001, LOAD-CHAOS-001, ASSURANCE-PACK-001 | TODO |

Just below the line (not admitted, revisit after the cards): SURFACE-PARITY-001, COMPOSITE-WORKER-001, AUTONOMOUS-PERPETUAL-001,
CURSOR-PROVIDER-001, the TRACE-* cluster. Realized-in-code rows are covered by their port cards; 30 acceptance invariants from the
triage (§4 of the extract) are pinned to cards O1–O4, R2, K1–K3, S2–S3 by the card author.

## K2 calibration / pending authority

- Measurement starts 2026-09-16T13:50:03Z after preflight; actual AST-read catalog inventory is 15,477
  lines in 14 files (including the memory-read re-export), 3,981 entries. AST text and the compiled legacy
  oracle agree for every key; the two floor templates were compared with explicit sentinel parameters.
- Owner selected **Fable's exact keep/delete list** when the card counts did not reproduce. No such list
  is currently present under `deckent-refactor-work`; its path/content is required before catalog membership
  changes. Astra's 3,374/607 reachability inventory is comparison evidence only, not deletion authority.
- Independent work is implemented: synchronous registry and locale resolver, renderer sandbox proof,
  ten bilingual family files holding the existing 444 K1 keys, JSON-derived key type, duplicate/placeholder
  gates. K1's `config.invalid` was renamed to `config.valueInvalid` to reserve the conflicting legacy key.
- K2 remains WIP: legacy-key import, full legacy/new translation parity, protected-family decisions and
  command-surface parity assessment await the exact list. R1 has not started; no K2 commit/push.
- Evidence: `/home/alperen/deckent-refactor-work/proof/K2-astra-inventory.json`, `K2-wip.json`, and
  `K2-wip-verify.log`. Calibration is open; no final port rate or card closure is claimed.
