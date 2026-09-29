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
  adapters belong to M4. The retired tenant fields and file-isolation helpers are gone (H34 S4): company is a data scope,
  config schema 3, layout registry 4 (SCR-A, owner 2026-09-28: `scratch` resource), doctor JSON 2; older versions are refused with a
  typed error, never converted.
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
  The agent's scratch area is the layout resource `scratch` (`state/scratch`, registry v4): `<owner>/<session>` where owner =
  sha256(scope, principal issuer+subject) and session = sha256(conversation id | turn id), 32 hex each (no identity text in paths);
  directories 0700 created one component at a time from a descriptor, never through a link; files written by `scratch_write` 0600.
  Inspectable by path-query (`inspect layout` lists `scratch`).
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
- **Unreleased versions change in place (owner 2026-09-26, Jev f4c8bc32).** A protocol, schema or config version that was never pushed and
  is run by no installed service may be amended in place; once pushed or run by an installed service, a change needs a version bump.
  Recorded amendment: runtime protocol v14 gained the `approval.settled` outcome `unsettled` and the `tool.output` producer before v14
  was pushed (2026-09-26, `5fa0812`); the live service still ran v13. From `5fa0812` on, v14 is released: further changes bump. v15 was introduced 2026-09-27 (T-L5 `@file`) as the single v15 package
  (owner 2026-09-27); it is unreleased until pushed, and the remaining v15 items add to it without another bump. v15 was pushed and runs in the live service (released). v16 was
  introduced 2026-09-28 (OPEN-REASONING-FILE, owner) as the single v16 package: `chatTurn` gains the optional `reasoning`; it is
  unreleased until pushed, and further v16 items add to it without another bump. SCR-A adds to v16: `chatTurn.sessionId?` and the
  operations `inspectScratch` / `clearScratch` (`{ schemaVersion: 1, scopeId, sessionId }`, delivery required, current version only;
  the peer is the owner — scope membership read/write, no further grant). `inspectScratch` → path, exists, bytes, files newest first
  (≤ 200, bounded to the delivery), limits; `clearScratch` empties the area and keeps its directory (a shell's TMPDIR stays valid).
  v17 was introduced 2026-09-29 (MODES-3) as the single v17 package: permission-mode names `standart | full-auto | full-access`, view
  `askEdits`/`fullAccess`, command `askEdits?`, `chatTurn.fullAccess?: true`; lifecycle window [17,16]. The owner-approved v17 items
  (question cards, Agent OS catalog, card standing scopes) add to it without a further bump until it is pushed. With it: bindings v3;
  audit event schema 1 (additive kinds `full-access-turn`, `full-access-call`, summary `fetch`; old mode names stay readable); ledger
  unchanged.
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
  credentials yet), SDK `execute|compensate|inspectConfiguredOperation`, CLI `deckent operation`. A required approval goes
  through the operation approval broker (C12 G1/G2, below). Not claimed: any ERP adapter, credentials, registry
  resolution of targets (A04-1/A04-2 done, see below), migration of the five existing flows.
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
Only CLI (including its `terminal` line/rich views) and MCP surfaces are shipped here; the MCP client reaches only the owner's
local stdio servers (MCP-CLIENT); Desktop/HTTP, remote MCP servers and IFS connectors remain targets. Unused translation keys are not handlers or evidence of a shipped surface.

**Startup cost (STARTUP-COST, seventh batch).** A process entry's static import graph is paid on every run. Heavy packages (`ink`,
`react`, `@modelcontextprotocol/server|client`) load only on the entry path that uses them and through dynamic `import()`: the terminal UI
loads with `deckent terminal` / the arg-less TTY opening (`workSurfaceLabels`/`runtimeBuildSkew` live in `cli/internal/work-labels.ts`),
`surfaces/index.ts` offers `loadMcpSurface()` instead of `createMcpServer`, and the MCP client SDK loads with the first MCP server start.
`tests/contracts/composition/startup-graph.test.ts` (on `dist`, static edges only) holds this for the SDK and CLI entries and "no Ink/React/
MCP client" for the stdio MCP entry. Measured by the lane: `deckent --version` 468 → 247 ms, SDK import 311 → 237 ms. Next: the whole
`adapters/index.js` barrel on process entries (remaining cost is ESM compile/resolve); a compile cache is a separate decision.

### Operator terminal contract v1 (accepted target, partial implementation)

The operator terminal is a presentation of the same typed operator actions as CLI, MCP and (later) Desktop,
not a second shell. Principal, scope, resource and policy travel with every turn; persona grants nothing.
Market notes live outside the repo (`/home/alperen/deckent-refactor-work/proof/TERMINAL-UI-LANDSCAPE/`).

- **Regions:** banner, status strip (scope, chat model, busy/cancelling), work ledger (append-only chat,
  run, worker and notice rows), single input owner, hints. **Events:** `slash`, `submit`, `cancel`, `exit`;
  the slash catalog is data (`slash-registry`). **Composer (P2):** the single input owner is a pure reducer plus a
  small Ink view (unit `surfaces/core/terminal-composer`): grapheme/cell-aware caret, readline editing and kill/yank, multiline
  (Shift/Alt+Enter, Ctrl+J, trailing `\`), in-session history and Ctrl+R, atomic paste chips expanded on submit, a
  slash palette (typing filters by prefix, then subsequence; Up/Down select; Enter runs the highlighted command — a command
  that takes an argument completes to `/name ` and waits, a fully typed name runs as typed; Tab completes; Esc closes until
  the text changes; Enter without suggestions sends the text), `?` shortcuts, and an `@file` picker (T-L5, protocol v15: typing
  inside an `@token` opens candidates from the runtime service, debounced 60 ms with earlier lookups aborted; a single candidate is
  offered, never typed for the user; Esc closes it for that text and a late answer never reopens it; Enter/Tab insert the picked path in the form the
  submit parser reads back exactly: `@path ` for a plain name, `@"path" ` when the name has whitespace, trailing sentence punctuation,
  a leading `@` or `"` (only `\"` and `\\` are escapes; Astra 2134 R3); Enter on a typed-out name sends the line only when it is already
  in that form; a quoted query (`@"my f`) looks names with spaces up); it emits `submit`/`cancel`/`exit` intents only. Idle Ctrl+C
  clears a draft or arms exit (second press within 2 s exits); Ctrl+D exits on an empty idle line; while busy
  Esc/Ctrl+C cancel the turn. History and `@` candidates/attachments are ports; the surface reads no files. History persistence is the
  `terminal-history` adapter: private per-project `state/terminal-history.jsonl` (0600, no-follow, append-only, last 500
  entries, compacted when doubled), visible line only — entries that carried pasted content are never stored and secret
  shapes are redacted; `terminal.persistHistory: false` disables it.
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
  in the previous and the current protocol version ([16, 15] since v16; the window moves with each released version) and answered in the request's version; a client retries these two only, once per
  older version, when the connection closed unanswered — so an upgraded terminal can describe and stop a service started
  from an older build (proven live: v11 terminal → v10 service → skew notice → `/service-restart`). A retry resends the same
  shutdown command and instance, never a new one, and every other operation — anything effectful — is current-version only. `deckent runtime shutdown` without command fields builds the governed shutdown command from the live
  descriptor; a service without `service.identity` cannot be stopped that way (`RUNTIME_SHUTDOWN_UNAVAILABLE` says how
  to configure identity and a shutdown grant) and the terminal banner says so. **Upgrade:** `runtime serve` upgrades an
  existing older ledger once at startup, before accepting connections and only under ledger and endpoint custody: the
  service first takes an exclusive kernel `flock` on the ledger's private companion file `<ledger>-lock` (created 0600 beside
  the ledger, opened `O_NOFOLLOW|O_CLOEXEC` by the local runtime socket native adapter, required to be a regular single-link
  file of the service user and re-checked by path identity after locking), then binds the kernel-owned abstract guard socket
  of its endpoint. Both are held by any live host of this build and released together (after admitted work settled, or by
  the kernel when the process dies). A second start against a live service — on the same endpoint or on another endpoint of
  the same ledger (`layout.resources.runtimeSocket` changed) — fails `LOCAL_RUNTIME_ALREADY_RUNNING` without naming the other
  endpoint (LEDGER-SINGLETON, owner 2026-09-28: one runtime service per ledger) before any backup or migration, and custody is kept until the listener is up (Astra 2054 R1). A consistent copy is written first
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
- **Delivery fit (SESSION-RESULT-LIMIT-2026-09-28):** the worst-case delivered size of every declared provider profile —
  `modelInvocationNativeResponseUpperBound` (one formula shared by the adapters) plus the same arithmetic as
  `assertInvocationDeliveryFit` — is reported ahead of time by `deckent doctor` (`modelInvocationDelivery`, unconditional, `[]` when
  clean) against the runtime-service and MCP surfaces; `models activate` refuses the admission when a profile is already declared for
  the reference and can never deliver on some surface (`MODEL_ACTIVATION_DELIVERY_UNFIT`, before `app.admit()`, no claim or ledger
  effect). The check lives in `engine/core/model-activation` / `engine/core/model-invocation`; composition only wires the surfaces
  (the MCP capacity comes from `adapters/core/mcp-transport`, never from the surface layer). A profile declared later, or a
  `service.responseMaxBytes` lowered after activation, is reported by doctor only (the one ongoing authority).
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
  and unsealed attempts are visible). `/approvals` opens an arrow-key picker of pending items (runtime `listApprovals`; Enter opens
  the highlighted item's y/N card, Esc closes) and `/approvals <n|id>` lists them and opens that card; the decision goes through the runtime `decideApproval` (same peer-authenticated live-session path as
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
admission. The summary answer is normalized into the bounded shape before validation (TERM-FEEDBACK-1, live turn 975da614 answered every list
field as one string): a string, scalars or objects become items, an absent list is empty, text longer than an item is split at a space
(no text dropped), a count past the bound is named (`[N more items omitted by Deckent]`), a too long objective is cut with its length
and digest; an answer without a string objective is unreadable. The `summarize` port distinguishes a summary, `unreadable` (the call
answered, nothing usable) and `null` (the call failed). `unreadable` compacts with Deckent's mechanical excerpt, labelled not
model-written (earlier assistant texts and tool results, each ≤ 400 characters with length and digest, newest within 12 000 characters;
user messages and tool calls copied as before), and the turn's closure note says so (`AGENT_TURN_MECHANICAL_COMPACTION_NOTE`, shown in
the footer). A failed call keeps the history unchanged and closes the turn with a note that says to send again or start a new
conversation. Re-asking the model was not chosen: a second governed call would need another command id scheme and can fail again; the
mechanical excerpt is deterministic, free and labelled. Open: the `compacted` event does not carry the summary kind (a protocol field
would be a checkpoint), and a newest exchange larger than the window cannot be compacted (admission then refuses).
**History lifecycle and bounded turn memory (Astra 2091 fix, Jev 4a702440).** The interactive workline's agent path sends the whole
conversation (no message-count cut; `terminal.chat.historyMessages` now bounds only the plain line mode); the runtime owns its
lifecycle. Compaction is also triggered when the exact serialized history exceeds 75% of the service input bound
(`service.inputMaxBytes`, passed by the composition as `admission.requestMaxBytes`), so a conversation keeps fitting the client's next
request even when the window is unknown. The loop keeps no copy of appended messages: the result carries the final answer, a count and
the incremental digest (same value as the digest of the whole array); a replay appends nothing (count 0, recorded digest). Read dedupe
answers only with a result the model can still see: an entry is bound to the result message itself (providers reuse call ids across
rounds; Astra 2106 R1), a compaction drops entries whose message left the prompt, and a successful non-read call clears it. Byte
pressure also counts headroom (owner 2026-09-26, Astra 2106 R2): the longest answer (`maxCompletionTokens` × 4 bytes) plus one user
message (an eighth of the bound, at most 32 KiB) must still fit the next request; a request that cannot fit even so is refused by the
client before anything is sent as `RUNTIME_CHAT_TURN_TOO_LARGE` (start `/new` or write less), never as a transport fault. Open: a `compacted` event must fit one event frame (`service.responseMaxBytes`); a tail of very large tool
results, or a summary copying many long user messages (each ≤ 4000 characters), can exceed it and then cancels the turn (fail
closed, not silent); and a tail that alone stays above the high-water mark is summarized again every round (billed, no progress;
candidate guard: skip when the last compaction did not shrink the history). The byte check needs no counter port. Evidence: engine repeated-compaction/edit/byte tests, real service byte-bound compaction, workline → service →
session snapshot → `/resume` with 44/46 messages sent whole; mutations 1–7 (`proof/F26-T-L5-FIX-2091/`).
**Concurrency slot = locally open request (INFLIGHT-FIX, owner 2026-09-28; replaces PROVIDERS/A3A "unknown outcomes retain
capacity").** An allocation's `inFlight` counts claims without an outcome. Every outcome — `responded`, `rejected`, `not-sent` and
`unknown` — is recorded only after the native `send` settled, and the native port contract requires `send` to settle only after its
transport request is closed locally (`provider-http-json` destroys its per-request agent before resolving/rejecting), so each
settlement releases the slot. The `unknown` record, its evidence, its spending hold and `lifetimeCalls` are unchanged: uncertain
effect and billing stay; only concurrency is corrected. Replay of a settlement never releases twice. The allocation integrity audit
counts only open claims. `maxInFlight` therefore bounds locally open requests, not provider work that may continue after a disconnect
(vLLM aborts a streamed request on disconnect; an API provider may keep computing — billing uncertainty is the spending hold's job).
A claim left by a crashed **service** process is settled at the next start (FIX-2143-SLOTS, owner 2026-09-28): the service's model send owner is `runtime-service:<custodyId>:<instanceId>` (minted only by `runtimeServiceModelOwnerId`), where
`custodyId` is the digest naming the endpoint custody the instance holds (`LocalRuntimeSocketGuard.custodyId`; the guard socket is
`\0deckent-<custodyId>`, `custodyId = sha256(endpoint \0 uid)`). Holding one endpoint's custody proves only that no service instance is
alive **on that endpoint** (the kernel frees the guard socket when a process dies; a clean stop releases it only after every admitted
operation settled); the runtime socket is a configurable layout resource, so another endpoint may share the ledger (Astra 2145 R1).
Since LEDGER-SINGLETON the start also holds ledger custody, so no other service of this ledger is alive; the owner predicate still
names the endpoint custody (deriving it from ledger custody, which would also close a dead owner's claim after the socket moved, is
a follow-up slice). Ledger custody is a filesystem lock: it excludes services in other network or PID namespaces on the same kernel
and any path to the same ledger directory (bind mounts). Not claimed: NFS or other network filesystems, and a same-UID actor that
deletes `<ledger>-lock` while it is held (trusted-host model, as for the ledger itself); builds before the lock do not hold it. The
lock file is never removed by the product.
A start therefore proves ended only owners that name the custody it holds now (`endedRuntimeServiceModelOwner(custodyId)`; no
prefix-only match exists). An open call whose control is `permitted` with such an
owner settles `unknown` through the ordinary settlement (`transport-error`, no evidence; spending hold `unknown`, `lifetimeCalls`
unchanged, slot freed). Untouched and still holding their slot: `permitted` calls of an instance of another endpoint (proven only by a later start on that endpoint), the earlier unpublished owner shape without custody, `pending` (claim without send permission), `unobserved` (v18
migrated), and `permitted` calls of any other owner (host-less direct call, a build before this one). The durable record does not
carry "owner ended" as a separate reason (outcome schema v4 allows only `transport-error`); the start observer reports the count.
**Start reconciliation.** Under ledger and endpoint custody (with the ledger upgrade and interrupted-turn close), per allocation, one
transaction: an allocation with `inFlight = 0` and no `claimed` row is skipped (nothing can be written). Otherwise every retained row
of the allocation is decoded with the ordinary record decoder (column/receipt/control/cancellation/content agreement), the number of
rows must equal `lifetimeCalls`, each receipt's allocation limits must equal the checkpoint's, and open claims may not exceed
`inFlight`; any failure rolls the transaction back and reports the allocation `inconsistent`, untouched (Astra 2143 R1). From the
verified records: open calls of ended service owners settle `unknown` (above); then, from the counts after those settlements, only
`open < inFlight <= open + unknown` is rewritten to `open` (earlier-build surplus). Observer:
`onModelAllocationSlotsReleased({ allocations, released, settled, inconsistent })`, called when anything was released, settled or
reported. No ledger schema or version change. Cost: O(retained rows) of the allocation, only when a slot is held or a row is open.
**Terminal turn phases (TL-A, 2026-09-28).** Protocol v15 is unchanged. The runtime service emits no phase event; the terminal derives
"the service is summarizing" from the `context` event it already receives, the history it holds, the engine's compaction rule and the
service's admission values from the same configuration; the engine alone decides and compacts, the mark is presentation (a parity test
runs the real service). Live lines: "model is preparing a response · Ns", "summarizing earlier messages · Ns"; the status row shows
"Esc cancels" while a turn runs. On Esc the engine's closure note never reaches the surface (the socket closes), so the footer names the
stopped part from the client's stream state (`compaction` | `model` | `tool`); a summary stopped halfway is not kept and the screen says
so; a completed summary is kept. Reasoning streams as a dim, sanitized (`terminalSafeText`) 2-line preview, never printed to the
scrollback nor added to history; `/reasoning [on|off]` toggles the preview for the session (default on). Limits: against a service of
another build or configuration the mark can be wrong until `compacted` or the first model delta; the chat-turn admission is one pure engine function (`agentTurnAdmission`: output reserve, 2048 safety reserve, request bytes and
next-request reserve) used by both the service and the terminal; it sits in the engine next to the compaction rule because composition
may not call domain decision functions. The compaction predicate itself is still expressed twice (engine loop and terminal), guarded by
the parity test.
**Tool lines and read limits (TL-B, 2026-09-28).** The terminal derives a display target (grep/glob pattern first) and a finished-call
result summary ("12 matches", "243/269 lines, more available") client-side from `message` events already on the wire; the engine's `describeAgentCall` — the C12 approval `resource` — is unchanged byte for byte; the terminal renderer (`surfaces/core/terminal-render` assistant stream) derives both from the `message` deltas the turn already
streams, with the derivation functions in `surfaces/core/terminal-kit`; the terminal agent stream in composition carries the engine's
target only and imports surfaces as types only, so composition (SDK, runtime service) never loads the surface layer (Ink/React) at
runtime — guarded by `tests/contracts/composition/sdk-import-graph.test.ts` over the built `dist/index.js` graph. Read results default to 64 KiB (`terminal.chat.readResultMaxBytes`,
1 KiB–1 MiB, chat schema 1 unchanged); `grep` accepts `context` (0–5) and `maxHits` (≤ 200). `maxHits` caps **seed hits** (hits that open a context window); hits inside an
opened window are shown, marked `:` and counted too; with `context=0` it is the number of hits shown. A grep result with hits ends
with `[deckent] grep: matches=N` (`N` = `:`-marked hit lines actually returned, counted after the result byte cap; `N+` when fewer
than found: hit cap, byte-cap cut, skipped or unscanned files). The terminal's grep count comes only from that last line, or 0 from
the "no matches" line (`+` when the search was not complete); without it (older result, other producer, final byte-cap cut) no
summary is shown — hit rows are never parsed back, since a workspace path may contain `:` (Astra 2145 R2). Tool `version` unchanged.
**Model-facing system prompt (TL-C D4).** The runtime service renders a versioned (`AGENT_TURN_SYSTEM_PROMPT_VERSION`, now 4),
English, deterministic instruction segment in code (protocol text like tool descriptions, never a catalog string): project root,
Deckent data root (workspace-relative when inside the project, else marked unreadable; v4 names Deckent's own state protected),
the configuration path, protected places, the declared tools by class (read / edit / shell), that policy and the permission mode
decide every call (runs, waits for the operator, or is denied; a denial is final), declared-parameters-only, bounded-result
continuation (`hasMore=true` → `nextStartLine`), same-argument read references, and one short progress line between tool rounds.
Each sent round has exactly one system message: the segment, then the client's own system text (catalog: persona + reply language).
The client's history, `message`/`compacted` events and saved sessions never hold the segment; measurement counts exactly what is
sent. The turn's `requestDigest` binds `sha256(segment)`: a turn id replayed after the segment changed (new version, other project
root or layout, other tool set) is `AGENT_TURN_CONFLICT`, never an answer to another prompt. System prompt **v2** (SCR-A): the renderer moved
to `engine/core/agent-turn` (pure text; composition budget); v2 adds the scratch line (path, tools, diagrams as Mermaid/SVG text,
`run_shell` TMPDIR, retention). The request digest changes with it: a turn id replayed across the update is `AGENT_TURN_CONFLICT`.
System prompt **v3** (FETCH): the network line (`fetch_url`, allowlisted hosts ≤ 32 named, what happens to other hosts) or `Network
access: none`; every turn's request digest changes again.
System prompt **v4** (TERM-FEEDBACK-1): one line naming the running model from the bound catalog definition (native id; provider and
model reference with versions; "running inside Deckent"; answer identity questions with it), and the data-root line no longer points at
the ledger and saved conversations: Deckent's own state and authority, keys and credential files are named protected (the tools and the
shell refuse them); the configuration is named readable. Every turn's request digest changes again.
**Agent tool deny floor per layout (TL-C finding, TERM-FEEDBACK-1).** Agent read tools (and through the same `WorkspaceScope`: edit and
shell path classification, the bubblewrap and Landlock deny views, `@file`) deny the Core floor plus every product resource of the
layout that lies inside the project except the configuration (`AGENT_READABLE_PRODUCT_RESOURCES = ['config']`, default-deny for
resources added later; TERM-FEEDBACK-1: the owner's live session listed and read other saved conversations): each resource, anything
under it, its sidecars (`rel*`: `ledger.db-wal`, `terminal-history.jsonl.<pid>.tmp`) and a writer's hidden temporary
(`.policy.json.<id>.tmp`). The deny list's nested literal heads (`WorkspaceScope.protectedAnchors`:
`.deckent/live-data/state/ledger.db`, `.deckent/host`, …) are protected together with their ancestors by both sandboxes even under an
ignored tree (`node_modules`, `.cache`, a `.gitignore` entry) — the ignored-tree exception never reaches Deckent's own state; a chain
through a symbolic link refuses the call. In the shell plan a `PATH_PROTECTED` verdict on one of these patterns is a hard floor
(`PRODUCT_STATE_PROTECTED`, no card, no effect intent): product management is not opened by any approval (owner F2); the Core floor's
other paths (`.env`, keys) keep asking and are then refused by the sandbox. Policy and bindings are authority sources and stay closed;
config names credentials only by reference and edits of it stay on the write floor. In a bubblewrap shell the runtime socket inside the
project is masked too (no connection). The glob matcher tests a pattern's literal head first (20k paths, 97 patterns: 1617 ms without
it, 199 ms with the shipped matcher; the old 28 patterns 197 ms). Open limits: the agent can no longer read or `@`-attach saved
conversations, the ledger, logs or policy (owner reads them outside the agent); Landlock (measured ABI 7; `LANDLOCK_ACCESS_FS_RESOLVE_UNIX` is ABI 9+, not measured) does not restrict connect() to a pathname
socket, but the realm's seccomp filter refuses every `socket()` except AF_INET/AF_INET6 stream sockets (measured on ABI 7: a unix
socket otherwise reached `/var/run/docker.sock`), so the runtime socket inside the project is unreachable in both realms; a data root equal to the
project root would also close same-named project files. Product paths the deny language cannot name literally are refused at layout admission (Astra 2166): an effective project root,
data root or bootstrap configuration path holding `*` or `?` is `LAYOUT_PATH_UNEXPRESSIBLE` (config reason `layout`; service start,
installation preview and every turn resolve through the same function); brackets and braces stay accepted; the glob grammar
(`GLOB_WILDCARD`, `globLiteralHead`, `hasGlobWildcard`) lives once in `platform/core/common`. History: previously a data root moved inside the project (`.deckent/live-data`)
left approval records, the integrity key directory and whole pending diffs readable, and `state/approval-previews` was readable even in
the default layout. `@file` candidates and attachments use the same `agentWorkspaceDeny(projectRoot, layout)` (OPEN-REASONING-FILE):
approval records and pending diffs are neither listed nor attachable (`refused`/`path-denied`); the candidate index is cached per
project root and deny list.
**No-progress note (TL-C D7).** A round is without progress when it has tool calls, every call ended `duplicate`,
`invalid-arguments` or `error`, and the model wrote no text; `denied`, approval outcomes and `cancelled` are not the model's failure.
At the second consecutive such round the engine appends one `user` message `[deckent] The last two rounds made no progress: …`
(once per streak; a round with progress resets it; never on a cancelled turn). No counter or limit ends the turn. The note is part
of the appended history (`message` event; v15 schema already admits `user`), so a replay and the next turn see it.
**Reasoning control (TL-C D8, legacy 7108 descriptor).** A catalog capability `chat-template-enable-thinking` v1 (openai-chat
family; catalog schema v1 unchanged, capability ids are data) declares that the served chat template reads `enable_thinking`. The
`openai-chat-http` adapter (version stays 4: the field is optional and catalog-gated) accepts `chat_template_kwargs:
{ enable_thinking: boolean }` only for a binding that declares it supported, else `OPENAI_CHAT_REQUEST_INVALID` before any network.
The compaction call sends `enable_thinking: false` when declared; rounds are unchanged. **Thinking off per turn (protocol v16, OPEN-REASONING-FILE).** `chatTurn` accepts an optional `reasoning: 'on' | 'off'` (command
schema 1 unchanged; the wire version carries it). With `off` the service sends `chat_template_kwargs: { enable_thinking: false }` in
every round of a model whose binding declares the capability, and the provider counter (`/tokenize`) body carries the same switch,
so the count is of exactly what is sent. The request digest binds `reasoning` only when present (default turns keep their digest;
the same turn id with and without it is `AGENT_TURN_CONFLICT`). A model that does not declare the capability refuses a
thinking-off turn by name (`AGENT_TURN_REASONING_UNSUPPORTED`, usage) before any claim, model call or spending; it is never
ignored silently. The terminal's one `/reasoning` state drives both the preview and the request (a `/reasoning` queued before a
message holds for it); the terminal never sends `on`. `reasoning_effort` stays open (TL-C review §3b).
**Conversation sessions (T-L5c, Jev 9ae569b1).** The workline saves the whole current history (system prompt excluded) after every
turn as one snapshot per session in the managed `terminalSessions` directory (`openTerminalSessionStore`: owner-only 0600, no-follow,
atomic temp + rename, known secret shapes redacted, at most 50 sessions and 16 MiB each, oversize refused before redaction). A
compaction simply rewrites the snapshot, so a resumed conversation can never carry pre-compaction messages twice (legacy defect).
`/resume` opens an arrow-key picker of this scope's recent sessions (Enter continues the highlighted one, Esc closes; TERM-PICKERS) and `/resume <n|id>` continues one (its messages become the history; later turns save
into it); `/new` starts a fresh session; `/context` shows the latest measured prompt against the window. Snapshots are client
context, never authority; they follow the composer history switch `terminal.persistHistory`. The shared credential redaction's URL
pattern now bounds the scheme (`{0,31}`): the unbounded form backtracked quadratically on long letter runs (80k chars: 2.7 s).
**Composer `@file` over the runtime (T-L5, protocol v15, owner 2026-09-27).** Two bounded control operations, current version only:
`findWorkspaceFiles {scopeId, query ≤ 256, limit 1..50}` → `{paths, truncated, incomplete}` and `attachWorkspaceFile {scopeId, path,
maxBytes ≤ 32768}` → `{path, status: 'attached', content, bytes, totalBytes, truncated}` | `{path, status: 'refused', reason}` (reason: the
read boundary's typed path errors, `binary`, `read-error`, `cancelled`; a refusal is a result, not a failure). Both require `delivery`;
the answer always fits it. The caller is the connection's verified peer and must be a member of the scope under current policy (read
access); files come only from the project workspace through `workspace-read` (Core deny floor, ignored/generated directories, no
symlink followed, regular single-link files, UTF-8-boundary prefix, NUL = binary, a file changed while read is refused). Candidates
come from a per-project index walked at most every 10 s (single flight, ≤ 50 000 files; a measured walk took 170–460 ms on 1.3k–2.6k
files, so a per-key walk was rejected); ranking: file name before path, exact (with or without extension) > prefix > substring >
subsequence, then fewer segments, shorter path. The attach path always resolves fresh, so a stale candidate that disappeared or became
denied is refused. On submit the draft's mentions outside paste chips (at most 8, no repeats, exact paths) are attached; one tokenizer owns
lookup, completion and submit (`@` at text start or after whitespace, never `@@` or an email; `@"…"` keeps every character; a bare
`@path` runs to whitespace and drops trailing sentence punctuation; an unclosed `@"` reads as bare and never swallows later mentions;
a quoted mention reaching into a paste chip is dropped): the user message is
the typed text plus one labelled block per file (`--- attached file <path> (…) ---` … `--- end of <path> ---`, model-facing protocol
text), ≤ 32 KiB per file and ≤ 128 KiB per message; the ledger shows the typed text and one notice per file. Content is part of the
user message, so the chatTurn request digest, session snapshots and compaction cover it; no ledger change. The client rejects an
attachment larger than it asked for. A v15 terminal on a v14 service shows no candidates. Authorization is scope membership only (no
separate policy resource); whether `@file` needs its own grant is an open owner question.
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
nothing and closes at its expiry or the next service start. At start, under ledger and endpoint custody and after interrupting turns, every
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
`Makefile`, `Dockerfile`) raises `allow` to `require-approval` in standart and full-auto (a launched full-access turn lowers it,
MODES-3 — except the installation's configuration file, `edit-authority`); an approval shows the planned diff. The write is one
C11 effect of the Core `workspace.file.write` operation on the `workspace-file` target (record id = the workspace-relative path,
resolved only through the workspace scope): live peer session, operation policy re-evaluated right before the effect, intent
before effect, precondition = the planned version (a file changed since it was planned or shown is refused, nothing written),
atomic write (exclusive temporary file in the same directory, fsync, directory re-verified, version re-checked, rename, directory
fsync; mode kept). Each attempt journals its own phases under the wire key (journal v2, atomic, 0600, managed `fileEffects`
directory; Astra 2094 R1): `prepared` with a unique temporary name before that file exists, `committed` after the rename, `aborted`
before the temporary file is removed — and the temporary file is removed only once `aborted` is durable; if that journal write
fails the temporary file stays as evidence that the rename did not happen (Astra 2100) — `escaped` when the parent left the workspace during the write. Crash settlement decides from
that evidence, never from content: committed → applied (even if the file changed later); aborted or no journal →
absent (resend; a stale temporary file of the earlier attempt is removed first); prepared with its temporary file present → absent;
prepared with it gone → unknown whatever the file holds (`prepared` precedes the temporary file, so a crash before it existed and
a crash after the rename look the same, and content equality is not causal evidence; Astra 2100); escaped, unreadable or a retired v1 journal → unknown — never a blind
retry. After the rename the parent is verified again: a directory moved out of the workspace meanwhile is journaled `escaped` (with
where it went) and the effect is unknown, never reported as done, and nothing is written again to undo it (Astra 2094 R2: detection,
not prevention — Node has no openat2/renameat; a same-user process, including the planned unsandboxed host shell, can move directories;
the confining mechanism is an owner decision, see PLAN). Approval previews are bounded to 16 KiB UTF-8 bytes (whole lines first, never
a split character) under a first-line marker naming what is not shown and the sha256 of the whole text; a cut edit diff is kept whole,
owner-only (0600, exclusive, not redacted: it must be exactly the change approved), in the managed `approvalPreviews` directory while
the approval is pending, removed when it settles and swept at service start (Astra 2094 R3). The effect's identity is the turn, the call's position (round,
index), the arguments and the planned version (Astra 2113: the version alone collided after writes B, A, B and reported a write that
did not happen); the effect's approval gate (C12 G3) admits only from the durable `agent-tool-call` record of exactly the executed call: a sealed (MAC) `allow`, subject and action digest rebuilt from the executed call (turn, round, index, tool@version, resource, arguments digest), requested by the effect principal, decided on the request it names, inside its expiry at the claim (judged by the requesting process, I40-c B). It applies whenever the owner was asked — tool decision, write floor or operation decision. The claimed intent pins `approval {approvalId, actionDigest}` (its consumption); later passes verify the pin without a window; a settled record replays. In-turn state is only a pointer to the record and the per-turn one-approval-one-command map; it never admits. Not excluded: another writer between the final
version check and the rename (no advisory locks). `adapters/core/sqlite-agent-turn` stores `agent_turns` and `agent_turn_tool_calls` in the ledger.
**Agent scratch area (SCR-A, owner 2026-09-28).** Three tools, no new class or decision cell: `scratch_write {path, content}` (class
`edit`, cell `edit`, never on the write floor), `scratch_read` (= `read_file` over the area) and `scratch_list` (= `list_dir`), class
`read`. A scratch write is a C11 effect of the Core operation `workspace.scratch.write@1` on target kind `scratch-file` (namespace
`workspace` is Core-closed; registry module `core.scratch-write`); record ids are `<owner>/<session>/<path>` because the effect
store's busy check and sequence are per target kind and id across scopes. The physical write reuses the workspace-file target over
the session area (conditional on the planned version, atomic, journaled, 0600). Silence comes only from policy: `agent-tool/invoke
scratch_*` and `operation/execute workspace.scratch.write` both `allow` → no card in ask mode; otherwise the normal C12 flow or
`POLICY_DENIED`; a mode relaxation uses the existing `permission-mode` event (audit schema unchanged). Missing directories are
created at the effect (after the decision), never through a link. Quotas are configuration (`terminal.scratch`: write 1 MiB, session 64 MiB, installation 512 MiB). The check when planned (before any card) is advisory; the binding check runs at the effect inside the service's one scratch custody (`createScratchActivity`, adapter `scratch-store/internal/custody.ts`): every scratch write goes through `ScratchSession.spend(rel, bytes, write, signal?)`, which takes the custody's single write lane, measures the session and installation usage (the replaced file counted once), refuses or runs the write, and hands the lane on whatever the outcome (written, refused, failed, unknown, cancelled while waiting). The lane is an exclusive reservation of the resource's byte budget for one check→write transition: no other scratch write changes the usage between the measurement and the rename, so two concurrent writes never spend the same free bytes, and an unknown outcome is measured from the disk by the next write (never spent twice nor lost). Reservation is in-process only: the LEDGER-SINGLETON custody (held from start to dispose) leaves one service per ledger/layout, and only that service writes the scratch resource through Deckent. A refusal is the tool result `error=scratch-quota-exceeded (<write|session|installation>: …)`, never a cut. The encoded effect input must also fit the catalog
bound (1 MiB), so the effective content ceiling is 1 MiB minus JSON escaping. The area belongs to the conversation:
`chatTurn.sessionId` (v16, optional) keys it; without it the turn has its own area. Project tools never reach the scratch resource
(`agentWorkspaceDeny` adds it beside approvals and previews). Retention: a session area whose newest change (lstat walk, links not followed) is older than `terminal.scratch.retentionDays` (7) is removed at service start under ledger custody and by the running service every `sweepIntervalMs` (1 h, unreferenced timer, started once the listener is up, stopped with the service). Open/hold and measure/remove use one ownership mechanism, the same custody: a turn holds its area (and its owner directory) before the area is opened, waiting while a removal of it is in flight and then opening a fresh area; the sweep claims an area before measuring it and keeps the claim until the removal ended, so a held area is never claimed and a claimed area is never opened; the owner directory is removed only under its own claim, which any held area of that owner refuses. A failed open or a failed removal releases what it took. Service stop closes the custody (no claim succeeds any more) and waits for a removal in flight before the endpoint and ledger custody are released. Non-area entries are left alone; an area past the walk bounds is kept and counted `unreadable` (observer `onScratchSwept({ removedSessions, removedBytes, kept, unreadable })`). Open limits: content is stored
in the effect intent (ledger growth under heavy use; content-addressed input is a follow-up); the installation quota walks the whole
resource per write (bounded 100 000 entries / depth 64, fail-closed past them); shell writes are measured but not stopped by the
quota; scratch writes of one installation are serialized in the service (each holder writes at most `writeMaxBytes`; a throughput choice, no measured capacity); `/scratch clear` (the person's own request) may empty an area a running turn uses; scratch content is not redacted.
**Read-only shell classification (T-L4 slice 3a, Jev d6909e28).** `engine/core/shell-classification` is pure: a POSIX `sh -c`
scanner (pipelines of stages; redirection only to /dev/null or between stdout/stderr; substitutions, expansions, subshells, braces,
heredocs and background jobs refused with typed reasons), the legacy program allowlist and option grammars (argv semantics: quoting
never demotes an option), sed/awk script grammars, `find` and `git` read grammars, and the risk tiers (destructive table as the
always-ask floor, worst part wins, redirection/tee → modify; `safe-read` only from the classifier). It is a port of legacy
`shell-readonly-classifier.ts`/`shell-risk.ts` @a8b67e2a1 (POSIX only; PowerShell is `UNSUPPORTED_DIALECT`, so a Windows host asks for
every shell command). Paths go through a port: `adapters/core/shell-paths` checks each argument over the same `WorkspaceScope` as the
read tools and edits (lexically inside, not denied, existing, real path inside and not denied; a path or glob prefix with a `..`
component is checked as the kernel opens it — native realpath of the unnormalized text, so `link/..` is the parent of the link's
target — and must exist inside and not denied (Astra 2111); a `..` after a glob segment is GLOB_UNSUPPORTED; sh globs expanded against the real
directory, bounded at 10,000 matches, each match checked; git pathspecs lexical). The shared deny list gained the legacy credential
carriers (`*.pfx`, `*.keystore`, `*.jks`, `.pypirc`, `credentials`, `credentials.json`, `secrets.json`, `.brain/memory.db*`) and the
`.git` directory itself, so read tools refuse them too; legacy `.deckent/private/` is dropped (Next keeps private state under the
already denied `.deckent/host`, `audit-key`, `approvals`). Not covered: intermediate symlink hops that leave the root and return (the
final real path is what the shell reads), a swap between classification and execution, and — legacy-inherited, verified —
traversal (`grep -r x .`, `rg x .`, `find . -type f`) and git object reads (`git show HEAD:.env`, `git log -p`, `git cat-file -p`)
classify read-only with risk `low` although the shell then walks into denied files or prints objects no path check sees; slice 3c
must not run `low` silently on this verdict alone. No tool uses it yet (slice 3c).
`classifyShellContainment` (SHELL-AUTONOMY) is a second pure layer over the lenient risk scanner (command substitutions exposed):
a command is contained unless a part runs a program-floor program (privilege, interpreter, eval-like wrapper, xargs, package manager,
network tool, `env <program>`, `find -exec/-execdir/-ok/-okdir`; `tee` is not on it — it writes like a redirection), its program word is not a plain name (`$x`, `$(…)`, a path), it has a
process substitution, a `case` construct or anything unparseable, or a word (redirection targets and `--opt=value` values included)
names a protected path — the write floor or the product state — lexically, from the project root and with leading `./`/`../` dropped.
It is an intent filter, not a boundary: the sandbox realm is the boundary (awk `system()`, `git -c`, `make` and similar are not seen).
**Host shell execution (T-L4 slice 3b, Jev 52f9b6f9).** `adapters/core/host-shell` runs one command: `bash --noprofile --norc -c`
(no rc-file side effects; legacy used `-lc`), stdin closed, cwd = workspace root, its own process group; environment = an allowlist
copied from the service (PATH, HOME, USER, LOGNAME, LANG, LC_ALL/CTYPE/MESSAGES, TZ, TMPDIR, SHELL) plus operator-allowed names and
fixed non-interactive settings (TERM=dumb, NO_COLOR, PAGER/GIT_PAGER=cat, GIT_TERMINAL_PROMPT=0) — credentials in the service
environment never reach the command unless their name is allowed. The process group is the call's lifetime (Astra 2112 R1,
2119): cancellation and the timeout (default 300 s) signal the whole group (SIGTERM, SIGKILL after 2 s); when the shell exits by
itself, surviving group members get the same SIGTERM → 2 s → SIGKILL; inherited pipes still open afterwards are drained for a 1 s
grace and then released, and the timeout or a cancellation releases them at once (the status stays `exited`). The result reports
`cleanup`: `clean`, `group-ended`, or `unverified` (the group could not be observed empty after SIGKILL, or pipes were released while
held); the agent shell tool puts that note in the model's result and the owner's stream (Astra 2124). Protocol v15 also carries the value as an optional `cleanup` field on the
`tool.finished` event and on the agent tool outcome — the host shell tool's outcome only, enforced at the single emission point in the
agent-turn loop; the terminal's finished call line shows a short suffix for `group-ended`/`unverified` and nothing for `clean` or an absent
field (CLEANUP-MARK; closes Astra 2124 open item 1, owner 2026-09-27); the line reserves its elapsed/status/cleanup tail and shortens
the command text instead, and below the room for the tool name the tail takes its own wrapped line (Astra 2139 R3). This is a process-group
contract, not a sandbox (the bubblewrap realm adds a PID namespace; the Landlock realm does not): a descendant that left the group (setsid, a daemon) is not observed and can outlive the call. Output streams
in chunks ≤ 8 KiB without splitting a UTF-8 character; the result keeps 16 KiB (`HOST_SHELL_RESULT_MAX_BYTES`; a quarter head, the
rest tail), cut on UTF-8 boundaries — a character split across two pipe reads is carried to the next read, never replaced by U+FFFD
(Astra 2112 R2) — with the omitted byte count (legacy kept everything). `durationMs` is monotonic elapsed time (I40). Results: exited (code/signal), timed-out, cancelled, spawn-failed,
unsupported-platform (Windows). On the host realm it is not a sandbox: the command has the service user's file, process and network
access (the sandbox realms below narrow this). Open:
the command runs in its own process group so it can be killed, which also means a service crash leaves a running command orphaned
(the turn is closed as interrupted at the next start, but nothing signals the group; legacy had the same property; Node has no
parent-death signal) — candidate: record the group id in the effect journal and signal it at start.
**Independent integration review (Astra re=2125, 2026-09-27; `5a25b10`, not yet main):** the 2119 unbounded post-exit pipe wait and 2124 missing cleanup notice are fixed in the reviewed integration. Timeout/abort release retained pipes and a separate drain grace bounds completion; `cleanup:unverified` reaches the model result and owner output stream. Process-group signaling still cannot prove escaped descendants died. A persistent finished-call cleanup marker remains a protocol/owner decision. This review does not admit a sandbox or live activation. The follow-up review of `1e896fb` (2127, integration only) closes H34 read-side pinning and A04 registry mutability. The follow-up `b596eee` review (2130) closes both C12 violations: protocol subject visibility now participates in SQL page selection before LIMIT/capacity, and fresh unconsumed approval admission is rechecked after observation before the first claim. Already-consumed intent recovery remains separate. I40-c in that candidate uses trusted producer/consumer time and a monotonic TTL; the decider subtracts usability, never adds lifetime, with a 5 s conservative allowance. A decider already 5 s ahead may reject about 10 s early relative to the producer, and small TTLs can be wholly unusable; a single expiry authority remains a separate owner option. These are reviewed integration properties, not claims that current main or the live service has been updated (PLAN). Open limit (Astra 2145): the ledger upgrade, interrupted-turn close, orphaned tool-call approval expiry and preview sweep still rely on
endpoint custody alone; a service started on another socket over the same ledger is not excluded from them (ledger-level custody is
the proposed class fix, owner decision).

**`@` index, `/resume` replay and `/context` (TERM-UX-1, seventh batch).** The terminal's `@` index (`RuntimeWorkspaceFileHost`) waits for
its first walk; after its 10 s ttl the old list returns at once while one background walk refreshes it; a list older than `maxStaleMs` (1 h)
is not served; a failed refresh keeps the old list. The terminal warms the index at opening (`findTerminalMentions('')`, same authority and
deny) and a bare `@` does not wait for the 60 ms quiet period. `/resume` prints the chosen conversation (last 24 messages, user text ≤ 600
characters, attached file bodies not printed, tool results as one count line, summaries marked); the model context was already whole.
`/context`: window bar and percentage, the automatic summary threshold (display constant 0.75 = `AGENT_COMPACTION_HIGH_WATER`, held
equal by a contract test) and the tokens left, a size-estimate split of the visible history (the service's own instructions are not in
it), the last summary, the three largest items and a `/new` suggestion at ≥ 60 %. Protocol unchanged (v16). Open: `/compact` (protocol
decision), redrawing an open suggestion list when the index refreshes.

**Shell realm (S5, S9, S11; owner 2026-09-28).** Shell calls run through one `ShellRealm` port (host / bubblewrap / landlock).
`terminal.shell.realm = require-sandbox | prefer-sandbox | host` (default `prefer-sandbox`). The service probes once per process (bwrap
on PATH, user namespace via a short-lived native helper, Landlock ABI; 2.5 s bound, failures `unknown`, nothing installed). Sandbox
mechanisms are realm providers (`ShellSandbox.usable(capabilities)` → realm, result marker, a posture function of the call's write view, a notice when the posture
falls short — or why not), taken in preference order from a code-only composition port (`RuntimeServicePorts.shellSandboxes`; shipped
list **bubblewrap, then Landlock**). `host` → host (result bytes unchanged); a sandbox mode → the first usable provider; none usable →
`require-sandbox` refuses before any plan, approval or effect (`SHELL_SANDBOX_UNAVAILABLE`), `prefer-sandbox` runs on the host and says
so in the approval preview, the live stream, the model result and the finished line (`sandbox: none; running on host (bubblewrap: …;
landlock: …)`) — never a silent fallback; macOS/Windows `SHELL_REALM_UNSUPPORTED`. Every result's first line names its realm (`sandbox:
bubblewrap | landlock | degraded | none`; only trusted metadata, never command output); the approval card renders that posture against the same `shellWritePosture` result the effect enforces (always `owner-approved` once a card exists; `sandboxWriteView` in `host-shell`), so its project, write-floor and `.git` wording cannot drift from the boundary (host and the no-sandbox fallback keep a fixed text).
Both sandbox launchers go through the host shell's one process runner (`ShellLaunch`: program, argv ending in `bash --noprofile --norc
-c`, optional fd 3 setup-failure channel), so the process-group, cancellation, timeout, output-bound and cleanup contract is the same
everywhere; a realm that cannot set itself up refuses the call (`spawn-failed` → effect `refused`, the reason is the result: "nothing
was run"), never runs on the host instead.
**Bubblewrap realm (S9).** `adapters/core/shell-sandbox-bwrap`: `bwrap … -- bash` with the launcher verified at a known path
(`/usr/bin/bwrap`, `/usr/local/bin/bwrap`, `/bin/bwrap`: regular executable not writable by group/others; PATH never consulted for it),
usable only with `bubblewrap` and `userNamespace` both measured `available`. View per call: `--unshare-all` (network included; the
fetch tool is the only egress), `--die-with-parent`, `--new-session`, fresh `/proc`, minimal `/dev`, `/tmp` and HOME as 64 MiB tmpfs
(HOME never bound: `~/.ssh`, tokens, a ledger under HOME invisible), system prefixes read-only by allowlist (`/usr /etc /bin /sbin
/lib* /opt /snap /nix /sys`; never `/`, `/mnt`, `/run`, `/var`, `/home`), PATH program directories (`bin`/`.bin`/`sbin` by name; a
`bin` with its `lib*`/`libexec` siblings; never HOME or above it, never inside/above the project or scratch, never under `/mnt /media
/run /dev /proc /sys /var`, never a non-program directory such as `~/.local`) read-only so an nvm/`~/.local/bin` toolchain keeps
working — every bind source, the entry and each `lib*`/`libexec` sibling, must be its own canonical directory (no link in any
component) admitted by the same exclusions, so `lib -> $HOME` beside a `bin` is never a bind and a symbolic-link toolchain directory is
not bound at all (Astra 2154 R1; a component swapped for a link between the check and the mount is the documented same-user race) —,
the project read-write, Git metadata under the **inode floor before any grant (Astra 2156)**: a `.git` file that has more than one link
is another name of something and is masked (never a grant, never a worktree resolution); a `.git` directory anywhere, the root `.git`
file (a worktree) and — only in the verified worktree shape (`gitWorktreeRepository`, shared with Landlock) — its common repository are
bound read-only and then walked: every multi-linked file inside is masked unless its content hashes to its Git object or pack name
(`isVerifiedGitObject`: loose objects inflated and hashed, packs/indexes by their trailer checksum; a hard-linked local clone keeps its
objects), an unreadable or too deep directory inside is masked; any other `.git` file opens nothing (a forged pointer a sandboxed
command wrote cannot bind HOME; a submodule loses `git status` inside). The per-directory scan is shared with Landlock
(`scanGitDirectory`) and its security verdict is taken **afresh on every call** — the directory is listed and every regular file's link
count is read each time; no directory-level cache carries a child's verdict (Astra 2158 R1: a single-link file can gain another name
elsewhere and be rewritten through it without its directory's times changing). Only a verified object's content hash is cached, under
the inode's device, number, size, mtime, **ctime** and the identity its path promises (Astra 2158 R2: content cannot change without the
kernel advancing ctime — a user can put mtime back with `utime`, never ctime; the same inode under another object name is re-verified).
Bounds of that cache, stated honestly: ctime is kernel-set at nanosecond resolution, so a change landing in the same tick as the cached
ctime, or a component swapped between the scan and the mount, is outside what the scan can see. Git metadata has its own walk budget
(200 000 entries; over it, or over 4 096 masks — e.g. a hard-linked clone whose objects do not verify — the call is refused), the deny
floor masked (denied directories and fully-denied subtrees as empty tmpfs; denied files as a read-only `/dev/null` bind that opens with
EACCES — protected, not absent; a regular file with more than one link is masked the same way, since another name of a protected inode
would open it (Astra 2154 R2; single-link files stay open; inside Git metadata the same rule applies with the verified-object exemption
above — the multi-link protection covers the whole project view including `.git`, not only the working tree); symlinks neither followed
nor masked; `node_modules`/`dist`-class directories not entered), the conversation's scratch area read-write (TMPDIR unchanged). What
the walk could not see is closed, never left read-write (Astra 2154 R3): a directory it could not read, or one beyond depth 32, is
masked as an empty tmpfs (a `chmod` inside changes the tmpfs, not the host directory); an unreadable project root refuses the call.
Deny walk bounded (50 000 entries / 4 096 masks; over it the call is refused). The PID namespace ends every process the command started
with the call, a `setsid` escapee included (measured: without `--die-with-parent` it survives); the outer `bwrap` exits on SIGTERM, so
cancellation and the timeout end the namespace. Result marker `sandbox: bubblewrap`; card "Runs in a bubblewrap sandbox: …". Cost on
this machine ≈ 420 ms per call (Astra 2158: the common repository's 6.2 k-entry `.git` is listed and its ≈ 5.1 k files `lstat`ed on
every call — the thread-pool round trips dominate, ≈ 220 ms; the first call after service start ≈ 700 ms while 797 hard-linked objects
are hashed once; ≈ 180 ms with the withdrawn directory cache, ≈ 145 ms before 2156, ≈ 90 ms before 2154) vs ≈ 2 ms on the host. Open
limits: masked files read "Permission denied" rather than ENOENT; ignored-tree exception (both realms): `node_modules`/`dist`-class
directories are not scanned, so a `node_modules/pkg/.env` is readable and a nested `node_modules/pkg/.git/config` writable inside
(Astra 2154 measured both; owner option: mask/carve every `.git` and deny match inside ignored trees at the cost of scanning them);
`.git` read-only means `git commit`/`git add` fail inside (owner decision); the product's own state inside the project (ledger, policy,
sessions, audit, keys — every resource but the configuration, TERM-FEEDBACK-1) is closed in the sandbox in every layout, an ignored
ancestor included (Astra 2162: the deny list's nested literal heads are `WorkspaceScope.protectedAnchors`; an ignored directory holding
one is listed, its denied entries masked and only the ancestors entered — siblings stay unscanned; a symbolic link on that chain
refuses the call; a `.gitignore` change cannot lift this); user-namespace-restricted hosts (AppArmor) not measured (the probe's
`unavailable` makes the realm unusable); the availability gate is the probe's PATH scan while the launcher comes from known paths (a
service PATH without `/usr/bin` → unusable, fail-closed); `--die-with-parent` should also end a sandboxed command when the service dies
(candidate for the "Host shell execution" orphan item) — untested.
**Landlock realm (S11).** Second provider (chosen when bubblewrap is not usable): each call builds a rule set from a fresh scan of the
project (`host-shell/internal/landlock.ts`) and runs bash through the native helper `shell-sandbox`
(`host-shell/native/shell_sandbox.c`), which applies it and execs bash in the same process. Landlock only adds access and a directory
rule reaches everything beneath it, so a directory holding a protected path or a `.git` is carved: listing only, each entry its own
rule — clean files and trees read-write, protected paths (the turn's deny list), multiply linked files, special files and unreadable
directories no rule; symbolic links none; ignored directories read-write as a whole and not scanned. Git metadata is read-only under
the same inode floor **before any grant (Astra 2156)**: a multi-linked `.git` file takes no rule; a `.git` directory and a worktree's
common repository (root `.git` file in the verified shape only) are not one read grant but carved read rules from the shared
`scanGitDirectory` (verdicts re-read every call, only object hashes cached under ctime and expected identity — Astra 2158): a directory
whose subtree holds only single-link files, verified objects (`isVerifiedGitObject`) and readable directories takes one `r` rule,
otherwise listing only and per-entry rules — a multi-linked unverified file, a symbolic link, an unreadable or too deep directory none
(git metadata budget 200 000 entries; over it the set is refused). No other `.git` file opens anything outside. System directories
(`/usr /bin /sbin /lib* /opt`, the running Node's `bin`/`lib`) read + execute, `/etc` and `/proc` read,
`/dev/{null,zero,full,random,urandom}` read-write; the scratch area read-write and the command's `HOME`; HOME, `/tmp`, `/mnt`, `/run`,
`/var`, `/sys` and everything else unreachable (`stat` is not restricted by Landlock). Bounds: 20 000 scanned entries, depth 32, 8 192
rules, 1 MiB of rule arguments — past a bound nothing runs (beyond depth 32 the whole set is refused; a directory the scan cannot read
takes no rule and stays unreachable even after a `chmod` inside — pinned by tests after Astra 2154 R3). The helper opens relative rule
paths beneath the root with `openat2 RESOLVE_BENEATH|NO_SYMLINKS`, requires the announced kernel ABI, sets `PR_SET_NO_NEW_PRIVS`,
restricts itself (ABI ≥ 4: TCP bind/connect handled with no rule; ABI ≥ 6: signal and abstract-unix scopes), then installs a seccomp
filter (foreign-architecture/x32 calls kill; `io_uring_setup` refused; `socket()` refused except AF_INET/AF_INET6 stream sockets when
Landlock handles TCP — ABI < 4: every socket refused; `listen()` and MSG_FASTOPEN sends refused: measured on ABI 7 that a unix socket
reached `/var/run/docker.sock`, UDP left the machine, and the Landlock TCP rule missed a `listen()` autobind and a TCP Fast Open
connect). Any setup failure is one line on fd 3 (close-on-exec), exit 125, no exec; the runner turns it into `spawn-failed` (effect
refused), so a command cannot forge one. Posture: ABI ≥ 6 → marker `sandbox: landlock`; ABI < 6 → typed DEGRADED: marker `sandbox:
degraded` and a notice naming what is open (signals ABI < 6, truncation ABI < 3, TCP by the socket filter ABI < 4) on the card, the
live stream, the result and the finished line. Network is closed at every ABI. Open limits: the project root and every directory
holding a protected path or `.git` cannot gain, lose or rename entries inside the sandbox (`touch new-at-root`, `sed -i` of a root
file, a first `mkdir dist`); tools installed under HOME do not run (unlike bubblewrap); glob-protected files inside ignored directories
are not carved; no PID namespace — a `setsid` descendant escapes the process group (it stays in the Landlock domain); ≈ 310 ms rule-set
build on this repository after Astra 2158 (≈ 125 ms with the withdrawn directory cache, ≈ 90 ms before 2156; per-entry object rules for
a carved `objects/` tree can approach the 8 192-rule bound in a large hard-linked clone whose objects do not verify); the product's own
state inside the project is closed in every layout, an ignored ancestor included (Astra 2162: an ignored directory holding a protected
anchor is carved — listing only, denied entries no rule, the ancestors carved in turn, every other entry keeps its read-write grant
unscanned, except a write-floor entry of a floor-read-only call, which takes a read-only rule (869c01f); a symbolic link on the chain
refuses the set).
**Agent shell tool (T-L4 slice 3c-i, Jev 82858581).** `run_shell {command}` (tool class `shell`) is declared beside the read and edit
tools. Policy first: the `agent-tool` decision and the `operation` decision for Core `host.shell.run` v1 (`execute`), stricter wins, a
deny is answered before anything else and never offered. Then the command is classified (slice 3a over the turn's workspace scope):
only a read-only command of bounded reach (risk `none`) runs without asking, and only under allow; `low` (traversal, repository
objects), modify and the destructive table ask the owner in standart and full-auto (a launched full-access turn lowers them, MODES-3). In full-auto inside an enforced sandbox realm a contained command of any other tier but destructive runs without asking when the company rule is mode-eligible (SHELL-AUTONOMY; outside the narrow mutating set such a run sees the project read-only, Astra 2170); the realm, not the classifier, bounds it — paths outside the project are left to the realm (bubblewrap: private `/tmp` tmpfs, empty HOME; Landlock: writes outside the project and scratch area refused). The
approval preview shows the exact command, its risk tier and reason, and where it runs (the realm's posture: bubblewrap, Landlock and its limits, or the host: not a sandbox — described from the call's own write posture). Every run is a C11 effect on the
`host-shell` target (live peer session, operation policy re-evaluated before the effect, intent before spawn; the approval subject's
`resource` shows at most the first 200 characters of the command, and the exact command is bound by the arguments digest); each run is its own
record, so an uncertain run never makes the shell busy; its effect identity is the turn, the call's position (model round, index in
the response) and the arguments digest — a replay of the same call is the same effect, a later identical command is another; the
provider's call id is not identity (providers reuse it; Astra 2113); an owner approval admits the run only through the same durable-record gate as edits (C12 G3) and is pinned in the run's intent. A shell keeps no idempotency record: exited is the effect (any exit code), a
cancelled or timed-out run is `unknown` (the result says what it changed is unknown) and is never re-run, a run that could not start is
refused. Turn cancellation reaches the running command (group killed). Output streams as `tool.output` while the turn channel has
room (a new channel `room()`); past half of it the display stops with one visible marker, and the streamed display is drained before
the result is emitted. The result keeps 16 KiB (head + tail, omitted bytes counted), like a read tool. `terminal.shell` configures the
per-command timeout (default 300 s) and extra environment names. Live use needs owner grants (`agent-tool` `run_shell`, `operation`
`host.shell.run` execute). The terminal (slice 3c-ii) shows the last three lines of the running call's output under its live line
and nothing of it afterwards (the finished call stays one line; the output reached the model as the result). Command output is
untrusted: before display every escape sequence (CSI, OSC — titles, clipboard —, other ESC forms) and every control character but
newline and tab is removed and carriage returns become line breaks; the live tail keeps 2,048 characters. The same sanitizer
applies to model answer text, a tool call's display target and the approval card's summary and preview (slice 3c-iii): a probe showed
Ink drops cursor and OSC sequences but passes SGR, and SGR can conceal text (ESC[8m) — e.g. hide a line of a diff on the card.
Astra review of `95c3a14` + `6a53765` (2026-09-26, 2094): content-equality recovery, the moved-parent write and the unbounded preview —
corrected locally as described above; for R2 the owner accepted (2026-09-26) the documented residual race between the last check and the
rename (no native or isolated writer for now); awaiting Astra re-review.
Astra review of `e6085ca` (2026-09-26, 2092): swallowed close failures and a late answer clearing a newer card — corrected locally
as described above; Astra re-review of `7e0e349` (2095) confirmed both original corrections with 71 targeted tests. The subsequent
observer-dependent startup recovery defect is corrected in `a4604fc`: recovery runs before optional notification. Astra 2097
re-review confirms observed/unobserved starts both expire the orphan, and a missing integrity key leaves it pending, reports
`keyUnavailable` and creates no key (3 fresh real-service tests). This scoped review closes 2092/2096; T-L5 and file-write findings
remain open, and full verification/deployment acceptance are separate.
Astra 2099 re-review (2026-09-26): retaining read dedupe by provider call ID is insufficient because IDs may repeat across rounds;
a recent unrelated call can keep a compacted-away read marked visible. Also the pre-round 75% request-byte threshold does not
ensure the completed answer plus next user input can enter the service transport; a valid configuration reproduces rejection in
the client before runtime compaction. Both were corrected in `2900a8d` (dedupe bound to result messages; request headroom and a typed
refusal, owner decision 2026-09-26); Astra 2117 scoped PASS (2026-09-27, 46 fresh engine/runtime tests) closes these two repros.
The selected four-bytes-per-completion-token reserve is a sizing allowance, not a universal tokenizer byte bound; oversized
requests still receive the typed refusal. Large compacted frames and tails above the watermark remain open limitations.
**Shell TMPDIR = scratch area (SCR-A).** `run_shell` gets `TMPDIR` = the conversation's scratch area (a fixed value that wins over
the service environment and over an operator naming `TMPDIR` in `terminal.shell.environment`). The shell path port takes the area as
a second root: an absolute path inside it is checked against the area's own scope (read-only `none` → may run without asking under
allow; `cp/mv/mkdir/touch` into it → `narrow-mutating`); leaving it lexically or through a link is `PATH_OUTSIDE_ROOT`.
`$TMPDIR/...` is a variable expansion and asks unless full-auto in an enforced sandbox (SHELL-AUTONOMY) or full access lowers it. Project-root classification is unchanged. In the Landlock realm the area
is also the command's `HOME`; in the bubblewrap realm HOME is an empty tmpfs and the area is a separate read-write bind.
**Agent fetch tool (FETCH S6/S7/S10, owner 2026-09-28).** `terminal.fetch` (schemaVersion 1, optional): `egress: none | allowlist |
approval` (default `none`), `allowedHosts[]` (exact lowercase DNS names; no wildcard, no IP), `maxBytes` (4 MiB), `timeoutMs` (30 s),
`maxRedirects` (3); no proxy field (corporate proxy is a separate slice). `none` builds nothing: no `fetch_url`, no transport use, and
the system prompt says there is no network access. **Egress mapping (decided, Jev ee030c0e 0.90 / sufficiency 0.77): `allowlist`
refuses every host outside `allowedHosts` without a card or a DNS lookup (`host-not-allowed`); `approval` runs listed hosts under
policy and opens an owner card for any other host.** A redirect is followed only to the call's own host (for an approved call: the host
the owner approved) or an allowlisted host (decided, Q2). A timeout before the TLS handshake finished sent no HTTP request and is
`refused`; after it, `unknown` (decided, Q3). `fetch_url {url, maxBytes?}` (class `deckent`) is planned before anything is resolved —
no DNS query leaves the machine before a decision: https only, no userinfo, port 443, no IP literal, ≤ 2048 characters, fragment
dropped. Decision: the one `decideAgentToolCall` over `agent-tool/invoke fetch_url` and `operation/execute network.fetch`; cells
`fetch-listed` (the policy decision stands) and `fetch-unlisted` (allow → card); neither is relaxable, so no permission mode lowers a
fetch and the `permission-mode` audit event is never written for one (schema unchanged) — except a launched full-access turn (MODES-3;
owner 2026-09-29: a trial, decided again after use), which lowers `fetch-unlisted` like every other cell and records it as a
`full-access-call`; refusals of the egress setting stay refusals. A fetch is not counted by the silent-decision
counters. The card shows `GET <whole URL>`, the allowlist verdict, the byte limit and `sha256(url)`; the approval resource is the URL
cut at 200 characters and the arguments digest binds the rest (C12 G3 unchanged). Each call is a C11 effect of Core
**`network.fetch@1`** on target kind **`network-fetch`** (root registry module `core.network-fetch`; the id closes the `network`
namespace to overlays; `write` class, policy approval, no precondition, no compensation, input `{url, maxBytes}` ≤ 4 KiB), its own
record, identity = turn + call position + arguments digest. Adapter `adapters/core/http-fetch`: every hop resolves the host, requires
every answer to pass the gateway's `isPublicNativeAddress` (extended to IPv6: global unicast `2000::/3` minus `2001::/23`,
`2001:db8::/32`, `2002::/16`, `3fff::/20`; mapped/NAT64/ULA/link-local/multicast/loopback are outside; the machine's own addresses
excluded; the gateway still resolves IPv4 only), connects to the checked address (no second resolution) with SNI and Host = host and
certificate verification on, sends one GET with `User-Agent: Deckent-Fetch/1`, `Accept-Encoding: identity`, no
`Authorization`/`Cookie`; a redirect (301/302/303/307/308) is followed only over https to an allowlisted host or the call's own host,
anything else stops (`redirect-refused`, `too-many-redirects`); the body is cut at `min(maxBytes, args.maxBytes)`; `timeoutMs` bounds
the whole call. Outcomes: nothing sent (bad URL, DNS, non-public address, TLS/connect failure, or a timeout before the TLS handshake
finished) → effect `refused`; answered (any status, a stopped redirect included) → `settled`; sent then timed out, cancelled or broken
→ `unknown`, never sent again (`lookup` is always unknown). The body lands in the conversation's scratch area as
`fetch/<sha256(body)>.<ext>` (extension only from a fixed media-type table) through `ScratchSession.deposit` — not a `scratch_write`
effect (its content would ride in the intent, bounded at 1 MiB) but the same scratch write lane: `deposit` runs inside
`ScratchSession.spend`, so its quota check and write are one transition with no other scratch write in between (Astra 2149 R2);
exclusive 0600 temporary file, flushed, renamed; over quota the body is not kept (`scratch-quota-exceeded`); the fetch call's signal
abandons the wait for the lane (result `not saved: error=cancelled`). The model gets status, content type, size, cut flag, redirects,
final URL, the saved path and, for a text type, the first 16 KiB through the existing secret-shape filter (`redactText`); a binary body
is not shown. The transport (resolve / connect / trust anchors) is a code-only port: the product always uses the system transport;
`startConfiguredRuntimeService(…, { fetchTransport })` exists for in-process tests and `runtime serve` never passes it; the
public-address check is not part of the transport and cannot be turned off. Open limits: prompt-injection in fetched text is inherent
(the head is data, a body line may imitate a `[deckent]` meta line); the saved file is not redacted (as scratch); the deposit path is
created link-free but the final rename is by path (same-user race, as scratch); fetched bodies wait in the one installation-wide
scratch lane (a 4 MiB write holds it for its write); no proxy, no POST, no cookies/auth by design; an allowlisted host that resolves to
a private/intranet address is always refused (the on-prem/Enterprise intranet need belongs to the proxy slice).
**Allocation without a lifetime total (T-L3a, owner 2026-09-25, ledger v36).** A model invocation profile's allocation may set
`maxCalls: null`: no lifetime total of calls, an explicit and audited profile choice (the local terminal profile can use it;
live since the owner's 2026-09-25 migration, API profiles keep theirs). `maxInFlight` still bounds concurrency, and policy, activation, provider availability and spending authority
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
The OpenAI chat wire shape (request messages, response reading, the uncounted prompt bound) belongs to the `provider-openai-chat`
adapter; the compaction call protocol and the approval preview bound belong to engine `agent-turn` (COMP-BUDGET-2).
The 2026-09-25 review limits (Astra 2079: `tool_choice: none` on responses, an undeclared streamed name rejected only at finish) were
corrected in `e12a253`; Astra 2091 found no new blocker in them.
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
The 2026-09-25 review limits (Astra 2078: no path recheck of walked descriptors, backtracking glob on the service thread) were
corrected in `e12a253` (every walked directory and file is re-verified; globs match by a bounded dynamic program); Astra 2091 found
no new blocker in them.

**Anthropic Messages provider (ANTHROPIC-PROVIDER G8, seventh batch; ANTHROPIC-PROFILE, eighth batch).** Provider adapters: `openai-chat-http` (v4), `openrouter-chat-http`
(v1) and `anthropic-messages-http` (v2, family `anthropic-messages`, API version `2023-06-01`; unit `adapters/core/provider-anthropic-messages`).
The adapter takes the provider-neutral (OpenAI-shaped) local request and returns an assembled neutral `chat.completion` evidence; consumers
do not know the family (one exception: the capability check knows both). `provider-http-json` credential kinds are `none | bearer |
header(x-api-key)` with bounded static headers; `header` only over https. Spend: price id `anthropic-published-tariff` v1 (published rates
are profile data; the quote ceiling is integer arithmetic); settlement of usage × tariff does not exist yet, so a responded call stays
`held` (checkpoint A, blocks real Anthropic use). Thinking continuity: a process-local bounded cache inside the adapter, bound to the
unchanged request prefix (checkpoint B: `providerContinuation`, v17). Error codes reuse `OPENAI_CHAT_*`. Per-model request contract
(ANTHROPIC-PROFILE, adapter v2): an adapter-owned, dated and sourced capability registry (`internal/models.json`, docs read 2026-09-29)
lists per model the accepted thinking types (adaptive, manual budget), the single off type (`disabled` | `between_tools` | none) with its
effort ceiling, `output_config.effort` levels and default, and the synchronous max output. A profile is checked against its pinned model's
row at load (`OPENAI_CHAT_DEFINITION_INVALID`, no call); an unlisted model admits only no thinking field and no effort. `effort` is profile
data sent as `output_config.effort` (GA, no beta header) and forwarded to `count_tokens`. Not supported: per-message effort,
`display: "updates"`, structured output, task budgets. The registry must be re-read from the official pages at least every 30 days or on a new
model announcement (no refresh mechanism yet). Not yet: SSE byte/token metering in live streaming, a keyring/`secretResolver` link for the key (environment variable only),
the owner's first billed smoke call (Opus 5.5 `effort`, Sonnet 5.5 `between_tools`), tariff rows for legacy models, a neutral
`reasoning: {mode, effort}` (P2).

**Sandbox scan speed (SANDBOX-SPEED G2, seventh batch).** Both realms' scans pick their reads per directory by `statfs`: synchronous on
a local file system, asynchronous elsewhere (`fs-ops`); the verdict is re-read on every call and does not depend on the read flavour
(Astra 2158 holds). The deny matcher answers the shapes the deny list is made of — `**/<segment glob>`, a literal, a literal head with one
trailing `*` or `**` — without the dynamic program, on the platform's one wildcard set (`GLOB_WILDCARD`, only `*` and `?`); equivalence
with the general matcher is an oracle test. Measured on this repository (ext4/WSL2, warm): bubblewrap ~465 → ~60 ms, Landlock ~316 →
~51 ms per call. Open: execution off the event loop (~50 ms block), network file systems, `statfs`/`readdir` micro-costs.

**Permission modes (MODES-3, owner 2026-09-29; supersedes the slice 4a mode set).** Three modes: `standart` (the default — no bindings
entry: reads, scratch and the in-project edits the company marked mode-eligible run without a card; shell and the write floor ask),
`full-auto` (+ the narrow mutating shell set and MCP calls; inside an enforced sandbox also contained unbounded shell — SHELL-AUTONOMY),
`full-access` (launched only; below). The person's "ask for edits too" preference is `askEdits: true` on their bindings entry — not a
mode — and suppresses the `edit` lowering in standart and full-auto. `bindings.json` v3: `modes[] = {id, principal, scopes, mode ∈
standart|full-auto|full-access, askEdits?: true}`; `standart` without `askEdits` is the absence of an entry; zero entries = standart,
two for one person and scope = standart with every edit asked (fail closed). The reader accepts v1, v2 (mapped in memory: `ask` →
standart + askEdits, `auto-edit` → standart, `full-auto` → full-auto; `upgradeBindingsDocument`) and v3; every write is v3 (the first
`/mode` write upgrades the file; the authority writer's archive keeps the v2 document). A build before MODES-3 refuses v3 as a whole
(`POLICY_INVALID` → `POLICY_UNAVAILABLE`). In the slice 4a and SHELL-AUTONOMY text below, `ask` reads as standart + `askEdits` and
`auto-edit` as standart.
**Permission modes — decision and audit (T-L4 slice 4a, owner 2026-09-27 q1–q5).** The company marks a v2 `require-approval` rule or role permission
`modeEligible: true` (invalid on any other effect; v1 policy has no such field). A mode creates no authority. One pure function
(`engine/core/policy` `decideAgentToolCall`) decides every agent tool call over the policy + bindings snapshot: the stricter of the
`agent-tool`/`invoke` and operation/`execute` decisions (deny ends it, before the call is planned) → the floor raise (write floor,
shell `low`, destructive, always-ask, other modify, narrow mutating raise allow) → the mode lowering, only when the policy decision
itself is `require-approval`, every matching `require-approval` rule on each asking side is eligible, the cell is relaxable in the
mode (ordinary edit: standart/full-auto unless `askEdits`; narrow mutating shell: full-auto) and the person's mode is unambiguous (two
entries decide as standart with every edit asked). Allow rules
never lower; a raised allow is never lowered; read tools and read-only shell commands under require-approval always ask. The narrow mutating shell tier is a separate classifier layer (`classifyShellMutation`): exactly one simple command (one pipeline of
one stage; no `&&`, `;`, `||`, newline or pipe — an earlier part could change what a later part writes, Astra 2133) of `mkdir [-p -v]`,
`touch [-c]`, `cp [-n -v] src dst`, `mv [-n -v] src dst` whose sources pass the read check and whose targets pass a write check
(inside the workspace, not denied, not on the write floor, parent a real directory, target absent or a single-link regular file — an existing directory target is not narrow;
no glob, `~`, `..`, leading `-`); interpreters, privilege, eval, xargs, tee, package managers, network tools, anything the strict
scanner refuses and PowerShell are the always-ask floor, decided first; `rm` is not narrow. The turn authorizes with the whole
decision and `prepare` repeats it. At the effect a call the owner was not asked for is decided again on fresh policy: a
relaxation first writes one sealed `permission-mode` audit event (audit port, ledger v41; event id = scope, turn, round, index,
arguments digest; summary = workspace path or first 200 characters + arguments digest) — if it cannot be written nothing runs
(`audit-unavailable`) — and the effect gate re-decides on every admission and admits only the audited decision: allow on the same effective revision with
the same mode, cell, company rule ids and person entry; a deny since → `POLICY_DENIED`, anything else (a lost relaxation, another
mode, revision or grant, a plain allow) → `EFFECT_APPROVAL_REQUIRED`; nothing runs and nothing is re-audited (Astra 2133/2134 R2);
a decision that was silent without a mode increments `agent-tool.silent.edit|shell` (summary, not evidence: a counter failure does
not stop the call). Owner-approved calls keep the C12 G3 gate unchanged. The protocol and ledger v41 are unchanged by 4a; the
mode is not on the wire yet (status row and `/mode` join the v15 package). Version note: a policy document carrying `modeEligible`, or
bindings v2, is refused as a whole by a build before this slice (strict schemas) — fail closed, never a silent relaxation. Side effect: on an installation that never produced an approval, the first silent call creates the approval/audit
integrity key through the counter path. Open (owner): read-only shell under an eligible rule still asks in full-auto (needs audit event v2);
`rm` stays outside the narrow set; permanent exact resources are slice 4d.
**Full-auto inside an enforced sandbox (SHELL-AUTONOMY, owner 2026-09-28 live test, lead decision).** The decision request carries,
for a shell call, the planned realm's containment (`ShellRealmContainment`: `sandbox` = bubblewrap or Landlock at ABI ≥ 6, `degraded` =
Landlock below 6, `host` = host mode or a `prefer-sandbox` fallback; typed on `ShellRealmResolution`, never parsed from the marker) and
whether the command is contained (`classifyShellContainment`). In full-auto, in a `sandbox` realm, for a contained command, the cells
`shell-read-none`, `shell-read-low`, `shell-other-modify` and `shell-always-ask` (the strict scanner's construct refusals: compound,
expansion, redirection, subshell) are relaxable too, under the same rule as before (policy decision itself `require-approval`, every
asking rule `modeEligible`, one mode entry), and such a run sees the project read-only (shell write postures, below);
`shell-destructive`, the write floor, read tools and fetch never are; host, fallback and degraded realms, and standart, are unchanged. The relaxation is audited as the existing `shell-modify` cell (ledger/audit schema
unchanged; the realm is not in the record — open, audit event v2). This reopens, for the sandbox realm only, the earlier open note
"read-only shell under an eligible rule still asks in full-auto". What a call may write in a sandbox is the one derivation under
shell write postures (below). The destructive table asks in standart and full-auto; the earlier `unrestricted` design note became the
launched full-access mode (MODES-3, below), which lowers it.
The one decision orders its lowerings: the mode relaxation first (`relaxableFor(request)`: the static `RELAXABLE` cells, and in full-auto,
in an enforced sandbox realm, for a contained command, the sandbox cells), the standing approval (PERSISTENT-APPROVALS G6) last — it lowers
a standing cell only where no mode did. `shell-read-low` is both: in full-auto inside a sandbox it is lowered by the mode (a
`permission-mode` audit event), on the host, a degraded sandbox, for a command that is not contained or in standart by the standing
approval (a `standing-approval` event); the existing audit kinds already tell the two paths apart (no schema change). `standingWouldLower`
takes the same request (shell field included), so no standing scope is offered where the mode already lowers the call. Every call the
owner did not approve at its card — a mode relaxation, a standing approval, a decision silent without a mode — runs unattended in the
sense of the postures below.
**Shell write postures (Astra 2170 × MODES-3, lead merge 2026-09-29).** A sandboxed shell call's write posture is derived once, at the
effect, from who stands behind the call (the call decision hands the effect a typed authority `owner-approved | full-access |
unattended`, never text) and the planned tier (`shellWritePosture`, composition agent-turn):
- **owner-approved** (the owner's card): the project writes, the write floor included; `.git` stays read-only except in a full-access turn.
- **full-access** (an audited `full-access-call` of a turn launched in full access while the company grant holds; owner 2026-09-29: full
  access is comprehensive and owner-authorized by the mode): the project, the write floor (existing and new names) and `.git` (and a
  worktree's common repository) write; the configuration file stays read-only (that turn's sandbox floor is only the configuration
  file); the hard floor — product state, credentials, the MCP registry — stays masked/denied.
- **unattended, narrow mutating set**: the project writes, the write floor's existing paths read-only (literal targets passed the write
  check; bubblewrap `--ro-bind` before the deny masks, Landlock `r` rules with the parent carved).
- **unattended, every other tier** (the full-auto sandbox relaxation, silent or standing-approved reads): the whole project read-only
  (bubblewrap `--ro-bind`, Landlock `r` rules; the scratch area and bubblewrap's private `/tmp` stay writable), so no name, existing or
  new, appears without a card (Astra 2170 R1); a failed such run tells the model the project was read-only. In a full-access turn an
  unattended call means the grant no longer holds (it reads as standart): it is project read-only whatever its tier.
Standart and full-auto keep exactly the Astra 2170 postures. A read-only project also keeps its repository read-only (Landlock `git`
class, bubblewrap's writable common repository follow the project posture). The write floor holds inside a Landlock carve too (an
ignored ancestor holding product state, e.g. `.deckent/` in `.gitignore` with the data root beneath it): a floored entry takes a
read-only rule and a floored directory's subtree is read-only (869c01f; before it, the carve granted every other entry read-write, so
the `.deckent/**` floor of a narrow unattended call and the full-access configuration file were writable under Landlock — bubblewrap
held). MCP server starts — in a turn and from the CLI (trust, health, restart) — build the same layout with the write floor
(`writeFloor` is required on `ShellSandboxLayout`); both realms refuse a read-only-floor request whose layout carries no matcher (fail
closed, the server does not start). MCP server views keep this behavior in every mode (the approval floor carried; no repository
write); MODES-3 defined no full-access MCP posture. The host realm has no OS boundary for any posture. Open (C5, PLAN SHELL-OVERLAY): a
long-lived MCP server can still create a floor name that does not exist yet; a full boundary needs an overlay with a post-run apply
step (bubblewrap ≥ 0.11 or a native userns overlay) — a new effect class, an owner decision.
**Full access (MODES-3).** A turn is full access only when `chatTurn.fullAccess: true` (protocol v17) — set by the terminal launched with
`deckent --full-access` / `deckent terminal --full-access` or by the person's stored start mode `full-access` — and only while a company
grant allows `permission-mode`/`set` on id `full-access` (`fullAccessGrant`; the decision asks it on every call, so a grant revoked
mid-turn stops the next effect at its gate). A stored `full-access` entry without the flag decides as standart (headless/SDK/MCP need the
explicit parameter; MCP/SDK expose no `chatTurn`). Admission (`admitFullAccessTurn`): no grant → `PERMISSION_MODE_DENIED {mode:
full-access}`, recorded when possible; allowed → a sealed `full-access-turn` event before the first round (no record →
`AUDIT_UNAVAILABLE`, no turn). Decision: a deny ends it (every mode); a company `require-approval` that is not `modeEligible` still asks
(the Claude "ask rule" analog, Enterprise's lever); otherwise every cell runs without a card — the floor raise and eligible
require-approvals are lowered — except `mcp-floor` (the owner's `alwaysAsk` pin / pinned `destructiveHint`) and the new `edit-authority`
cell (a write of the installation's configuration file inside the project: it decides where policy, bindings and approvals live, the
realm and the network; raising in every mode, never lowered, no standing approval). Every allowed effect call (edit, shell, fetch, MCP)
writes a sealed `full-access-call` event (cell, policy decision, raised, lowered company rules, grant rule, summary; fetch = host +
argument digest, never the URL) before its effect; the effect gate admits only that decision (`isAuditedDecision`). Read tools are not
recorded per call. Hard floor unchanged in every mode: product state (every layout resource but `config`), credential patterns,
`.deckent/host|audit-key|approvals`, the MCP project registry. A full-access turn opens only the repository internals: the workspace
deny drops `REPOSITORY_INTERNALS_DENY` (`.git`, `.git/**`, `**/.git`, `**/.git/**`), and both sandboxes make Git metadata writable
(`ShellSandboxLayout.repositoryWritable`: bubblewrap binds no `.git` read-only and binds a worktree's common repository read-write;
Landlock gives clean Git entries `w`; the inode floor's masks stay); the sandbox posture is the full-access bullet above. Host realm: the
hard floor for shell is name-based (a command naming product state is refused; an expanded name is not caught) — the realm is not
changed by full access (config `terminal.shell.realm`; owner 2026-09-29: full access stays comprehensive, not forced into a sandbox —
the OS boundary for product state is the planned OPEN-SANDBOX view, PLAN "İzin modları ve sandbox").
**Mode status and `/mode` (T-L4 slice 4c, owner q7, protocol v15).** Two v15 operations, current version only (a v14 envelope is
refused; window stays [15,14]). MODES-3 shapes (protocol v17): `inspectPermissionMode {scopeId}` → `{supported, mode, askEdits, revision, eligible,
fullAccess}` over the request's
policy + bindings snapshot (scope admission `read`; `eligible` = a mode-eligible require-approval rule can apply to this person here;
`supported: false` for a v1 policy), and `setPermissionMode {scopeId, mode, askEdits?, expectedRevision}` → the view + `previous`, `changed`.
No actor field: the socket peer is the principal and only that exact issuer + subject's bindings `modes` entries change (the
scope leaves them; unless standart without `askEdits`, it joins the caller's entry of that mode or a new `m-<hash>` entry); every other entry and the role
`bindings` are kept. `PermissionModeApplication` (engine/core/policy) owns the transition: conditional on the effective
`policy+bindings` revision (`PERMISSION_MODE_CONFLICT`), a company `permission-mode`/`set` grant whose resource id is the target
mode (deny/no grant → `POLICY_DENIED`, require-approval → `POLICY_APPROVAL_UNSUPPORTED`); tightening to `standart` or setting `askEdits` needs no set grant (owner 2026-09-27, R4: the grant/deny rules
are not consulted for them; a company deny cannot keep a person in a relaxed mode, the scope boundary still applies; audited as
`decision {effect: 'allow', ruleId: null}` — a grant always names its rule, so a null rule means no grant was required), v1 policy →
`PERMISSION_MODE_UNSUPPORTED`. Every decision writes a sealed `permission-mode-change` audit event (audit subject union extension;
ledger v41 unchanged): `requested`, `previous`, `decision {effect, ruleId}`, `bindingsRevision {before, after|null}`; an allowed
change is recorded before the file changes (no record, no change; an unrecordable refusal is still a refusal) — so an `allow`
record's `after` revision is intent, not proof: a rename failure or a replacement detected by the identity check (typed conflict)
leaves a record whose revision never reached the file. `FilePolicySource.update`
is the conditional store: per-file serialization in the service process, policy + bindings read under the usual guards, the new
document written to a same-directory `O_CREAT|O_EXCL|O_NOFOLLOW` file with the original 0400/0600 mode, flushed, the identities (dev/ino/size/mtime/ctime) of both authority files re-checked — the bindings target and the policy file that
authorized the change and fixed the compared revision (Astra 2139 R1; either replaced → `PERMISSION_MODE_CONFLICT`, nothing replaced), then `rename` + directory fsync; the writer must be the trusted owner uid. The new
bindings revision is `m-` + sha256(previous revision, new body) (chained, no ABA). Every write is bindings v3 (a v1/v2 file is upgraded on
the first write). The terminal shows the mode as a droppable status-row segment (catalog text only; drop order notice → elapsed →
mode → model → queue; hidden when unknown or unsupported), refreshed at open, after `/mode` and after each turn; `/mode` shows it
and `/mode <mode>` sets it with the revision last read. The surface reads and writes no file. MODES-3: `full-auto` and the stored
`full-access` start mode need their grant; the `permission-mode-change` event gains optional `askEdits {requested, previous}` and the
`permission-mode` event's `grants.person` may be null (the default standart). Terminal: the status segment `full-access` is
non-droppable (role error); `/mode full-access` is refused in the surface (the service is not asked) with how to launch; `/mode
standart|full-auto` in a full-access session ends full access for the session; `/mode ask-edits on|off`; `/mode start full-access`
stores the start mode (next launch). Launch: the flag without the grant → the terminal does not open (`PERMISSION_MODE_DENIED`); a
stored start mode without the grant → a standart session with a notice; full access → an opening warning notice.

**`/mode` messages (MODE-UX G3, seventh batch).** On a v1 policy (`view.supported = false`) the surface never calls `set`; `/mode` shows
the current mode with a one-line effect, the other modes with theirs, and says when nothing in this scope can change it. Typed refusals:
`PERMISSION_MODE_DENIED` (`{mode}`; no allow grant on `permission-mode`/`set`, instead of the generic `POLICY_DENIED`; `require-approval`
stays `POLICY_APPROVAL_UNSUPPORTED`) and `PERMISSION_MODE_LOCKED` (the authority write lock is held; `CONFIG_WRITE_LOCKED`'s path/pid/age
carried, only on `setPermissionMode`). Protocol and view schema unchanged (v15). Open: which modes are actually settable (per-mode `set`
grant) is not in the view (checkpoint).

**Standing approvals (PERSISTENT-APPROVALS G6, owner 2026-09-28 "kapsam seçmeli", seventh batch).** A standing approval is the person's
own v2 grant on resource kind `agent-tool-call` (ids `standing-*`, one person, one scope list, id = key `v1:<tool>:<kind>:<pattern>`), or
"this session" (`SessionStanding`, the service process's memory keyed by scope + person + conversation). Only the lowering step of
`decideAgentToolCall` reads it (step 4): it lowers the floor raise of a standing cell, or an eligible `require-approval` that no mode
lowered; a deny is never lowered, and only the edit, `shell-read-low` and `shell-narrow-mutating` cells can stand (write floor,
destructive, always-ask, other-modify, fetch and MCP cells cannot). A role's all-ids authority over the kind is authority to delegate,
never an approval. Persisting goes through `policy.administer@1` (P3): `PersistentStanding` submits the change, allows the pending
operation approval as the same person through `ApprovalApplication.decide` (separation of duties applies) and resubmits; the delegation
bound is that person's authority. Every use and every "this session" answer is a sealed `standing-approval` audit event (`remembered` /
`used`) written before the memory holds it or the effect runs. The card offers a scope only when `standingWouldLower` holds. In the
default standart an eligible ordinary edit is lowered by the mode first; a standing approval on an edit matters for a person who asks
for edits too (`askEdits`) or where the mode does not lower. CLI:
`deckent policy grants --mine` / `deckent policy revoke`. No version changed (policy v2, bindings v1/v2, ledger v42, protocol v16, layout 4);
the vocabulary gains `agent-tool-call`. Not yet: the card scopes + decision field on protocol v17 (introduced by MODES-3; MCP `decide_approval` keeps them out), the
service wiring from the turn's `requestApproval` to `offer`/`remember`/`persist`, the installation root (P4; a v1 live policy cannot offer
"always"), `/policy`, listing this session's memory.

## Package contract

- Public API is `index.ts`; everything else is internal.
- Every configured text source file ≤ 1,500 lines (eslint + lint-arch; 800 design target), functions ≤ 150 lines (warning).
- Package line budgets and the total budget live in `arch.json` (`budgets`); growth past a budget is a
  design decision, not a lint fix.
- Mechanism code is string-free: user-facing text comes from `src/platform/core/i18n/locales/{en,tr}/*.json` through `t('key')`.
  Keys are literals (lint), catalogs have identical key sets (lint), surfaces never print literals (lint).
- Config field values live in `src/platform/core/config-fields`; `config-literal` uses source-derived
`scripts/config-vocabulary.json` with freshness checks before lint/build.

- Concrete model/provider identifiers and provider credential variable names are forbidden in `src/**`
  (`arch.json` `literals.forbidden`, empty `allow`); they come from configuration and registry data only.
- Target: the product writes markdown only through one docs-authority writer (`arch.json` `markdown.writerModule`),
  and only `DECKENT.md` plus a bounded section in `CLAUDE.md`/`AGENTS.md`. That module does not exist yet
  (PLAN "Mimari kapı artıkları", W0-9); lint-arch `md-write` enforces the rule, so today no product code writes
  markdown, and no README/CHANGELOG/vision/sprint-log writers exist.
- Every environment: Linux, macOS, Windows native, Windows WSL, Docker. A platform without proof reports a
  typed `UNSUPPORTED`/`DEGRADED`, never a silent fallback.
- Project state lives under the project's `.deckent/` (gitignored; layout from `layout-resources.json`), and the
  transactional ledger carries its own schema version. Legacy `.brain/memory.db` is not a Next store; it stays on
  the workspace deny list and migrates only through the memory cards.

**External dependencies (DEPS-GOV, owner 2026-09-29; eighth batch).** `dependencies.json` (schemaVersion 2; `arch.json`
`dependencies.registry`) is the single source of truth for every package.json dependency and devDependency: owning arch units or packages,
purpose, grep-backed features, criticality (P0/P1/P2), alternatives with version and date, own-solution note, embedded (bundled) components
and lastReview/nextReview (interval ≤ 30/60/90 days by criticality); a `platform` section tracks Node, node:sqlite, bubblewrap, git and
Docker the same way. lint-arch (offline, in verify) fails when a `src` bare import (static, export-from, `import()`, `typeof import()`,
`createRequire()()`) is not a package.json `dependency` with a runtime registry entry owned by the importing unit/package, when a
devDependency is imported from src, when a Node built-in lacks the `node:` prefix, when a module load uses a non-literal specifier, when an
owner no longer imports the package, when package.json and the registry disagree, and when an installed package's sourcemaps embed
components other than the registry's `embedded[]`; a passed nextReview only warns. The domain's external allowlist is derived from the
registry (the former `packages.domain.externalImports` is gone). `scripts/deps-watch.mjs <dir>` (networked, not in verify) writes a dated
JSON + Markdown report: OSV for the installed tree and embedded components (unrated = HIGH, MAL- = CRITICAL), npm
latest/deprecated/provenance, alternative versions, `npm audit signatures`, licenses against the registry policy; it exits 1 on
HIGH/CRITICAL and on any unreadable source. `acceptedRisks` (evidence-backed, expiring ≤ 30 days for HIGH/CRITICAL, ≤ 90 otherwise) turn
an exactly matching advisory set on one package@version and carrier into MITIGATED report rows that do not fail; expiry or any
advisory/version/carrier/severity change fails again; lint-arch validates the entries and warns after expiry. The one entry today is
fast-uri 3.1.0 inside MCP SDK 2.2.0 (expires 2026-10-29: renewed with fresh evidence, or removed when the SDK ships a rebuilt bundle).
Not yet: weekly scheduling of deps-watch (CI `schedule` or host cron; the pre-batch run is manual).

**Published package (DEPS-DIST, 2026-09-29; ninth batch).** The npm package has no `dependencies`: `scripts/build-dist.mjs` bundles
third-party runtime code into `dist/vendor/` chunks with esbuild (ESM, code splitting, lazy `import()` preserved) while every Deckent module
keeps its tsc path, so `import.meta.url`-relative resources (build identity, package root, N-API addon, sandbox helpers, spawned entries)
resolve as in the tested `dist`. Outputs that define esbuild's `__require` shim get a `createRequire` banner. The package ships
`sbom.cdx.json` (CycloneDX 1.6 from the bundler metafile: a package is shipped only if it contributed bytes; components embedded inside a
shipped package are listed under it only when the embedding file was bundled) and `THIRD-PARTY-NOTICES.md`; `deps-watch --sbom` and
OSV-Scanner read it. `scripts/pack-smoke.mjs` installs the tarball offline with an empty cache and drives version, MCP server, MCP client,
runtime service, terminal and native addon per supported Node. Publication is gated (`summary.json publishable`) while public declarations
name third-party packages, LICENSE is absent or a shipped component lacks license text. The Core license line under "Enterprise layering"
(MIT) is not changed here: the Apache-2.0 decision lands with DEPS-P0.

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
| 2026-09-29 | Seventh batch keeps `surfaces/core/terminal` within the 2000-line unit budget by moving two dependency-free presentation pieces: the approval-card key mapping (`decisionKey`, `scopedDecisionKey`, `StandingScope`) to `terminal-kit` and `ArrowPicker` to `terminal-render`; `terminal` re-exports the key mapping unchanged. | MODE-UX, PERSISTENT-APPROVALS, `/mcp` and TERM-UX-1 together passed 2000 (2020, then 2041). No budget raise; the next terminal feature splits the unit by responsibility (e.g. a session unit), as TERM-UX-1 noted. |
| 2026-09-28 | FOUNDATION: `budgets.packageLines.composition` 5000 → 5500 (owner-approved increase; earlier decision "raise to 5500 if the pressure returns"). | MCP client + policy administration wiring (seventh batch, measured 5067 lines after the SESSION-RESULT-LIMIT, POLICY-ADMIN and MCP-CLIENT merges). The next pressure is answered by moving responsibility out of composition, not by another raise. |
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

### First-run policy template (implemented, SCR-B, owner 2026-09-28 option B)

`deckent init policy --scope <id> --preview|--apply` is a second installation path that needs no Docker, pool or registry: it
journals only `policy.json` + `bindings.json` under the same single `installationJournal` ("one installation, one transaction";
`InstallationResource` gains `bindings`, journal schema unchanged), takes no `authoredProfile`, and derives its plan/transaction id
deterministically from scope + principal + template version. `PolicyTemplateInstallationApplication` (engine installation) is the
sibling of `InstallationPublicationApplication`, reusing its `INSTALLATION_PUBLICATION_*` vocabulary without the
Docker/pool/evidence/consent ceremony. `firstRunPolicyTemplate` (domain policy) is a v2 policy + v1 bindings: read and scratch tools
silently `allow`, edit/shell `require-approval` with `modeEligible: true`, operation grants for `workspace.file.write`,
`host.shell.run` and `workspace.scratch.write` (both sides must allow for silence), no pool/service grant (owner's decision). Tool
names and operation ids are template data pinned to the real tool specs and Core descriptors by a contract test. `doctor --json`
reports `policyTemplate: {id, version} | null` (recognition only, never authority). It grants no fetch: the default egress is `none`,
and opening the network (a `fetch_url` / `network.fetch` grant and a `terminal.fetch` section) is a separate owner decision.

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

Git transport closure (GIT-NET, owner 2026-09-29 P1; eighth batch): every local Git invocation of the patch adapter (`git-patch`:
snapshot, integration observation and the command runner share one construction, `GIT_LOCAL_ENV` / `localGitArgs`) reaches no transport, through three independent layers:
`-c protocol.allow=never` (the owner-named mechanism); `GIT_ALLOW_PROTOCOL=''`, an environment variable that overrides any configuration,
so a hostile source repository's own `.git/config` (`protocol.file.allow=always`, not suppressed by `GIT_CONFIG_NOSYSTEM`/
`GIT_CONFIG_GLOBAL`) cannot re-permit a transport (measured residual, closed and mutation-verified); and `GIT_NO_LAZY_FETCH=1` against
promisor lazy fetch. The `git-workspace` broker is the named local-clone exception (`protocol.file.allow=always` for its clone; its
pre-clone `rev-parse` calls carry `GIT_NO_LAZY_FETCH=1` but no `GIT_ALLOW_PROTOCOL` — `file` would be needed there, a decision not yet
made). Not yet: a declared minimum Git version checked at run time.

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
`session.started` and unmapped counts until its normalizer lands. **Structured final report (B09-2).** Native authoring v3 asks the worker for a final report v1 (summary, changed-file claims, check
claims and results, open issues) through the pinned CLI's schema flag (Claude `--json-schema`, Codex `exec --output-schema`; Cursor's
pinned CLI has none → `unsupported`); v2 profiles are unchanged; optional `maxTurns` is profile data (Claude only, refused elsewhere).
The container bridge validates the strict shape, bounds it (32 KiB), redacts every free-text field and seals it as a versioned
`native-worker-report` record inside the existing dispatch stdout artifact; invalid/oversized reports count as `dropped`. The report
is an untrusted worker claim: acceptance is unchanged (a reported `passed` check does not rescue exit 7); `task transcript` shows it
after artifact/identity verification. Not yet measured: real model schema output and a real turn-limit stop. `report workers` and
live `workers watch` phases (B09-3) remain open.

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
**Time contract (I40).** Core components that compare wall times read the platform `SystemTrustedClock`, never raw
`Date.now`: composition wires it once per operation into tariff acquisition, preparation, quote and send, invocation
records (claim/permit/outcome, cancel, purge) and Run reservation; adapters keep their `now: () => number` port.
Tariff observations are process-bound (WeakSet provenance), so the floor alone orders them; tariff expiry
(`now >= expiresAtMs`) stays exact and the floor only moves forward (during a backward step expiry is noticed up to
one step late, as before). Records written by another local process may lead this one by an independent step:
task-approval admission tolerates a decision time at most `MAX_WALL_SKEW_MS` (5000 ms, a versioned platform invariant,
not configuration) ahead of the reservation time. The allowance orders records only: it never extends request or
tariff expiry and never bypasses MAC integrity or `requestDigest` checks. Cancellation delivery and recovery read the trusted clock; a persisted `claimUntil` / `nextEligibleAt` of another process is
taken over only when it is at most `now − MAX_WALL_SKEW_MS`, in the atomic claim decision for every entry point (I40-b; cost: every
retry waits retryDelayMs + 5 s, including a process's own). Config write-lock waits and in-process failure backoff are monotonic;
lock age subtracts the allowance before age-based reclaim; worker heartbeat age is `max(0, now − mtime − MAX_WALL_SKEW_MS)`.
Remaining raw-`Date.now` comparisons across
processes (record-only timestamps) are listed in the I40 review and are not yet on this contract. Agent tool approvals (I40-c B, owner 2026-09-27): request and turn timestamps read the trusted clock, and only the requesting process determines expiry, using its floored wall clock and the monotonic TTL anchored at request creation. The deciding application authenticates, authorizes, seals and persists the decision without independently expiring tool-call requests; a record already expired is still refused. The producer checks expiry while waiting, after asynchronous policy work and immediately before the effect claim. A recorded allow is decision history, not evidence of execution nor an extension. The record schema permits `decidedAt >= expiresAt` only for `agent-tool-call` subjects (createdAt lower bound and task/operation expiry bounds unchanged); an older build refuses such a record with `APPROVAL_INTEGRITY`, and mixed reading is prevented because the same batch moves the ledger to v41, which older builds refuse.
This Linux local witness
is not remote bearer authentication; `token-verified` remains an extension port, not a shipped verifier.

**Operation approval broker (C12 G1/G2, ledger v40).** A catalog operation whose policy answers `require-approval` no longer stops
with `EFFECT_APPROVAL_REQUIRED`: the approval subject `operation` {operation id@version, target, commandId, input digest, target
binding, expected version, compensates} is opened (producer integrity, `approvals.requestTtlMs`) and the first submission returns
an `approval-pending` outcome (EffectApprovalPending, schemaVersion 2; settled EffectResult v1 unchanged byte-for-byte) — no intent,
no effect (owner Q1: approval → intent → effect). After an `allow`, resubmitting the same command applies the effect once: the
intent carries `approval {approvalId, actionDigest}` and consumes it; another commandId or input is another request; the allow is
usable only within `admitWithinMs` (descriptor data, default `approvals.requestTtlMs`; owner Q3) and a decision time beyond
`now + MAX_WALL_SKEW_MS` is refused. The core never blocks; SDK `awaitApproval` / CLI `deckent operation … --wait <ms>` poll and
resubmit once (owner Q2). Ledger v40 adds `operation` to the approvals subject CHECK (backed-up migration; a v39 build refuses
v40). Since protocol v15 (2026-09-27) runtime clients receive operation-subject
approvals: the terminal `/approvals` lists them (run/task `-`, request summary) and decides them on the y/N card; a v14 client cannot
reach approval operations at all (current version only). The hidden-subject view for versions below 15 remains the engine contract
(excluded in page selection before LIMIT, Astra 2128), tested in process. **Runtime operations and MCP operation tools (C12 G4, protocol v15).** `executeOperation`, `compensateOperation` (input: the effect
command) and `inspectOperation` (`{schemaVersion: 1, scopeId, commandId}` → `{schemaVersion: 1, record}`) are v15 control operations,
current version only, bounded by `delivery` (an inspected record carries the command input; an answer beyond the delivery is
`RUNTIME_SERVICE_RESPONSE_LIMIT`, an execute outcome is durable first and replays by `commandId`). The service runs them through the
same composition function as the CLI/SDK (`withEffects`), with the kernel-verified socket peer as principal and that connection's
live witness as session (the `configuredApproval` pattern): same scope membership/company (`SCOPE_UNKNOWN`, code only), policy,
broker and effect contract. Non-blocking: a required approval answers `approval-pending`; the same command resubmitted after an
allow settles once (no wait over the socket). The client validates and correlates every answer. MCP `execute_operation`,
`compensate_operation`, `inspect_operation` use the runtime client; their hints are derived from the installation's reachable
catalog (unified catalog restricted to configured target kinds): read-only iff every reachable operation reads, destructive iff
any writes or is irreversible, open-world iff any exists; compensation is bounded by the whole reachable catalog (Astra 2139 R2: the compensating operation resolves from the current catalog
while the pairing comes from the original intent's pinned descriptor, so any reachable operation may be a pinned compensation;
compensate hints ≡ execute hints); idempotent from the
engine's commandId replay; inspect is a read-only ledger query. Approval tools and their live-session and four-eyes rules are
unchanged (no MCP self-approval relaxation). CLI `deckent operation` stays on the direct path (no service fallback). A v14 envelope
for these operations is dropped before dispatch (the client sees a transport failure; no dedicated version code).
A tool's JSON result is sent as text and, only when it is a JSON object, also as `structuredContent` (the protocol requires an object);
a list result (`list_approvals`) travels as text only — before C12 G4 a validating MCP client rejected it (`expected record, received array`). Authorization points outside the catalog answer `require-approval` with typed `POLICY_APPROVAL_UNSUPPORTED` (still a
refusal; owner Q8), and cancellation recovery and its classifiers treat it and `SCOPE_UNKNOWN` as denials, never as a crashed page. Installation's two require-approval points (pool grant, shutdown grant) use their own `INSTALLATION_PROFILE_APPROVAL_UNSUPPORTED` (config, exit 78; owner 2026-09-27), like their `INSTALLATION_PROFILE_*` siblings; `init preview` is proven with the compiled CLI, `init apply` shares the same preparation call (inspection only).
C12 G3: agent edit/shell effects verify their `agent-tool-call` record at the effect (same pin-in-intent consumption); the terminal flow, protocol and ledger are unchanged by G3. Refusals are typed tool results (`APPROVAL_REQUIRED`, `_DENIED`, `_EXPIRED`, `_CONFLICT`, `_MISSING`, `_INTEGRITY`), nothing written or run.

**General Core audit port, first slice (AUDIT-PORT, ledger v41; owner 2026-09-27 q4/q5).** Silent decisions Core makes get a durable, sealed audit record through one port: `domain/core/audit` (event v1: `eventId`, `scopeId`, principal issuer/subject, policy revision, caller-supplied `atMs`, typed `subject` — first kind `permission-mode`: mode, cell, tool, turn/round/index/call, derived company and person grant ids, `require-approval → allow`, and a bounded summary: workspace-relative path or the first 200 characters of the shell head plus `argsDigest`; never the raw command or file content), `engine/core/audit` (`AuditStore` port, `sealAuditRecord`/`verifyAuditRecord` on the approval MAC line — `audit-record:1` over event + scope-local sequence + keyId — and `AuditApplication`: `record` returns only after the store wrote the sealed record, committed by the store or inside the caller's open transaction; any failure is typed `AUDIT_UNAVAILABLE`/`AUDIT_INVALID`/`AUDIT_CONFLICT` and the caller applies no effect — "no audit, no effect"; `list` verifies every seal, row identity and sequence continuity within one scope; `count`/`counters` are q5 summary totals) and `adapters/core/audit-store` on the shared ledger. Ledger v41 adds `audit_events` (PK scope+sequence, UNIQUE scope+event id; `BEFORE UPDATE`/`BEFORE DELETE` triggers abort with `AUDIT_APPEND_ONLY`, so append-only is a database guarantee) and `audit_counters` (mutable summaries, no seal). The service-start upgrade backs up v40 (0600) and migrates in one transaction; a v40 build refuses a v41 ledger (`ATTEMPT_STORE_VERSION`). Not yet: a SIEM/export adapter reading the port, sealed counters, retention.

**Roles, bindings and four-eyes (H34 S2, policy v2).** Policy documents are v1 or v2; v2 adds `roles` (role → permission rules) and
`separationOfDuties` (`requester-cannot-approve` over scopes). Role membership lives in a separate `bindings` layout resource
(`bindings.json`, same owner/mode/link/size guarantees as the policy file; owner H34 d): principals → roles over scopes. The source
merges both into one effective document (revision = policy + bindings), so every existing gate evaluates roles; order stays
scope → deny/restriction → require-approval → allow → NO_GRANT; role rules are derived per request for that principal only (exact
issuer + subject); a role is never a call parameter; a binding grants membership in a pinned scope but never declares or pins one.
v1 parsing is unchanged (bindings are not read); an older reader refuses v2. Four-eyes is enforced in `ApprovalApplication.decide`
on `allow` only (the requester's own allow → `APPROVAL_DENIED`). Roles may target `task` rules (2026-09-27): Run reservation wires
the task-admission filter whenever any explicit or role-derived task rule exists in the effective document (`policyGatesTaskAdmission`);
the per-principal decision stays exact, the wiring check is document-wide (unrelated principals may see the approval journal opened). Adding the `bindings` resource changes every installation's layout revision:
admitted but unexecuted Runs from before the update get `RUN_STORE_CONFLICT` at execution (same as earlier resource additions).
Scope access mode is stated at every call (Astra 2126 R1): queries pass `read` and never pin a scope; only write admissions pin.
The sealed adapter registry holds immutable snapshots of factories and manifests (Astra 2126 R2).

**Governed policy administration (POLICY-ADMIN P1–P3, lead decision A1, 2026-09-28).** One Core catalog operation
`policy.administer@1` (target kind `authority-document`, record `installation` = policy.json + bindings.json, version = the effective
`policy+bindings` revision; `effectClass: write`, **`approval: required`**, `precondition: record-version`, no compensation — a revert is
a new change). Input v1: 1–32 typed changes `grant.add|remove|replace`, `binding.add|remove|replace` (`domain/core/policy`
`planPolicyChange`); roles, restrictions, separation of duties and persons' modes are not change kinds yet. **Delegation bound**
(`delegationWithin`, pure): every touched rule — added, removed, both sides of a replacement; a binding touches each permission of each
named role at its scopes — must lie in the bounding principal's own authority cell by cell (action × id × scope; `'all'` is one cell),
in the evaluator's order: a deny/restriction meeting the cell refuses; no allow/require-approval covering it refuses; require-approval
stays at most require-approval; `modeEligible` only from eligible rules; ≤ 4096 cells. The owner root is data: role
`installation-owner` whose permissions `installationOwnerPermissions(kinds)` lists every kind (U2 form); kind matching is the single
`kindCovers` (exact today; the joker kind of S2 = U1 changes only it). No evaluator branch for the owner; a restriction binds it too.
**Never silent (owner M3):** `approval: required` opens a C12 request even on an allow grant, in every permission mode. **I3:** the
bound is the decider's authority — `DelegationBoundGate` (engine/core/approval) loads the sealed approval, refuses a decider without
the authority before any claim (`POLICY_DELEGATION_EXCEEDS`), and the target checks the bound again inside the store's write window on
the exact snapshot it replaces (a claimed command is refused terminally there). **Surface class (I5-i):** descriptor field
`surface: 'authority'`; `EffectApplication` is generic by default and refuses such a descriptor right after catalog resolution, before
target/policy/approval/ledger access (`OPERATION_SURFACE_RESTRICTED`) — CLI `deckent operation`, SDK, the runtime service behind MCP
`execute_operation` and the agent producers (including the MCP client's `mcp.tool.call@1` producer, whose one-entry catalog never
resolves it); only `PolicyAdministrationApplication` passes `{ surface: 'authority' }`; generic `inspect` stays readable. **Audit:**
subject `authority-change` (event v1 union, ledger unchanged): operation, commandId, approvalId, decider, input digest, revision
before/after, change counts — recorded before any file changes. **Writer (P2):** `FilePolicySource.updateAuthority` is the one writer of
both files for every product path (`/mode` included; its wire, grant rules, `permission-mode-change` event and `m-` revisions are
unchanged): both files read under the usual guards, O_EXCL temporaries + fsync, identity of both files re-checked before each rename,
order bindings→policy when the change removes/replaces, else policy→bindings (both intermediate states validated first), chained `a-`
revisions, an archive record per write under the registered `audit` resource (`audit/authority-revisions`, `prepared` before the first
rename, `committed` after the last, full documents before/after; keyed by the C11 wire key for `lookup`: committed or files at `after` →
applied, files at `before` → absent, anything else → unknown), and a cross-process lock injected by composition (the platform directory
lock `policy.json.write-lock`, 5 s bounded wait, typed `CONFIG_WRITE_LOCKED`). Measured (2–4 OS processes, 400–600 writes): without the
lock 39–70 lost updates, with it 0. The `POLICY_*` refusal codes have en/tr texts but no surface maps them yet. Not yet: any surface
(`/policy`, `deckent policy`, protocol v17), refusal audit events, last-owner guard, external-change detection, a sealed archive, MCP
`decide_approval` refusal for authority subjects.

**Authority hardening (POLICY-HARDEN P3-R, seventh batch).** `ApprovalApplication` takes a `restriction { catalog, surface?, refused? }`:
an approval of an operation whose descriptor is `surface: 'authority'` is allowed only by the application built with `surface: 'authority'`;
every general surface (SDK, CLI, MCP `decide_approval` through the runtime service, the terminal) gets `APPROVAL_SURFACE_RESTRICTED` (registered,
so the runtime client sees the code); a deny stays open everywhere (open decision). A claimed intent whose authority is gone at settle is
refused terminally (`POLICY_DENIED` → `refused/EFFECT_REJECTED`; no new refusal value). Audit event v1 gains `authority-refusal` (`stage
decide|submit|settle`, code, command/approval ids; no change content). The approval summary of an authority operation is a redacted,
human-readable diff (`describePolicyChange`, ≤ 2048 characters, cut by code point) through `OperationApprovalBroker`'s `describe`; no
protocol field. Remaining: P4 installation root, P5 authority surface, model tool M3, ledger v43 archive.

**Company scope registry (H34 S1, ledger v39).** Every request scope resolves to a company or is refused with typed `SCOPE_UNKNOWN`;
no flag relaxes this. Ledger v39 adds `companies(company_id)` and `scope_registry(scope_id PK, company_id FK, origin
'migration'|'start'|'admission')`: one company per scope, insert-only pins, so the company of every scope-partitioned record is the
join through its `scope_id` (no per-table company column). A scope named explicitly in an allow grant of the trusted company policy
is pinned to the configured `company.id` at its first write admission, before any scoped record is admitted; reads never write (an
unpinned declared scope resolves for that read only and holds no records); `scopes: 'all'` reaches pinned scopes only and never
declares one. Once pinned a scope never moves: another `company.id` answers `SCOPE_UNKNOWN` (no disclosure; Astra 2122/2123). No
trusted grant → `POLICY_DENIED` before any ledger access. One composition function (`scoped-request`) serves CLI/SDK/MCP, the runtime
socket peer path, inventory and governed shutdown. Config `company.id` (default `default`, `^[a-z0-9][a-z0-9-]{0,62}$`) is shown by
`doctor --json` as `company.companyId`. `runtime serve` pins the configured company and the installation's own scopes at start; the
v38 → v39 upgrade (0600 backup first, one transaction) pins scopes already in the ledger; a v38 build refuses a v39 ledger. Company-aware
authorization at every port (H34 S3): the membership rule is the one company check; every port's first policy check (`principal.scopeIds`, reason `SCOPE`) consumes its result. Where one installation reads another's records (a `next-project` worker source), the target resolves the scope for its own company and the bridge refuses unless that equals the request's company (`assertRequestCompany`, before any target record is read). A `SCOPE_UNKNOWN` refusal carries an internal typed reason (`COMPANY` | `UNREGISTERED`) on `PolicyAuthorizationError`; surfaces carry the code only, so another company's scope stays indistinguishable from an unknown one. Role bindings never reach a scope pinned to another company; governed shutdown and runtime loops re-enter the same membership per admission/page. H34 S4 removed the retired scope fields: config schema 3, layout registry 3, doctor JSON 2 (config 2 → `CONFIG_VERSION_UNSUPPORTED`, an older layout snapshot → `LAYOUT_VERSION_UNSUPPORTED`; no conversion or alias); the vocabulary gate forbids the retired word everywhere except the HARVEST record. The layout revision changes, so Runs admitted before the update are not claimed compatible. `runtime serve` refuses to start (typed `RUNTIME_SERVICE_SCOPE_FOREIGN`, category `config`, exit 78; no company identity disclosed) when one of its own scopes — its configured identity/loop scopes or any scope the trusted policy declares — is already pinned to another company (owner 2026-09-27 evening decision 6); a read-only precheck runs before any write, so a refused start leaves the ledger unchanged, and the post-write `pinnedElsewhere` check remains a backstop for the admission race. Consequence: an installation cannot change its own `company.id` after its scopes were pinned at a prior start (no company migration operation exists yet). Not yet: run-progression lists runs of foreign-pinned scopes each poll (S3 Q2); a company migration operation.

**Operation target adapter registry (A04-1).** Operation targets resolve through a registry, not a literal: `domain/core/adapter-registry`
(manifest v1: `module {id, version, tier, namespace|null}`, `requires.coreApi {min,max}` against `CORE_API_VERSION` 1,
`provides.targetAdapters`, `provides.operations`, `signature|null`) and `engine/core/adapter-registry` (`AdapterRegistry`: Core
entries at construction own the root namespace, overlays register under their own dotted namespace, sealed after config
registration). Tier and namespace claims grant nothing; a namespace may not equal, nest under or over another or a root id; duplicate
`id@version` and adapter ids are refused; a manifest may add operations but never redefine one (owner Q5, adds-only); a non-null
signature is refused until verification exists (A04-3, owner Q7). Config shape is unchanged (`operations.targets[].adapter` is a
registry identity; `http-conditional` is the Core entry `core.http-conditional-effect@1`). Not yet: module
loading, signature verification and a separately distributed Enterprise package (A04-3), public SDK export of module registration.

**Standard Schema boundary (DEPS-SCHEMA, owner 2026-09-29; eighth batch).** A target adapter factory's `optionsSchema` is a
`StandardSchemaV1<unknown, { kind }>` (Standard Schema 1.1.0, https://standardschema.dev; types vendored verbatim under
`platform/core/validate`, MIT, not an npm dependency), not a zod type: an Enterprise/ERP module may use zod 3.25+, Valibot, ArkType or a
hand-written validator; Core internals keep zod. The registry is the one validation owner (`AdapterRegistry.targetOptions`, used by config
validation, `resolveOperationCatalog` and `targets`). Validation is synchronous: a Promise result is refused
(`OPERATION_TARGET_OPTIONS_ASYNC` in config, `REGISTRY_OPTIONS_ASYNC` at construction; the rejection is consumed); a result without a
non-empty string `kind` is invalid whatever the vendor's declared type. Admission requires `~standard.version === 1` and a `validate`
function (`REGISTRY_FACTORY_MISMATCH`) and snapshots `~standard.validate`, so reassigning it after seal changes nothing. `CORE_API_VERSION`
stays 1 (the change widens what a module may pass; zod 3.25 schemas already satisfy it). The SDK exports the Standard Schema types and
`isStandardSchemaV1`/`validateStandardSchemaSync` through `platform`. Not yet: config sections (`registerConfigSection`) still take a strict
zod object (owner checkpoint C1); the SDK entry still publishes six live zod schema values and 44 `z.infer` types (owner checkpoint C2);
Standard JSON Schema is vendored but unused until zod ≥ 4.2. The MCP `tools/list` inputSchema dialect is pinned by
`tests/fixtures/mcp-wire/tool-input-schemas.json` (draft-07 today; ZOD4-PREP, ninth batch); a dialect change happens only through a reviewed
diff of that fixture.

**Unified operation catalog (A04-2).** Every producer resolves operations from one catalog: `AdapterRegistry.catalog(configCatalog, configTargetKinds)` unifies the Core code operations (`workspace.file.write@1`, `host.shell.run@1`, `workspace.scratch.write@1`, `network.fetch@1`, `policy.administer@1`, `mcp.tool.call@1` — root registry entries `core.workspace-write@1` / `core.host-shell@1` / `core.scratch-write@1` / `core.network-fetch@1` / `core.policy-administer@1` / `core.mcp-tool-call@1` with no config-built adapter), registered module `provides.operations` and the validated `operations.catalog`, through the pure `unifyOperationCatalog`. Provenance (`core`, recorded by the registry itself; `module`; `config`) is inspection data and grants nothing. Typed refusals, in order: a config target claiming a Core operation's target kind (`OPERATION_TARGET_KIND_RESERVED`), a config entry using a Core operation id at any version (`OPERATION_CORE_REDEFINED`), the same `id@version` from two sources (`OPERATION_CATALOG_CONFLICT`), a config id inside a registered module's namespace — root or overlay, and everything under it — that the module never declared (`OPERATION_NAMESPACE_RESERVED`, owner 2026-09-27 decision 7; checked after an exact `id@version` conflict), a module compensation absent from the unified catalog (`OPERATION_COMPENSATION_UNKNOWN`). Config validation and the composition resolver call the same function, so a configuration that loads cannot resolve differently later; the section-level refusal stays `OPERATIONS_INVALID`. Config shape is unchanged; `findOperation` is gone. CLI `deckent operation`, SDK and the runtime service (MCP) share the one operation producer. The Core ids close the `workspace`, `workspace.file`, `workspace.scratch`, `host`, `network`, `policy` and `mcp` namespaces to overlays. Not yet: the terminal edit/shell producers still hold their own one-entry catalogs over the same descriptor objects; a module `targetKind` without a configured target fails at execution (`EFFECT_OPERATION_UNKNOWN`), not at config time; config entries inside a namespace no registered module owns are still allowed (open).

**MCP client (MCP-CLIENT, owner 2026-09-28 S6 a; scoped registry files owner 2026-09-28).** Deckent is an MCP client of the owner's
local stdio servers, managed like Claude Code's scoped files (code.claude.com/docs/en/mcp, checked 2026-09-28: local/project/user,
managed on top, `mcp add|add-json|list|get|remove`), never in configuration: project `<project>/.deckent/mcp.json` (shared;
Claude-compatible `mcpServers`, plus Deckent `realm`/`timeoutMs`), personal `<Deckent global root>/mcp.json` (0600; top-level
`mcpServers` = user, `projects.<real project path>.mcpServers` = local). The same name connects once from its highest scope, whole entry:
managed > local > project > user; an invalid override blocks the name. The company policy is a read interface (`ManagedMcpPolicy`:
servers, allowed, denied; no Core source yet). `${VAR}`/`${VAR:-default}` expand in command, args and env; a project file reads
credential-shaped names as empty and may not use `$DECK:NAME` (personal files may). Trust and tool pins are product state
(`<data root>/integrations/mcp-trust.json`, 0600, atomic; no layout or ledger schema change), bound to the entry's definition digest (stricter
than Claude Code, which binds approval to the name and asks only for project servers): an unapproved or changed server is never started nor
offered; `deckent mcp approve` starts it in its realm, shows the card (the registry template, never an expanded `${VAR}`) and pins its
tools; every scope needs approval (no silent trust on first use). The agent's read floor protects `.deckent/mcp.json` (read tools, shell
classification, bubblewrap mask, Landlock). The service owns one pool (`RuntimeChatTurnHost.mcp`): a server starts with the first turn that
needs it, negotiates the era with SDK `versionNegotiation: auto` (2026-07-28 via `server/discover`, else the 2025-11-25 `initialize`; on
stdio the SDK probes with a sibling process), is listed every turn and kept for the service's life; the client SDK loads with the first
server start; a crash restarts on next use at most `maxRestarts` times; service stop awaits closing all of them (stdin, then
SIGTERM/SIGKILL) before the endpoint and ledger custody are released. Realm per server like the shell (`prefer-sandbox` default:
bubblewrap wraps the long-lived process through the optional `ShellSandbox.usable().launch`; no network, HOME hidden; `require-sandbox`
refuses without it; `host` explicit; Landlock is not offered for MCP servers). A sandboxed start that fails is diagnosed in the same view
(MCP-SANDBOX-PATHS, 2026-09-29; `mcp-client/internal/diagnose.ts`): the command is resolved on this machine with the server's PATH (not found
→ `start-failed` "command not found", no name), then it and every existing absolute-path argument (≤ 16) are probed through the launcher's
own prefix (`bwrap <view> -- /bin/sh -c '[ -e … ]'`; our `sh`/`test` only, never server code; 5 s bound; a failed probe leaves the SDK
reason). The first path the view hides is named (`sandbox-unreachable`, `path-hidden` with role command/argument and the link target when
it differs); without one, a package runner (npx, pnpx, bunx, uvx, pipx: no network, empty HOME) or container client (docker, podman,
nerdctl: daemon socket outside the view) is named by the command's own name. Never parsed from the server's stderr (untrusted). The
outcome is unchanged: a failure, never a start on the host (prefer-sandbox falls back only when no sandbox is usable, as before). `mcp
add|approve` raise `MCP_SANDBOX_COMMAND_UNREACHABLE` (params name, kind, role, path, target, runner; a `${VAR}` path is shown as the
template, without target; the message is one catalog sentence per kind, `error.MCP_SANDBOX_COMMAND_UNREACHABLE.*`); `mcp list` adds
`detail` and `diagnosis` to a failed health. Measured on this machine: +10–30 ms on a failed start only. No MCP failure is silent (lead
follow-up, `0b24ead`): a server a turn could not decide or start is named in the turn's result note (protocol v17's `note`; MCP notices
first, the engine's note kept whole, the MCP part shortened to 4096) with its display-safe diagnosis; a start failure is recorded per
project in `integrations/mcp-start-failures.json` (0600, atomic, config write lock; key scope + name + definition digest; advisory only —
it suppresses a repeated first-use card and never offers or trusts anything), removed by `/mcp approve|reconnect|remove`, a successful
approval or start; `mcp list` carries `lastStart` and `/mcp` prints it. The adapter returns a structured notice (`McpStartNotice`:
start-failed, not-recorded, not-decided) and never renders owner text; composition's one renderer (`renderMcpStartNotice`, catalog
`mcp.start.*`) writes the turn note in the service's locale (its environment, then `language`) and `lastStart.text` in the calling
surface's locale (`/mcp`, `mcp list|get --lang`). Open: the notice arrives at the turn's end (a start-of-turn notice needs a new stream
event kind, v18); the view's toolchain comes from the service environment's PATH while the server's PATH comes from the service process
or the entry's `env.PATH` (an entry that sets PATH can search a directory the view did not bind). Pin digest = sha256 over name, title, description,
input/output schema, annotations; only pinned tools whose live definition matches are offered (`mcp__<server>__<tool>`; display and audit
`mcp:<server>/<tool>`); a changed definition is withdrawn until re-approved. A call is a C11 effect of `mcp.tool.call@1` on `mcp-tool` (input:
server, tool, digest, arguments), decided by `decideAgentToolCall` over `agent-tool/invoke` ∧ `operation/execute`; cells `mcp-call`
(raising; relaxable in full-auto only) and `mcp-floor` (pin `alwaysAsk` or pinned `destructiveHint: true`; never relaxed). Nothing is sent
before the decision; after sending, timeout/cancel/crash is `unknown` and never resent; answers are cut at the agent's tool-result limit and
pass `redactText`; the model is told they are untrusted data. The audit contract gained the additive `mcp-call` cell and
`{kind: 'mcp', tool, argsDigest}` summary (event schema version 1). CLI: `deckent mcp add|add-json|list|get|remove|approve` (`list`
reports connected/drifted/failed for approved servers and "pending approval" without starting others; `get` never starts). Not yet:
a separate approval subject kind (the first-use card reuses `agent-tool-call`), `/mcp` texts beyond the catalog lines, company policy source (POLICY-ADMIN), http/sse/OAuth, MRTR input
requests from servers (no elicitation/sampling/roots handler; an `input_required` server is untested), `subscriptions/listen`/listChanged
(the list is re-read each turn),
signed server bundles. The tool list is read with all its pages (SDK 2.2.0 follows `nextCursor`; at most 16 pages and 512 tools, more is
`too-many-tools`; pins apply over every page). Trust decisions (owner 2026-09-28, `db5121d`): adding a local/user server is its trust
decision (cards, or `--yes`; `--no-approve` skips); a project entry is decided on its first use. Cards come in two phases — `launch`
(definition as written, variables set/unset, env names, realm; nothing runs before yes) and `tools` (started in its realm; live tools with
digests; yes pins them); no records `declined` for that definition; an unanswered card records nothing. User trust lives beside the
personal registry (`<global root>/mcp-trust.json`) and holds in every project; project/local trust in the data root. Trust and registry
writes run in the config write lock (`withConfigWriteLock`). Every change (trust, decline, reset, revoke, reconnect) is a sealed `mcp-trust`
audit event written first. The turn asks first-use cards on the C12 approval path as an `agent-tool-call` subject with the reserved tool
`mcp_trust` (no approval schema change). `/mcp` lists servers and trust state and does approve (reset), reconnect (record counter; the
service replaces the process on next use) and remove. The compiled `deckent-mcp` stdio entry serves both eras (`serveStdio`), proven with SDK clients in legacy, auto and
pinned-2026 modes (`mcp-eras-process.test.ts`).
A sandboxed MCP server's long-lived bubblewrap view keeps the write floor's existing paths read-only (third-party code that no card approves
call by call; the MCP layout carries the write floor). The rest of the project stays writable for it; the host realm is unchanged.
The pool builds the SDK `Client` with `jsonSchemaValidator: new CfWorkerJsonSchemaValidator()` (`@modelcontextprotocol/client/validators/cf-worker`,
interpreter-based @cfworker/json-schema 4.1.1; MCP-VALIDATOR 2026-09-29): a server's `outputSchema` is untrusted input and never reaches the ajv 8.18 +
fast-uri 3.1.0 copy bundled inside SDK 2.2.0 (8 HIGH advisories, not fixable by `overrides`; the module still loads with the SDK). Every `tools/call` carries the pinned
definition (MCP-PIN-DEF, eighth batch, Jev 12e80d38, 2026-09-29): the pool keeps, per listing, the frozen digest-covered projection of each tool
(name, title, description, input/output schema, annotations — nothing unpinned reaches the SDK) and passes a fresh copy as
`callTool(..., { toolDefinition })` (SDK ≥ 2.2). The SDK then neither consults its response cache nor re-lists, so a HEADER_MISMATCH
(-32020, SEP-2243) is answered as a typed error (`kind: 'header-mismatch'`) and never re-sent (C11; a deliberate deviation from spec
2026-07-28's "SHOULD re-list and retry" — a retry is a new call with a new decision; a changed definition is re-pinned with
`deckent mcp approve`). structuredContent is validated with the cf-worker validator against the pinned outputSchema (MCP SHOULD): a result
that does not conform, or is missing where an outputSchema is declared, is an answered -32602 error (`kind: 'output-schema'`; the SDK raises
-32600 for "missing", normalized to -32602) — the server answered, so the effect may have happened: the C11 record settles as answered, the
call is never retried and the model is told the result was withheld. A pinned outputSchema the validator cannot compile is refused before
sending (`invalid-output-schema`; the SDK would otherwise throw its pre-send -32602, which would look answered). The classification of the
SDK's post-send checks relies on SDK 2.2.0's message texts (a changed text degrades to `kind: 'server'`, still answered, never resent;
tripwire: the `mcp-client.test.ts` -32602 cases). Not yet: a tool with an uncompilable pinned outputSchema is still offered (refused per
call, not marked `unmappable` at open); with `toolDefinition` the SDK also scans the pinned inputSchema for `x-mcp-header` on every
modern-era call (headers are ignored on stdio; untested path). The MCP server side validates schemas only in
`elicitInput`, which Deckent does not use.

**MCP 2026-07-28 alignment (sources checked 2026-09-28).** Spec revision 2026-07-28 (published 2026-07-28, modelcontextprotocol.io
changelog) makes the core stateless (`server/discover`, per-request `_meta` protocol version and client capabilities, `resultType`,
`ttlMs`/`cacheScope` on lists, `subscriptions/listen`, MRTR, Tasks as an extension). Deckent pins `@modelcontextprotocol/server` and
`client` 2.2.0 (npm 2026-09-28T19:09Z; `core` 2.2.0 transitively; MCP-SDK-22). Since 2.1.0 (2026-09-23): stdio server transport closes on
stdin EOF and drops in-flight requests, HTTP gets a 4 MiB body limit and requires `MCP-Protocol-Version` on 2026-07-28 POSTs, DPoP and
OAuth scope challenges are added; 2.2.0: `listTools()` follows `nextCursor` (bounded by `listMaxPages`), no unhandled rejection when
notifying on a closed connection, OAuth issuer binding. Implemented: stdio server both eras; stdio client `auto` negotiation. Not implemented: HTTP server/client in either era,
`input_required`/MRTR, `subscriptions/listen`, Tasks, resources/prompts.

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
adopted commit is still the tip and no later record exists. The basis is Task acceptance; an adoption reports `verification: not-verified` unless it binds a verification Run (B06-2b below).
Live checkout/runtime activation (B07) is separate. Git writers outside
Deckent under the same OS user and a checkout racing the observe→update-ref window are not fenced; a record that can no longer
complete keeps the target blocked until operator recovery (no abandon command yet).

**Delivery-pinned Run (B06-2a, no version change).** `createDeliveryRun` (SDK; composition `createConfiguredDeliveryRun`, not a
runtime-service operation) admits the same Run contract as `createRun` plus `deliveryCommandId`. After `run:create`, trusted
composition resolves the completed delivery of the same scope with its reference still naming the delivered commit (the
predicate `requireDelivered` is shared with adoption), requires `attempt:read-output` on the delivered attempt, and captures
the Git source at that exact commit. The Run row, its automatic-progression intent and its workspace custody
(`baseRevision` = delivered commit, record v1 in the v9 `run_workspace_custody` table) commit in one transaction, so a
progression turn never samples the moving source HEAD first. The per-attempt clone checks out the commit even though
`refs/deckent/deliveries/*` is not cloned (`clone --local` copies the object store; proven loose and packed). The receipt
command and Run snapshot are unchanged; a pinned replay must match the recorded custody exactly (source and commit), else
`RUN_COMMAND_CONFLICT`, and a plain Run can never be claimed as pinned. Like adoption's resume, a replay is answered from the recorded state before the delivery reference check (candidate from the ledger's delivered `plan.commit`), so a deleted or moved reference does not change it; a first admission always runs the full check (owner 2026-09-27 night). Refusals reuse existing codes: unknown/incomplete
delivery or missing reference `ADOPTION_NOT_DELIVERED`, moved reference `PATCH_CONFLICT`, foreign company `SCOPE_UNKNOWN`,
missing grant `POLICY_DENIED`. Adoption binds such a Run as verification evidence (B06-2b); the task kind still comes from the caller (config-derived verification
kind and CLI in B06-2c).

**Adoption verification binding (B06-2b, ledger v42).** The adoption command is v2: optional `verificationRunId` +
`verificationKind` (both or neither; v1 commands are no longer accepted, CLI sends v2 without them). With a binding, after the
delivery and the attempt's Task acceptance checks and before the target check, one engine owner (`workspace-patch/verification`)
requires: `run:inspect` on the Run (`POLICY_DENIED`), the Run in the adoption's scope with exactly one task of the named kind, its
workspace custody on the delivered commit from the adoption's own Git source (fresh `captureSource(commit)`), and its pinned
profile equal to the installation's current `admission.registry` profile for that kind (profile encoding v1 = criterion encoding v1
rules, sha256) — otherwise `ADOPTION_VERIFICATION_MISMATCH`; only then the task phase: `accepted` verifies, `failed` →
`_FAILED`, `pending|active|evaluating` → `_PENDING`, `reconciling` → `_UNSETTLED`, `cancelled` → `_CANCELLED`. Evidence
identity precedes phase: a failed Run on another commit is a mismatch. No refusal writes a record or moves branch or fence.
The adopt intent is v2 (`verification: null | {runId, taskId, attemptId, kind, runRevision, commit, profileFingerprint,
criteria[]}`, checked consistent with the command and `toCommit`); rollback intents stay v1. The result is v2:
`verification: {status: 'not-verified'} | {status: 'verified', …binding}`. `verified` means only "one task of this kind, run on
this exact commit with this profile, ended accepted by its recorded criteria" — not independent review, live activation or product
acceptance. A replay answers from the record; the same command id with another Run or kind is `ADOPTION_CONFLICT`. Criteria are
recorded, not checked (the Run creator chooses them until B06-2c policy). Ledger v42 changes no table: the service-start upgrade
backs up v41 (0600) and, in one transaction, rewrites every exact v1 adopt record whose columns agree into its canonical v2 text
(`verification: null`, command schema 2), so pre-upgrade adoptions replay, settle and roll back; other records stay byte for byte
(still `ADOPTION_CORRUPT` if unreadable). A v41 build refuses a v42 ledger (`ATTEMPT_STORE_VERSION`, proven with the real `de2f30f`
build; rows written by that build migrate and an interrupted one settles afterwards). Not yet: config precondition (`execution.adoption.verification`), CLI flags and verified text, criteria policy, audit subject.

**Adoption verification precondition (B06-2c, config schema 3, no ledger/protocol change).** Config `execution.adoption.verification`
(`null` default | `{kind, required, criteria[1..16]}`, each criterion `{evaluator:{id,version}, parameters}`) is the installation's bar. The one
owner is `verifyAdoption` (engine `workspace-patch/verification.ts`), after Task acceptance and before the target check: no verification Run
named → `ADOPTION_NOT_VERIFIED` when `required`, otherwise `not-verified` as before; a named Run must be of the configured kind
(`ADOPTION_VERIFICATION_MISMATCH`) and, after the B06-2b identity/profile checks and **before its phase**, meet every required criterion with
one of its task's acceptance criteria of the same evaluator that is not weaker under the Run's pinned evaluator implementation
(`ADOPTION_VERIFICATION_CRITERIA_WEAKER`). "Not weaker" is evaluator code in `capabilities/evaluation-evidence` (`criterionWithin`;
`process-exit@1`: accepted exit codes ⊆ the bar's); an implementation without a rule fails closed — Enterprise evaluators add theirs under
their implementation identity. Without the section B06-2b behavior is unchanged (caller kind, no bar). A settled adoption replays from its
record even if `required` was switched on later (B06-1 replay contract). The applied bar is not written into the adoption record (the
verification block already carries kind, profile and criteria fingerprints; recording the bar would be an intent v3 = ledger change).
CLI: `task integration-adopt … --verification-run <run>` takes the kind from config (`ADOPTION_VERIFICATION_NOT_CONFIGURED`, category
config, when absent; the engine re-checks it); `run create … --delivery-command-id <id>` admits a delivery-pinned Run through the local
composition path (`createConfiguredDeliveryRun`, not a runtime-service operation; protocol unchanged). Not yet: an `adoption-verification` audit subject, CLI `--wait`.

**Read-only dependency binds (B06-2c, owner 2026-09-27 evening (4)).** A Docker task profile may declare `readOnlyMounts`
(`[{source, target}]`, ≤ 8) — profile data, pinned with the Run and part of its profile fingerprint. `source` is relative to the trusted
project root (normalized; no `..`/`.`/empty, `.git` or `.deckent` segment); composition resolves it before any dispatch and refuses
(`EXECUTION_PROFILE_INVALID`) a path that is not a real directory (any link on its path), or that contains or lies inside the product layout
root or any layout resource. `target` is an absolute normalized container path outside `/workspace`, `/tmp`, `/deckent`, `/run`, `/proc`,
`/sys`, `/dev` (a bind can never overlay the delivered tree, which must stay exactly the verified commit). The supervisor re-checks the
source at launch (real directory, outside the workspaces root) and always adds `readonly`; there is no writable form. `--network none`,
`--read-only`, cap-drop, user and `/workspace` are unchanged. Supervisor option `readOnlyMounts` is additive (adapter version 2, like
`inputs`/`connection`); a build without it refuses such a dispatch profile (`SUPERVISOR_PROFILE_INVALID`). Customer installations use a
verification image with its dependencies instead (owner); host-prepared dependencies may drift from the delivered lockfile (stale deps can
fail or, in principle, mask a lockfile change — known limit).

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
