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

Native coding authoring v2 pins the observed CLI version and a versioned discovery choice.
Disabled discovery is the default: Claude uses subscription-compatible safe-mode; unverified
Codex/Cursor suppression requests fail instead of silently enabling repository discovery.
Repository discovery is an explicit profile exception for all three providers. Only Claude's
repository mode accepts typed `disableAllHooks` settings; arbitrary settings/env/helper/path
injection and disabled-mode/settings combinations are rejected. This is not a general tool gate.
The binding's optional preflight-v1 metadata records discovery, version and required flags;
the worker probes in an empty temporary directory before credential-file publication/task start.
Mismatch is a sanitized preflight failure. Old authoring v1 is rejected; already persisted
profiles without preflight retain exact replay, without an implicit upgrade or retroactive claim.
Adapter flags and the pinned image remain the execution mechanism; no new state owner or ledger.

Worker image versioning (owner 2026-09-22) is an explicit operator build operation shipped in `assets/worker-image`:
recipe schema 2 names `repository`, `imageVersion`, `previousVersion` and the base image; the Dockerfile's
newest-first `# version <id> | <date> | base <image> | supersedes <id|none> | <reason>` comment lines are the
human-readable history, validated against the recipe before any Docker call and copied into the image. Each
version maps to exactly one immutable imageId, tagged `<repository>:<imageVersion>` with OCI version/revision/base
labels; rebuilding a version whose tag already names another image is refused. Receipts (schema 2) record version,
tag, labels, history, source hashes and the probed provider manifest; earlier receipts are archived, earlier images
and tags are retained for active Runs and rollback. The product still binds execution only by `imageId`; tags,
labels and history are operator evidence, not authority, and no image is pulled, activated or removed by the product.

Native authoring v2 also accepts mutually exclusive raw prompt or structured composition-v1.
A packaged versioned common core plus explicitly selected persona/skills/context and task/scope/
acceptance compile deterministically; no catalog discovery or new routing/admission owner is added.
Content is bounded task data, never credential storage. Optional prompt-delivery-v1 metadata binds
the rendered content, selected-part identifiers/versions/hashes and original argv. Resolution and
worker bootstrap reject integrity mismatches. Claude receives the core through system-prompt;
Codex through a private tmpfs instructions file with project-document loading disabled; Cursor
receives core and task inline. These are delivery capabilities, not complete discovery suppression.
Existing raw prepared profiles remain unchanged. The worker substitutes placeholders internally
and emits a sanitized spawn receipt into existing Attempt output. It proves process input handoff,
not provider acknowledgement, model compliance or acceptance. Persona grants no policy authority.

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

### Enterprise layering, effect settlement and ERP adapters — owner 2026-09-23 (accepted target; Lane B)

Deckent-Enterprise is the commercial target; Core is standalone open source (MIT). Enterprise is layered on published
Core contracts and never requires editing Core. Core-memory law 10 records this rule (Jev 124d141b, two lanes 0.99).

- **Contract gate.** New external effects use one Core effect-settlement port, never another module-specific
  intent/claim/effect/finish flow. The port carries: a versioned operation (catalog id/version, effect class,
  compensation availability), scope/principal/actor, an idempotency key, a conditional-write precondition observed
  from the target (Git tip, ERP record version/ETag or business condition), intent persisted before the effect,
  re-authorization and live-session check immediately before the effect, exact settlement evidence where the target
  supports it (Git fence ref, ERP-side idempotency record) and otherwise typed `unknown` reconciliation without blind
  retry, and compensation as a new intent (cancel/reverse), not a silent rollback. Existing delivery, adoption,
  integration, cancellation delivery and model-invocation flows migrate onto it after the dogfood lane; until then
  they are recorded debt, not a pattern to copy.
- **Operation-keyed approval.** Approval binds (scope, resource kind, resource id, action digest), not only Run/Task.
  A policy `require-approval` decision opens or checks an approval request instead of collapsing into `POLICY_DENIED`.
  Four-eyes/separation of duties remain organization policy data.
- **Registry overlay.** Adapters, policy sources, identity providers, operation catalogs, ledger extension
  namespaces and surfaces are registered through a versioned registry with module manifests (tier, version,
  required Core API range, capabilities). Composition resolves registered units; a separately distributed Enterprise
  package proves overlay without Core edits before Enterprise features are claimed. Tiers never grant authority.
- **ERP adapter family (Enterprise).** IFS (Cloud via MCP/REST and Applications 10 native), SAP, Oracle, Microsoft,
  Uyumsoft and Logo implement the same operation/effect/approval contracts. Customer ERP development projects are built
  on these adapters; Deckent-Enterprise owns writing and distributing internal packages as each customer's ERP version
  changes. Every adapter/package declares the ERP product/version range it supports; compatibility is never assumed.
  ERP company/site authority maps to Core company scope. No ERP access exists yet: adapters start against documented
  generic surfaces and are not claimed working until a customer/test environment proves read and conditional write.
- **C11-1 implemented (2026-09-23, ledger v34).** `domain/core/effect` (operation descriptor, command, intent/record, pure
  settle/unknown/refuse transitions, compensation check), `engine/core/effect` (`EffectApplication`, ports `OperationCatalog`,
  `EffectTarget` observe/apply/lookup, `EffectStore`, `EffectApprovalGate`; `OperationPolicyAuthorization` keeps
  `require-approval` distinct from deny), `effect_intents` table (per-scope idempotency key, per-record sequence, a claimed
  or unknown intent blocks the record), config section `operations` (catalog + targets, empty by default), Core generic
  adapter `http-conditional-effect` (ETag/If-Match, Idempotency-Key, idempotency lookup; loopback http or https, no
  credentials yet), SDK `execute|compensate|inspectConfiguredOperation`, CLI `deckent operation`. Required approval stops
  before any effect with `EFFECT_APPROVAL_REQUIRED` until C12. Not claimed: any ERP adapter, credentials, MCP tool, registry
  resolution of targets (A04), migration of the five existing flows.
- **C11-1 REVISE (Astra 2041, Jev 2bfd2ee9, 2026-09-24).** The target never sees the caller's key: the intent stores a wire
  key derived from scope, target kind+id, operation id@version and caller key, so two scopes or operations reusing a key
  cannot settle each other's records. The intent also pins a target binding (descriptor digest + the adapter's endpoint
  `identity()`); a resume against a changed binding — or an older intent without one — stops with `EFFECT_TARGET_CHANGED`
  before any send or lookup (operator recovery). A compare-and-swap loser of a concurrent identical replay reloads and
  returns the settled record. The HTTP target bounds the whole exchange, not only socket idleness. One target kind maps
  to one endpoint per installation (config rejects duplicate kinds), which is what makes kind+id busy scoping sound.
- **Two lanes.** Lane A (time-boxed dogfood, no new effect types, owner allowed a DOGFOOD trial 2026-09-23) and
  Lane B (the contracts above, company scope, IFS scenario design and sandbox proof moved ahead of M4).

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
Only CLI (including its `terminal` line/rich views) and MCP surfaces are shipped here; Desktop/HTTP, external MCP
client and IFS connectors remain targets. Unused translation keys are not handlers or evidence of a shipped surface.

### Operator terminal contract v1 (accepted target, partial implementation)

The operator terminal is a presentation of the same typed operator actions as CLI, MCP and (later) Desktop,
not a second shell. Principal, scope, resource and policy travel with every turn; persona grants nothing.
Market notes live outside the repo (`/home/alperen/deckent-refactor-work/proof/TERMINAL-UI-LANDSCAPE/`).

- **Regions:** banner, status strip (scope, chat model, busy/cancelling), work ledger (append-only chat,
  run, worker and notice rows), single input owner, hints. **Events:** `slash`, `submit`, `cancel`, `exit`;
  the slash catalog is data (`slash-registry`). **Composer (P2):** the single input owner is a pure reducer plus a
  small Ink view (unit `surfaces/core/terminal-composer`): grapheme/cell-aware caret, readline editing and kill/yank, multiline
  (Shift/Alt+Enter, Ctrl+J, trailing `\`), in-session history and Ctrl+R, atomic paste chips expanded on submit, Tab
  slash completion with argument hints, `?` shortcuts; it emits `submit`/`cancel`/`exit` intents only. Idle Ctrl+C
  clears a draft or arms exit (second press within 2 s exits); Ctrl+D exits on an empty idle line; while busy
  Esc/Ctrl+C cancel the turn. History and `@` mention candidates are ports; the surface reads no files. History persistence is the
  `terminal-history` adapter: private per-project `state/terminal-history.jsonl` (0600, no-follow, append-only, last 500
  entries, compacted when doubled), visible line only — entries that carried pasted content are never stored and secret
  shapes are redacted; `terminal.persistHistory: false` disables it. `@` candidates still need a scoped read port.
- **Entry (owner 2026-09-23, T0):** `deckent` with no arguments on a real terminal (TTY stdin and stdout, `TERM` not
  `dumb`) opens the interactive terminal, as does bare `deckent terminal`; piped or dumb terminals print help, and
  `deckent --help` is always help. The scope comes from `--scope` or `terminal.scopeId`; without either the typed
  `TERMINAL_SCOPE_REQUIRED` screen says how to set one. **Runtime auto-start:** when no service answers on the
  configured endpoint and absence is positively observed (absent socket, never-created state directory, or a refused
  connection — nothing listens on a crashed host's stale socket), an interactive terminal
  starts `runtime serve` of the same executable as a **detached background process** (no shell, no stdin, output
  appended to the private `runtimeLog` resource `state/runtime-service.log`, 0600, no-follow) and waits for a
  successful describe within `terminal.serviceStartTimeoutMs` (default 20 s); one monotonic budget covers the first describe,
  the launch and readiness, so a peer that accepts and stays silent cannot hold the terminal. `/service-restart` and flagless
  `runtime shutdown` carry one budget through describe, the shutdown answer, the wait for absence and readiness; running out
  is an unknown outcome (the command may still be admitted), never proof of stop or permission to replace the service. A peer that accepts but fails or stays silent may be a
  live incompatible or unhealthy service: it is reported (`LOCAL_RUNTIME_TRANSPORT`), never replaced. The launch is shown
  as ours only when the descriptor's `processId` equals the launched pid; a concurrent winner is shown as connected
  (Astra 2054 R2). The service keeps running after the
  terminal exits so runs and workers continue (owner decision after Jev 0198c77c abstained in effect); it stops with
  `deckent runtime shutdown`. An existing service is reused; an endpoint that fails ownership checks is never replaced;
  a start failure is shown in the view (`RUNTIME_AUTOSTART_FAILED` with the log path) and is not fatal. Piped line
  mode and other CLI/MCP commands never start a service; `terminal.autostartService: false` only connects.
  **Lifecycle (T0b, Jev 8bb2a0c7):** the service descriptor carries an optional `build` (source tree digest and commit);
  a compiled terminal compares it with its own build and shows a typed notice when the service runs another or an unknown
  build, offering `/service-restart` (governed shutdown, then auto-start) — it never restarts on its own, because runs may
  be in flight. **Lifecycle compatibility window (Jev 898c8af3):** `describeService` and `shutdownService` are accepted
  in the previous and the current protocol version ([11, 12] since v12) and answered in the request's version; a client retries these two only, once per
  older version, when the connection closed unanswered — so an upgraded terminal can describe and stop a service started
  from an older build (proven live: v11 terminal → v10 service → skew notice → `/service-restart`). A retry resends the same
  shutdown command and instance, never a new one, and every other operation — anything effectful — is current-version only. `deckent runtime shutdown` without command fields builds the governed shutdown command from the live
  descriptor; a service without `service.identity` cannot be stopped that way (`RUNTIME_SHUTDOWN_UNAVAILABLE` says how
  to configure identity and a shutdown grant) and the terminal banner says so. **Upgrade:** `runtime serve` upgrades an
  existing older ledger once at startup, before accepting connections and only under endpoint custody: the service first
  binds the kernel-owned abstract guard socket of its endpoint (held by any live host of any build, released by the kernel
  when the process dies), so a second start against a live service fails `LOCAL_RUNTIME_ALREADY_RUNNING` before any
  backup or migration, and custody is kept until the listener is up (Astra 2054 R1). A consistent copy is written first
  (`VACUUM INTO` the `ledgerBackups` resource `state/backups/ledger-v<N>-<time>.db`, 0600, never over an existing file),
  then the normal single-transaction migration runs and the service reports from/to versions. A missing or current
  ledger is untouched; clients and read paths never migrate. Typed error responses carry bounded message
  parameters (≤ 8 keys, strings ≤ 512 chars; omitted for older lifecycle versions), so a remote error renders the same
  text as a local one. Open: idle stop policy for the background service.
- **Adapters:** `deckent terminal workline [--scope <id>]` is the Ink view and requires TTY stdin and stdout
  (`TERMINAL_TTY_REQUIRED` otherwise); `terminal session [--scope <id>]` is line mode and also serves piped
  input (slash input stays local: `/status` answers locally, unknown commands are reported, never sent to the model); `terminal status|chat-plan|snapshot` are one-shot JSON/text reads. Ink/React are Core runtime
  dependencies pinned exactly; `NO_COLOR`, `--no-color` and non-TTY stdout render without colour.
- **Chat is one governed model invocation per turn:** the `terminal.chat` config section names a declared
  catalog model and `maxCompletionTokens`; catalog revision and binding are read per turn; the turn goes
  through the runtime model client in the caller's `--scope` (same path as `models invoke`), so principal,
  policy, activation and spending apply. Abort (Esc, or Ctrl+C while busy) stops the wait and requests
  cancellation of that invocation. There is no direct/unmanaged HTTP backend and no silent fallback.
  **Streaming (S-STREAM, implemented end to end 2026-09-24):** `streamTerminalChatTurn` yields the surface
  `TurnDelta` contract over runtime protocol `invokeModelStream` (since v11): the same governed invocation as `invokeModel`
  (authorization, activation, reservation before send, settlement, durable command replay), answered by ordered delta
  frames and exactly one ordinary response frame. Delta frames are presentation: each ≤ `service.responseMaxBytes`, all
  together ≤ one more `responseMaxBytes`, coalesced per event-loop turn; when exhausted they stop for good, so the client
  always holds a prefix and completes the answer from the recorded result. This is an upper bound on buffered delta bytes,
  not strict per-write backpressure: the send loop may continue after a socket write reports a full buffer (Astra 2054). A replayed command sends no deltas and never
  reaches the provider again (a concurrent duplicate gets the pending receipt without deltas, engine-tested; the terminal
  composition reports that as `TERMINAL_CHAT_INVOCATION_PENDING`: still running elsewhere, recorded, not failed). Disconnect
  stops delivery only; the client sends the same governed cancellation command as the plain turn (the peer's session
  ends with its connection, so the service cannot cancel on its behalf). `openai-chat-http` v4 accepts `stream: true`
  with required `stream_options.include_usage` and parses SSE incrementally with the same deadline, redirect, model-match
  and tool-call rules; `responseMaxBytes` bounds the retained evidence prefix and the assembled `chat.completion` (with a
  wire digest in a `deckent_stream` block — the native object of a streamed call is assembled provenance, never the
  provider's verbatim body), and total wire bytes are bounded at 16× it plus 1024 bytes per requested completion token (4× the
  measured vLLM framing), so a long legitimate answer is not rejected after it was billed (an allowance, not a guarantee for
  every provider's framing); the bound limits bandwidth, not memory. The first invalid chunk (malformed, tool call, model change, usage over budget, data after `[DONE]`) ends the read
  at once and closes the connection (whether a remote provider then stops computing or billing is not proven by it); its
  cause is recorded only when every observed byte
  is retained (evidence `complete` means that, not that the provider finished), otherwise the reason is `response-limit`,
  because a semantic rejection cause is only claimed with complete evidence (S decisions, Jev aac0af98/e2faa91b).
  A stream without `[DONE]`, finish and usage is interrupted (uncertain, never retried). Streamed text is withheld while it could still begin an echoed bearer credential.
- **Rendering (P3, unit `surfaces/core/terminal-render`):** a pure `renderAssistantStream(state, delta, now)` state
  machine feeds the workline: a stream segmenter emits finished units (prose line, list item, quote, heading, whole fenced
  code block or table) to `Static` scrollback as they complete and keeps only the unfinished tail live (an unclosed
  fence renders live, is chunked into scrollback past 200 lines and is flushed on `done`, fixing the legacy freeze);
  a dependency-free markdown renderer (headings, emphasis, inline code, lists, quotes, links as label + URL, fenced code
  with a small built-in highlighter for ts/js/json/py/sh/sql/diff, width-aware tables, diff colouring) produces a span
  model resolved through the palette (`none` tier = no colour, ASCII glyph set). Reasoning deltas are narrated in one
  muted live line (tokens, seconds) that collapses to "thought for Xs" when the answer starts; reasoning text is never
  stored or sent back as history. A turn footer shows elapsed time, tokens and truncation/cancel/failure. The status row
  is one width-fitted line (scope · model · state · elapsed · queue · notice, dropped by priority, never wrapping).
- **Units (2026-09-24):** `terminal-kit` (palette, slash registry, `TurnDelta` stream contract) ← `terminal-render` and
  `terminal-composer` ← `terminal` (workline, ledger, work surface); split by responsibility to keep each unit within the
  2000-line budget.
- **Local/free models** use `openai-chat-http` v4 with an operator-declared `operator-static` tariff (v1: zero rates only).
  The quote is reserved against the scope budget and a responded call settles `settled-local 0` in the spend ledger;
  there is no unmetered bypass class. Positive chargeback rates need a separate measurement basis.
- **Ledger:** run/worker rows come from the same inspection handlers as `run inspect`/`workers list`.
  `/runs` reads that same inventory page and appends one inspection card per id; it does not create or cancel a run.
  Chat text is not run truth. Watches are single-flight polls with bounded memory. The Ink `Static`
  printer only appends; compaction starts a new epoch so rows past any count keep printing.
- **Work surface (P4, 2026-09-24):** worker cards and a bounded live panel (dynamic region, shown while `/watch-workers`
  runs, fed only by that single-flight poll or `followWorkers`) render one line per worker from the `activity`/`usage`
  of `inspectWorkers` (`worker 2 · claude <model> · editing src/x.ts · 12 s ago · 18.4k tokens (cache 83%)`): phase text
  from `cli.worker.phase.*`, age = observation time − host `receivedAt` (never `atMs`), truncated/dropped markers, a
  finished/failed session labelled "worker reported"; `starting` with unmapped events is muted progress, not an error.
  `/transcript <n|attempt>` reads the sealed transcript through the `task transcript` producer (`read-output`; denial
  and unsealed attempts are visible). `/approvals [n|id]` lists pending items via the runtime `listApprovals` and opens
  one y/N card; the decision goes through the runtime `decideApproval` (same peer-authenticated live-session path as
  `approvals decide`). Only a single typed `y` approves; `n`, Enter, Esc and Ctrl+C deny; there is no remember/always key and
  no auto-approval. Pending approvals are announced on the heartbeat (one bounded page per tick, rotating), on by
  default whenever approvals are wired, never more often than every 10 s (lead integration decision; tests may override).
  `/cancel <runId>` inspects the run, asks y/N and calls the `run cancel`
  handler against the inspected revision. Read-only commands never prompt; an open card owns the keys.
- **Local inference serving** (`inference_serving`, `deckent inference plan|budget`) is a separate
  configuration card: pure capacity/launch estimates with loopback-only publish. `loopbackMetricsUrl` only
  derives a loopback `/metrics` URL. `deckent inference metrics` reads that URL through the bounded
  inference-metrics adapter (loopback only — the name `localhost` is resolved and every answer must be a valid 127.0.0.0/8 or `::1` address before contact, then connections go only to the checked addresses, in answer order after a connection failure; one total deadline covers resolution and every attempt, and a late answer starts no connection — the profile's metrics limits, no redirect follow) and never
  through a surface fetch. Deckent does not start the server. `previewEmptyInferenceSlot` is an empty-budget estimate and
  is not Run admission. MCP `inference_plan` and `inference_budget` are the same read. The Desktop bridge
  snapshot carries work rows only (no chat content) and is not a live file channel. Watches stay
  single-flight polls unless the ledger `followWorkers` / `followRuns` port is connected.

Domain cannot import platform or other packages, host modules or ambient host globals. The purity gate also rejects
composition access to domain decision functions while allowing schema/type wiring; static analysis does not prove
all semantic purity. Surfaces may consume public platform/domain/capabilities/engine APIs and never adapters.
Engine consumes public platform/domain/capabilities contracts; adapters implement engine ports. Composition is the
only layer that wires adapters to applications and surfaces. Cross-unit dependencies and cycles are declared and
gated in `arch.json`; package imports use public `index.ts` barrels and `internal/` remains package-private.

Current compiled entries include the CLI and MCP composition binaries; the CLI starts the local runtime service. SDK, CLI and
MCP share the implemented inspection, activation, installation and runtime-control contracts; capability-specific
linked execution evidence defines where parity is complete. New package names have no compatibility import aliases.


**Agent turn loop (T-L3b, engine core; runtime and terminal wiring below).** `engine/core/agent-turn` `runAgentTurn` runs one turn over ports: a
governed model round (the composition derives the round command id from the turn so a replay never bills twice) → each declared
tool call checked against its JSON schema subset, authorized per call (policy resource `agent-tool`, id = tool name, action
`invoke`; `deny` and `require-approval` are typed results, never bypassed — tool approvals arrive with T-L4) and executed → results
back to the model → next round, until the model answers without tools, the user cancels, or a round has no answer. No round, call
or time budget (owner 2026-09-24). Every call emits `tool.started` (display target) and `tool.finished` (status, ms, bytes); the
turn ends with one `done`; a turn without a model answer (reasoning spent the output budget, a round rejected/unknown, cancel) gets
an engine-written closure note instead of silence. Identical read calls in one turn are answered with a reference to the earlier
result, other classes are never deduplicated. The runtime operation, context admission/compaction and terminal rendering are
implemented in the slices below; the T-L5 review limits remain open.
**Durable agent turns (T-L3b2, ledger v37, Astra 2074 D3).** `runDurableAgentTurn` claims `(scopeId, turnId)` before any round:
the turn id is bound to the principal key and the composition's request digest. A new id runs the loop; the same request of the
same principal after the turn finished returns the stored outcome (the last answer and `done` are re-emitted, no model round);
while it runs a second claim is `AGENT_TURN_IN_PROGRESS`; a different request or principal is `AGENT_TURN_CONFLICT`; a row whose
state and record disagree is `AGENT_TURN_CORRUPT`. Every settled tool call is recorded (round, index, call id, tool and version,
arguments digest, display target, status, bytes and result digest — not the result text); a finished turn accepts no further
call or finish. The turn is finished with its outcome even when the loop throws (a store failure never masks the loop's error);
an answered turn whose outcome could not be stored is returned with `recorded: false` and stays running until the next start.
Turns left running by a stopped service are closed as interrupted (`error` with a fixed note) by `interruptRunning`, never
resumed; a damaged row is reported and left as it is without blocking the others. The service start wiring (after exclusive
socket ownership, like the ledger upgrade) runs at every `runtime serve`.
**Runtime agent turn (T-L3c, protocol v12, Jev 9df04efb).** `chatTurn` runs one durable agent turn inside the runtime service:
the principal comes from the connection; the model, `maxCompletionTokens` and tools from fresh configuration (`terminal.chat`);
the client sends only its history ending with the new user message (untrusted context, bound to the turn id by a digest over
history, model, catalog revision, binding, completion limit and tool list). Every round is the existing governed invocation under
`commandId = sha256('turn-round:1', scope, turn, round)`; its failure closes the turn with the typed code in the note. Tools are
declared to the model only when its binding declares `tool-calls`; each call is decided by `AgentToolPolicyAuthorization`
(`agent-tool`/`invoke`, id = tool name; an unreadable policy is `deny`) and runs as a workspace read tool on the project. The answer
streams as v12 **event frames** (`text`, `reasoning`, `tool.started`, `tool.finished`, `usage`, `message`) followed by one response
frame with the bounded `ChatTurnResult` (finish, note, rounds, tool calls, the final answer when it fits the replay bound and the
delivery, `replayed`, `recorded`). Event frames are required data, not presentation: the client's history continues from exactly the
`message` events. Each frame is bounded by `service.responseMaxBytes`; the stream as a whole is not (no turn budget); the loop waits
for the peer to drain before each round and tool call, and at most `4 × responseMaxBytes` may wait unread before the turn is
cancelled; an event that cannot fit one frame cancels the turn instead of being dropped. A peer that disconnects cancels the turn
at the next write (a Unix peer that closed after its request is not visible earlier); `cancelChatTurn` of the same principal
cancels at once (another principal's turn, or an unknown one, is `not-running`); service stop cancels running turns. Stores:
`agent_turns`/`agent_turn_tool_calls` (T-L3b2). Errors: `AGENT_TURN_IN_PROGRESS | CONFLICT | CORRUPT | INVALID | UNAVAILABLE`.
Reading tools needs an explicit policy grant (`agent-tool`, ids `read_file`, `list_dir`, `grep`, `glob`, action `invoke`);
without it every call is `denied`.
**Terminal agent turns (T-L3d).** The interactive terminal's turns are `chatTurn` turns (`streamTerminalAgentTurn`): a fresh turn id per
turn; service events become surface `TurnDelta`s — `tool` (started, then finished with status and duration; the target carried from
the start), `message` (history, never rendered) and `done` with the engine's closure note. Each finished tool call prints one line
(`name target · seconds · status` when not ok); the running call shows a live spinner line; text before a tool call is printed first;
a later round's reasoning starts a fresh narration; the footer sums completion tokens over rounds and shows the note. The next turn's
history is exactly the previous turn's `message` events; the history window (until T-L5 token admission) starts at a user message,
so a tool result never loses its call, and keeps the newest exchange whole. Aborting (Esc/Ctrl+C) sends `cancelChatTurn` at once.
Line mode (`terminal session`, piped) still sends plain governed invocations without tools.
**Context measurement and admission (T-L5a, protocol v13, Jev 90c2e32b).** Before every round the loop measures the prompt once and
every decision reads that one measurement: the `context` event (round, prompt tokens, window, quality), admission, and — with T-L5b —
compaction. Measurement is the provider's own count of exactly the round's request: `ModelInvocationApplication.measure` runs the
same principal, policy (`invoke`), binding, activation and profile checks as `invoke` (shared `admittedTarget`), then the native port's
optional `measure` — no claim, receipt, spending or model execution. `openai-chat-http` counts through a same-origin
`tokenizeEndpoint` (vLLM-style `POST /tokenize` with the same model, messages and tools the round sends), only when the binding
declares `token-count`; its own deadline is 2 s + 250 ms/KiB (≤ 30 s), its answer ≤ 8 MiB, and any failure is `null`, never a failed
turn. Without a counter the prompt is a conservative upper bound (every UTF-8 byte of messages and tools a token, plus 64 per
request, 16 per message, 32 per tool), always labelled `upper-bound`. The window is the smaller of the profile's
`contextWindowTokens` and the provider's report (unknown → no admission decision; the provider stays the arbiter). A round whose
prompt + `maxCompletionTokens` + 2048 safety tokens exceeds the window is never sent: the turn closes with a note naming the
numbers and quality. The footer shows `context [~]N% of W`. v13 also fixes the `compacted` event shape: its `messages` replace every
non-system message the client holds (the client keeps its system prompt); the workline applies it.
**Automatic compaction (T-L5b, Jev 6460731d).** On the same measurement, when a round's prompt + reserves passes 75% of the window,
the engine plans a compaction: the system message and the newest 8 messages (widened so a tool result never loses its call) stay;
the older part is summarized by a governed, tools-off invocation (`turn-compact:1(scope, turn, n)`, the older messages as a bounded
plain transcript, legacy JSON shape: objective, findings, decisions, unresolved, next actions, inspected areas). It becomes one
labelled `user` message: the model-written summary plus the earlier user messages verbatim (each ≤ 4000 characters, cut with length
and digest) and the earlier tool calls, both copied from the history, never from the model; it is context only and grants no
authority. The turn emits `compacted` (surface: one line "N earlier messages were summarized"), measures again and applies
admission. A failed or unreadable summary keeps the history unchanged and closes the turn with a note; nothing more is sent. Open:
no deterministic model-free fallback yet, and a newest exchange larger than the window cannot be compacted (admission then refuses).
**History lifecycle and bounded turn memory (Astra 2091 fix, Jev 4a702440).** The interactive workline's agent path sends the whole
conversation (no message-count cut; `terminal.chat.historyMessages` now bounds only the plain line mode); the runtime owns its
lifecycle. Compaction is also triggered when the exact serialized history exceeds 75% of the service input bound
(`service.inputMaxBytes`, passed by the composition as `admission.requestMaxBytes`), so a conversation keeps fitting the client's next
request even when the window is unknown. The loop keeps no copy of appended messages: the result carries the final answer, a count and
the incremental digest (same value as the digest of the whole array); a replay appends nothing (count 0, recorded digest). Read dedupe
answers only with a result the model can still see: a compaction drops entries whose result left the prompt, and a successful
non-read call clears it. Open: a `compacted` event must fit one event frame (`service.responseMaxBytes`); a tail of very large tool
results, or a summary copying many long user messages (each ≤ 4000 characters), can exceed it and then cancels the turn (fail
closed, not silent); and a tail that alone stays above the high-water mark is summarized again every round (billed, no progress;
candidate guard: skip when the last compaction did not shrink the history). The byte check needs no counter port. Evidence: engine repeated-compaction/edit/byte tests, real service byte-bound compaction, workline → service →
session snapshot → `/resume` with 44/46 messages sent whole; mutations 1–7 (`proof/F26-T-L5-FIX-2091/`).
**Conversation sessions (T-L5c, Jev 9ae569b1).** The workline saves the whole current history (system prompt excluded) after every
turn as one snapshot per session in the managed `terminalSessions` directory (`openTerminalSessionStore`: owner-only 0600, no-follow,
atomic temp + rename, known secret shapes redacted, at most 50 sessions and 16 MiB each, oversize refused before redaction). A
compaction simply rewrites the snapshot, so a resumed conversation can never carry pre-compaction messages twice (legacy defect).
`/resume` lists this scope's recent sessions and `/resume <n|id>` continues one (its messages become the history; later turns save
into it); `/new` starts a fresh session; `/context` shows the latest measured prompt against the window. Snapshots are client
context, never authority; they follow the composer history switch `terminal.persistHistory`. The shared credential redaction's URL
pattern now bounds the scheme (`{0,31}`): the unbounded form backtracked quadratically on long letter runs (80k chars: 2.7 s).
**Operation-keyed approval for agent tool calls (C12 minimal, T-L4 slice 1, Jev 9266755b, ledger v38, protocol v14).** An approval
request is a union: task admission (schemaVersion 1, unchanged, so every sealed record verifies byte for byte) or an operation-keyed
request (schemaVersion 2) whose `subject` is `agent-tool-call` {turnId, round, index, tool, toolVersion, resource, argsDigest}; its
action digest (`agent-tool-call:1` over scope + subject) makes it call-exact and single use (never renewed; the next call opens its
own). Ledger v38 rebuilds `approvals` with `subject_kind`, nullable run/task and a per-(scope, action digest) index for tool calls.
When policy says `require-approval` for an `agent-tool` call, the turn opens the request (the agent turn is an approval producer and
creates the integrity key on first use, like Run reservation), emits `approval.requested` (call id, approval id, revision, audit
summary `tool · resource · digest`, presentation preview ≤ 16 KiB, expiry = `approvals.requestTtlMs`) and waits (store polled every
250 ms) until the existing `decideApproval` (session-authenticated, `approval`/`decide` grant) decides it, it expires, or the turn is
cancelled — expiry and cancel close the request as `expired` through the one sealed pending → expired transition (shared with lazy
expiry). A failed close is re-read: a record another writer already settled is authoritative (at expiry a decision committed first is
returned; a cancelled turn still runs nothing); a record still pending or unreadable after 3 short attempts is `APPROVAL_UNSETTLED`,
never reported as closed. Once `approval.requested` went out, `approval.settled` always follows; its outcome adds `unsettled` (v14
amended before release, no v15: no v14 peer was ever shipped), and the terminal closes the card and says the pending request permits
nothing and closes at its expiry or the next service start. At start, under endpoint custody and after interrupting turns, every
still-pending tool-call approval is closed as expired in bounded pages (task approvals untouched; an unverifiable record is counted;
a missing integrity key is reported, never created); the host reports `tool-call-approvals-expired`. An allow is followed by a fresh policy
evaluation (a deny since the request wins). Outcomes are typed call results: `ok` after the run, `denied` (owner or policy),
`approval-expired`, `cancelled`, or `approval-required` when no approval could be obtained; nothing but an explicit, re-authorized
allow runs the call. The terminal shows the request on the existing decision card (summary, preview up to 24 lines, expiry; a single
`y` allows, every other key denies) and closes it when the approval settles elsewhere; a late answer to one decision closes only its
own card, never a newer call's (Astra 2092 R1). v14 also carries `tool.output` for slice 3.
**Agent file edits as C11 effects (T-L4 slice 2).** `edit_file` (exact `old_string` → `new_string`, unique unless `replace_all`; no
`$` pattern interpretation) and `write_file` (whole content) are declared beside the read tools (tool class `edit`). Policy is
asked first (a denied call is answered before the file is touched, so its result never depends on content); then the loop's
`prepare` port plans the call from the file as it is: resolved workspace-relative path (normalized,
inside the root, not denied, parent not a symlinked directory), the file's version (sha256 of its bytes, or `absent`), the new
content and a bounded unified diff (LCS ≤ 4M cells, else summarized); a plan error is the call's result and nothing is asked. The
call's decision is the stricter of the `agent-tool` decision and the `operation` decision for `workspace.file.write` (`execute`), and
the write floor (`.github/**`, CI files, hooks, package manifests, `.deckent/**`, agent configuration, `AGENTS.md`/`CLAUDE.md`,
`Makefile`, `Dockerfile`) raises `allow` to `require-approval` in every mode; an approval shows the planned diff. The write is one
C11 effect of the Core `workspace.file.write` operation on the `workspace-file` target (record id = the workspace-relative path,
resolved only through the workspace scope): live peer session, operation policy re-evaluated right before the effect, intent
before effect, precondition = the planned version (a file changed since it was planned or shown is refused, nothing written),
atomic write (exclusive temporary file in the same directory, fsync, directory re-verified, version re-checked, rename, directory
fsync; mode kept). Each attempt journals its own phases under the wire key (journal v2, atomic, 0600, managed `fileEffects`
directory; Astra 2094 R1): `prepared` with a unique temporary name before that file exists, `committed` after the rename, `aborted`
before the temporary file is removed, `escaped` when the parent left the workspace during the write. Crash settlement decides from
that evidence, never from content equality alone: committed → applied (even if the file changed later); aborted or no journal →
absent (resend; a stale temporary file of the earlier attempt is removed first); prepared with its temporary file present → absent;
prepared with it gone → applied only at `next`, else unknown; escaped, unreadable or a retired v1 journal → unknown — never a blind
retry. After the rename the parent is verified again: a directory moved out of the workspace meanwhile is journaled `escaped` (with
where it went) and the effect is unknown, never reported as done, and nothing is written again to undo it (Astra 2094 R2: detection,
not prevention — Node has no openat2/renameat; a same-user process, including the planned unsandboxed host shell, can move directories;
the confining mechanism is an owner decision, see PLAN). Approval previews are bounded to 16 KiB UTF-8 bytes (whole lines first, never
a split character) under a first-line marker naming what is not shown and the sha256 of the whole text; a cut edit diff is kept whole,
owner-only (0600, exclusive, not redacted: it must be exactly the change approved), in the managed `approvalPreviews` directory while
the approval is pending, removed when it settles and swept at service start (Astra 2094 R3). The effect's approval gate admits a
`require-approval` decision only for the command the owner approved in this turn. Not excluded: another writer between the final
version check and the rename (no advisory locks). `adapters/core/sqlite-agent-turn` stores `agent_turns` and `agent_turn_tool_calls` in the ledger.
Astra review of `95c3a14` + `6a53765` (2026-09-26, 2094): content-equality recovery, the moved-parent write and the unbounded preview —
corrected locally as described above (R2 as detection pending the owner's isolation decision); awaiting Astra re-review.
Astra review of `e6085ca` (2026-09-26, 2092): swallowed close failures and a late answer clearing a newer card — corrected locally
as described above; Astra re-review of `7e0e349` (2095) confirmed both original corrections with 71 targeted tests. The subsequent
observer-dependent startup recovery defect is corrected in `a4604fc`: recovery runs before optional notification. Astra 2097
re-review confirms observed/unobserved starts both expire the orphan, and a missing integrity key leaves it pending, reports
`keyUnavailable` and creates no key (3 fresh real-service tests). This scoped review closes 2092/2096; T-L5 and file-write findings
remain open, and full verification/deployment acceptance are separate.
**Allocation without a lifetime total (T-L3a, owner 2026-09-25, ledger v36).** A model invocation profile's allocation may set
`maxCalls: null`: no lifetime total of calls, an explicit and audited profile choice (the local terminal profile can use it;
live activation is pending, API profiles keep theirs). `maxInFlight` still bounds concurrency, and policy, activation, provider availability and spending authority
still apply. The allocation contract of an id is fixed: changing its limits is `MODEL_INVOCATION_ALLOCATION_CONFLICT`, so a profile
moves to an unbounded allocation under a new id; existing receipts keep verifying against their own allocation. Ledger v36 rebuilds
`model_invocation_allocations` row for row with a nullable, positive-when-set `max_calls`.
**Tool calls over openai-chat (T-L2).** `openai-chat-http` v4 sends `tools`/`tool_choice` and accepts assistant `tool_calls` and
`tool` messages only when the model binding declares the `tool-calls` capability as supported (catalog data); otherwise any tool
call is refused as before. Responses may carry calls only to declared tool names, with unique ids and `finish_reason:
tool_calls`; the legacy `function_call` is never accepted and `tool_choice: none` forbids calls even with tools declared (Astra 2079). Streamed calls are assembled by index (fixed id, name and arguments in
pieces, contiguous indexes) and pass the same check; a streamed name that no declared name can still match stops the read and presentation at once; a cut stream is interrupted
(uncertain) and yields no call. Arguments stay the provider's raw text: invalid JSON is the loop's typed tool error to the model.
The loop sees the provider-neutral `AgentToolCall` (`id`, `name`, `argumentsJson`); native details stay in the native result.
Review limit (2026-09-25): `tool_choice: none` is not yet enforced on responses, and an undeclared streamed name with a tools
list is rejected only at finish, allowing later text deltas. These are open adapter checks before T-L2 acceptance.
**Agent terminal direction (owner 2026-09-24) and tool contract (T-L1).** The terminal becomes a Claude Code-class agent
terminal: one full-context model, an engine-owned governed tool loop, permission modes, Deckent tracking and management through
commands, queries and MCP, no terminal budgets (automatic compaction for an endless flow), local model first and API providers
after; the local vLLM worker lane is separate. The shell runs on the user's machine with permission modes — a policy/permission
boundary, not an isolation claim. Tools are data (`domain/core/agent-tool`: name, version, class `read|edit|shell|deckent|mcp`,
JSON input schema); a tool never grants authority. T-L1 ships the read class as `adapters/core/workspace-read`, ported from the
legacy native tools minus their defects: `read_file` (bounded content view from line 1 for a plain path, `outline` with headings
and size/longest-line statistics, numbered ranges with long-line elision naming the exact `lineByteOffset` continuation, search),
`list_dir`, `grep` (long lines are searched and elided, skipped binary/oversized files are reported instead of a bare "no
matches"), `glob`. Every result is byte-bounded by the tool itself (16 KiB default) and states any cut; fitting results into the
model context is the loop's job in one token unit. Reads resolve the real path inside the workspace (traversal, absolute paths and
symlink targets outside are refused), a Core deny floor (`.env*`, keys, credentials, `.git/**`, Deckent host/approval/audit state)
is registry data, generated directories are skipped. **Boundary under races (Astra 2072):** every open walks the real path's
components from a root descriptor (`/proc/self/fd/<fd>/<name>`, openat semantics) with no-follow on each component and re-checks
the opened descriptor's own path, so a parent or root swapped for a symlink after the check is refused; files with more than one
link are refused (a hard link can alias a protected file); files open non-blocking and must be regular, so FIFOs and devices never
stall the service; walks list directories through their descriptors and count what they could not cover (depth > 32, unreadable,
changed, special files) instead of reporting absence; every directory and file opened during a walk is re-verified against its
workspace path too, so a parent moved out mid-walk yields a refusal, not its outside content (Astra 2078). Globs (the glob tool, grep's
filter and the deny floor) are matched by a dynamic program bounded by pattern × path length, never by a backtracking regex; glob
patterns are capped at 512 bytes. A descriptor verified at open is read as that object even if it is moved afterwards. Regular expressions run in a worker thread that is terminated on cancel, the
signal reaches every tool, and every result branch is cut to the cap with a stated marker; path/pattern arguments and limits are
validated. The guarantee is Linux-only (WSL included); other platforms fail closed until they have an equivalent. Engine per-call
authorization is not wired in T-L1; the read adapter is not an admitted terminal execution surface by itself (T-L3).
Review limit (2026-09-25): walked child/file descriptors still lack the path recheck after a directory moves outside the scope;
glob matching (including grep's glob filter) still runs on the service thread and can block cancellation. The direct-file,
content-regex, byte-cap and incomplete-walk fixes do not close these two remaining branches.

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

The Markdown gate admits five documents: `README.md`, `ARCHITECTURE.md`, `PLAN.md`, `COMPLETED-PLAN.md`, `CHANGELOG.md`;
≤70-line permanent product-development contracts `CLAUDE.md`, `AGENTS.md`;
≤5-line pointer `.codex/AGENTS.md`; `.deckent/docs/core-memory/*.md`;
and the explicit refactor host-kit globs in `arch.json`: the remaining 23 `.agents/skills/<skill>`
directories/references plus `.claude/agents`, `.claude/rules`, `.codex/rules`.
The host kit is excluded from product distribution (`package.json files`: dist/native/assets/README/LICENSE).
Product code still writes no Markdown; owner-maintained host instructions are a development-only exception.
Design reasoning goes into the decision log below, not arbitrary new documents.
Owner 2026-09-21: `follow-up-works/current-flow.md` is an optional, replaceable development tracker;
its exact path is admitted by the Markdown gate, excluded from product distribution, and may be deleted.
PLAN.md retains durable roadmap/decisions, remaining work and material open findings; owner 2026-09-24: completed work
and closed findings move to COMPLETED-PLAN.md (read only when history is needed), so PLAN stays short. Small work/history
lives in the transient tracker and external refactor archive, not an append-only product plan.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-09-22 | Operator **Terminal Contract v1**: regions, motor-agnostic events, colour tiers, Ink + line adapters; every chat turn is a governed model invocation in the caller's scope; chat ≠ run ledger. | One contract across Terminal/MCP/Desktop; Ink is the Node rich-TTY adapter, not product authority. Integration removed an unmanaged HTTP chat path and a global Run-capacity cap found in review. |
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
`artifacts.patchPreview` config bounds entries, depth and path bytes.

Owner 2026-09-22 (B05 finding 3): the base tree is listed once (`ls-tree`: paths, modes, object ids, sizes) and
compared with the descriptor-relative workspace read by Git blob id (`blob <size>\0` hash with the repository's
algorithm); only changed, added or removed paths read base content, one bounded `cat-file` per changed blob.
Candidate preparation and verification likewise validate `before` entries against base object ids and prove the
candidate equals base + patch by the same hash-diff; manifest digests still cover the whole candidate read.
Exhausted Git output/time bounds and scan budgets are typed `PATCH_LIMIT` with a bounded `detail`
(`git-output|git-timeout|time|bytes|entries|depth|path`) surfaced as error params; `PATCH_UNAVAILABLE` means
missing custody or Git. `execution.git.outputBytes` defaults to 4 MiB, sized for tens of thousands of tracked
paths; the workspace itself is still read in full (twice) within the byte budget.

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

**Worker Event Contract (B09-1, 2026-09-23, ledger v35).** One current schema (`domain/core/worker-event`,
`schemaVersion` 1; there is no user-selectable variant — a new version replaces the contract with a migration):
`session.started`, `message` (size + ≤240-char redacted excerpt; thinking content never kept), `tool.call`
(tool class read/edit/write/shell/search/network/agent/other, workspace-relative target), `tool.result`,
`usage`, `quota`, `limit`, `session.ended` (provider totals authoritative), `unmapped` (counted native types)
and host-only `dropped`. The provider normalizer and redaction run inside the container bridge, so raw native
stream, credentials and paths outside `/workspace` never reach the host. The per-attempt gateway accepts
`POST /events` only after bootstrap, validates every line against the schema, enforces strictly increasing
sequence and batch/event/byte caps, and replaces rejects with a counted `dropped` marker. **Hardening (Astra 2044):**
the gateway re-applies redaction to every free-text field on the host with the credential values it projected plus the
generic secret patterns (the bridge scrub is best-effort; a hostile worker can POST schema-valid text directly); loss
markers are charged to the same event/byte budget, one slot stays reserved, and once the budget is spent batches are
refused (429) without parsing and counted as unreported loss, sealed as one final `dropped` marker; the seal record says
`projection: partial` when the live `worker.events` file missed writes — a write that stays short after bounded retries,
a zero-byte or rejected write, or a failed close (Astra 2054 R4); observation loss never fails the attempt. The host appends
`{receivedAt, event}` to `worker.events` (0600, host clock only; worker clocks are untrusted) off the request
path; at attempt end the events are sealed as an artifact and recorded in `worker_event_logs`. Summary
(tokens, cache-read ratio, cost basis, tool classes, files touched, errors) and the live activity phase are
pure recomputations from events — no model call, no scoring. `task transcript` (SDK/CLI) needs attempt
`read-output`. Events are untrusted worker evidence: they never grant authority, acceptance or terminal truth;
failure to record or seal never changes execution. Claude and Codex are normalized (Codex `exec --json`: thread/turn/item
events of the pinned 0.155.1 CLI — command executions are shell calls, each `file_change` path is its own edit/write call,
agent text is a redacted excerpt, reasoning and command output are never kept, cached input tokens are counted apart, one
turn ends the session; shapes follow the pinned Codex 0.155.1 SDK item types, not yet a recorded live run). Every carried
field, unmapped type names included, is redacted before bounding; unknown kinds and statuses are counted as unmapped and never
become success; malformed nested data is counted, and the bridge's line observer never lets a normalizer or delivery fault reach
the child process listeners; a file_change attributes up to 512 paths and counts the rest; tool ids are stable, bounded digests
when the native id is long or unsafe (Astra 2066). Cursor reports only
`session.started` and unmapped counts until its normalizer lands. Structured final report, budgets (B09-2),
`report workers` and live `workers watch` phases (B09-3) remain open.

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
Wall and monotonic deadlines plus revocation are checked before mutation. The trusted wall clock never runs backward within
one process (a floor over observed time; WSL2 was measured stepping back ~2.1 s every ~30 s) and a decision is never
earlier than its approval's creation; this orders local records only — it does not synchronize processes or keep expiry
advancing during a backward step, so elapsed-time limits use monotonic deadlines and cross-process skew stays explicit.
This Linux local witness
is not remote bearer authentication; `token-verified` remains an extension port, not a shipped verifier.

A replacement integration command explicitly names its predecessor and prepares a separate candidate;
it never adopts the old directory or declares its writer dead. Git delivery has its own policy action
and live session check. It records intent in ledger v32, builds a deterministic commit from retained
patch bytes using a private index, and atomically creates a dedicated `refs/deckent/deliveries/` reference
while verifying source HEAD. Source branch, index and working files are not modified. Exact ref/commit
custody reconciles a crash after Git publication before ledger settlement. Receipt replay is historical
evidence, not verification of today's ref. Checked-out branch adoption and live-worktree merge remain
separate operations; `reference-only` delivery does not claim either or accept the Task.

Branch adoption (B06-1, ledger v33) moves one operator-listed branch (`execution.adoption.targets`, empty by default) from
the delivery base to the delivered commit with a Git compare-and-swap. It requires the completed delivery with its reference
intact, the recorded Task acceptance of that exact attempt, an existing branch at the base that no worktree has checked out
(checked explicitly: `update-ref` does not refuse it), its own policy action and a live session. A changed base is refused.
Intent precedes the Git effect and an unsettled record blocks the target. Each target has a fence reference
(`refs/deckent/adoption-fences/<sha256(target)>` → deterministic blob naming target, sequence and command); one `update-ref`
transaction moves the branch and advances the fence from the previous sequence, so a stale duplicate of Deckent's own command
cannot move the branch after newer records (Astra 2039). Crash settlement reads exact fence ownership: this record's fence →
settle only; previous fence with the branch at the base → move; anything else, including a foreign writer placing the same
commit, is a conflict. A new effect re-checks the current allow-list. Rollback CASes back to the previous tip only while the
adopted commit is still the tip and no later record exists. The basis is Task acceptance, reported as `not-verified`; a
verification Run on the adopted commit (B06-2) and live checkout/runtime activation (B07) are separate. Git writers outside
Deckent under the same OS user and a checkout racing the observe→update-ref window are not fenced; a record that can no longer
complete keeps the target blocked until operator recovery (no abandon command yet).

### Cancellation settlement — owner 2026-09-22 (implemented)

Cancellation is durable intent plus a deterministic terminal transition owned by the run reducer. `cancelRun`
propagates intent to bound attempts and, in the same transaction, prevents attempts that have no dispatch record
(`preventRunAttempt`, reason prevented-before-launch) and settles attempts that already exited but were not yet
evaluated (`settleCancelledRunAttempt`). A worker killed after cancellation settles to `cancelled` when its
terminal exit is projected (`finishDispatch`), never on the kill command alone. Claimed-but-ungranted dispatches
are prevented by the launch decision; running, unknown or unresolved-effect attempts stay with delivery and the
reconciler. `reconcileAttempt` and cancellation delivery apply the same idempotent store settlement and report it
as `settlement`; accepted/failed tasks are never re-marked; no observation is fabricated and nothing is retried.
Pool occupancy counts only active/evaluating/uncertain tasks, so `cancelled` releases capacity. Run-level closure
of still-pending tasks in a cancel-requested run remains a separate transition.

### Worker toolchain currency — owner 2026-09-22 (report slice implemented)

Workers must run the current version of the interface that invokes them; the first slice is an honest report, not an
update. A versioned catalog (`engine/core/toolchain-currency/internal/catalog.json`) names each provider's distribution
mechanism: Codex and Claude Code are npm packages with documented self-update controls (`check_for_update_on_startup=false`,
`DISABLE_AUTOUPDATER=1`); Cursor is an installer script with auto-update on and no documented version endpoint, so its
currency is `unsupported` until a vendor mechanism exists. Admitted versions are the durable preflight pins of prepared native
profiles in the admission registry. `doctor --toolchains` (CLI), `inspect_toolchain_currency` (MCP) and
`inspectToolchainCurrency` (SDK) read `<toolchains.currency.registryEndpoint>/<package>/latest` once per package with a
timeout and response cap, no credentials, only when `toolchains.currency.mode` is `report`; default `doctor` stays network-free.
Statuses: `fresh | stale | ahead | unparsed | unknown-offline | unsupported | disabled | not-admitted`; failures carry a bounded
reason code. Nothing here activates, rebuilds or updates a worker; policy-driven rebuild (next image version, preflight, new
profile revision, in-flight Runs keep their imageId) and API capability snapshots are the following slices.

### Worker toolchain update policy — owner 2026-09-22 (propose/auto slice implemented)

`toolchains.update` is policy data: `mode off | propose | auto` (default propose), `buildTimeoutMs`, `outputBytes`, `atStartup`.
`toolchains update [--apply]` (CLI), `update_toolchains` (MCP) and `updateToolchains` (SDK) run the currency report and, when an
npm provider is stale, plan exactly one next image version (`r<N+1>-<day>`, newest-first history line, recipe delta) as a typed plan
under `<workspaces>/toolchains/plans/`. In `auto` mode or with an explicit apply, the shipped builder files are copied into an
exclusive private context `<workspaces>/toolchains/builds/<version>/` with the edited Dockerfile/recipe, run through the bounded
process runner (environment allowlist, timeout, output cap), and the builder's receipt (`receipts/<version>.json`) yields a
profile-revision proposal (`proposals/<version>.json`): exact `cliVersion`/`imageId` changes per affected native profile, marked
`not-applied`. Installed config, policy and package bytes are never modified; the proposal is applied through a new installation
profile revision, so in-flight Runs keep their imageId and previous versions remain for rollback. No new layout resource is added
because the layout revision (part of attempt identity) hashes the resource registry; the toolchains custody lives beside integration
candidates under the workspaces resource. `atStartup` emits the read-only currency report after `runtime serve` is ready and never
builds. Codex workers now run with `-c check_for_update_on_startup=false`; Claude workers keep `DISABLE_AUTOUPDATER=1`; Cursor stays an
explicit unsupported exception.
