# Port ledger

Single source of work for the clean-room port. One row per card; status is one of `TODO`, `CARD` (port card
written, not started), `WIP`, `REVIEW`, `DONE`. Roles: **Astra** implements product code; **Fable** writes port
cards, tooling/gates, golden/parity runs and reviews every card. Full rationale, inventory and kill record:
`/home/alperen/deckent-refactor-work/PLAN-APPROVED-2026-09-16.md` (outside the repo).

## Owner review cadence — 2026-09-17

Advance each card in small, frequent slices. Explain the scope before editing and material findings during
work; then present legacy→Next feature mapping, affected surfaces, package/layer/dependency ownership,
configuration/version/language impact, changed files, actual verification and remaining gaps in Turkish.
State Fable review separately. Give Alperen a checkpoint to inspect and steer before the next substantive
implementation slice; routine edits and checks inside the agreed slice continue without repeated permission.
A full card is not the minimum review unit. The next proposal must name one concrete responsibility and proof.
This applies to every product port, new capability and refactor; existing WIP and accepted decisions remain intact.

## Owner checkpoint — task semantics and IFS integration (2026-09-17)

Task is the work unit; run/directives, do/natural-language-or-structured and periodic autonomous are execution
entries coordinated by goal-bounded Mission. Task-kind modules are separate from these entries and permission.
A separate process surface is proposed for deferral, not deletion of ERP workflows. ARCHITECTURE records detail.
First end-to-end business integration is IFS ERP: Cloud via MCP if prepared/verified, and Applications 10 via
native connector where MCP is unavailable/unsuitable. Both owner test environments exist; Cloud access setup,
exact supported transports and first business scenario are pending. No external calls/writes admitted by this plan.
6–8 local workers / up to 50 tasks describe the initial workload; enterprise counts are illustrative, not hardcoded
limits or fixed release claims. Core ports/security accepted; individual adapter packaging remains undecided.

Current slice EXECUTION-SURFACES-AUDIT: source-backed capability/ownership analysis with independent Fable input.
Owner correction: no legacy aliases, old-config conversion or compatibility burden. K1-F1/A is a historical
field inventory; its compatibility proposals are withdrawn. New contracts precede the next product edit.
Review the existing card amendment at `/home/alperen/deckent-refactor-work/cards/K1-F1-config-schema-as-data.md`.
K1-F1 must not blindly preserve deckent_style semantics or claim byte parity for intentional changes. Metadata
and schema derivation stay narrow; complex validators remain package-owned code. Lint projection freshness must
be checked before lint consumes it. No runtime feature or env control is inferred from a schema entry alone.
Next implementation slice requires owner checkpoint; keep existing ARCH-IMPORTS/K2 WIP intact.

## Kabul edilmiş kod dilimi — K1-F1/B (REVIEW 1316)

Northstar ARCHITECTURE içindedir. Yeni bağımsız blueprint dosyası yok.
K1-F1/B bağımsız PASS aldı; parent K1-F1 açık. Sonraki önerilen C dilimi: registry-fed literal gate,
output default tüketicileri, düz provider projeksiyonlarının kaldırılması, description/tier/since metadata.
Host worker öneri sabitleri ASSURANCE kapsamındadır. Owner1317 yetkilerini bu oturumda doğrudan onayladı: PASS sonrası Next commit; push owner gate.
Rutin kabul edilmiş dilimler ilerler; yeni mimari/sözleşme/yetki kararı owner checkpoint gerektirir.
Kapsam: tek config field registry → schema/default/env/metadata; legacy alias/migrate/style kaldırma;
strict kayıtlı alan kabulü; worker sayısına eski100 tavanını taşımama. Provider validators, lock/secret
korumaları ve mevcut K2/ARCH-IMPORTS WIP korunur. CLI config get + doğrudan public config API kanıtı;
MCP/SDK yürütme kontratları ve provider-native capability/metric uygulaması sonraki küçük dilimlerdir.

## Owner-admitted transition — 2026-09-17

Authority: live owner acceptance of the Fable/Astra review, extended with isolation, deterministic database
adapters, modular packaging, compatibility and conditional Go. ARCHITECTURE.md contains the accepted contracts.
This section supersedes conflicting future scope/dependency prose in the 2026-09-16 port map; it does not
rewrite prior DONE evidence or claim new production capabilities. Legacy product remains read-only; owner 2026-09-17 admits host instructions/skills/hooks and communication.md setup there.

Current WIP is preserved. K1-F1 / ARCH-IMPORTS / K2 and their existing review prerequisites establish the stable
base before package relocation. No shared-path mutation by concurrent implementers. The old port map below is
responsibility inventory; affected cards must be reconciled with these rows before execution.

| ID | Scope / dependencies | Acceptance | Status |
|---|---|---|---|
| HOST-SETUP | Corrections K1/K2/B1–B3/N3–N6 applied; B1 live delivery independently verified; Fable REVIEW 1298 PASS (2026-09-17). Owner 2026-09-17: shared refactor skill, adapted Codex/Claude/Cursor hosts, Git-first workspace policy, bounded Fable channel | Hook behavioral tests, host manifests, Next verify; independent Fable review and live receipt verified in 1298 | DONE |
| FOUNDATION | After stable K1-F1/ARCH-IMPORTS/K2 base: update package map, imports, pointers and 1,500-line/native gate consistently; keep 800 design target; separate private Enterprise composition | Preserve prior behavior/proof; current source and machine graph agree; Core installs without proprietary modules | TODO |
| CONTRACT | On FOUNDATION: ontology/transition ownership, pure domain, application commands/queries/events, supervisor port, module/config/protocol version policy | Shared schema and compatibility vectors; explicit composition root; existing legacy shared services mapped; one writer per transition | TODO |
| STORE | On CONTRACT; supersedes K3/B06 internal store scope: typed state/memory/search/artifact ports, deterministic adapters, capability validation, bounded concurrency, transactions/outbox/reconciliation | Real adapter conformance: concurrent updates, stale revisions, scope isolation, unknown commit, safe retry, restart, migration/restore; unsupported topology fails explicitly | TODO |
| ISOLATION | On CONTRACT; refines R1/R2/W1: Git-first workspace broker/worktrees, separate sandbox posture, per-attempt capabilities, conflict control and verified landing | Actual subprocess/container paths: main/sibling denial, network/secrets, process ownership, changed-base conflict, cancel/crash and partial effects; platform limitations explicit | TODO |
| EXECUTION | On CONTRACT/STORE/ISOLATION and P1 essentials: first full TS execution slice including policy/approval, provider, result store, Brain acceptance, Auditor and Nervous boundaries; shared operation port enables subsequent IFS-E2E business proof | Real request-to-accepted-result plus duplicate dispatch, disconnected client, approval race and recovery across shared surfaces | TODO |
| IFS-E2E | First external business integration after EXECUTION; use required connector/surface primitives without waiting for unrelated legacy catalog ports. Cloud MCP candidate + Applications 10 native adapter; exact scenario/transport discovery precedes external calls | Same typed business operations, principal/scope, approval, idempotency/reconciliation and read-back evidence on both test environments; unsupported transport explicit; no live external mutations before the scenario is admitted | TODO |
| LANG | After TS execution/capacity baseline: bounded Go supervisor comparison for an explicit cost/reliability hypothesis, same protocol and failure suite | Compare total resources, latency, recovery, packaging and maintenance cost; record keep-TS or selective-Go outcome, retire redundant implementation | TODO |
| DOGFOOD | On accepted EXECUTION with controlled parallel DAG and verified acceptance/recovery | Stable N operates on isolated N+1; cost/usage/evidence recorded; no self-overwriting runtime; external recovery; expand only proven task scope | TODO |
| LEARNING | On execution evidence plus M1/A1/O4 integration: outcome-to-routing/skill/model improvement; reusable domain-independent workflows | Real producer/consumer chain, selective updates, held-out evaluation and rollback; model tuning only with data/provenance controls | TODO |
| ASSURANCE | Across capabilities; final release depends on required platform/capacity/surface and distribution proofs | Resource-derived workload/concurrency matrix measured (initial local 6–8 workers/up to 50 tasks; larger counts illustrative); bounded evaluation; backup/restore/upgrade; Core public artifacts exclude Enterprise; separate Enterprise acceptance | TODO |

Ordering corrections: GOLD behavior capture begins with contracts and separates preserved behavior from known
bugs (raw-DONE lineage gap, evaluate-lock fail-open, Desktop approval contract). G-CONTRACT design does not close
those defects without their wired binary tests. Security scope, approval and data integrity belong in Core;
customer org management, IdP/RLS integrations and fleet/HA administration extend them in private Enterprise.
Public Core cutover and Enterprise release are distinct. Cross-host execution/settlement requirements must be
reconciled with CL1's earlier host-only limitation before claiming remote support. Required adapter candidates
are admitted by the capability map; naming PostgreSQL/Mongo/vector stores does not claim implementation.
Timing is calibrated from execution/review work, not LOC or i18n throughput; no unmeasured 12-16 week promise.

## Earlier port map (scopes reconciled through the transition above)

K1-F1 and ARCH-IMPORTS land before K2. Subsequent runtime cards follow the owner-admitted transition dependencies.

Port cards (responsibility map, decisions, invariants, proof) live outside the repo at
`/home/alperen/deckent-refactor-work/cards/<CARD>.md`; a row moves to `CARD` when its card is written.

| Card | Scope | Depends | Legacy→target lines | Lane | Milestone / proof | Status |
|---|---|---|---|---|---|---|
| K0 | skeleton, arch.json, lint-arch, eslint, build, CI, i18n kernel, CLI `--version` | — | →1.5k | Fable | `deckent --version` from dist | DONE |
| K1 | kernel: types/errors/constants, host/platform, config v2 (+ registered sections), output, principal/tenant | K0 | 13k→6k | Astra | `config get` / `migrate` / kernel `doctor`; 3 fixtures, 12/12 shared-value parity | DONE |
| EXECUTION-SURFACES-AUDIT | Source-backed execution capability map; no legacy aliases; independent Fable comparison and owner ontology checkpoint | K1-F1/A inventory | docs/proof | Astra + Fable analysis | report under deckent-refactor-work; source wiring distinct from runtime proof | REVIEW |
| K1-F1/B | Config fields SSOT → schema/default/env/metadata; no legacy alias/migrate/style; strict fields and platform-only global read | K1-F1/A + owner2026-09-17 | code/proof | Astra, Fable review | verify84+host9, real CLI + public API; parent K1-F1 remains open for remaining gates/provider policy | DONE |
| K1-F1/A | Historical grouped field inventory; alias/compatibility proposals withdrawn by owner; product code unchanged | K1 | docs/proof | Astra, Fable review | complete inventory + owner checkpoint; IFS first integration captured | DONE |
| K1-F1 | config schema-as-data: single field registry → derived zod/defaults/env/metadata; no legacy aliases; remove base/config-defaults; registry-fed literal lint | K1 | 0.6k→0.5k | Astra | new config contract and rejected unsupported inputs; new task/entry semantics reconciled; registry authority | DONE |
| K1-F1/C | Registry literal gate, output defaults, canonical provider shape, metadata | K1-F1/B | code/proof | Astra / Fable | REVIEW1323 PASS; parent K1-F1 accepted with REVIEW1316 | DONE |
| ARCH-IMPORTS | `#pkg/tier/unit` subpath-import aliases (package.json imports + tsconfig paths + lint import-style) | K1 | tooling | Fable (infra) + Astra (K1 conversion) | lint-arch import-style 0 violations | CARD |
| K2 | kernel/i18n: 3,374 approved legacy keys → 10 family JSONs per locale, `t()`, one locale resolver (calibration card 1) | K0 | 15.4k→0.3k + data | Astra | 13,496/13,496 catalog parity; CLI-format gap recorded | REVIEW |
| K3 | kernel/store: SQLite primitive, artifact schema/versioning, locks | K1 | 10k→1.5k | Astra | contract | TODO |
| K4 | kernel/docs-authority: markdown write gate + DECKENT/CLAUDE/AGENTS injection | K1 | →0.4k | Astra | contract | TODO |
| R1 | native: preserve ABI/security behavior, split C mechanisms to the accepted size bound (card revision required); TS loader ≤1.8k (TOCTOU snapshot kept); artifact v2; prebuild matrix linux x64/arm64 + darwin | K1 | 7.8k→1.6k | Astra | `doctor` native section; UNAVAILABLE path exit 0 | CARD |
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
| Z | not ported (DEFERRED unless a consumer is proven): core/catalog, notification-providers, operation-catalog, task-execution-admission, legacy win32 TS adapter, extensions, sdk; intelligence/training responsibilities are evaluated under LEARNING, not deferred as a capability | — | ~30k→0 | — | — | DEFERRED |

## Velocity (measured, updated per card)

| Card | Legacy lines consumed | New lines | Contract cases | Lane-hours | Review rounds | Parity defects |
|---|---|---|---|---|---|---|
| K0 | — | (see lint-arch summary) | 7 | — | — | — |
| K1 | not measured; card inventory ≈13k | repo total: 1,642 TS + 894 catalog lines | 57 K1/gate additions; 69 total | not timed (K2 is calibration 1) | round 1 REVISE; round 2 GO (Fable) | B1/B2 addressed; doctor scoped |
| K2 | 15,477 AST-read catalog lines | 105 TS mechanism + 7,678 physical family JSON lines | 15 new; 84 total | see K2-review.json; idle wait excluded | pending Fable | 0/13,496 catalog; 4 inherited CLI-format differences |

Calendar estimates require representative execution, review and rework measurements. Catalog/memory LOC rates
are not an execution-engine estimate; the 2026-09-17 transition supersedes the earlier LOC formula.

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
| B02 | One durable approval broker (CAS, expiry, relay, typed risk tier); every approval producer binds to it; decisions via one verified-identity application service (CLI/Desktop/API); Dashboard observes | kernel/core + surfaces/core | K3, S0 | APPROVAL-001, APPROVAL-SURFACE-UNIFICATION-001 | TODO |
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

## K2 calibration / review evidence

- Fable authority: `cards/K2-keys.json`, sha256 `5e4e5a0218b9c9a636404bd62e225f9f1bee38f7590d9fa701a7e74eb4a7b53e`.
  Exact keep 3,374 / exclude 607; all 46 manual-audit keys retained. The AST-read source inventory is
  15,477 lines in 14 files, including the memory-read re-export; 3,981 legacy entries.
- Runtime catalog: 3,819 keys (3,374 legacy + 444 existing K1 + `tui.switch_unavailable`), ten families
  per locale. Largest family file is 740 physical lines; mechanism is 105 physical lines (111 by the
  lint gate's split-newline accounting). No size exception or generated long union was introduced.
- Live oracle: 13,496 key/locale/parameter comparisons, zero mismatches. Portable CI fixtures contain
  frozen legacy oracle digests plus exact family key lists, without requiring the legacy checkout.
  All 23 dynamic legacy sites have typechecked explicit-table handoffs; current kernel callers already
  use literal keys. Other package callers migrate on their own cards; the legacy checkout was read-only.
- CLI surface comparison is **not byte-equal** for en/tr `--help` and `--version`: both binaries exit 0,
  but K0 has a limited command inventory and a different version banner. This existing contract gap
  is recorded for Fable/S0 disposition; catalog parity must not be presented as full CLI parity.
- Local verification: 84 tests, 0 lint violations, build and smoke pass. Renderer sandbox has no Node
  globals/built-ins in the translation unit. K2 awaits Fable review and the admitted K1-F1/ARCH-IMPORTS
  pre-landing dependencies; no K2 commit/push, and R1 has not started.
- Calibration has two active measurement intervals: the first stopped at `K2-wip.json` while awaiting
  authority; the resumed interval begins at the first port-script write. Waiting time between turns
  is excluded. Review time and final rate remain open until Fable's verdict.
- Evidence in `/home/alperen/deckent-refactor-work/proof/`: `K2-import.json`, `K2-parity.json`,
  `K2-dynamic-audit.json`, `K2-dynamic-port-tables.mts`, `K2-cli-parity.json`, `K2-verify.log`, `K2-review.json`.

K1-F1/C DONE (REVIEW1323): output default/metadata/strict projection removal + source-derived literal gate. K1-F1/B commit4842353.

C proof: working tree86 product+9 host; isolated commit candidate71 tests, lint/build/smoke pass.
Output standard comparison remains format semantics; defaults derive from config-fields. Parent review requested.

Owner path decision: unified `.deckent` product data root for both dev/dogfood and installed product;
logical path registry with configurable root, layout revision and shared inspection; platform-local surface
scratch is scoped/owned/retained, never canonical job state. No legacy data movement in this slice.
PATH-LAYOUT: FOUNDATION → CONTRACT → STORE/ISOLATION prerequisite before runtime/ERP writes; cover existing
BRAIN_HOME/.brain, .deck secret file, global directories and direct .deckent joins in one inventory; define
whether each is durable, secret, cache, runtime or workspace. Verify root relocation, containment and recovery.
B01/TENANT: unify tenant.ts local fallback with registry identity authority; tracked residual from REVIEW1323 N1.
K2 landing checklist: regenerate scripts/config-vocabulary.json from the final source layout BEFORE lint/build.
Host sizing heuristics remain ASSURANCE scope. `since` is historical introduction version, not current package version.

| FOUNDATION/A | Shared source/native/app budget: 1,500 hard cap, 800 design target; monotonic build timing | Fable PASS1340 | DONE |

| PATH-LAYOUT/A+B | Shared durable root/registry, read-only resolution and secret-reference boundary; scratch, config-root relocation and sandbox remain pending | Independent Fable PASS1349; isolated97 tests | DONE |

| FOUNDATION/B + PATH-INSPECTION | Exact candidate package mapping, CLI composition and shared path query | Fable PASS1357; isolated99 tests, build/smoke; proof/FOUNDATION-B-verification.json | DONE |

Residuals: restore host-test verification on HOST-SETUP landing; distinguish provider policy registry from clients in CONTRACT; replace relative manifest metadata import before FOUNDATION closure.

| PATH-LAYOUT/C | Fixed locator, validated layout config and immutable inspection snapshot | Fable PASS1358; isolated102 tests; proof/PATH-LAYOUT-C-verification.json | DONE |

Residual: once config is loaded, propagate its pinned layout to all operation/crash consumers; bootstrap environment resolution does not replace an active operation snapshot.

| CONTRACT/A | pure task graph admission and dependency readiness; no worker execution claimed | Independent Fable PASS 1365:2a96fe9cd2db; immutable candidate proof | DONE |
Residuals: direct-only blocked classification, sanitized schema issue paths, shared bounded domain primitives and readonly readiness input.

| CONTRACT/B | versioned attempt evidence and application transitions; no worker execution claimed | Independent Fable PASS 1366:e0b7a3ec4620; immutable candidate proof | DONE |
Residuals before real supervisor: represent signal termination; journal stale replay separately; share field-wise identity comparisons; test external cancellation without request.

| STORE/A | Attempt application, required authorization port, atomic SQLite snapshot/receipt and scoped replay/CAS | Fable PASS1375; isolated121 tests; proof/STORE-A-verification.json | DONE |
Residual STORE/B: typed contention/bounded busy policy, registered ledger path and guarded0600 IO, trusted principal/policy composition, worker/pool capacity and platform proof. Node24 built-in SQLite is experimental; no production capacity/durability guarantee inferred.

| CONTRACT/C | Shared wire identity, sanitized diagnostics, signal exits, stale evidence and direct-blocker semantics | Fable PASS1378; isolated119 plus STORE/A integration126 tests | DONE |

| FOUNDATION/C | Colocated public metadata projection, explicit generation and freshness check | Fable PASS1382; isolated115 verify; npm lint and build both invoke freshness tool | DONE |

| STORE/B | Required wait/journal/durability options, typed contention, separate-process lock proof | Fable PASS1389/1390; isolated129 verify | DONE |
Residuals: config/layout composition STORE/C, commit-time reader contention test, nonblocking worker and platform matrix.

| STORE/C | Configured registry ledger + shared SQLite option schema + trusted-host POSIX file preflight | Fable PASS1396; isolated133 verify | DONE |
Storage wait default100ms is the same configurable registry policy in development and installed Core; not an SLO or automatic retry budget. Windows ledger opening is UNSUPPORTED until an ACL backend is verified. Same-UID worker access to managed tree remains an ISOLATION invariant.

| STORE/D | Real reader transaction during DELETE/WAL commit | Fable PASS1397; isolated131 verify | DONE |
Forced WAL checkpoint and power-loss durability remain ASSURANCE/G-CAP gaps.

| SUPERVISOR/A | Real Docker adapter and application/SQLite terminal-evidence consumer | Fable PASS1398; isolated133 including4 real Docker tests, zero skipped | DONE |
Public ingress remains closed until durable dispatch fence and trusted workspace broker exist. Durable output artifacts, aggregate quotas, crash reconciliation and broader platform proof remain pending.

AUTH/A PASS: v2 command rejects caller identity; verified scope and authorization precede replay/store. Local OS verifier is direct-process only; remote policy and stable installation issuer remain gaps.

WORKSPACE/A PASS: private pinned Git checkout with copied objects and replay-safe lease. Real Git and Docker tests passed; layout binding, dispatch custody, history policy and allocation recovery remain gaps.

WORKSPACE/B PASS1415: shared managed-directory preflight and configured workspaces registry;149 tests including real Git→Docker isolation. Independent source-repository authorization and per-test container custody checks remain.

DISPATCH/A PASS1416: atomic one-time launch claim, unresolved custody retained, Next SQLite schema1→2 preserves attempt/receipt data.150 tests; downgrade unsupported. Signal result parity and unresolved inventory remain.

DISPATCH/B PASS1417: authenticate/authorize every execution/replay/release; durable claim→supervisor→terminal record; real Docker release then replay does not rerun.152 tests. Atomic Attempt projection and retained-artifact release gate remain pending.

DISPATCH/C PASS1419: read-only daemon observation and separately authorized reconciliation settle exited containers without relaunch.154 tests; active-worker recovery/cancel and concurrent finish enrichment remain pending.

DISPATCH/D PASS1422: engine/domain terminal projection and dispatch terminal persist atomically;155 tests including injected transaction rollback. Task acceptance and artifact durability remain separate.

DISPATCH/E PASS1428: shared exit cause and field-wise request equality;161 tests. Transport interruption is read from dispatch evidence, never inferred as a process signal.

DISPATCH/F PASS1429: execute/reconcile merges only compatible unknown→known interruption evidence;164 tests. Future metadata must preserve canonical outcome and have explicit merge tests.

ARTIFACT/A PASS1430: scoped content-addressed POSIX store and configured artifact layout;163 tests. Authenticated callers, retention/GC/encryption and production maxBytes config remain required.

ARTIFACT/B PASS1437: attempt-bound retained output is mandatory before container release;171 tests. Missing/partial/oversize output remains explicit operator work; no silent cleanup.

ARTIFACT/C PASS1438: bounded per-container local logs, explicit capture completeness and authorized partial recovery;172 tests. Blocking log backpressure and partial-history release policy remain open.

CANCEL/A PASS1439: durable cancellation actor/intent precedes actual Docker kill;174 tests. Created/start race and post-controller-crash watchdog remain open; cancellation request is not terminal proof.

RUNTIME-CONFIG/A PASS1442: shared runtime/artifact policy schemas and one-snapshot composition;176 tests. Execution defaults disabled. Source authorization, localized composition errors and output/artifact budget consistency remain before public ingress.

POLICY/A PASS1447: verified principal/scope/action/resource grant checks and deny-only restrictions;179 tests. Admission decision evidence, shared action catalog and measured cache policy remain pending.

INVENTORY/A PASS1448: bounded authenticated keyset inventory without argv/workspace data;181 tests. Moving ID order is not claim chronology; artifact completeness/owner liveness and public inspection budget remain pending.

POLICY/B DONE: pinned-layout, owner-checked fresh file policy; 184 tests/12 Docker; Fable1455 PASS. Before DOGFOOD resolve layout registry revision/upgrade compatibility; installation must separate administrative policy ownership where required.

INVENTORY/C DONE: inspect existing managed files without creation/permission repair; 183 tests/12 Docker; Fable1457 PASS. POSIX trusted-host preflight remains non-atomic with subsequent database opening.

INVENTORY-B DONE: Read-only SQLite inventory reader; exact rebase preserves policy exports;189 tests/12 Docker.

INVENTORY-D DONE: Configured local inventory query;191 tests/12 Docker; public binding awaits policy-derived membership in INVENTORY/F.

INVENTORY-E DONE: Readonly WAL missing-shm failure is typed, without immutable fallback;192 tests/12 Docker. Native corruption classification remains follow-up.

INVENTORY-F DONE: Inventory scope membership derives from trusted policy, not project config;195 tests/12 Docker. Future public execution must use equivalent trusted membership.

INVENTORY-G DONE: Shipped read-only CLI/SDK inventory parity;198 tests/12 Docker. Follow-ups: signal/code labels, narrow text layout, config locale/output-mode, catalog prefix lint.

RUN-A DONE: Pure revisioned Run graph/progress/attempt bindings;199 tests/12 Docker foundations. No durable store or acceptance closure claimed.

SCHEDULING-A DONE: Bounded deterministic wave planning with explicit policy ordering and execution/in-flight limits;206 tests/12 Docker. Planning alone never authorizes launch.

RUN-B DONE: Durable Run and atomic task/attempt reservation in SQLite schema3;211 tests/12 Docker including separate-process lock. Per-Run capacity only; shared pool still gates runtime launch.

RUN/C DONE: authoritative attempt-to-Run projection in one SQLite transaction;213 tests/12 Docker, Fable1488 PASS. Dispatch-to-Run projection remains explicit until automatic transactional wiring/reconciler is implemented.

POOL/A DONE: same-ledger shared pool admission across Runs/scopes;217 tests/12 Docker,Fable1492 PASS. Schema4 and Run policy2, explicit immutable pools, no invented legacy assignment. Raw dispatch binding guard and performance/assignment workflow remain pending.

RUN/D DONE: full Run binding/pool guard before fresh dispatch; terminal Attempt/Run/journal written atomically.221 tests/12 real Docker; Fable1498 PASS. Historical unbound dispatch reconciliation remains open.

RUN/E DONE: authenticated, current-policy-checked Run inspect/cancel service; durable CAS+receipt cancellation, no fabricated worker stop.225 tests/12 real Docker; Fable1499 PASS. Surface wiring, cancellation fanout and claim-start fence remain open.

RUN/F DONE: readonly configured SDK inspectRun, scope/run policy before ledger access, revision corruption checks and schema2 nonmigration.230 tests/12 Docker; Fable1504 PASS. Public RunView and shared sanitized error mapping precede CLI/MCP wiring.

POLICY/C DONE: versioned core action/resource vocabulary shared by authorization types, SDK and CLI.233 tests/12 Docker; Fable1512 PASS. Generated vocabulary projection and human formatting remain followups.

RUN/G DONE: explicit RunView v1 projection and one sanitized query mapper, no storage snapshot export.236 tests/12 Docker; Fable1513 PASS. Dedicated Run error registry entries pending.

RUN/H DONE: run inspect CLI shares SDK RunView and policy/ledger path;237 tests/12 Docker; Fable1514 PASS. Linux pipe parity proven; design-critic text refinements tracked, other platforms/live UI not claimed.

CANCEL/B DONE: atomic Run cancellation intent propagation to bound nonterminal Attempt/dispatch records, preserving finished evidence and prior actor.241 tests/12 Docker; Fable1516 PASS. Supervisor delivery and claim-start race remain open; large transaction latency unmeasured.

CANCEL/C DONE: bounded cancellation delivery through existing per-attempt authorization;243 tests/13 Docker; Fable1524 PASS. Redelivery uses same commandId; retry reason classification, automatic loop and claim-start fence remain open.

RUN/H-text DONE: Fable1514 design-critic N1–N6 closed by PASS1525; recorded cancellation language, generic resource denial, ASCII heading, inspect key namespace and EN/absent human proof.241 tests/12 Docker.

RUN/I DONE: authenticated create service with strict task-graph input, trusted clock/layout/policy and actor-bound replay;246 tests/13 Docker; Fable1526 PASS. Configured resolver and public pending-vs-launch semantics remain next wiring steps.

RUN/J DONE: configured local SDK admission with explicit pool-use authority, trusted layout/clock, declared input-order and dedicated Run errors.249 tests/13 Docker; Fable1529 PASS. Zero-capacity profile semantics and admission-triggered schema migration need followup; no launch implied.

MCP/A DONE — local stdio inspect_run / inspect_inventory / policy_vocabulary share configured SDK services; Fable PASS 1534, 251 tests including 13 real Docker. Remote auth and mutating tools remain pending. Follow-ups: explicit project selection, safe explanatory errors, dependency consolidation.

RUN/K DONE — SDK admission requires positive capacity and current ledger schema inside writer transaction; no implicit migration. PASS1547,253 tests/13 Docker. Follow-up: shared schema-version constant.

MCP/B DONE — real-process oversized input regression closes MCP/A transport proof gap. PASS1548,252 tests/13 Docker.

SUPERVISOR/C DONE — strict runtime result validation before dispatch effects; invalid evidence remains unresolved without relaunch. PASS1549,252 tests/13 Docker. Content size stays adapter bounded.

MCP/C DONE — --project selects bootstrap root from any cwd, invalid args redact errors. PASS1550,255 tests/13 Docker. Relative root remains cwd-dependent; absolute-path guidance follow-up.

SUPERVISOR/D DONE — internal versioned process transport and real Docker through control child. PASS1551,264 tests/14 Docker. No Go/configured selection/streaming claim; transport termination does not prove worker termination.

SUPERVISOR/E DONE — NUL options rejected, missing binary and invalid UTF8 redacted, live control abort verified. PASS1552,267 tests/14 Docker. Inherited-pipe deadline follow-up under SUPERVISOR/F.

SUPERVISOR/F DONE — stop closes local stdio after killing control PID; inherited pipe writers cannot extend deadline. PASS1563,268 tests/14 Docker. Descendant termination remains unproven, explicitly outside this fix.

SUPERVISOR/G DONE — single TS identity/options normalization and digest producer preserves existing bytes; golden Unicode cases plus old/new real Docker crossing. PASS1564,276 tests/14 Docker plus crossing proof. Not exported through product SDK.

SUPERVISOR/H DONE — injectable internal command runner, default Node execFile behavior preserved; typed redacted failures. PASS1568,279 tests/14 Docker plus injected crossing. Explicit env, byte output and group custody remain next comparison prerequisites.

SUPERVISOR/I DONE — opt-in Linux profile with explicit env/cwd, closed stdin, raw bounded output, started/reason evidence and process-group stop. PASS1576,285 tests/15 Docker. Production env registry selection, escaped-session custody and Go qualification remain open.

SUPERVISOR/J DONE — readiness-driven cancellation replaces startup/deadline race in inherited-pipe test; rejected promises consumed. PASS1577 closes1570,280 tests/14 Docker.

SUPERVISOR/K DONE — strict correlated process evidence, canonical base64 and pre-decode bounds; producer uses same validator. PASS1578,304 tests/15 Docker. Shared Go conformance vectors and signal-name vocabulary follow-up.

EVALUATION/A landed: versioned pure evaluation binding/classification, exact criteria and attempt revisions; no acceptance mutation. 315 tests / 15 real Docker; Fable PASS 1590. Artifact provenance and atomic acceptance follow.

EVALUATION/B: bounded scoped artifact content verification; 319 tests/15 Docker, Fable PASS1607. Attempt provenance follows C; no acceptance API.

EVALUATION/C: trusted dispatch record binds exact attempt/request/output receipt before artifact read; 322 tests/15 Docker, Fable PASS1602. Only retained output, no workspace artifact linkage yet.

EVALUATION/D: pure pass/fail/HOLD Run transitions; HOLD consumes revision, accepted Task cannot reopen. 327 tests/15 Docker, Fable PASS1603. Actual admission, immutable criteria and atomic acceptance remain pending.

STORE/E: shared writer/reader ledger version authority; schema4 unchanged, atomic migration rollback proof. 316 tests/15 Docker, Fable PASS1608.

SUPERVISOR/L landed after Fable PASS1616: atomic readiness publication closes empty-PID race1605; 328 tests/15 Docker and 5 repeated targeted cancellation suites. Production behavior unchanged.

RUN/L landed after Fable PASS1618: SDK requestRunCancellation uses current policy and existing versioned command, persists intent only. 331 tests/15 Docker; no worker delivery or termination claim. CLI text and shared composition context follow.

RUN/M landed after Fable PASS1633 + independent design critic ACCEPTABLE_FOR_PIPE_V1: CLI intent-only run cancel, shared SDK JSON, EN/TR real-binary captures and policy/revision negatives. 334 tests/15 Docker; no worker delivery. Next safe-action/help/replay capture refinements tracked in1633; configured delivery follows CANCEL/D.

RUN/N: shared config/OS identity/fresh policy/membership/deferred ledger path for Run surfaces; no behavior change. Fable PASS1637, 331 tests/15 Docker. Empty-membership error consistency remains a follow-up.

SUPERVISOR/M: bounded process-group termination observation, ENOENT-only absence; no runner changes. Fable PASS1638, 331 tests/15 Docker plus ten target repetitions. No OS reaping or escaped-session assurance.

MCP/D: explicit cancellation-intent tool with native write/idempotency annotations and common SDK authority; real stdio parity, fresh policy denial. Fable PASS1639, 334 tests/15 Docker. Worker delivery not invoked by this tool; no alias for renamed internal server factory.

CANCEL/D DONE — configured SDK cancellation delivery, fresh per-attempt cancel policy, bounded coordination; Fable 1642 PASS, 336 tests including 16 real Docker. Undispatched runtime-directory preflight refinement remains.

MCP/E DONE — explicit delivery tool through configured SDK; official MCP stdio to real Docker, 337 tests / 17 Docker; Fable 1645 PASS.

RUN/O DONE — shared context denies authenticated identities without scope membership before ledger/runtime access; Fable1664 PASS, 338 tests / 17 Docker.

CANCEL/E DONE — no runtime directory or Docker dependency for undispatched attempts; shared lazy dispatch initialization. Fable1667 PASS, 339 tests / 17 Docker.

RUN/P DONE — CLI cancel now performs configured delivery; SDK/CLI/MCP real worker parity, EN/TR stale/replay captures, Fable1671 PASS and ACCEPTABLE_FOR_PIPE_V1, 340 tests / 18 Docker. Partial-outcome summary and terminology refinements follow.

CANCEL/F DONE — names missing cancellation/execution profiles before intent or runtime directory creation; Fable1676 PASS, 342 tests / 18 Docker.

STORE/F DONE — trusted full-identity dispatch lookup shared with cancellation, six identity axes and corruption negatives; Fable1689 PASS, 345 tests / 18 Docker. Generic adapter port follow-up recorded.

RECONCILE/A DONE — configured SDK observes recorded workers and settles proven exits under original custody; fresh reconcile policy, no caller argv/path. Fable1697 PASS, 346 tests / 19 Docker. Port ownership follow-up and profile snapshot limitation tracked.

RUN/Q DONE — visible partial-delivery count, consistent TR task/attempt terms; unchanged JSON and command success. Fable1701 PASS + ACCEPTABLE_FOR_PIPE_V1, 348 tests / 19 Docker.

MCP/F DONE — reconcile_attempt through configured SDK, explicit non-destructive ledger mutation annotation, strict identity and fresh policy; Fable1705 PASS, 349 tests / 20 Docker. Model tool-selection hint follow-up noted.

GRAPH2/A DONE — versioned criterion definitions and bounded immutable JSON parameters; Fable1709 PASS, 353 tests / 20 Docker. Runtime graph admission pending; description bounds and definition fingerprints precede persistence. Proxy traps are outside plain-JSON input guarantee.

GRAPH2/B DONE: Fable 1713 PASS; graph v2 carries versioned criterion definitions and exact references. v1 remains distinct; runtime admission wiring pending.

STORE/G DONE: Fable 1716 PASS; Run-bound dispatch lookup and identity authorization are engine-owned ports. Runtime and wire semantics unchanged; 356 tests passed.

CUSTODY-A DONE: Fable 1723:0562c1bb8227 PASS. Versioned adapter-owned profile capture/restore; point-in-time host and daemon origin checks; persistence wiring remains pending. Owner 1727 single-current-schema correction follows in GRAPH2/D and CUSTODY/C.

GRAPH2-C DONE: Fable 1724:fdc8003b5022 PASS. Bounded descriptions and complete versioned criterion encoding with golden vectors; description changes require a new definition version. Owner 1727 single-current-schema correction follows in GRAPH2/D and CUSTODY/C.

CUSTODY-B DONE: Fable 1725:5dcf4ffbed2a PASS. Profile-bearing dispatch contract separates prevention from observed process exit; atomic grant and durable delivery remain pending. Owner 1727 single-current-schema correction follows in GRAPH2/D and CUSTODY/C.

GRAPH2/D DONE — single current graph schema 2, typed criterion references and language-neutral golden fixtures. Fable PASS 1735; 363 tests including 21 Docker tests.

CUSTODY/C + LAUNCH/A foundation DONE — canonical dispatch schema 2 and ledger 5, required adapter validation, transactional single-use grant and cancellation prevention. Fable PASS 1737; 376 tests /21 Docker. LAUNCH/B must move pure launch decisions into engine; durable delivery remains open.

LAUNCH/B DONE — Real SQLite/Docker cancellation barriers; 379 tests/24 Docker. Behavior PASS1742; layer prerequisite PASS1754, applied in following L1 commit.

CANCEL/G1 DONE — Recorded-profile cancellation/reconciliation survives execution configuration change/removal; 379 tests/24 Docker; Fable PASS1748.

CANCEL/G2 DONE — Docker endpoint bound in adapter profile2; ledger6 forward validation and strict migration gate; 381 tests/24 Docker; Fable PASS1751. Cross-host rebind/backup relocation remain unsupported; no automatic reset.

LAUNCH/L1 DONE — Pure engine launch decision; SQLite transactional persistence; injected clock; 390 tests/24 Docker; Fable PASS1754. N3 and durable retry tracked separately.

LAUNCH/N3 DONE — all three cancellation entry paths persist actor and Attempt intent atomically; real controller exit after grant remains unresolved without relaunch. Fable PASS1757;397 tests/26 Docker. Cancellation attribution rule extraction is a follow-up note.

CANCEL/G3 DONE — durable cancellation journal, bounded retries and token CAS;407 tests/26 Docker, Fable PASS1759. M1 prerequisite OPEN: configured bounded runtime loop must drive queued deliveries through this journal; current command replay is not autonomous delivery.

EXEC-EVIDENCE PASS (Fable 1762): six-case Docker evidence matrix verified; 409 tests, 28 real Docker. Automatic cancellation runtime loop remains an M1 prerequisite; second daemon and physical power loss not qualified.

REGISTRY/A + GRAPH2/E admission DONE: Fable1768 PASS,438 tests/28 Docker. Run schema2 pins selected profiles/evaluators and criterion fingerprints; ledger8 refuses unsupported data without invention. Actual selected-profile execution and evaluation runtime remain open.

EVAL/E-OUTPUT DONE: Fable1773 PASS,446 tests/28 Docker. Canonical output envelope checked after bounded content integrity, exact Attempt identity and completeness required.

EVAL/E-STORE DONE: Fable1775 PASS,461 tests/28 Docker. Pure custody/revision decision and atomic Run CAS+receipt reuse existing ledger. Authenticated evaluator application is separately under review.

EVAL/E-APPLICATION DONE: Fable1779 PASS,472 tests/28 Docker. Authenticated evaluation derives verdict from pinned criteria after output proof, rechecks policy before atomic acceptance. Actual Docker/surface wiring is separately under review.

- EXECUTION/SELECTED PASS 1783: pinned profile → recorded Git base → Docker → artifact → evaluator proved; 488 tests. Per-attempt base and new-path race evidence remain M1 follow-ups.

- TASK/SURFACES PASS1787: typed SDK/MCP execution/evaluation and EN/TR errors; 496 tests with actual Docker. Public reservation residual tracked separately in requests1785/1786; CLI and autonomous cancellation remain open.

- RUN/RESERVATION PASS1791: persisted policy, generated identities, authorized replay and atomic reservation; 511 tests. Pool authorization extraction L1 follow-up; file-policy timing limits remain explicit.

- RESERVATION/SURFACES PASS1794: SDK/MCP public create→reserve→execute→evaluate, 511 tests. Public-producer residual closed at SDK/MCP scope; Run-scoped Attempt policy selectors remain follow-up; M1/DOGFOOD still open.

- CLI/WORKFLOW functional PASS1798: real compiled CLI create→reserve→execute→evaluate, configurable bounded graph input, 533 tests. CLI/TEXT C1–C6 mandatory before M1; terminology/help/actionable failures/exit evidence remain open.

CANCEL/RECOVERY PASS1804: bounded durable discovery and shared delivery application landed. Runtime hosting and typed failure observability remain follow-up; no M1 claim.

POOL/AUTHORITY PASS1809: reservation pool authorization belongs to engine. Admission pool reuse remains follow-up.

RECOVERY/COMPOSITION PASS1814: shared recorded-profile factory and bounded SDK recovery landed. Service hosting/provisioning remain open; no M1 claim.

RECOVERY/PROCESS PASS1819: actual controller SIGKILL followed by fresh-process recorded-profile recovery verified. Continuous service remains next.

CLI/TEXT PASS1834: fix(cli): clarify localized task lifecycle and usage.

RUN/CUSTODY PASS1834: feat(workspace): persist immutable Run source custody.

GIT/CUSTODY PASS1834: feat(git): validate recorded workspace source and base.

RUN/BASE PASS1834: feat(workspace): share one immutable Git base across a Run.

RUNTIME/HOST PASS1834: feat(runtime): host bounded cancellation recovery loop. Required distinct config description key R1 follows separately.

ADMISSION/POOL PASS1834: refactor(admission): enforce pool authorization in engine.

SERVICE/PROTOCOL PASS1834: feat(runtime): define strict correlated service protocol.

SERVICE-CORE PASS1839:452692b22bdc: feat(runtime): host authenticated local service and client. Shutdown finalization correction follows reviewed SERVICE/SHUTDOWN; no DOGFOOD claim.

SERVICE-SURFACES PASS1840:28d1476c3aa7: feat(surfaces): connect CLI and MCP to shared runtime service. Shutdown finalization correction follows reviewed SERVICE/SHUTDOWN; no DOGFOOD claim.

CLI-POLISH-revised PASS1853: fix(cli): complete localized help and actionable diagnostics. New output-recovery capacity investigation1852 remains open; no M1 closure claim.

EXEC-EVIDENCE-OFFLINE-rebased PASS1853: test(recovery): prove explicit reconciliation after offline worker exit. New output-recovery capacity investigation1852 remains open; no M1 closure claim.

SERVICE-SHUTDOWN-rebased PASS1853: fix(runtime): include socket finalization in shutdown grace. New output-recovery capacity investigation1852 remains open; no M1 closure claim.

RUNTIME-DESCRIPTION-rebased PASS1853: fix(config): describe automatic cancellation recovery accurately. New output-recovery capacity investigation1852 remains open; no M1 closure claim.

JOURNAL-FINALIZATION-REVIEW2 DONE — Fable1878 unconditional PASS; combined chain668 tests. Reservation1852 remains open; reconciliation R1 separate.

OUTPUT-RECOVERY-REVIEW2 DONE — Fable1878 unconditional PASS; combined chain668 tests. Reservation1852 remains open; reconciliation R1 separate.

RECONCILIATION-PAGE-REVIEW2: DONE — Fable1878/1895 PASS; exact reviewed candidate landed. Cancellation fairness F1 and reservation1852 root cause remain separate open work.

RECONCILIATION-LOOP-REVIEW2: DONE — Fable1878/1895 PASS; exact reviewed candidate landed. Cancellation fairness F1 and reservation1852 root cause remain separate open work.

RECONCILIATION-COMPOSITION-REVIEW2: DONE — Fable1878/1895 PASS; exact reviewed candidate landed. Cancellation fairness F1 and reservation1852 root cause remain separate open work.

RECONCILIATION-SERVICE-REVIEW2: DONE — Fable1878/1895 PASS; exact reviewed candidate landed. Cancellation fairness F1 and reservation1852 root cause remain separate open work.

RECONCILIATION-R1: DONE — Fable1878/1895 PASS; exact reviewed candidate landed. Cancellation fairness F1 and reservation1852 root cause remain separate open work.

RESERVATION-DIAGNOSTIC: DONE — Fable1878/1895 PASS; exact reviewed candidate landed. Cancellation fairness F1 and reservation1852 root cause remain separate open work.

WORKSPACE-VERSION-CONFLICT: DONE — Fable1902 PASS; adapter version stays pinned, bounded reason at shared error mapping; protocol params and localized detail remain follow-up.

RESERVATION-CLOCK-CONDITION: DONE — Fable1915 PASS; controlled SQLite time condition proven; historical1852 cause remains open. Independent test-only slice does not depend on pending cancellation F1 behavior.

RESERVATION-READABLE-DIAGNOSTIC DONE — Fable PASS 1919; EN/TR bounded detail, incomplete params retain generic text. Service protocol params and measured delay remain open.

CANCELLATION-PAGE-FAIRNESS DONE — Fable PASS 1921; unavailable records no longer starve later pages. Transport backoff remains. SQLite companion race remains separate.

CONFIG-LOCK-GENERATION DONE — Fable PASS1927; generation replacement yields contention before file-type rejection; exact historical1907 cause unproven.

MANAGED-COMPANION-UNLINK DONE — Fable PASS 1933:c2794c4444dd; exact reviewed candidate landed; historical failures remain separately qualified.

RESERVATION-ELIGIBILITY-GAP DONE — Fable PASS 1934:060bceb9e229; exact reviewed candidate landed; historical failures remain separately qualified.

| AUTH/A | Mandatory verifier + scope/authorization before store/replay, actor-bound receipt, v2 command without client principalId; direct-local OS verifier | Isolated142 tests including4 real Docker; proof/AUTH-A-verification.json | REVIEW |

| WORKSPACE/A | Git-backed per-attempt private checkout, pinned commit, no shared hardlinks/alternates, protected lease replay | Isolated146 tests incl4 real Git +4 real Docker; proof/WORKSPACE-A-verification.json | REVIEW |

| ARCH-GATES/E1 | Exact declared unit dependencies, resolved-symbol cycle and composition decision-import gates, canonical vocabulary, 2000-line unit budget | Candidate verification and independent review pending | REVIEW |

2026-09-19 ARCH-GATES/E1 DONE — Fable1954 PASS; exact reviewed candidate landed. Unit dependency/cycle/PLAN reference and composition decision gates enforced; unit budget 2000 and vocabulary enforced.

2026-09-19 LOCAL-PEER-TRANSPORT/P1 DONE — Fable1955 PASS; Linux peer lifecycle, native fatal handling and pinned endpoint cleanup. F-P1a bounded transient accept-pressure handling remains mandatory before P4; P2/P3 and final surface acceptance remain open.

| Slice | Responsibility | Evidence | Status |
|---|---|---|---|
| SERVICE-SHUTDOWN/P2A | Instance-bound shutdown command, fresh service-specific authorization, canonical admission/audit and one-shot outcome store; no transport stop until P2B | Deny/revocation, instance/actor/replay conflicts, audit-failure rejection, SQLite v9→10 conformance; independent review | REVIEW |

2026-09-19 SERVICE-SHUTDOWN/P2A DONE — Fable1961 PASS; instance-bound command, fresh service policy, SQLite ledger10 canonical admission/audit and one-shot outcome. Full verify730 product/16native/18host; transport delivery remains P2B. Remote signed identity and per-replay attempt audit are explicit later assurance work.

| Slice | Responsibility | Evidence | Status |
|---|---|---|---|
| SERVICE-SHUTDOWN/P2B | Wire2 descriptor and exact instance-fenced shutdown via actual OS peer, fresh policy, durable admission, once-only post-response handoff and persisted outcome; shared SDK/CLI/MCP | Real socket deny/audit-failure/restart/grace/outcome failure and surface parity | REVIEW |
| LOCAL-PEER-TRANSPORT/P1a | Bounded accept resource-pressure pause/retry with poll/timer cleanup | Fable1955 followup; native failure/recovery proof before P4 | REVIEW |

2026-09-19 SERVICE-SHUTDOWN/P2B + LOCAL-PEER-TRANSPORT/P1a DONE — Fable1965 PASS; actual kernel-peer admission and durable shutdown outcome through CLI/MCP/SDK, wire2, configurable bounded native accept retries. Full verify751 product/24native/18host; real fd-pressure and P4 worker-preservation/final repeated acceptance remain open.

| REAL-INIT/P3A | Supplied versioned installation profile integrity, real OS identity/policy checks, read-only SDK and CLI preview; heterogeneous pinned task profiles and shared pool budgets | No writes, no credential/config echo, separate shutdown consent, exact paths and explicit unverified package/image blockers | REVIEW |

2026-09-19 REAL-INIT/P3A DONE — Fable1971 PASS; supplied profile integrity and normalized plan identity, actual OS-bound narrow policy checks, independent shutdown choice, immutable complete CLI/SDK preview. Full verify775 product/24native/18host. Package/image trust and availability remain unverified; no apply/readiness/builtin release profile claim. P3B journal/materialization and P4 acceptance remain open.

| REAL-INIT/P3B-GATE | Fixed installation journal resource, private checksum-checked journal observer, generation fence before config cache and after fresh/cache reads | Pending/unsafe/corrupt/change hold; global-only independent; no installer producer/apply/readiness claim | REVIEW |

| REAL-INIT/P3C-EVIDENCE | Read-only installed distribution measurement and exact local Docker image observations; shared CLI/SDK proposal identity | Explicit measurement coverage, no publisher/approval/readiness claim, no project writes | REVIEW |

2026-09-19 TOOL/EXIT, REAL-INIT/P3B-GATE and REAL-INIT/P3C-EVIDENCE DONE — Fable1983 PASS. Separate exact commits; combined isolated verify814 product/24native/18host. Journal admission gate and CLI/SDK evidence proposal delivered; no apply, recorded consent, publisher authenticity or ready claim. P3D durable writer and P3E publication remain open.

| REAL-INIT/P3D-JOURNAL | Single current journal v2 with bounded embedded recovery material; durable generation-checked owning adapter under shared config writer lock | Real filesystem CAS/concurrency/escaped calls/cached config gate and compiled producer SIGKILL; no installer apply/readiness | REVIEW |

2026-09-19 REAL-INIT/P3D-JOURNAL DONE — Fable1988 PASS; journal2 complete recovery envelope and durable owning writer, shared config lock and drained IO; mandatory compiled producer SIGKILL proof; isolated828 product/24native/18host. D-CUSTODY remains strict no-group/other-write until direct owner decision; symlink project aliases unsupported. Actual apply and readiness remain P3E/P4 work.

| REAL-INIT/P3E-PUBLICATION | Custom-proposal explicit apply/resume; retained authored and normalized material; fresh no-replace files; atomic SQLite11 ownership+pool; shared CLI/SDK application | Real local-image/pinned-package installer, moved data root, foreign resources, pending permission-fault recovery without source profile | REVIEW |

2026-09-19 REAL-INIT/P3E-PUBLICATION DONE — Fable1992 PASS; explicit custom proposal consent, journal-before-effects no-replace publication, owned SQLite v11 ledger, CLI/SDK apply and profile-independent resume; isolated 860 product/24 native/18 host. Installation persistence proven; runtime-ready and P4 cross-surface execution remain open. Strict custody retained; slow-disk lock timing and separate upgrade path remain follow-up.

2026-09-19 RUNTIME/P4 REVIEW preparation — installed service SDK/CLI/MCP Git/Docker acceptance; installed offline output recovery and durable cancellation restart; concurrent installer bounded hold and explicit replay/conflict. Preserve 2000ms lock limit, expose INSTALLATION_JOURNAL_BUSY distinctly. Final exact candidate requires three consecutive full verify runs. Linux-only actual runtime; coherent backup/restore and publisher-verified default remain unsupported, not inferred from migration or installer recovery.

2026-09-19 RUNTIME/P4 gate correction — third R5 full verify exposed existing config healing pruning its own returned backup. Retain the exact new receipt plus at most two eligible prior regular backups; preserve foreign/symlink entries. Clock-regression and protected-path tests close the defect; no global clock or backup/restore claim.

2026-09-19 RUNTIME/P4 DONE — Fable2001 PASS; same exact R6 candidate three consecutive full verifies and independent fourth868 product/24native/18host. Actual installed SDK/CLI/MCP→Git/Docker acceptance, offline output/cancel restart, two-process installer replay/conflict. Typed journal contention and preserved config backup receipt. Linux/custom-profile boundary only; no Brain/provider/backup/HA/dogfood claim.

| PROVIDERS/A0 | Declared native provider/model/protocol catalog; generic pre-resolution secret policy; shared readonly SDK/CLI/MCP inspection | Real config layers, forbidden-secret resolver0, typed schema/bounds and compiled surface parity; no activation/network or readiness | WIP |

2026-09-19 PROVIDERS/A0 writer admission — same catalog semantic authority validates config before durable writes through generic validateValue; environment-dependent validators remain in loadConfig. Deterministic duplicate-write red retained; rejection preserves prior bytes and creates no lock/temp/backup.

2026-09-19 PROVIDERS/A0 DONE — Fable2008 PASS exact34files. Root and independent897product/24native/18host; declared native catalog SDK/CLI/MCP, pre-resolution secret guard and semantic writer admission. Independent first run exposed unrelated reservation delayed observation retained in review; no clock-cause claim. No activation/network/readiness.

| PROVIDERS/A1 | P5; A0 PASS | Exact native model semantic binding, domain encoding + engine SHA256 + SDK/CLI/MCP read-only inspection; no activation/store/invocation | WIP |

| STORE/LEDGER-OWNER | P5 shared storage prerequisite | Separate physical SQLite connection/migration owner; schema11 and paths unchanged, no activation authority or alias | WIP |

2026-09-19 PROVIDERS/A1 DONE — Fable2018 PASS exact21files; root and independent914product/24native/18host. Exact native semantic binding across SDK/CLI/MCP, no activation authority. A1-a validation placeholder and A1-b bounded repeated parsing remain nonblocking follow-ups.

2026-09-19 STORE/LEDGER-OWNER DONE — Fable2022 PASS exact28files; root and independent915product/24native/18host. Single schema/options/open owner with lazy native import, unchanged schema11/paths and specialized installer/readonly behavior. Activation remains separate adapter/card.

RESERVATION/IMMEDIATE WIP — Explicit immediate/not-before eligibility; Run snapshot3, scheduling2, receipt-proven forward ledger12 migration; Fable2016 designGO K1–K5. No clock clamp or TTL change.

2026-09-19 RESERVATION/IMMEDIATE DONE — Fable2028 PASS exact38files; root and independent949product/24native/18host. Run snapshot3/scheduling2, explicit eligibility, evidence-proven ledger12 forward migration, readonly minimum12, EN/TR delay gap. K3 wall-clock inventory remains open for unrelated TTL/retry/lock behavior.

| PROVIDERS/A2A | P5; A1+STORE+IMMEDIATE prerequisites | Scoped activation domain/application, separate SQLite adapter and atomic audit; ledger13, no invocation or surface mutation yet | REVIEW |

2026-09-19 PROVIDERS/A2A DONE — Fable2032 PASS exact41files, root and independent975product/24native/18host. Scoped activation CAS, fresh authorization and immutable historical replay, catalog-independent revocation, shared ledger13 atomic state+receipt. No public activation or invocation claim in this slice.

| PROVIDERS/A2B | P5; A2A | Scoped readonly activation and shared SDK/CLI/MCP; no invocation | REVIEW |

2026-09-20 PROVIDERS/A2B DONE — Fable2036 PASS exact52files, root and independent986product/24native/18host. Shared scoped activation across compiled SDK/CLI/MCP, readonly reader, neutral request context; current policy before store and historical replay without resurrection. Availability and invocation remain unobserved.

| AUTH/NATIVE-CONFIG | P5; A2B | API metadata/config reads no longer require an unrelated provider credential; no invocation authority | REVIEW |

2026-09-20 AUTH/NATIVE-CONFIG DONE — Fable2042 PASS exact9files, root and independent986product/24native/18host. Known defect removed: API-mode metadata and activation required an unrelated vendor credential. Generic cache revalidation, secret handling, policy and activation remain; native invocation requires its separate selected-profile/credential/budget admission, not a global config gate.

| PROVIDERS/A3A | P5; A2+AUTH | Standalone invocation contract/application and scoped atomic call-count/in-flight claim; shared ledger14; native transport is A3B | REVIEW |

PROVIDERS/A3A DONE — exact R6 independently reviewed; immutable invocation contracts/application and one canonical SQLite14 record with scoped unique command identity, durable call/in-flight bounds, conservative unknown custody. Full1007/191+24native+18host; two actual processes samecommand yield one fresh claim/one replay. Native transport and public invocation surfaces remain A3B/C; no provider/Brain/dogfood claim.

| PROVIDERS/A3B | P5; A3A | Explicit profiles, current invocation policy and adapter-owned native text HTTP; canonical loopback/no credentials; owned fixture only | REVIEW |

| PROVIDERS/A3C | P5; A3B | Shared SDK/CLI/MCP native invocation and bounded file/stdin CLI JSON; owned HTTP fixture proof; no real provider or Brain acceptance | REVIEW |

PROVIDERS/A3B DONE — exact R8 reviewed: adapter-owned nonstream text HTTP, explicit scoped profile, current policy/composition and distinct immutable allocation conflict. Full1019/194+24native+18host. Canonical numeric loopback with per-request no-proxy transport; owned fixture only. Shared invocation surfaces follow A3C; runtime ownership remains A4. No real provider, credential, monetary or dogfood claim.

PROVIDERS/A3C DONE — exact R9 Fable2064 PASS with mandatory C-a before real provider admission: full-result preclaim fit, permanent MCP overflow/recovery tests, and clear SDK/CLI recovery guidance. Full1027/197+24native+18host; owned fixture only. A3D corrective delivery card closes C-a; A4 runtime ownership remains planned.

| BIN/ENTRY | Installed executable correction; shared host entry identity | Compiled CLI/MCP symlink startup and side-effect-free import, exact source proof | REVIEW |

BIN/ENTRY DONE — Fable2073 PASS; shared main-module detection fixes installed symlink CLI/MCP startup. Exact R1 source, four real process regressions; Linux Node24.15 proof, older-node fallback branch only.

PROVIDERS/A3D REVIEW — preclaim complete-result capacity from final admission and adapter-owned bound, BigInt arithmetic and exact historical/concurrent replay; MCP-only recovery guidance. Corrects C-a delivery defect; no runtime ownership or paid-provider readiness claim.

PROVIDERS/A3D DONE — Fable2075 PASS closes C-a: full-result fit before claim/send, permanent compiled MCP regression and explicit recovery guidance. Full1038/198+24native+18host; no real provider or runtime ownership claim. Rejected-response evidence remains B-b; A4 separate.

PROVIDERS/A4A REVIEW — shared local peer identity before scoped policy/model invocation and strict engine-owned command/query result correlation. Native runtime wire/client/server integration and disconnect proof follow A4B; not yet implemented.

PROVIDERS/A4A DONE — Fable2080 PASS: verified same-UID native peer before policy/config/store, shared scoped invocation, strict command/query receipt correlation. Full1045/199+24native+18host. Public service wiring is A4B; replay metadata is advisory, multi-user identity remains unsupported.
