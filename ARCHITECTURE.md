# Architecture

Ortak ürün/geliştirme ölçütü: [.deckent/docs/core-memory/project_product_north_star.md](.deckent/docs/core-memory/project_product_north_star.md).
Owner 2026-09-21: dar dilimler ürün hedefini küçültmez; mevcut kararlar yeni kanıt olmadan yeniden açılmaz.

## Northstar — owner 2026-09-17

Deckent, kullanıcının niyetini güvenli, paralel ve doğrulanmış işe dönüştüren müşteri-kurulumlu Agent OS ürünüdür.
- **Ürün:** basit sohbetten solo/team/on-prem/air-gapped kullanıma; güvenli Core, ayrı proprietary Enterprise.
- **İş:** Task iş, Run yürütme, Mission opsiyonel hedef koordinasyonu; tek uygulama ve durum otoritesi.
- **AI:** provider-native message/tool/stream/usage/effort yetenekleri sürümlü adapter sözleşmeleriyle korunur;
  desteklenmeyen özellik açık sonuç verir. Sabit model/fiyat/efor eşlemesi ve sessiz semantik kayıp yok.
- **MultiX:** kaynak, bağımlılık, etki çatışması ve provider kapasitesiyle sınırlı paralellik; iptal/backpressure/uzlaştırma.
- **Yüzey:** SDK, MCP ve CLI aynı tipli komut/sorgu/olayları sunar; aynı kimlik, hata, onay ve sonuç anlamı.
- **Mimari:** modüler paketler, açık katman/port ve sürüm sınırları; değişebilir politika registry/config verisi.
  TypeScript korunur; Go yalnız ölçülmüş sınır kazancıyla. Legacy alias/uyumluluk yükü yok.
- **Kanıt:** iş kabul oranı, uçtan uca ve kuyruk p95/p99, throughput/aktif paralellik, provider TTFT/token/usage/maliyet,
  retry/iptal/kurtarma, izolasyon ihlali ve belirsiz/çift etki izlenir. Her ölçüm workload/sürüm/ortam taşır;
  tahmin ve gerçek kullanım ayrılır, eksik ölçüm sıfır sayılmaz; hassas içerik veya sınırsız kimlik metric etiketi olmaz.
- **Teslim:** Brain kabul, Auditor bağımsız denetim, Nervous gözlem/öneri; öğrenme kanıt/eval/geri dönüşle ilerler.
  Her küçük dilim gerçek yüzey kanıtı ve Türkçe owner raporuyla kapanır; hedef enterprise-grade ürün.


Owner 2026-09-17: first workspace implementation is Git-backed worktree/path allocation; non-Git
workspace adapters remain an extension boundary. Worktree separation is never the sandbox security proof.
Host refactor kit lives in `.agents/` and is development tooling, not a runtime or Enterprise module.

The package and gate sections below describe the current implementation. The 2026-09-17 owner amendment
records the accepted target and its transition work in PLAN.md. Target decisions are not implemented gates:
arch.json and the current source layout change together in that work. Existing WIP and proof are preserved.
scripts/lint-arch.mjs enforces the current machine rules; historical decisions remain in the log.
No baseline or silent exception is introduced; rule changes remain explicit and versioned.

## Owner decision — 2026-09-22: Mission target accepted, implementation pending

The 2026-09-21 O4 reopening is superseded by the accepted Mission → Run → Task → Attempt
coordination model after APPROVAL and POLICY-EFFECT-VERDICT prerequisites. Mission owns bounded
rounds with mandatory maxRounds and an invocation checkpoint per (mission, round, purpose);
it calls existing Run applications rather than writing their state or introducing another scheduler.
Backlog/reactive inputs are versioned Mission sources; periodic autonomous execution follows DOGFOOD.
The Mission implementation and vocabulary gate update remain pending. This decision neither restores
the mandatory legacy seven-level hierarchy nor decides additional Goal/Flow/Operation aggregates.

## Owner amendment — 2026-09-17 (accepted target, implementation pending)

Authority: Alperen's live acceptance of the consolidated Fable/Astra review, with database, sandbox/worktree,
module/version and conditional Go clarifications. This amendment supersedes conflicting target language below;
historical proof and current gates retain their measured scope. PLAN.md tracks the transition, not completion.

### Product, packages and dependencies

- Customer-installed product: personal computer, team server, on-prem, customer-hosted remote and air-gapped.
  No vendor-operated SaaS tenancy requirement. Core carries principal/scope/resource/policy context end to end;
  The accepted scope chain is installation > company > optional site/unit > project > session;
  installation is the hosting/trust boundary, company isolation is enforced in scoped data decisions,
  not a separate filesystem root. Default is one company. Enterprise maps customer identity,
  RBAC/RLS and governance into these contracts. Company-aware Core policy precedes M2; IdP/SIEM
  adapters belong to M4. Current tenant-named config/identity fields await a separate code migration.
- Development is in deckent-next. Public deckent receives only the completed Core distribution. Proprietary
  Enterprise sources/packages remain separately controlled from their first implementation, consume public Core
  APIs and are excluded from public source, history and package artifacts. Core installs without Enterprise.
- Target responsibility layers: platform, domain, capabilities, engine, adapters, surfaces. Domain is pure:
  it can depend on pure contracts/types, never config/filesystem/database drivers. Engine owns application
  transitions and ports; adapters implement ports. An explicit composition root imports and wires adapters.
  Existing kernel/providers/runtime/orchestration packages migrate only after a reviewed mapping and stable WIP.
- Tiers (core/base/enterprise/custom/user) describe distribution and extension; they do not grant authority.
  Security policy can narrow permissions; a user override cannot relax a mandatory organization deny.
- Every transition has one owner. Existing shared legacy services are port inputs, not presumed absent.
  Brain plans/evaluates/accepts; deterministic scheduling dispatches eligible work; independent Auditor checks;
  Nervous observes and requests bounded recovery. They do not become competing state writers.
- Legacy Goal/Mission/Flow/Run/WorkItem/Attempt/Operation names are evidence for responsibility analysis,
  not identities to migrate or alias. Define new task-centered contracts; do not impose the old hierarchy.
  An agent persona does not grant privileges. Learning is required product scope, not a deferred legacy folder.
- TypeScript Core is retained. Go may own measured execution responsibilities through a versioned supervisor
  port when total complexity/resource/reliability evidence justifies it. No duplicate scheduler, approval or
  acceptance authority, and no automatic full-Go rewrite. Application daemon and supervisor are distinct roles.
- Accepted size policy: 1,500 lines maximum per file including native C; 800 is a design target, not a second
  hard ceiling. FOUNDATION/A applies this limit coherently in ESLint and the source/native/app gate.
  No silent native exemption. Variable product policies/catalogs are data; protocol constants and safety
  invariants are explicit versioned code contracts. Unit cohesion matters beyond the accepted 2,000-line unit budget.

### Task-centered execution — owner checkpoint 2026-09-17

- Owner 2026-09-21: new Run admission atomically records automatic progression intent; no separate
  start command. The running common runtime discovers actor-matched intents, rechecks current
  operation policy and resumes eligible work. Migration never silently activates old admissions.
  Ledger25 records evaluation observation in the same transaction as its receipt, distinguishing
  never-evaluated output from an evaluated unknown. Unknown is not automatically re-evaluated.
  Current local driver refills same-Run capacity after verified acceptance within a configured automatic-turn
  reservation budget. At the budget boundary it drains existing custody and rotates paged Run intents.
  This is nonpreemptive allocation-turn fairness, not a time guarantee; slow tails, restart fairness and fleet scale remain open.


- Task represents the work. `run` executes a directives-defined workload; `do` admits natural-language,
  AI-produced or structured work; `autonomous` periodically performs/monitors admitted tasks and processes.
  Mission coordinates goal-bounded cycles of run/do/autonomous, sequentially or in parallel.
  These entry/coordination semantics do not authorize separate schedulers, policy engines or state writers.
  Task/coordination identities require a new contract; no legacy identity migration or compatibility aliases.
- Task kind describes the work domain, independently of execution entry, scheduling and permission.
  Owner examples: code, routine, daily and purchase. Exact canonical IDs remain a contract decision.
  Use versioned modular definitions/profiles for personal/team/Enterprise use; future purchase refinements
  (internal/external, etc.) can extend the domain without multiplying execution engines. A daily preset
  may propose a schedule; the actual schedule is explicit and separately validated. Kind grants no authority.
- Owner 2026-09-22: `do` is intent → versioned, receipted RunProposal → deterministic task-graph
  compilation → scope/cost/effect gates → existing Run admission, with approval when required.
  It depends on command/effect-policy contracts, not Mission; planning invocation spends are budgeted.
  Mission AI author remains a separate extension of deterministic Mission rounds and checkpoints.
- Owner 2026-09-22: process work uses a versioned business-operation catalog and task kind through
  existing Run/Task/Attempt and tool invocation claim/settle/unknown recovery; no third engine.
  Mission templates add ordered steps, external waits and aggregate outcomes. Operations declare
  scope/field access, effect class, idempotency, compensation availability and cost/row/time limits.
  Irreversible writes are explicit and approval-gated; ERP company/site authority maps to Deckent
  company scope. Each ERP retains its integration design behind the shared operation/governance port.
  IFS is the current target; actual access/scenario and effect boundaries need proof before mutation.
  The old deckent_style enum mixes work unit and execution semantics and is not the target ontology.
- Legacy is reference only for capabilities, learned invariants and design gaps. Implement new contracts.
  No legacy command/config/value aliases, compatibility parser or migration burden is admitted (owner correction).
  Historical source inventories are evidence, not acceptance criteria for old names or defaults. Future version
  evolution of the new product remains required; it does not imply support for the legacy format.
- Previous 500-worker/10k-task numbers were scale illustrations, not release promises or global limits.
  Initial local working scenario: approximately 6–8 parallel workers and at most 50 tasks in the admitted workload.
  Workload size, ready queue, active workers, provider/tool quotas and evaluation throughput are separate budgets;
  enterprise ceilings follow deployment resources and evidence, not those local example numbers.
- First end-to-end business integration: IFS ERP. Owner has test environments for IFS Cloud and Applications 10.
  Cloud is the preferred MCP integration candidate and is being prepared; MCP availability/authorization is not yet
  proven. Applications 10 also participates through a native connector path where MCP is unavailable/unsuitable.
  Both paths consume the same typed business operations, scope, approval, result/effect and recovery contracts.
  Native means a direct supported integration adapter, not a requirement for Go or direct database writes.
  Actual API/transport/auth and first business scenario remain to be verified against the supplied environments.
  No connector is claimed implemented. Developer dogfood remains a separate later acceptance scope.
- Core owns storage ports and security guarantees. Individual database-adapter commercial packaging remains
  an explicit distribution decision; do not infer the edition from database brand or capability alone.

### Subscription coding workers — owner 2026-09-21

Owner selected provider-restricted egress: Docker keeps `network=none`; an attempt-owned Unix
socket reaches a host CONNECT gateway with an exact provider HTTPS allowlist. The gateway rejects
non-public/local IPv4 destinations, pins the checked address and requires matching plaintext TLS
ClientHello SNI; malformed/missing SNI and ECH fail closed. TLS is not terminated. Encrypted HTTP
paths, bodies and provider-side effects are not inspected or independently authorized by this gate.

The current native-connection adapter projects only the selected provider's unexpired access material
into private container tmpfs; no host HOME, Docker socket, refresh token or host credential writeback.
Cursor uses its native ephemeral auth-token input inside the worker process. Provider endpoints and
connection bounds are versioned adapter catalog data. `nativeSubscription` v1 binds the provider in
the prepared Docker task profile; configured task execution retains normal policy, reservation,
workspace, dispatch ownership and artifact collection. Persisted supervisor connection descriptors
contain paths and bootstrap digest, never credential values. Expired/unavailable credentials fail
explicitly; subscription refresh and fleet-wide account lifecycle remain open.

Gateway shutdown/deadline closes sockets; a lost host gateway cannot be reconstructed from a receipt
to grant new access. Existing Docker custody still supports observation, cancellation and output
recovery without credentials; replay never reauthenticates a recorded dispatch. Native raw output
is suppressed in favor of a bounded exit/error summary; full native event/usage normalization remains
open. Full-access worker code can read its own access material and use the allowed provider channel;
this is not within-worker secret isolation or comprehensive external-effect interception.

Phase 1 integrates supported Codex/Claude/Cursor headless coding executors inside Docker using
subscription authority, first one verified path then parallel heterogeneous workers. Deckent owns no
proprietary model: it owns task admission, scheduling, policy, custody and acceptance. Native executor
semantics stay behind versioned adapters; model/persona/skill bindings are configuration, not grants.
Credential custody, sandbox confinement, cancellation and outputs must be demonstrated before activation;
existing host login does not prove container support. Missing simulated API cost never blocks a
subscription job; actual access/quota limits remain enforced. Local inference and other API/provider
paths follow in phase 2; existing serving runtimes are preferred to writing a custom serving engine.

Owner 2026-09-21, revised dogfood sequencing: the first isolated coding-worker profile runs
native unattended/full-access inside its assigned sandbox, without per-tool human prompts.
Provider-specific flags are adapter-owned and version-verified; the mode is versioned profile data.
A complete Deckent tool catalog or native-to-Deckent approval bridge is NOT a prerequisite for this
coding dogfood pilot. Use the executor's own file/shell/test tools; observe bounded native events,
exit, artifacts and cancellation without claiming exhaustive interception of every effect.
The pilot covers assigned workspace edits/tests and controlled patch delivery. It does not grant
host full access, Docker socket access, production/ERP credentials or unrestricted host HOME mounts.
The provider connection/authentication boundary is implemented in the restricted gateway and
ephemeral credential projection described above; refresh and account lifecycle remain open.
Permission bypass alone does not establish secret isolation or working network access.
Runtime custody, capacity, cancellation and honest outcome handling remain mandatory. General tool
mediation and per-action approvals stay in product scope and will be designed from dogfood evidence;
privileged external business effects are outside this pilot. Standing grants and action-specific approval
remain distinct in the target policy model. No approval bridge or automatic native callback is claimed.
Keep executor integration behind a versioned boundary usable from a future measured Go supervisor;
Go adoption is not decided by this sequencing change.

An authorized human may approve their own requested operation in solo or enterprise installations,
subject to explicit organizational separation-of-duties restrictions. Without the relevant authority,
they wait for an authorized decider. Expiry closes the approval request without permitting execution;
the Task remains held for explicit renewal under current policy, not an automatic repeated request.
Task-admission human approval is implemented as described in “Task approval, live sessions and
isolated delivery” below; general native-tool approval callbacks and notification consumption are not.
The bounded native coding connection is wired; full agentic acceptance, active-model admission,
refresh, usage and dogfood closure remain open.

### Product data layout — owner 2026-09-17

- Development/dogfood and customer installations use the same product data layout: one project/installation
  `.deckent` root owns persistent brain/memory, tasks/runs, locks, approvals, audit, artifacts and ERP state.
  Source code and external host products' own configuration are outside this product-state contract.
- One versioned path registry/resolver derives logical resource locations from validated config and scope;
  modules never assemble their own root, sibling `.brain`, `.tasks`, or arbitrary temporary directory.
  Root relocation is configuration, not per-consumer branching. Persist resource IDs/relative references;
  active operations keep a resolved layout revision so config changes cannot split one run across roots.
- Terminal/Desktop and other surface-local cache/session/scratch use declared platform-local runtime/temp
  locations with scope, permissions, owner and retention. Durable jobs/decisions never rely on temporary files.
  Actual locations are inspectable from the shared CLI/SDK/MCP path-query contract; no surface-specific truth.
- Remote database/blob storage remains supported: `.deckent` contains configuration references, manifests and
  inspectable logical locations, not secret plaintext or an unsolicited mirror of every remote ERP record.
  External systems of record remain external. Workspace/worktree allocation is a separate managed resource.
- FOUNDATION defines the layout; CONTRACT versions resolver and inspection; STORE/ISOLATION implement/test
  relocation, containment, symlink rejection, concurrent locks, crash cleanup and secret permissions. Existing
  legacy stores/keys are not moved/deleted. Current BRAIN_HOME/global-scope behavior is not target completion.

### Deterministic storage and customer data access

- Product-state operations (Run, Attempt, Approval, reservations, receipts) are typed domain operations.
  LLMs neither generate their queries nor choose transactions, credentials, database routing or retry policy.
- Keep execution state, memory records, vector search, audit/events and artifact storage as separate ports.
  An index may be rebuilt from canonical records; it is not an independent approval or Run-state authority.
- Resolve installed storage modules from schema-validated effective config and a capability registry once per
  configuration generation. JSON/YAML, if supported, are parsers into the same schema and precedence chain.
  IDENTITY.md is descriptive context, not connection, permission or infrastructure-selection authority.
  Config contains secret references, not credentials. Active operations retain their resolved binding/revision.
- Each port selects its admitted adapter (SQLite, PostgreSQL, MongoDB or another implementation). Dialect and
  driver differences remain inside adapters; domain/engine contain no scattered `if dbstack` query branches.
  Package selection and capabilities are data; unsupported guarantees fail with a typed explanation.
- SQL values use bound parameters. Identifiers/operators/order fields come from validated schemas/allowlists,
  not value placeholders or string interpolation. Document queries use validated typed filters; no arbitrary
  operator, JavaScript expression or unvalidated aggregation is accepted from a model/user.
- Customer business-data requests may use an LLM to propose intent or a constrained query plan. Deterministic
  code validates schema, principal/scope, field access, operation permissions, cost/row/time limits and required
  approval, then compiles the plan through the connector. Prefer domain operations for writes; raw-query tools,
  if admitted, are separate privileged capabilities, never the internal state-store path.
- Adapter manifests declare actual transaction/isolation, conditional-update, ordering, pagination, streaming
  and cancellation capabilities. Probe deployment prerequisites; selecting MongoDB does not prove transaction
  support, and PostgreSQL isolation levels are not interchangeable with SQLite locking.
- Bound connection pools, write queues, in-flight requests and result sizes. Parallelize independent operations
  within resource/scope limits; serialize conflicts at the relevant resource or aggregate. SQLite contention,
  serialization conflicts and network failures have explicit typed handling, not one generic retry loop.
- Retry only classified safe operations with bounded attempts/deadlines and idempotency or conditional writes.
  An unknown commit outcome requires reconciliation; retries do not repeat untracked external side effects.
  Admission accounts for query/deadline budgets; cancellation requests do not prove a remote write was undone.
- A state transition and its outbox record share a transaction where required. Cross-store changes use explicit
  durable coordination/reconciliation, never pretend atomicity. Scope applies to queries, caches, vector filters,
  artifacts and logs; customer RLS is an additional enforcement mechanism, not the whole boundary.

### Workspace, sandbox and effect isolation

- A Git worktree separates working trees/indexes; it shares repository metadata/objects and is not a security
  sandbox. Workspace projection (worktree, independent snapshot/copy, direct workspace) and execution realm
  (host process, container, VM or remote) are separate resolved axes of one execution posture.
- The resolved posture binds attempt identity, owner generation, base revision, resource capabilities,
  filesystem mounts, network policy, secret access, CPU/RAM/PID/disk/time budgets and effect/landing policy.
  Direct execution remains explicit and policy-admitted; unavailable isolation never silently becomes direct.
- Untrusted workers do not receive writable main-workspace or shared Git administrative paths. A trusted
  workspace broker materializes the permitted view and mediates Git mutations; snapshots/copies are used where
  shared metadata would violate the threat model. Read-only source and bounded outputs are independent choices.
- Separate attempt workspace, temporary files, caches, credentials and scoped data. Containers are adapters,
  not proof of isolation: mounts, privileges, network and secret exposure must be verified in each environment.
- Resource/side-effect conflicts (same branch, file, CRM record or deployment) are scheduled explicitly beyond
  the task dependency DAG. Staged outputs bind to the tested base and artifact digest. Verify before landing;
  serialize/fence the landing, detect a changed base, and revalidate the integration result before acceptance.
- Cancel, crash and disconnect preserve evidence and uncertain effects. Stop only owned processes/resources;
  cleanup has retention and ownership rules. Discarding a worktree cannot undo an external API/DB operation.
  Those effects need idempotency, reconciliation or an explicitly supported compensation action.
- Proof covers sibling/main-workspace access, symlink/path escape, shared metadata, secrets/network, concurrent
  landing, stale ownership, cancel/restart and partial effects on the supported platform/realm matrix.

### Modules, protocol and version compatibility

- Module manifests identify version, public API/port versions, dependencies, required capabilities, config schema,
  migrations, distribution and provenance. Composition validates the graph before activation; no core deep imports.
  Optional modules load only when selected. An enabled security module failing cannot silently disable enforcement.
- Resolve and record a reproducible module/config generation; drain affected work before incompatible changes.
  A dependency version range is checked at install/admission; it is not permission to update active work silently.
- Version packages, wire protocols, config/data schemas and native ABI independently. Breaking public contracts
  require an explicit compatibility/migration policy; protocol handshake rejects unsupported capability versions.
  TS/Go messages derive from a shared schema; compatibility tests cover supported old/new client/daemon/worker pairs.
- Schema evolution has backup/restore, exclusive migration ownership, expand/contract where applicable and an
  explicit rollback floor. Installing an older binary is not a rollback after an incompatible data migration.
- Legacy successes and known bugs are separate acceptance inputs. HMAC authenticity is not an asymmetric
  signature. Exactly-one accepted terminal record does not promise exactly-once arbitrary external effects.
- Capacity figures (10k tasks, 500 workers) are illustrative, not fixed acceptance thresholds. Baselines precede language choice;
  runtime and real-provider evidence remain separate. No delivery date is inferred from catalog-port throughput.
- Early dogfood requires a stable N controlling candidate N+1, bounded real work, independent acceptance,
  cancel/restart evidence and an external recovery path. Product self-development cannot bypass its own policy.

## Packages (current implementation)

```text
src/platform/       config, errors/i18n, identity/host, product paths, bootstrap state and shared metadata
src/domain/         pure versioned task/run/policy, provider catalog/binding, model activation and invocation contracts
src/capabilities/   evaluation evidence contracts and validation; no AI semantic acceptance
src/engine/         application transitions and ports for runs/attempts, scheduling, workspaces, installation, runtime,
                    provider inspection, model activation and durable invocation admission/inspection
src/adapters/       SQLite stores/migrations, Git/Docker execution, local runtime socket/native bridge,
                    installation custody/evidence and provider-native adapters
src/surfaces/       shared CLI and MCP parsing/rendering/tool contracts
src/composition/    executable SDK/CLI/MCP/runtime wiring and adapter selection
```

The implemented product includes installed Git/Docker runtime execution and recovery, authenticated local runtime
control, recoverable custom-profile installation, declared provider/model inspection, scoped model activation and
durable native model invocation through runtime-backed SDK/CLI/MCP, task-admission approval, Linux
live sessions, and reference-only Git delivery/recovery. Three subscription coding providers have
recorded real local parallel execution evidence at `652d1c2`; this is not general provider, platform
or dogfood acceptance. The former `b1e430f` A3A-only snapshot is historical, not current capability.
General tool mediation, Brain semantic acceptance and DOGFOOD closure remain open.

Current transport is explicit: CLI Run/Task execution and approval use the runtime client; installation,
worker inspection and patch/integration operations use direct composition. MCP stdio uses runtime for
Run/Task/approval/model/spend and direct composition for catalog/activation. SDK exposes both configured
applications and a runtime client. One application/state owner does not imply one transport; direct SDK
access alone is not evidence of a policy bypass. Further custody/parity changes need their own proof.
Only CLI and MCP surfaces are shipped here; Desktop/TUI/HTTP, external MCP client and IFS connectors
remain targets. Unused translation keys are not handlers or evidence of a shipped surface.

Domain cannot import platform or other packages, host modules or ambient host globals. The purity gate also rejects
composition access to domain decision functions while allowing schema/type wiring; static analysis does not prove
all semantic purity. Surfaces may consume public platform/domain/capabilities/engine APIs and never adapters.
Engine consumes public platform/domain/capabilities contracts; adapters implement engine ports. Composition is the
only layer that wires adapters to applications and surfaces. Cross-unit dependencies and cycles are declared and
gated in `arch.json`; package imports use public `index.ts` barrels and `internal/` remains package-private.

Current compiled entries include the CLI and MCP composition binaries; the CLI starts the local runtime service. SDK, CLI and
MCP share the implemented inspection, activation, installation and runtime-control contracts; capability-specific
linked execution evidence defines where parity is complete. New package names have no compatibility import aliases.

## Package contract

- Public API is `index.ts`; everything else is internal.
- Every configured text source file ≤ 1,500 lines (eslint + lint-arch; 800 design target), functions ≤ 150 lines (warning).
- Package line budgets and the total budget live in `arch.json` (`budgets`); growth past a budget is a
  design decision, not a lint fix.
- Mechanism code is string-free: user-facing text comes from `kernel/core/i18n/locales/{en,tr}/*.json` through `t('key')`.
  Keys are literals (lint), catalogs have identical key sets (lint), surfaces never print literals (lint).
- Config field values live in `kernel/core/config-fields`; `config-literal` uses source-derived
`scripts/config-vocabulary.json` with freshness checks before lint/build.

Model, provider and flow identifiers appear only in `providers/core/registry/` (lint).
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
- Budget: ≤ 8,000 test cases total, every test file ≤ 1,500 lines (lint; 800 design target). Legacy invariant titles are in
  `tests/contracts/HARVEST.json`; each port card lists which titles it honours.

## Documents

The Markdown gate admits four documents: `README.md`, `ARCHITECTURE.md`, `PLAN.md`, `CHANGELOG.md`;
≤70-line permanent product-development contracts `CLAUDE.md`, `AGENTS.md`;
≤5-line pointer `.codex/AGENTS.md`; `.deckent/docs/core-memory/*.md`;
and the explicit refactor host-kit globs in `arch.json`: the remaining 23 `.agents/skills/<skill>`
directories/references plus `.claude/agents`, `.claude/rules`, `.codex/rules`.
The host kit is excluded from product distribution (`package.json files`: dist/native/assets/README/LICENSE).
Product code still writes no Markdown; owner-maintained host instructions are a development-only exception.
Design reasoning goes into the decision log below, not arbitrary new documents.
Owner 2026-09-21: `follow-up-works/current-flow.md` is an optional, replaceable development tracker;
its exact path is admitted by the Markdown gate, excluded from product distribution, and may be deleted.
PLAN.md retains durable roadmap/decisions and material open findings; small work/history lives in the
transient tracker and external refactor archive, not an append-only product plan.

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
| 2026-09-16 | K2 mechanism: ten JSON families per locale, immutable validated registry, JSON-derived `MessageKey`, static manifest import for per-key floor defaults, and one locale resolver. No generated-file size exemption. | Preserves the 800-line rule and removes top-level await/Node dependencies from the renderer-facing translation unit. Legacy membership follows Fable's exact K2 list: 3,374 retained and 607 excluded; the 46 protected keys remain. K1's config.invalid moved to config.valueInvalid to preserve the legacy contract. |
| 2026-09-17 | Owner accepted consolidated architecture review with deterministic storage, separate workspace/sandbox axes, modular composition and version compatibility; TypeScript retained, Go conditional. | Target amendment above; FOUNDATION and successor rows in PLAN.md track implementation. No runtime/gate completion inferred from this decision. |
| 2026-09-17 | Refactor host kit tracked; owner exception; product still writes no markdown. | Exact host-kit globs plus pointers/core-memory match the gate; disabled skills excluded and host kit not shipped. |
| 2026-09-17 | Task-centered work; run/do/autonomous execution, goal-bounded Mission, modular task kinds; IFS ERP first business integration. | Cloud MCP candidate plus Applications 10 native-adapter proof; local 6–8 workers/up to 50 tasks is a workload scenario, not a system ceiling. Historical names/semantics do not override this decision. |
| 2026-09-17 | Pure config-fields SSOT and source-derived literal gate (REVIEW1323). | Unified .deckent product-state root accepted; implementation tracked separately in PATH-LAYOUT. |

| 2026-09-17 | FOUNDATION/A: 1,500 source lines maximum, 800 design target; native C/Go and application sources included. | Owner size amendment; Fable PASS1340. Historical HARVEST evidence exception is one exact file path. |

| 2026-09-17 | Config stores references; injected SecretResolver retrieves values per load without effective-secret caching or plaintext secret-file reads. | PATH-LAYOUT/A+B, Fable PASS1349; OS keyring backend remains unimplemented. |

| 2026-09-17 | Project .deckent/config.json is the fixed bootstrap locator; layout.root selects durable data root. Expose both locator and resolved paths, pin revision per operation. | Direct owner decision; no recursive config lookup or implicit migration. |

FOUNDATION/B accepted in Fable REVIEW1357: platform/adapters/composition package mapping and read-only CLI path query. Domain boundaries declared; execution is not implemented.

PATH-LAYOUT/C accepted in Fable REVIEW1358: project `.deckent/config.json` is the fixed locator, `layout.root` selects data root, and inspection exposes both. No recursive discovery or implicit migration; effective operation/crash layout propagation remains follow-up.

CONTRACT/A accepted: pure task graph admission and dependency readiness. Dependency readiness is not dispatch/resource/policy admission; canonical Task acceptance is required.

CONTRACT/B accepted: versioned attempt evidence and application transitions. Attempt evidence never accepts a Task; cancellation intent is separate from terminal process evidence. Durable journal and real supervisor are separate scopes.

STORE/A implements an attempt application service, typed store port and lazily selected SQLite adapter. Snapshot and receipt commit atomically with scoped replay/CAS. Production ingress, guarded path composition, contention policy and worker/pool isolation remain unimplemented; synchronous Node24 SQLite is an experimental baseline.

CONTRACT/C preserves exact termination cause (exit code or signal) and separates stale evidence from conflicting evidence. Version1 wire identities share a256-code-unit bound; content/task descriptions are not constrained by this ID bound. Dependency blocking is direct, with no implicit terminal cascade.

Runtime package metadata comes from a colocated generated artifact. package.json is the source; explicit tooling regenerates it, npm lint and build enforce freshness. No runtime directory-depth manifest dependency remains.

SQLite adapter requires explicit timeout/journal/durability options, maps busy/locked outcomes, and does not retry automatically. Linux separate-process BEGIN contention is verified; commit-time reader contention, worker isolation and platform matrix remain pending.

Ledger composition selects configured SQLite options and registry path. Default100ms native wait applies equally to development and installed Core and is configurable; no SLO implied. POSIX file preflight is not same-UID race-proof custody. Windows ledger opening explicitly remains unsupported pending ACL backend proof.

SQLite reader contention is tested by journal mode; ordinary WAL readers do not imply commit BUSY. Forced checkpoint and power-loss tests remain separate acceptance work.

ExecutionSupervisor v1 now has a real Docker adapter. Process exit is evidence, never Task acceptance. Containers remain until explicit release after durable application receipt. Trusted workspace allocation, dispatch fencing after release, durable output and aggregate scheduler quotas remain prerequisites for public execution.

Execution ledger identity is scope + local ID: attempts use (scope_id, attempt_id), command receipts use (scope_id, command_id); an ID alone carries no cross-scope authority. Fable1484 confirms the existing contract.

Local runtime service protocol is one current schema (2). Client shutdown binds an exact per-start instance and a separately authorized service resource; admission is durable before response/disconnect handoff, and accepted does not mean stopped. Missing final audit outcome remains unknown. SQLite ledger schema10 stores canonical service admission and final outcome separately.
Linux native peer credentials identify the connecting OS principal, not separate applications or admin roles sharing that UID. A root client is rejected when the daemon has a different UID; a root daemon accepts same-UID root peers. Path ownership and policy do not provide isolation from a hostile process under the same UID.
Operational service.identity (null by default), responseTimeoutMs, acceptRetryDelayMs and acceptRetryLimit are validated config. Native accept pressure pauses with the configured bounded retry policy; permanent errors/exhaustion still cause controlled shutdown. Native code/build stay adapter-owned; Linux x64 evidence is not Windows/remote/HA proof.

Supplied installation preview (REAL-INIT/P3A): a versioned materialized profile binds authored configuration,
policy and pool by a domain-separated canonical JSON SHA-256 digest. This proves content integrity only,
not publisher identity. The normalized configuration, actual local OS principal, explicit shutdown choice
and resolved paths bind a separate plan digest. CLI `init preview --profile` and SDK share one engine
application; preview writes no files and never grants policy or reports ready. Input size is registry-owned;
raw configuration and task argv are omitted from display. Full policy, task-kind/profile mappings, pool,
image references, actual principal/scope and resolved paths remain visible. Heterogeneous task profiles and
shared pool capacity above per-Run admission are valid. Shutdown is independently selected and must match
a single explicit narrow current policy grant; policy deny/restriction still wins.

The supplied profile is untrusted data; ordinary bounded UTF-8 JSON reading is not publisher verification.
Package trust, image provenance and image availability are explicit unresolved preview blockers. There is
no built-in release profile, default test image, installer apply, transaction recovery or readiness claim
in P3A. P3B must place recovery discovery under the fixed bootstrap location before config cache admission;
config-last alone cannot conceal partial state because missing config currently resolves defaults.

Bootstrap admission foundation (REAL-INIT/P3B-GATE): layout registry v2 classifies config and installationJournal
as fixed resources. Their paths remain under the bootstrap directory even when the data root moves; exact
resolved collisions and fixed-resource overrides are rejected. The strict private journal v1 records plan/profile
digests, publication progress and pending/committed phase without payload bytes. Its domain-separated checksum
detects corruption, not a hostile host owner. Only complete committed records with no blockers are admissible.

Project loadConfig observes the fixed journal before cache lookup and fences the same generation after all
validators/warning callbacks, before cache insertion or return. Pending/corrupt/unsafe/changed state is a typed
hold; there is no public installation bypass option. Explicit global-only inspection stays a separate scope.
A secret lookup begun before a concurrent transition may finish, but its configuration is discarded when the
fence detects the transition. Automatic config repair checks that fence inside the existing config writer lock,
before backup/write; the future installer must acquire this same lock before publishing its anchor. Trusted
low-level file helpers and hostile same-UID writers are not sandboxed by this read-admission boundary. POSIX
custody checks require owned non-symlink project/bootstrap directories. When a journal is genuinely absent,
ordinary directory modes (including group-writable projects) do not prevent config reads. A present journal
requires private ancestor modes and private single-linked journal files. Windows journal custody remains
unsupported, while a genuinely absent journal preserves ordinary reads.

This slice supplies the observer and live config/CLI gate. The product journal writer, materialized digest-
preserving profile, multi-resource publish/replay/recovery, and real image/package trust remain separate open
installer work. No full init, committed installation producer, P4 acceptance or readiness is claimed here.

Installation evidence preparation (REAL-INIT/P3C-EVIDENCE): CLI init inspect and SDK inspectInstallation
share one application observation sequence. A freshly validated profile is copied before asynchronous work.
The host Docker executable must be supplied separately by the operator, must equal the proposed profile
value, and is never chosen implicitly from that profile. Mutable inspection bounds come from the central
installation registry; supplied profile values may only narrow the installed host defaults during inspection.

The adapter measures package.json plus present literal distribution scopes declared by the running package,
not a caller-selected package root. It rejects observed symlinks (including declared ancestors), hardlinks,
nonregular files and generation changes; file/directory/depth/byte counts are bounded before allocation.
Missing declared scopes are reported explicitly. This is a trusted-host installed-byte measurement, not a
publisher signature, reproducible-build proof, npm package completeness claim, or hostile same-UID filesystem
sandbox. Third-party dependency bytes are explicitly excluded. Node pathname generation checks do not offer
openat-style race-proof ancestry custody; the running application package and host remain trusted.

Docker observations pin a local Unix endpoint, compare daemon identity before/after exact image-ID inspection,
and never pull/create/start an image. Package bytes are remeasured after image observations. The proposal
digest binds the normalized profile plan and measured package/image/daemon evidence. CLI and SDK expose
operatorApproval=not-recorded and publisherVerification=unverified; availability observation removes only
the availability-unknown marker. A future explicit apply must compare newly measured evidence against the
previously displayed proposal digest; accepting an old plan digest alone cannot approve new package bytes.
No journal publication, permission grant, publisher trust, installation readiness or apply is produced here.

2026-09-19 REAL-INIT/P3D-JOURNAL: the single current bootstrap journal advances in place to schema2, requiring a bounded immutable recovery object. Schema1 has no released installer-produced records; unsupported/incomplete data stays held, with no fabricated recovery or parallel alias reader. Platform validates structural integrity only; the installer application must validate material, exact proposal consent and all publication targets before acting. The POSIX journal adapter takes the fixed config writer lock before anchor publication; canonical payload/generation are copied at call admission, same-session writes serialize, started IO drains before unlock, every operation failure poisons the session. File and newly created parent-directory fsync precede acknowledgement; rename uncertainty remains explicit. Same-UID host cooperation is assumed, not native path CAS or hostile-host isolation. This slice adds no policy/config/pool installer, permission or ready command.

2026-09-19 REAL-INIT/P3E-PUBLICATION: explicit local custom consent binds actual OS issuer/subject to a freshly measured proposal; publisher authenticity stays unverified. A complete pending journal precedes every target effect. Original authored profile and normalized configuration are separate, immutable recovery inputs; resume revalidates current schema/paths/identity/evidence and rejects drift instead of silently adding defaults. Fresh file publication stages private bounded bytes in a transaction-reserved namespace and links without replacing a target; recovery recognizes only exact target/temp inode/content, including a bounded partial-prefix stage. SQLite schema11 stores exact installation ownership and pool in the same transaction; foreign markerless/nonempty databases are refused before persistent journal-mode changes. Readonly final verification precedes committed journal admission. Apply/resume share one engine application and require explicit custom acceptance/proposal/executable; shutdown permission remains an independent profile choice. This is local POSIX trusted-host installation; no builtin release profile, remote bootstrap, publisher signature, upgrade/overwrite flow or MCP self-authorization is added.

2026-09-20 AUTH/NATIVE-CONFIG: the global API-mode vendor-key requirement was a known metadata/activation defect and is removed (Fable2042). Credential, profile and request-budget holds belong to native invocation admission (A3/B08/B09), never general config/catalog reads; no invocation authority follows from API mode or activation.

### Workspace patch preparation (implemented, ledger29)

Host-produced text change packages bind source fingerprint, recorded Git base, exact attempt,
projected workspace snapshot digest and before/after file contents/modes. The existing dispatch
record owns one immutable patch artifact receipt; artifact persistence precedes its transactional
binding. A changed snapshot conflicts rather than replacing the first receipt. Unbound bytes after
an interrupted publication are not addressable through patch preview. This is neither Task acceptance
nor permission to apply changes to a live target.

SDK and CLI `task patch-prepare` share the application service, requiring existing `recover-output`
and `read-output` policy. First preparation and repeated capture require the retained exact Docker
container to be observed exited before/after bounded reads. Preparation must precede container release;
there is no credential renewal or worker launch. `task patch-preview` uses `read-output` and a read-only
ledger reader; its retained artifact remains available after container/workspace release.

The Git adapter reads immutable base blobs from the trusted source repository, never worker Git
configuration, hooks, filters, index or attributes. Linux descriptor-relative no-follow workspace
reads reject symlinks, hardlinks and special files, and detect changed snapshots. Versioned exclusion
rules omit Git/product/auth metadata and environment files; exclusions are included in the package.
Untracked non-excluded files are included. Only regular UTF-8 text files and executable mode are
supported; binary/submodule/symlink input fails explicitly. Scan bytes/time use artifact/Git limits;
`artifacts.patchPreview` config bounds entries, depth and path bytes. Bounds apply to the projected
whole tree, so large/generated repositories may require a future explicit scope contract.

Ledger29 protects the new optional dispatch receipt from older writers; explicit existing migration
moves v28 forward without changing prior records. Preview does not migrate. Live target HEAD and WIP
are not modified or certified fresh. Conditional apply, external-writer races, partial-apply recovery,
MCP parity and non-Linux snapshot adapters remain separate work.

### Local worker observation (implemented)

Configured task execution now maintains host-owned `worker.hb`, `worker.log` and `worker.result`
next to the attempt checkout, outside its Docker mount. Heartbeats sample exact daemon custody;
logs contain bounded structured process/terminal observations, never raw native stdout or credentials.
Results project the existing terminal ledger record. Atomic fsync/rename publication is best effort;
a missing/stale file never changes execution, cancellation, acceptance or recovery ownership.

`inspectConfiguredWorkers` and CLI `workers list|watch` share a local, read-only source monitor.
The current Next project and explicit `inspection.workers.sources` entries can reference other Next
projects or exact legacy task directories. Every Next source independently enforces its current scope
inspection policy; artifact/activity detail requires attempt read-output. Legacy sources are admitted
by the central project's scope inspection permission and explicit source/scope configuration. No recursive
HOME/tmp scan or remote reader is implied. Limits cover total workers, source count, directory entries,
file/tail bytes and heartbeat intervals. Each source reports its own unavailable/denied/not-sampled state.

Legacy `.hb/.log/.result` shapes remain observations. Host PID existence is identity-unverified; file
freshness is separate from process liveness. Result self-assessment is separate from Next terminal custody
and Task acceptance. Log analysis emits bounded diagnostic categories and whitelisted structured events,
not arbitrary legacy strings. Missing, malformed, stale, future and identity-mismatched evidence remain
visible. Stopping watch stops only the view. CLI snapshots/JSON-lines and SDK are implemented; Desktop/MCP
and cross-host monitoring remain future consumers of the same semantics. Linux local files/Docker are
verified; no non-Linux or legacy runtime activation is claimed.

### Next execution host cutover (2026-09-21)

Owner makes Next the sole local execution workspace; legacy is read-only reference.
Host CLI/MCP entry points and the registered local MCP integration target Next composition.
The shared global-scope resolver accepts `DECKENT_GLOBAL_HOME`, independently of the existing
project data override `DECKENT_HOME`; this location input participates in config cache identity.
The development host launcher pins Next cwd and global state, and removes inherited project
root overrides. Customer defaults and each source project's layout/policy remain unchanged.
No legacy runtime migration, old-value conversion, global credential copy or automatic run
admission follows from cutover. Existing external client processes need reconnection.

### Isolated patch integration candidates — owner 2026-09-21

Owner selected candidate preparation before live-source delivery. The shared workspace-patch
application checks the exact retained patch, source/base/HEAD and affected index/worktree paths.
`read-output` permits checking; separate `prepare-integration` authority permits preparation.
A short proposal code binds this observation and receipt; it grants no permission or writer lock.
Ledger30 records the scoped command, actor and intent before candidate effects. The existing Git
broker allocates an independent detached clone under configured workspaces/integrations, distinct
from worker custody. Candidate files are base plus patch; unrelated live WIP is excluded.
An immutable artifact manifest binds the projected snapshot to the intent after verification and
source/policy rechecks. Source HEAD/index/files are never written by this operation.

SDK and local CLI expose check/prepare. A completed command replays only after verifying current
policy, source observation and candidate bytes. Pending commands explicitly hold; no automatic
partial-candidate adoption, repair or cleanup is implemented. Git metadata and protected patch
exclusions are outside the content snapshot. This is neither a fence against other same-OS-user
processes nor a live landing, test result, Task acceptance, or automatic execution trigger.


### Refactor workspace ownership — owner latest decision 2026-09-21

Next is the repository where refactoring and product completion happen. The pre-refactor
product repository stays read-only reference. Local historical documents, experiments,
proof and toolchains live outside Next in `/home/alperen/deckent-refactor-work`; this
document surface stays outside Git and npm publication. Skills and active links use that
external location; no local directory or compatibility symlink is retained in Next.
Next core-memory is canonical and verified by its local digest manifest; optional comparison
against a separately selected reference is diagnostic, not legacy write authority.

Integration inspection uses a separate read-only query port on the same ledger30 records.
SDK/CLI require current read-output authority and exact Run/Attempt binding; they distinguish
absent intent, pending preparation and retained manifest. This historical view requires no
execution profile or Git access and explicitly does not revalidate current candidate files.

### Installation group custody — owner O5, 2026-09-21

Bootstrap observation and journal publication accept owner-uid-checked group-writable directory
ancestry and reject other-write (mode bit 0002), including an absent journal under unsafe ancestry.
Journal files remain private, single-linked, owner-checked; new directories remain 0700. This is
explicit group namespace custody: group members may alter/remove entries. Other resource guards
(publication, policy, artifacts, gateway, worker workspace) retain their own stricter invariants.
The proven installation target is an owned 0775 project with private child/data directories, not
blanket group-writable product state. No ownership repair or host chmod is performed.

## Task approval, live sessions and isolated delivery

Task admission approval is an additional restriction before scheduling's capacity-limited candidate
selection, rechecked under the reservation transaction. Composition installs this additional gate when
the policy has task-resource rules; absent task restriction is not an execution grant. It does not
replace execution policy or the pure launch reducer. Durable requests/decisions/receipts use the shared ledger (v31), scoped MAC
custody, explicit expiry renewal and one application across SDK/CLI/MCP. `task-admission:2` binds the
validated policy content as well as immutable Run/task/execution/requester identity. Pending requests
consume no reservation slot; approval requires a new reservation command. Old receipts never expand.
Request expiry bounds decision time; current policy can block future reservations. Notification
consumption, a separate approval-revocation surface and worker-native callback approval remain open.

A verified principal and a live session are distinct contracts. Local privileged decisions bind the
OS process birth/TTY/session evidence and, through the native runtime socket, its connection lifetime. A zero-timeout kernel poll and exact SO_PEERCRED check distinguish
normal request half-close from full disconnect before delayed Node socket events.
Wall and monotonic deadlines plus revocation are checked before mutation. This Linux local witness
is not remote bearer authentication; `token-verified` remains an extension port, not a shipped verifier.

A replacement integration command explicitly names its predecessor and prepares a separate candidate;
it never adopts the old directory or declares its writer dead. Git delivery has its own policy action
and live session check. It records intent in ledger v32, builds a deterministic commit from retained
patch bytes using a private index, and atomically creates a dedicated `refs/deckent/deliveries/` reference
while verifying source HEAD. Source branch, index and working files are not modified. Exact ref/commit
custody reconciles a crash after Git publication before ledger settlement. Receipt replay is historical
evidence, not verification of today's ref. Checked-out branch adoption and live-worktree merge remain
separate operations; `reference-only` delivery does not claim either or accept the Task.
