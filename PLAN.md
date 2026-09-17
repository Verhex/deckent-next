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
