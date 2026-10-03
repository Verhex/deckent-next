# Architecture

**Owner amendment 2026-10-02 — MCP-NO-DECIDE:** MCP exposes no approval decision tool: neither `allow` nor `deny`; `list_approvals` and `inspect_approval` remain observation. CLI `approval decide`, SDK and terminal decisions retain their existing authority checks. This supersedes B1's MCP-deny exception; protocol and ledger contracts stay unchanged. Implementation `57c49ac6` (batch 25; on main and live since `aa58f559`); evidence `proof/LIVE-SWITCH-BATCH25-2026-10-02/`.

Ortak ürün/geliştirme ölçütü: [.deckent/docs/core-memory/project_product_north_star.md](.deckent/docs/core-memory/project_product_north_star.md).
Owner 2026-09-21: dar dilimler ürün hedefini küçültmez; mevcut kararlar yeni kanıt olmadan yeniden açılmaz.

## Decision port — AOF-DECISION-PORT (2026-10-02; Fable PASS `2b8bdc31`; batch 27, on main and live since `dfb1b68f`)

Vendor-neutral v1 `DecisionCase`, `DecisionAdvice`, `DecisionRecord` and `DecisionPolicy` use descriptor-safe versioned Zod ingress. Pure preparation rejects future observations, dangling evidence references, duplicate/reserved ids and configured UTF-8/count limits, then produces canonical case data for an engine SHA-256 digest. Advice retains all option probabilities, separate `none_of_the_above` / `insufficient_information`, choice confidence, context sufficiency, per-check scores, actual model/usage and observed latency. Missing answers or uncertain transport never produce fabricated advice.

`DecisionApplication` is the sole prepare/ask/actor-selection/outcome owner. Every entry authenticates scope membership and checks the `decision` policy resource (`prepare`, `ask`, `record`, `outcome`, `inspect`). Its resource id is always the scope id (`case.scope` in prepare, `scopeId` elsewhere), independent of command/decision ids; id-restricted grants therefore govern all decisions in that scope, not individual decision ids. Require-approval remains typed unsupported outside the existing operation broker. Ask uses the existing model invocation command path for independent invoke authority, activation, exact catalog/profile binding, allocation, spending, cancellation and a single-use send receipt. Selection only records data; any subsequent operation must re-enter its ordinary principal/scope/resource/policy/approval path. No execution, approval grant, Mission use or worker tool is added here.

The optional registered `decision` config section must explicitly supply byte/count limits and choice/sufficiency thresholds. Missing policy is unavailable; no universal threshold is synthesized. Child configuration may tighten thresholds or limits, never relax parent policy. Below either configured threshold returns `below-threshold`, preserving the advice with no automatic action. The profile supplies the endpoint, secret reference, limits and tariff; adapter/protocol ids and question rubrics are registry asset data. A versioned thin HTTP adapter maps case to state and Choice/noul questions using the shared provider HTTP boundary. It has no vendor SDK dependency and no hidden retry.

Additive ledger v46 (lane v45; renumbered at batch-27 integration because A1/A3 Run parking owns v45) holds sealed decision intents and command receipts (IF NOT EXISTS like v39–v44, but a pre-existing same-name table must match the migration's stored CREATE text exactly, else the upgrade rolls back); the existing service-owned upgrade makes its versioned 0600 backup before migration. Clients/readers never migrate. Ask intent and admission audit commit before invocation. Advice settlement and observation audit commit together; actor selection/outcome and their audit also share a transaction. Ask replay binds original command and authenticated actor; a pending/lost result returns `unknown` and never repeats the external call automatically. Selected-option and outcome commands replay their immutable receipts; conflicting commands/second records are refused. Failed/lost COMMIT results raise typed `DECISION_OUTCOME_UNKNOWN`; best-effort rollback does not assert settlement, and retrying the same mutation commandId either returns its committed receipt or performs the rolled-back mutation once. Work/admission errors retain their original types. Inspect reports stored status (pending maps to unknown) with `replayed:false`, since inspection is not a command receipt replay; ask/mutation replays retain `replayed:true`. Inspect opens a read-only connection and never creates a key or ledger. Audit carries principal, scope, case/advice digests and selected option; case/advice snapshots are HMAC-bound.

SDK exposes `prepareDecision`, `askDecision`, `recordDecision`, `outcomeDecision`, `inspectDecision`; CLI `deckent decide prepare|ask|record|outcome|inspect --input <file|->` offers en/tr and `--json`, help and bounded input; `decide` and its five actions are registered in the CLI help catalog (work group, batch 27). The human choice line compares `probabilities[choice]` to its choice threshold and displays confidence separately. MCP exposes only read-only `inspect_decision`; no decision mutations. The adapter currently accepts only an operator-declared zero tariff (same existing reservation/local-zero settlement path); the current official API provides no verified maximum billing bound. Nonzero paid pricing, explicit pending-intent reconciliation/retention policy and worker modes/native bridge are not claimed implemented. AOF-WORKER-DECIDE remains next. Evidence and sources: external `proof/AOF-DECISION-PORT-2026-10-02/`; targeted results, independent review and integration are separate status.

## RUN-PROGRESSION-CONCURRENT — owner 2026-10-03, implemented source candidate

N1 measured independent Runs advancing serially while the pool had free capacity. The owner reopens wave-6 C18-L2;
lead Jev `5fdc0127` selected `concurrent_run_turns_bounded` (0.98/0.77). Each Run turn remains its single owner and drains
admitted executions before returning. Accepted change: bounded concurrent Run turns across polls, keyed by scope/Run;
`runRuntime.maxConcurrentRuns` defaults to the effective `service.maxConcurrentExecutions`. The execution-time service
cap is separate from pool reservation capacity. A reserved attempt waits for a service slot; shutdown retains custody
of active and waiting work. Only discovery failure or total advance failure triggers whole-driver backoff.
No ledger migration, runtime protocol bump, retry or scheduler/wave change. The driver keeps an in-flight scope/Run map across polls, refills free capacity without a page barrier,
retains an overflow cursor instead of starving the remainder and drains every admitted turn on abort. Expiry and observer
failures remain per Run; observer errors cannot terminate another Run. `RunProgressionTurn` itself is unchanged.
`RuntimeServiceLifecycle.admitExecution` is the internal bounded Run-producer FIFO; it shares the execution counter with
transport `admit`, preserving direct transport BUSY/request-cap behavior. Waiters remain drain-tracked and cannot be
bypassed by fresh execution admissions. The internal queue is bounded by configured concurrent Runs × per-turn executions;
`maxConcurrentRequests` retains its transport request meaning. At shutdown, executing work drains and queued composition
work rechecks the stop signal before invoking execution. No reservation is silently released or reported completed.
The additive observer `waitedForSlotMs` sums monotonic service-slot waits for that turn; absent when nothing queued, preserving
existing single-Run result bytes. Monitor's additive `waiting-execution-slot` is derived from an automatically admitted active
reservation without dispatch, with reservation time and `dispatch-pending` detail; it is not live gate telemetry. Pool blockers
remain reservation-time evidence. Config schema v4 adds the strict positive integer without migration; effective global/project
loading and config set/unset derive absent Run bounds from service capacity, explicit Run overrides remain independent.
Targeted ledger/driver/gate/config/monitor and six mutation checks are retained as author evidence. Eight single-task Runs filled
all eight configured pool slots in a controlled ledger test; this is not native worker or N1 throughput acceptance. Native socket
closure tests are retained but require the missing built `peer_credentials.node`; no build was admitted. External proof: `proof/RUN-PROGRESSION-CONCURRENT-2026-10-03/`. Independent/live acceptance remains open.

## WORKER-EFFORT — owner 2026-10-03, admitted lane

WORKER-EFFORT is rebased as `1cccd17c` onto main `97590485` (batch 31) in `deckent-next-lane-worker-effort`; this candidate is not landed or independently accepted. Sol REVIEW 2322 R1 identified an only-Ultra fallback that contradicted the no-automatic-Ultra boundary; owner-admitted WORKER-EFFORT-R corrects it in the dirty diff with RED/GREEN admission-to-frozen-argv evidence.
Native command registry v3 declares nullable `reasoningEffort` capability: argument templates/accepted levels/preflight flags,
or exact-model binding. Claude uses `--effort`, Codex `-c model_reasoning_effort=…`; no provider-to-effort-flag branch in code.
Cursor has no generated suffix/bracket mapping: the catalog must declare singleton `efforts` + `effortBinding: {mode: fixed-model, level}`
for the already selected exact model id. No Cursor model seed or activation is invented. V2/V3 catalogs accept that additive declaration.

Separate versioned `assets/native-coding/work-classes.json` owns class defaults and kind → class bindings; optional
`admission.registry.workClasses` replaces it as validated installation/Enterprise data. `task.kind` still chooses the template;
optional `workInput.workClass` chooses a declared class. Core targets: small/test high; feature (including coding) xhigh;
design/architecture/security-critical max. Explicit task effort wins and is never clamped. Defaults use the highest mutually declared
model/CLI level at or below the target, or the lowest supported non-Ultra level if all exceed it. When a below-Ultra target
meets only-Ultra support, selection is `level:null`, `source:cli-default`, `status:ultra-opt-in-required`, with class/revision/target retained;
no effort argument is sent and EN/TR inspect/monitor shows why. Supported explicit `effort:ultra` and a deliberate validated
registry class with `defaultEffort:ultra` remain opt-ins (the latter records `policy-default` and `target:ultra`). No automatic
model switch, text-based load inference or Ultra escalation. CLI default is not a guarantee of provider-effective depth.
Unmapped kind keeps visible `cli-default`; no usable knob records `unsupported`. An explicit unsupported request
refuses with `WORKER_EFFORT_UNSUPPORTED` before Run/receipt writes. Deadline, turn limit and resource budget remain separate.

The application admission owner resolves once through the existing execution registry and compiler; prepared pinned profiles use
the same selection/binding path. Frozen profile metadata stores level, source (`explicit|policy-default|cli-default`), status, and
policy class/revision/target where applicable; reservation copies it into the Attempt atomically. Replay keeps the original bytes
when policy/catalog changes. Execution refuses a Run/Attempt selection mismatch as `RUN_STORE_CORRUPT`; old snapshots lacking
metadata remain readable. Run task view and shared worker-model projection show effort/source in EN/TR inspect and monitor detail.
The setting proves what Deckent requested from the CLI, not the provider's effective reasoning or account entitlement (vendor caps apply).
Registry v3 is strict; Run execution v1, Attempt v1, catalog v2/v3, ledger/protocol versions stay unchanged through optional metadata.
Author RED/GREEN, command/source evidence and open check limits are in external `proof/WORKER-EFFORT-2026-10-03/`;
R1 delivery is `effort-r.md`/`effort-r.patch` against `1cccd17c`. Author targeted run: 38 passed, one local runtime socket test failed;
typecheck/eslint and lint-arch (0 violations) passed. The new status is additive to the current schema, with the same older-strict-reader
limitation as existing effort metadata. Independent review, lead integration, hosted/live/provider-request acceptance remain open.

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
Owner 2026-10-01: the reviewer is Sol, with model-independent channel address `astra`. A host-only user-systemd
timer checks recipient-pending channel entries every 45 minutes and admits a wake prompt to the existing Codex thread
only when idle; no model call on an empty channel, no interruption of an active turn, no authority from message bodies.
The ignored `.deckent/host/channel/watch` kit reconciles its own queued submissions and preserves other clients' prompts.
Polling persists through logout with user linger; machine/WSL downtime, authentication and daemon availability bound operation.
This is development coordination, not a Deckent scheduler, product recovery mechanism or continuous product-runtime admission.

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
  config schema 4 (CONFIG-SURFACE; explicit Next v3 read migration), layout registry 4 (SCR-A, owner 2026-09-28: `scratch` resource), doctor JSON 2; older versions are refused with a
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
  never-evaluated output from an evaluated unknown. Unknown is not automatically re-evaluated without new exact-attempt evidence.
  Owner 2026-10-01 A1/A3, implemented source candidate 2026-10-02 in `lane/run-park-timeout`:
  Run snapshot v4 has `running`, `parked {reason, since, deadline}` and explicit terminal outcome;
  RunView v3 carries outcome/reason and task decision evidence. One pure lifecycle owner closes dependency
  descendants transitively as `skipped` (`dependency-failed|dependency-cancelled`), never as work that ran.
  Parked/terminal Runs leave reservation discovery; a separate bounded actor-matched deadline page closes
  them as `incomplete` when any task was accepted, otherwise `failed`. Live work and uncertain effects retain custody.
  `runRuntime.parking` v1 defaults to 24 hours: conservative, unmeasured and lead-adjustable. Resume rechecks
  dependencies and preserves the deadline; close never reports incomplete work as success.
  Fable REVISE 2026-10-02, owner/lead typed return decision (Jev a8e582fe): the same evaluation owner may
  return an awaiting task only on a new exact-attempt retained output digest or verified host model seal.
  Return is explicitly triggered by `deckent task evaluate` or SDK `evaluateTask`; progression turns have no automatic
  producer to re-evaluate awaiting-decision tasks.
  Park captures the immutable output/seal digest baseline; application verifies artifacts and ledger commit rechecks custody.
  Each new digest is consumed once and recorded in the evaluation receipt. Unknown parks again with the original since/deadline;
  evidence-less, duplicate or expired returns remain TASK_EVALUATION_NOT_READY. A verified seal permits ordinary criterion acceptance,
  with model verdict verified; human acceptance of the original unknown remains visibly model-unverified.
  An unverified Claude-worker evaluation parks the task as `awaiting-decision`, releasing its pool slot even
  when independent work continues. The shared CLI / MCP-free SDK application accepts or rejects only a freshly
  verified `os-user` principal with existing `attempt:evaluate` policy authority, recording principal and decision
  in the existing sealed audit transaction. Acceptance remains “accepted — model evidence unverified”. Token/workload
  assurance alone cannot prove a human; MCP exposes no decision operation. Trusted policy may fail unknown immediately,
  preserving its original unknown evidence; it cannot auto-accept. Rule A substitution and Codex/Cursor evidence stay unchanged.
  Host-proven exited execution without ready output (including exit 137) parks visibly as `evaluation-not-ready`,
  cannot be accepted without evidence, and fails at the deadline. Historical evaluated unknowns park on the first
  authorized maintenance turn without evidence-less re-evaluation. Maintenance reads and computes deadlines with Run inspect;
  only immediately before committing due Run/task expiry does it require Run cancel (the existing close authority).
  Legacy task parking requires attempt:evaluate. A typed expiry refusal is reported for that Run; other Runs still progress.
  No-due progression needs no cancel grant and opens no lifecycle writer. Deadline polls enter the write transaction
  only for a due deadline.
  Store open requires the configured clock/parking timeout; pure transitions and terminal-dispatch cancellation settlement require explicit timing.
  Monitor treats parked Runs as open/stuck, projects decision reason/deadline and shows not-ready evaluation as pending.
  Its legacy v3 snapshot compatibility is a read-only projection; ledger45 owns durable conversion. Ledger v45 explicitly migrates snapshot/receipt v3 to v4,
  preserving revisions/history; existing service-start private v44 backup remains required for rollback.
  J5 retains host verification/loss metadata before an event prefix, counts scrubbed NDJSON bytes and rejects a
  production artifact ceiling below the current gateway event limit plus 32768 bytes of conservative seal reserve.
  J5 remains in provider-catalog effective validation: platform-only config ingress may still admit a smaller artifact ceiling;
  ingress ownership is an open limit, not changed by this REVISE. No runtime protocol bump: local operators use the same application contract. Independent review, full batch verify,
  packaged/current-platform/live acceptance remain open; this source candidate does not admit DOGFOOD S1.
  Current local driver refills same-Run capacity after verified acceptance within a configured automatic-turn
  reservation budget. At the budget boundary it drains existing custody and rotates paged Run intents.
  This is nonpreemptive allocation-turn fairness, not a time guarantee; slow tails, restart fairness and fleet scale remain open.


- Task represents the work. `run` executes a directives-defined workload; `do` admits natural-language,
  AI-produced or structured work; `autonomous` periodically performs/monitors admitted tasks and processes.
  Mission coordinates goal-bounded cycles of run/do/autonomous, sequentially or in parallel.
  These entry/coordination semantics do not authorize separate schedulers, policy engines or state writers.
  Task/coordination identities require a new contract; no legacy identity migration or compatibility aliases.
  (Current state 2026-10-01: `run` admits a typed task graph, `run create --graph`; no directives file is read —
  `DIRECTIVES` has no match in `src/`. Clarification, owner 2026-10-01 (D1 A, Jev 948ec531): the typed task graph — graph v3
  `workInput` — is the structured directive; free text enters only through `do` → RunProposal (D15b). The 2026-09-17 wording
  above stays as decision history.)
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

HARDCODE-P1-A (owner order Jev e2b81339 2026-10-02, built in the D4 night 2026-10-03; implementation `a7f2a78b` + envelope/documentation `6ba197fb`; Fable 5.1 bounded PASS 2026-10-03, landing conditions: full verify with built dist and native addon, remaining vendor lists `worker-admission.ts:24` / `worker-observation/files.ts:86` in PLAN):
`assets/native-coding/commands.json` schema 2 is the single native CLI registry asset. The strict loader
is the neutral `adapters/core/native-cli-registry` unit, re-exported by native-coding; this avoids the
native-coding → docker-supervisor → native-connection dependency cycle. Old/missing capability assets
fail with `NATIVE_CLI_REGISTRY_INVALID`. Required capabilities declare maxTurns flag/parser probe,
settings flag, prompt channel, structured-report flag/channel and model-usage evidence kind. The pure
provider vocabulary derives the accepted ids once from this versioned data asset; domain imports no
adapter. Authoring/binding/bootstrap select these capabilities, never a vendor identity table.
The compiler stamps `nativeSubscription.modelUsageEvidence`; explicit capability substitution fails
binding with the existing `WORKER_MODEL_BINDING_MISMATCH`. The gateway independently takes its bootstrap
and host-verification capability from the bound registry. Domain model verification consumes required
`evidenceCapability`; its verdict bytes stay unchanged. Host-only `model.verification` schema 2 carries
that field; recorded schema 1 events stay readable and worker protocol stays 1. Profile/Task-model reads
migrate an absent legacy capability from the shipped registry snapshot; explicit invalid fields are
refused. Model projection, evaluation producer and transition carry/bind it. Task evaluation's optional
model evidence gains the additive field without a ledger or outer protocol migration. Future registry
changes must retain those historical read semantics. The shipped session-events adapter holds missing
verified evidence; the two none-evidence adapters remain visibly unverified and criteria-driven (rule A).
Author targeted proof and remaining limits: external `proof/HARDCODE-P1-A-2026-10-03/review.md`.

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
is suppressed in favor of a bounded exit/error summary; Claude and Codex events are normalized
(B09-1/B09-3, "Local worker observation" below; Codex not yet against a recorded live run); Cursor normalization remains open. Full-access worker code can read its own access material and use the allowed provider channel;
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
  audit event schema 1 (additive kinds `full-access-turn`, `full-access-call`, `tracked-files-changed`, summary `fetch`; old mode names stay readable); ledger
  unchanged. v17 was pushed with `7fbe476c` (released; further changes bump).
  v18 was introduced 2026-09-29 (SECRET-WRITE, lead decision under this rule) as the single v18 package: the control operations
  `setSecret` / `deleteSecret`; lifecycle window [18,17]; every other v17 operation is unchanged in v18. It is unreleased until pushed, and
  further v18 items add to it without another bump. Like every bump, the window's older version is lifecycle-only: a v17 client can
  describe and stop a v18 service, nothing else; a mismatched envelope is closed unanswered (the client's typed `LOCAL_RUNTIME_TRANSPORT` —
  there is no dedicated version-refusal code), and a v18 terminal's describe of a v17 service retries at v17 and shows the build skew. The
  live service has run v18 since the 2026-09-29 switch (the v16 service was stopped with the old build's own CLI). FA-TRACKED-WARN adds no
  wire field: a v18 frame never carries `tool.finished.trackedChanges` (the released parser rejects it); the typed field waits for the v19
  bundle (with `chatTurn.language`), and until then the warning reaches every client as result text (see FA-TRACKED-WARN).
- Schema evolution has backup/restore, exclusive migration ownership, expand/contract where applicable and an
  explicit rollback floor. Installing an older binary is not a rollback after an incompatible data migration.
- Legacy successes and known bugs are separate acceptance inputs. HMAC authenticity is not an asymmetric
  signature. Exactly-one accepted terminal record does not promise exactly-once arbitrary external effects.
- Capacity figures (10k tasks, 500 workers) are illustrative, not fixed acceptance thresholds. Baselines precede language choice;
  runtime and real-provider evidence remain separate. No delivery date is inferred from catalog-port throughput.
- Early dogfood requires a stable N controlling candidate N+1, bounded real work, independent acceptance,
  cancel/restart evidence and an external recovery path. Product self-development cannot bypass its own policy.

### Enterprise layering, effect settlement and ERP adapters — owner 2026-09-23 (accepted target; Lane B)

Deckent-Enterprise is the commercial target; Core is standalone open source (Apache-2.0, DEPS-P0 2026-09-29). Enterprise is layered on published
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

The shared-ledger `model-invocation-process` contract test (whose temporary 45 s bound this slice removed to the 30 s default) exceeded
that default on a GitHub runner roughly 2× slower than local; `DECKENT_TEST_STARTUP_COST=1` records each phase (SDK import/client, CLI
client, runtime ready/stop, invoke-to-provider, durable settlement, MCP ready/call/close, cleanup) opt-in. The measured root cause was 64
sequential process launches inside one `it` (CI-FIX F6, sixteenth batch); the file is now five steps sharing one `beforeAll` fixture and
process-identical assertion counts, longest step ≈ 7 s locally (`b9b2ce15`). The earlier 22–23 s single-test measurement predates the
split and is no longer current evidence; a real GitHub runner run is the open proof.

CI preparation (CI-FIX F1–F3): the required Linux job pulls the Docker test fixture by digest (`bash scripts/ci-docker-fixture.sh`:
`node@sha256:8ec5d755…`, local image id checked and exported as `DECKENT_TEST_DOCKER_IMAGE` through `GITHUB_ENV`; a failed daemon, pull,
identity check or unprivileged container run fails preparation — tests are never skipped). It then builds bubblewrap in check mode, stages it
(`scripts/build-bwrap.mjs --arch x86_64 --out …`, `--stage-dev …`), builds the product and runs `scripts/ci-shell-realm.mjs`, which checks both
staged trees against the lock, places the launcher through the service path and requires the compiled `doctor.shellRealm` to select usable
bubblewrap (only the ephemeral runner enables user namespaces via its AppArmor sysctl; not a product installation step; `realm-arm64` stays
disabled). Workflow expressions are checked locally with actionlint v1.7.7 (`go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`,
then `actionlint -shellcheck= -pyflakes= .github/workflows/*.yml`; no npm dependency).

### Registry-driven configuration contract (CONFIG-SURFACE, owner 2026-10-02)

`engine/core/config` owns one typed `ConfigApplication`: inspect (all registered schema paths or one key), explain,
validate, set and unset. Fields, descriptions, JSON Schema type/enum/range/default, binding and apply mode derive from
`CONFIG_FIELDS` and `registerConfigSection`; there is no surface-owned key/schema list. The file adapter observes
project/global documents and effective default → global → project → env values. Secret provenance and credential keys
are masked before subtree selection; every string also passes through the existing shared redactSensitive matcher (tokens, Bearer credentials, URL passwords, key/value secrets and JWTs). Schema value annotations are masked too. Token resource counts stay visible. Raw JSON Schema conversion is cached per configRegistryGeneration with schema-derived paths (dynamic array indexes/record names share nodes); values, provenance and annotation masking remain fresh per observation.

Writes carry VerifiedPrincipal, scope, command id, explicit project/default or global target, and optional inspect
preimage digest (`--expect`; CLI `--expect absent` asserts no target document yet). Existing policy vocabulary adds `config/write`; first-run template v4 grants it to the
verified local owner. Global writes also require installation-wide delegation. Deny and require-approval fail closed;
config has no broker-supported approval subject yet (`POLICY_APPROVAL_UNSUPPORTED`). Terminal `/config` is read only.
Reads require no config-write grant. Composition supplies verified scope context; the engine plans, adapters own IO.

Authored object overlays validate supplied members against the original registry nodes (including union branches);
arrays replace whole values. Full merged semantics still validate through CORE_SCHEMA and registered sections. JSON-only
inputs reject undefined, nonfinite, cyclic or accessor values before publication. Union leaf explanations include all branches.

The existing writer lock serializes publication: validate each authored layer, full CORE_SCHEMA + registered section
validators and resulting effective document; check preimage; seal a value-free audit intent through the existing audit
port; retain the existing file as a versioned adjacent product backup; fsync temporary file, rename and fsync directory. Governed writes prune adjacent backups under that same lock using configFile.backupKeep (registry default 3), protecting the newly created backup. A CONFIG_BACKUP_PRUNE_FAILED failure occurs after publication and does not roll back saved bytes; inspect reconciles actual document state. Config writer waiting uses configFile.writeLockTimeoutMs (registry default 2000ms); compatibility writeConfig and healing reuse the registry source, while installation publication keeps its separate installation setting. A malformed project document heals with registry defaults because it cannot supply valid config policy.
Audit carries principal/scope/key/command/layer and before/after document digests. Audit and filesystem publication are
separate stores: the audit intent is not an effect-settlement receipt; after an IO failure inspect reconciles actual
bytes. Audit failure prevents config publication. Without an initialized ledger/policy/key custody, writes refuse.
Secrets section set/unset is refused and remains owned by `deckent secret`.

Config schema 4 removes `mode`, `spawn_backend`, `auth_mode`, `providers` and `live_trace` (no consumers). Explicit v3
Next documents normalize on read with values-free warnings; reads preserve bytes, the next governed write publishes v4.
Current/unversioned documents carrying retired keys receive typed CONFIG_FIELD_RETIRED issues; other old schemas remain
unsupported. This is Next version evolution, not legacy conversion. Every field/registered section declares binding
and apply metadata; registration refuses missing metadata/declared-only sections. Source AST lint checks declared
consumer references and rejects new declared-only fields; the frozen historical allowlist is empty and may only shrink.
The lint proves references, not end-to-end causality. Nested fields inherit their section's declared consumers/apply mode.

`max_workers` narrows admission execution/in-flight capacity and the SQLite reservation transaction's shared pool
occupancy; `auto` adds no ceiling. Monitor reports effective capacity while retaining actual occupancy. Existing Run
snapshots remain immutable. Every Docker profile admitted through the registry (including compiled templates) must be
within configured `execution.docker.memoryBytes/cpus/pids`; excess is EXECUTION_RESOURCE_CEILING, never silent clamping.
Existing admitted Docker profiles are not rewritten; the existing first-scope pin can precede refusal, but no Run,
receipt, progression intent or attempt is created on a resource-ceiling rejection.

CLI config has a dedicated `surfaces/core/config` unit: an 80-column grouped human view, compatible `get [key] --json`,
explain/validate/set/unset with safe numeric array paths and splice removal. Terminal `/config [key]` and monitor's
read-only Config tab/`monitor --config` use the same inspect operation. Monitor config concerns its current project;
other installation snapshots do not grant config authority. A failing Config read shows a typed unavailable state without discarding successful Run/worker refreshes; recovery replaces it with fresh config. Tab help derives its index from the active tab registry. CLI explain uses the project/effective view and refuses --global with CLI_USAGE. No runtime protocol/ledger version change is required.
The owner-only provider cleanup sequence and temp-project command evidence are outside Git in
`proof/CONFIG-SURFACE-2026-10-02/owner-vllm-steps.md`. Historical invocation inspection keeps its immutable old reference
and profile after provider removal; the test uses a seeded valid durable claim/unknown settlement, not a model request.
Native runtime transport, a freshly built executable, live restart and independent acceptance remain outside this lane's
verified evidence. Fixed architecture budgets are retained; filesystem/authority adapters and pure admission helpers
keep composition as wiring, and previous comment-only wiring notes move to the external proof packet.

### CLI help catalog (CLI-HELP, owner 2026-10-02)

`surfaces/core/cli-kit` owns the typed dispatch catalog and plain-text help renderer. Each registration
has a purpose group, an i18n summary key and a detail key; nested registrations inherit their family's
existing execution handler. `cli` binds the handlers once, uses the catalog for dispatch, and recognizes
help before initialization. Run/Task action admission reads this same catalog. Argument parsers, runtime
operations, authority, JSON envelopes and exit codes remain owned by the existing handlers.
Top-level help lists command families by purpose; developer families require `--help --all`. Details
and registered children are exposed by `deckent <command> --help [--lang en|tr]`; common flags appear once.
Canonical help outputs have bilingual goldens and an 80-display-column gate, and every registration's
group, summary and detail must exist in both locales. New actions register metadata and localized details
in this catalog (A1/A3 `run close|resume` and `task accept|reject` are registered since batch 27);
no top-level help string is hand-edited. The `config` family keeps its lazy handler edge (terminal-render/Ink).
Help locale (owner 2026-10-03): explicit `--lang`, then `DECKENT_LANGUAGE` / `DECKENT_LANG`, then project/global `language`, then system locale/default. CLI ingress supplies the read-only `loadConfigLanguage` projection to the help recognizer. It reuses the config layer readers and version/language schema, preserves absent language, and does not initialize provider sections, resolve secrets, heal, write or lock. Invalid/unreadable language configuration silently falls back; unrelated execution sections are not validated by help. Explicit/environment locale skips the config read.
Help paragraphs are authored without soft line breaks; intentional blank lines and command lists remain separate.
Wrapping keeps bracket/angle tokens, flag-placeholder pairs and inline commands whole, and balances short prose tails.
Sub-help renders an optional `<detail-key>.examples` message (shared by the family); absent examples are omitted.
This is presentation discovery, not an authorization registry. Source-surface evidence does not establish
packaged-binary or cross-platform acceptance; the lane excluded build and full verify by owner direction (batch-27 integration runs full verify).

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
  stored or sent back as history. (Note 2026-10-01: this is the terminal's history; the governed model-invocation content of
  a chat round still retains the provider's native response including its `reasoning` field — OpenAI-chat stream assembly,
  Anthropic thinking text. Owner 2026-10-01 (D5 A, Jev dc3c1d0b): retention becomes a scoped setting, default text not kept —
  reasoning digest, length and token count stay, a company may opt in to keep the text; the turn's streamed-reasoning prefix
  check moves to the digest; the retained response is then a documented redacted evidence form. PLAN REASONING-RETENTION.)
  A turn footer shows elapsed time, tokens and truncation/cancel/failure. The status row
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
  `approval decide`). Only a single typed `y` approves; `n`, Enter, Esc and Ctrl+C deny; an `/approvals` card has no remember/always key
  (the standing-scope keys `s`/`a` exist only on in-turn tool-call cards the service marks, PERSISTENT-APPROVALS G6 below) and there is no auto-approval. Pending approvals are announced on the heartbeat (one bounded page per tick, rotating), on by
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
**Truncated rounds (TRUNCATED-TOOLCALL, Jev 6192a348; live with the next switch).** A round is truncated when its reported completion
count reaches the completion limit every round requests (`AgentTurnAdmission.completionLimitTokens` = `terminal.chat.
maxCompletionTokens`) or its finish is `length`; the finish alone is not trusted (vLLM v0.30.0 streams a tool call cut at
`max_completion_tokens` as `tool_calls` — serving.py overwrites `length`, fixed upstream by PR #46303 after v0.30.0 — and its
qwen3_xml parser may leave unterminated or, with PR #53739, terminated half arguments). No call of a truncated round runs:
each is refused before argument checks, policy, approval and execution (no partial effect), recorded as `invalid-arguments`
without an argument digest, answered to the model with the engine protocol text `error=output-limit` naming the limit and how
to write in parts, and counted as no progress; the turn's note names the refused calls. A text answer cut by `length` keeps
its behaviour (finish `length`). Without a known limit only `length` marks a round. The openai-chat adapter still rejects a
response that carries calls with a finish other than `tool_calls` (`invalid-response`, T-L2), so a provider that reports
`length` honestly fails the round instead (no effect). Tool-call arguments in history stay the provider's raw text (vLLM coerces
unparsable history arguments to `{}`, PR #48922). Timeouts: the profile's `limits.timeoutMs` bounds the model call, while
`service.responseTimeoutMs` only bounds the final frame write (`server.ts`), so a raised `maxCompletionTokens` must raise the profile's
`maxOutputTokens` and `limits.timeoutMs` together. Open decision (lead/owner): a distinct `truncated` tool-call status (Jev 0.84,
below the 0.90 criterion, so the safest reversible `invalid-arguments` was kept; needs domain/wire `callStatusSchema`, sqlite record
enum, en/tr label keys, v18 or v19).

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
authority. (Finding 2026-10-01, wave 5 TUI-COMPLETION G4, code reading at `a2971850`, not tested: the compaction message itself is
`role: 'user'` (`engine/core/agent-turn/internal/compaction.ts:95`), so the next compaction treats it as an earlier user message and cuts it
at 4000 characters (`:11,78`); the model summary comes first, so with a long summary the first user directives survive the second
generation only as a `[cut … sha256]` marker — the verbatim carry above does not hold across generations. The fix applies this contract,
it does not change it; the harvest card input TC-1 COMPACT-CARRY regenerates a canonical block outside the compaction message from the
turn ledger/history in every generation, with a compaction render version bump. TC-0…TC-7 are inside the owner's full-TUI acceptance
(2026-10-01); the TC-1 mechanism is card input, not yet decided in detail (PLAN TUI-COMPLETION); not implemented.) The turn emits `compacted` (surface: one line "N earlier messages were summarized"), measures again and applies
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
client before anything is sent as `RUNTIME_CHAT_TURN_TOO_LARGE` (start `/clear` or write less), never as a transport fault. Open: a `compacted` event must fit one event frame (`service.responseMaxBytes`); a tail of very large tool
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
**Model-facing system prompt (TL-C D4).** The runtime service renders a versioned (`AGENT_TURN_SYSTEM_PROMPT_VERSION`, now 6),
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
System prompt **v5** (LANG-CRASH): the reply language of the person's locale as the first rule and again as the last line
(`AGENT_TURN_REPLY_LANGUAGES`: en → English, tr → Turkish (Türkçe); keyed like the catalog locales, so a new catalog locale without an entry
does not compile). The service resolves the locale as elsewhere (its environment, then `config.language`). The compaction instruction ends with
'Write every string in <language>' instead of 'the language of the conversation'. Every turn's request digest changes again. Not forced: a
local model can still drift; no post-check exists (a post-answer language check is a separate card). The terminal's own locale is not on the
wire: terminal and service differ only for `terminal --lang` or a service started from another environment. Lead decision (2026-09-30): B now —
the live installation sets `language: tr` in its configuration at the next live restart; A — `chatTurn.language?` on the wire — needs protocol
v19 (v18 is released) and ships with the next protocol bundle.
System prompt **v6** (PROMPT-POSTURE, live 2026-09-30): fetch_url and the shell are separate; the shell note states `createAgentShell().posture()`
(the realm and open-view rule of the turn's calls: open bubblewrap = network, real HOME, Deckent state sealed, the configuration written
only by an owner-approved call (Astra 2192 R9); closed = no network; host; unavailable), and `Network access: none` stays only when the
shell has no network. Every turn's request digest changes again.
System prompt **v7** (TRUNCATED-TOOLCALL, 2026-09-30): when an edit tool is offered it names the per-answer output limit
(`terminal.chat.maxCompletionTokens`) and the write-in-parts recipe; every turn's request digest changes again.
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
atomic temp + rename, known secret shapes redacted, at most 50 sessions per scope and 16 MiB each, oversize refused before redaction). A
compaction simply rewrites the snapshot, so a resumed conversation can never carry pre-compaction messages twice (legacy defect).
`/resume` opens an arrow-key picker of this scope's recent sessions (Enter continues the highlighted one, Esc closes; TERM-PICKERS) and `/resume <n|id>` continues one (its messages become the history; later turns save
into it). TC-0 RESUME-REF source candidate (TERMINAL-S00-S01, 2026-10-03): ids are exact canonical lowercase ids, never prefixes.
Indices (including picker Enter) resolve only against the last shown list after a fresh scope-bound query compares ordered ids,
update times, message counts and previews. Missing/changed lists load nothing (`SESSION_LIST_STALE`); invalid references return
`SESSION_REFERENCE_EXACT_REQUIRED`; a missing exact snapshot returns `SESSION_NOT_FOUND`, all with visible EN/TR notices.
Successful save/resume and `/clear` invalidate shown indices. The session hook remains the context transition owner; terminal-kit
holds the pure reference/port contract. Fresh list comparison and snapshot load are separate reads, not an atomic versioned read;
same-id concurrent updates between them are not fenced. No service/wire/ledger migration or approval authority is added.
`/clear` (named `/new` at T-L5c) starts a fresh session; `/context` shows the latest measured prompt against the window. Snapshots are client
context, never authority; they follow the composer history switch `terminal.persistHistory`. The shared credential redaction's URL
pattern now bounds the scheme (`{0,31}`): the unbounded form backtracked quadratically on long letter runs (80k chars: 2.7 s).
**TC-M host measurement harness (TERMINAL-S00-S01 source candidate, 2026-10-03).** The existing fake Workline TTY harness
observes frame bytes at the in-memory stdout writer with same-process monotonic clocks. One host collector retains raw samples,
nearest-rank p50/p95, invalid/missing counts; unresolved/invalid/backward/equal clock readings remain `unmeasured` with null
percentiles, never zero. Version/source/harness/lock digests, installed dependency versions, host environment and fixed workload
are pinned in external proof. Warm mount→first READY frame, submit→BUSY, text event→frame, approval event→card and
Esc→cancelled footer+READY are control intervals; fake model generation and compaction wall intervals are separate.
No product behavior or runtime telemetry producer is added. K-LATENCY-METRICS has no producer in base `0388c2cf` (source,
test, script and host-tool search); that wider runtime work remains open and should reuse this collector rather than duplicate it.
Process boot/import/service connection, physical terminal paint/flush, real model/GPU/provider/approval polling, long sessions and
loaded-host acceptance are unmeasured. Event→human surface 500 ms p95 remains a target. Proof: external
`proof/TERMINAL-S00-S01-2026-10-03/S00/`; author verification, independent review and landing are separate.
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
owner 2026-09-26 accepted this as a documented limit — no native/Landlock writer for now; COMPLETED-PLAN "Owner kararları 2026-09-26 (akşam)" (1)). Approval previews are bounded to 16 KiB UTF-8 bytes (whole lines first, never
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
must not run `low` silently on this verdict alone. Since slice 3c the agent `run_shell` tool uses it
(`composition/core/agent-turn/internal/shell.ts`).
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
it), the last summary, the three largest items and a `/clear` suggestion at ≥ 60 %. Protocol unchanged (v16). Open: `/compact` (protocol
decision), redrawing an open suggestion list when the index refreshes.

**Shell realm (S5, S9, S11; owner 2026-09-28).** Shell calls run through one `ShellRealm` port (host / bubblewrap / landlock).
`terminal.shell.realm = require-sandbox | prefer-sandbox | host` (default `prefer-sandbox`). The service probes once per process
(`ShellCapabilities` v2, BWRAP-SELECT): the bubblewrap launcher is selected and run once (below), the user namespace via a short-lived
native helper, the Landlock ABI; 2.5 s bound, failures `unknown`, nothing installed. The bubblewrap observation is `{ status, launcher,
rejected, restriction, detail }` — `available` only when the selected launcher's own sandbox run succeeded, `restricted` (typed, with the
fix) when that run met a user-namespace restriction; every rejected candidate is named. PATH is never read for the launcher. Sandbox
mechanisms are realm providers (`ShellSandbox.usable(capabilities)` → realm, result marker, a posture function of the call's write view, a notice when the posture
falls short — or why not), taken in preference order from a code-only composition port (`RuntimeServicePorts.shellSandboxes`; shipped
list **bubblewrap, then Landlock**). `host` → host (result bytes unchanged); a sandbox mode → the first usable provider; none usable →
`require-sandbox` refuses before any plan, approval or effect (`SHELL_SANDBOX_UNAVAILABLE`), `prefer-sandbox` runs on the host and says
so in the approval preview, the live stream, the model result and the finished line (`sandbox: none; running on host (bubblewrap: …;
landlock: …)`) — never a silent fallback. A later provider that wins after a preferred one was passed over **for any reason**
(REALM-NOTICE, live 2026-09-29: a host restriction such as AppArmor with its fix, a launcher inside the project or scratch area, an
unavailable or changed launcher) is a visible fallback too, in every sandbox mode: `[deckent] sandbox: <chosen> instead of <preferred>
(<preferred>: <reason>)` (one helper, `describeSandboxFallback`; each reason one line, control characters as spaces, at most 480
characters, `boundSandboxReason`) leads the resolution notice (live stream, model result) and follows the winning provider's posture
(approval card). The resolution carries the providers passed over (`rejected`, in order), which doctor reads. Lead decision 2026-09-29:
the notice stays on every fallback, including a host that always falls back (owner principle "never a silent fallback"; the cost is one
repeated line per shell call on such a host); macOS/Windows `SHELL_REALM_UNSUPPORTED`. Every result's first line names its realm (`sandbox:
bubblewrap | landlock | degraded | none`; only trusted metadata, never command output); the approval card renders that posture against the same `shellWritePosture` result the effect enforces (always `owner-approved` once a card exists; `sandboxWriteView` in `host-shell`), so its project, write-floor and `.git` wording cannot drift from the boundary (host and the no-sandbox fallback keep a fixed text).
Both sandbox launchers go through the host shell's one process runner (`ShellLaunch`: program, argv ending in `bash --noprofile --norc
-c`, optional fd 3 setup-failure channel), so the process-group, cancellation, timeout, output-bound and cleanup contract is the same
everywhere; a realm that cannot set itself up refuses the call (`spawn-failed` → effect `refused`, the reason is the result: "nothing
was run"), never runs on the host instead.
**Bubblewrap realm (S9).** `adapters/core/shell-sandbox-bwrap`: `bwrap … -- bash` with the launcher the probe selected
(BWRAP-SELECT, owner S1–S3/S6 2026-09-29, eleventh batch): first a system file at `/usr/bin/bwrap`, `/usr/local/bin/bwrap` or `/bin/bwrap`
(merged `/usr` tried once by canonical path) that is a regular executable, not a symbolic link, root-owned, not writable by group/others,
without setuid/setgid, in root-owned directories not writable by group/others up to `/`, whose `--version` is at least **0.12.0**
(GHSA-pxhw-h44j-8pfx / CVE-2026-87766; a distribution backport is not recognized); otherwise the **bundled build**
(`dist/adapters/core/shell-sandbox-bwrap/bundled/linux-<arch>/bwrap`, resolved from the module URL): its bytes are read once, must hash to
`BUBBLEWRAP_BUNDLED` (generated from `packaging/bwrap/bwrap.lock.json`), and the same bytes are written to `<global state
root>/bin/bwrap-<sha256>` (0700 directory, 0500 file, unique temporary + fsync, published with `link` — never replacing — so concurrent
processes normally run one inode (not when a publisher stalls > 0.5 s: its copy may then be replaced by another verifying copy); the check waits ≤ 0.5 s while a publisher's temporary name is still linked; only a copy that does not verify
is replaced by `rename`; an existing copy is reused only when ours, single-link and verifying; a replacing `rename` refused 29/120
concurrent measurements with nlink 0, 2026-09-30) — that copy is what runs, so an npm install under umask 002 (package file 0775) is not a problem and the package tree's
permissions are not trusted. PATH never consulted. The probe runs the selected launcher once (`--unshare-all --die-with-parent --new-session
--ro-bind / / --proc /proc --dev /dev -- /bin/true`, env empty, 1 s); the realm is usable only when that run succeeded, and on every use the
launcher file must still be the measured one (`dev:ino:size:mtimeNs:ctimeNs`; the bundled copy is re-hashed when its identity moved, a
changed system file needs a service restart). A launcher inside the project or the scratch area (a state root pointed there) is refused: a
sandboxed command could replace it. `launcher.overlay` (≥ 0.11.0) is what SHELL-OVERLAY reads. Bundled 0.13.0 is built with
`-Dassume_kernel=5.15.0` (owner S6: minimum kernel 5.15). Development and tests: `npm run build` stages the locked build into the gitignored
`src/…/bundled/` from a verifying build-bwrap output (`DECKENT_BWRAP_BUILD` or `.pack/bwrap/*`) and says loudly when none exists;
`bwrap-real-sandbox-guard.test.ts` fails a Linux host with open user namespaces that selected no working launcher with overlay (the
bubblewrap tests would otherwise skip); vitest gives every worker a temporary `DECKENT_GLOBAL_HOME`, so the realized copy never lands in
the owner's `~/.deckent/bin` (the development entry `.agents/refactor/next-entry.mjs` keeps its global home outside the checkout,
`~/.local/state/deckent-next-dev`, 0360bab9: a home inside the project put the copy there, which the rule above refuses — live 2026-09-29).
`selectBubblewrapLauncher({ place: false })` is the read-only measurement (doctor): an already placed, verifying copy is used; nothing is
created, written or re-moded, and a copy the service has not placed yet is reported as "not placed … yet". The shipped provider list is
one function, `shippedShellSandboxes(layout)` (bubblewrap, then Landlock): the service's default port, MCP `inspect` starts and doctor.
**CI-FULL build inputs (owner 2026-10-01; developer tooling only).** The bubblewrap driver constrains every
resolved host and per-architecture sysroot package to its locked version before installing, in addition to the direct requests;
the complete installed inventories and source/image/license/binary hashes are still checked afterwards. Missing repository
versions refuse the build; a deliberate audited lock refresh is required, never a silent refresh. The CI-FULL refresh changes
five host dependency entries only; both existing binary hashes remain unchanged. Source/artifact mirrors and a real arm64 realm
remain separate unproven work. The TypeScript build runs the checkout's installed `typescript/bin/tsc` using `process.execPath`,
without `npx`, a command shell or a Windows `.cmd` launcher; an absent compiler or compiler error fails the build.
The test harness canonicalizes only the OS temporary parent before fixture allocation and propagates it to descendants;
explicit test global homes and product roots are unchanged. Successful descriptor-relative workspace read/edit cases run only
when the existing Linux `/proc/self/fd` capability is available. Portable policy/grammar and typed unsupported-refusal tests
remain active; this partition does not implement macOS/Windows custody or grant platform acceptance.
**CI-FIX signal (owner 2026-10-03; source candidate, hosted acceptance pending).** All six matrix cells
are required workflow failures, named `required verify (<os>, node <24|26>)`; `continue-on-error` is absent.
Workflow YAML does not implement branch protection; the owner reports the main ruleset active (2026-10-03).
Same-ref concurrency cancels superseded runs. Existing pull_request remains secret-free with read-only contents
and no persisted checkout credential. Full history prevents source-history ratchets from silently losing CI coverage;
Windows disables Git line-ending conversion before checkout so locked license/golden bytes remain exact.
After setup-node, the workflow canonicalizes only the OS temporary parent into TMPDIR/TMP/TEMP through GITHUB_ENV;
Vitest, standalone host node:test and native children then allocate fixtures under the same real path.
Explicit product roots and the managed-file symlink/permission floor remain unchanged.
The existing job bound stays 30 minutes; verify has a 20-minute step bound, preserving time for always-run summary
and SHA-pinned official upload-artifact v7.0.1. Host node:test replaces Infinity with a 180-second
execution bound (existing fixture subprocess ceiling); native node:test uses the existing 30-second Vitest ceiling,
and each native compile/test invocation is capped at 180 seconds. Host/native test concurrency is two and their reporter is explicitly TAP so failed names/skip notes reach the collector. These bounds
reduce unbounded defaults; they do not increase existing fixture or Vitest timeouts. Each job retains the original verify exit through bash pipefail,
raw log, collected `verify-evidence`, failed Vitest/collection and Node host-test names and actual `verify-not-run` notes.
Missing Vitest outcomes are `VERIFY_OUTCOMES_UNAVAILABLE`, never zero passing tests; summary is not whole-job acceptance.
Native manifest exclusions now emit `verify-not-run` with `NATIVE_PLATFORM_UNSUPPORTED`.
The config file adapter defaults its bootstrap layout to the actual host platform; explicit simulations remain explicit.
The detached runtime launcher refuses Windows/missing O_NOFOLLOW before log I/O as RUNTIME_LAUNCH_UNSUPPORTED.
Windows rendering fixtures exercise bounded stdin with visible file-variant exclusions and a separate file-refusal negative.
Packaging evidence normalizes metadata separators and canonicalizes only declaration build roots.
No new native macOS/Windows custody is claimed; typed refusal tests and portable behavior stay separate.
Sources/versions dated 2026-10-03 and fresh proof limits live in external `proof/CI-FIX-2026-10-03/`.
R2 starts from the first all-required run `37111243380` on `38c9dae1`: all six cells failed, so R1 review
and local checks do not establish hosted acceptance. Fixture roots must satisfy the current architecture
registry, including required Markdown documents; full history/canonical temp alone cannot repair a stale fixture.
New or materially changed contract tests must exercise portable behavior on every matrix OS, or declare an
existing typed platform capability, assert its refusal before effects and retain a `verify-not-run` record for
the unavailable positive variant. Linux positives remain active; no untyped platform skip or security-floor
relaxation admits a green result. Config-lock owner-metadata and directory-enumeration EPERM/EACCES is bounded contention, never
evidence of a dead owner; only a successful later exclusive mkdir admits work, and persistent unreadability
ends in CONFIG_WRITE_LOCKED. Tracked-file unavailability carries a typed execution diagnostic without
changing its measurement/security bounds. Build/declaration/CI temp identities use native canonical paths;
the fast architecture scanner waits for stdout delivery before exiting, including large inventories.
R2 implementation/verification evidence: external `proof/CI-FIX-R2-2026-10-03/`.
CI-FIX-R3 (owner 2026-10-03, source candidate on `9740baae`) extends the same unreadability rule to
`readdir(lock)`: no empty/stale-owner claim, no entry/reclaim, bounded retry; other IO failures propagate.
Injected EPERM/EACCES → typed lock timeout and unchanged owner metadata is the RED/green contract;
real Windows contention and the separate duplicate-reclaim warning still require native evidence.
External exact candidate/checks/open limits: `proof/CI-FIX-R3-2026-10-03/review.md`.
**SOCKET-PUBLICATION (owner 2026-10-03; source candidate).** The Linux native runtime listener binds inside a pinned
0700 staging directory in the final parent, pins the socket inode, chmods that inode through `/proc/self/fd` and fstats
0600, listens, then publishes with descriptor-relative `renameat2(RENAME_NOREPLACE)`. The final name is absent until
a private listening socket is ready; existing files/symlinks/sockets are never overwritten. No process-wide umask
change or post-publication JS chmod; `MANAGED_FILE_UNSAFE` remains strict. Unsupported NOREPLACE is a typed
`LOCAL_PEER_PUBLICATION_UNSUPPORTED` / `LOCAL_RUNTIME_UNSUPPORTED` refusal without fallback. Both final and
staging paths must fit Linux's 108-byte `sun_path` including NUL (`LOCAL_PEER_OPTIONS` / `LOCAL_RUNTIME_OPTIONS`);
staging uses parent + `/.sXXXXXX/s` (11 bytes). Failure cleanup removes only the pinned socket identity and empty
pinned staging directory, preserving replacements. Crash orphan pruning and hostile same-UID isolation are not
claimed. Official [rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html) and
[unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html) verified 2026-10-03; author/hosted/review evidence is
separate in external `proof/SOCKET-PUBLICATION-2026-10-03/`.

**CI-WINDOWS-MACOS (owner 2026-10-01; verification tooling).** Each CI matrix job has a 30-minute ceiling,
with ~2.1x headroom over run36884716187's successful Linux jobs (14m05s/14m20s); cells cannot inherit
the 360-minute GitHub default. Linux-only local runtime socket/live OS-session tests name their capability in
collected test titles and skip only cases requiring it; portable policy/grammar and existing typed refusals stay
active. Bubblewrap ancestor traversal stops when dirname reaches its fixed point, including a Windows drive root;
Linux protection-pin placement and all security bounds remain unchanged. A subprocess regression owns a 2-second
OS kill deadline because a synchronous loop prevents an in-process test timer from firing. Host-platform guard
simulations are labelled; they do not establish native Windows/macOS custody or runtime support. Actual hosted
post-fix evidence and independent review remain lead gates; sources/inventories in external CI-WINDOWS proof.
Windows fixture homes explicitly carry USERPROFILE with their temporary HOME. Developer SBOM/ajv bundle guards
normalize metadata separators before package/forbidden-provider checks, and fixture imports use file URLs; no package
or dependency version changes. Shared CLI JSON file input refuses Windows or absent O_NOFOLLOW/O_NONBLOCK using
the caller's existing typed *_INPUT_UNAVAILABLE error before opening a path; bounded stdin stays available. Terminal
history/session file factories similarly refuse Windows or absent O_NOFOLLOW with existing MANAGED_FILE_UNSUPPORTED,
before reading/writing any state. They retain POSIX permission/link guarantees instead of claiming a Windows private
store. Terminal-history declares exactly the public platform managed-files error dependency; no contract schema changes.
**Doctor realm report (REALM-NOTICE).** `doctor` (`--json` field `shellRealm`, schemaVersion 1, additive to doctor schemaVersion 2,
`null` when unwired; human lines in the product's own sandbox words, no catalog text — the result marker with `[terminal.shell.realm
<mode>]`, then the notice or the reasons) reports the realm a shell call in this project gets under the configured mode, every provider
passed over and why, and the host measurement (`bubblewrap: {status, launcher {source, path, version, overlay}, rejected, detail}`,
`landlock`), measured read-only with the state root the service uses (`globalStateRoot()`), so "probe available, provider refuses" is
visible. Host mode also reports `preferSandbox` (the MCP registry default). Measured in the CLI process: a running service keeps its own
measurement until it restarts; no conversation scratch area (a launcher inside only the scratch area is not detected by doctor). (Closed view — standart, full-auto and unattended calls; a full-access call's open view is under Full access (MODES-3).) View per call: `--unshare-all` (network included; the
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
refuses the call; a `.gitignore` change cannot lift this); AppArmor-restricted Ubuntu (24.04 with the restriction on, 25.04+) is typed
`restricted` from the launcher's own run and falls back to Landlock visibly; this machine (WSL2) has no restriction sysctl, so that path is
unit-tested, not measured here; a selected launcher whose run fails is not replaced by the next candidate; between the per-use identity
check and `spawn` the copy can be swapped by the same user (0700 directory: no other principal; fd-exec not used); aarch64 is built but not
shipped until a real arm64 realm test (lock `shipArches`); `/bin/true` is the probe's command (a distribution without it reads
`unavailable`, with the reason); `--die-with-parent` should also end a sandboxed command when the service dies
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
the system prompt says there is no network access (v6: unless the shell's posture reaches the network — then fetch_url is named not offered). **Egress mapping (decided, Jev ee030c0e 0.90 / sufficiency 0.77): `allowlist`
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
matches"), `glob`. Every result is byte-bounded by the tool itself (16 KiB default at T-L1; 64 KiB since owner 2026-09-27,
`terminal.chat.readResultMaxBytes`) and states any cut; fitting results into the
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
(ANTHROPIC-PROFILE, adapter v2): an adapter-owned, dated and sourced capability registry (`internal/models.json`, docs read 2026-09-29;
owner 2026-10-01 D6: becomes a dated seed of the ledger v43 model catalog, PLAN CATALOG-SEED)
lists per model the accepted thinking types (adaptive, manual budget), the single off type (`disabled` | `between_tools` | none) with its
effort ceiling, `output_config.effort` levels and default, and the synchronous max output. A profile is checked against its pinned model's
row at load (`OPENAI_CHAT_DEFINITION_INVALID`, no call); an unlisted model admits only no thinking field and no effort. `effort` is profile
data sent as `output_config.effort` (GA, no beta header) and forwarded to `count_tokens`. Not supported: per-message effort,
`display: "updates"`, structured output, task budgets. The registry must be re-read from the official pages at least every 30 days or on a new
model announcement (no refresh mechanism yet). Not yet: SSE byte/token metering in live streaming, an OS keyring backend for the key (K2; the key resolves through the installation's configured secret store since SECRET-K1),
the owner's first billed smoke call (Opus 5.5 `effort`, Sonnet 5.5 `between_tools`), tariff rows for legacy models, a neutral
`reasoning: {mode, effort}` (P2).

HARDCODE-P1-B (source candidate; owner order Jev e2b81339 2026-10-02, built in the D4 night 2026-10-03): `models.json` schema 2 owns the top-level effort vocabulary
in declared ascending order and Anthropic `metering.promptOverheadTokens` / `thinkingBudgetMinTokens`.
The adapter derives its runtime enum/rank from this vocabulary; model levels must be a strictly ascending subset,
with a declared default and any off ceiling in the vocabulary. Runtime admission still checks the pinned row;
TypeScript effort strings no longer encode a second closed vocabulary. Missing parameters and old asset versions
throw typed `ZodError` at module load; no silent defaults. Positive safe integers and schema/order constraints remain code.
The shipped vocabulary, 2048 local prompt reservation allowance and 1024 manual-thinking minimum are preserved.
The minimum/effort sources were verified 2026-10-03; model rows retain their 2026-09-29 snapshot as the asset note states.
OpenAI-chat owns `internal/metering.json` schema 1: request/message/tool estimate overheads 64/16/32,
validated once at load and read by its existing UTF-8-byte estimate. These overheads are local estimate policy,
not vendor-count guarantees; the provider counter remains the separate counting path when available. No config, ledger,
provider protocol or public surface is added. Proof: `proof/HARDCODE-P1-B-2026-10-03/`; independent review and landing remain open.


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
unattended`, never text) and the planned tier (`shellWritePosture`, host-shell, beside `unattendedWritePosture`):
- **owner-approved** (the owner's card): the project writes, the write floor included; `.git` stays read-only except in a full-access turn.
- **full-access** (an audited `full-access-call` of a turn launched in full access while the company grant holds; owner 2026-09-29: full
  access is comprehensive and owner-authorized by the mode): the project, the write floor (existing and new names) and `.git` (and a
  worktree's common repository) write; the configuration file stays read-only (that turn's sandbox floor is only the configuration
  file); the hard floor — product state, credentials, the MCP registry — stays masked/denied. In a full-access turn the view is **open**
  (OPEN-SANDBOX, e376f546): `shellWritePosture` returns `open` for the `full-access` authority and for an `owner-approved` call of a
  full-access turn (never for an unattended or full-auto call); `sandboxWriteView` carries it (never with a read-only project or a write
  set) and the card says "network on, HOME visible, Deckent state and credentials hidden/read-only".
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
closed, the server does not start). MCP server views take the unattended posture with the whole project read-only (C5, owner 2026-09-29, until
SHELL-OVERLAY): one derivation, host-shell `unattendedWritePosture(narrowMutating)` — host-shell's `shellWritePosture` takes it for
unattended shell calls, `longLivedWritePosture()` (not narrow) for a long-lived server; the bubblewrap launch binds the project
`--ro-bind`, keeps the floor's matcher required (fail closed) and returns the write view it enforces, from which the launch and tools
cards say "the project is read-only, .git included" and that `realm: host` lets a server write. A sandboxed server therefore creates no
name in the project, existing or new, floor or not (Astra 2177 R1 closed for bubblewrap); only a bound scratch area, bubblewrap's
private `/tmp` and the empty HOME tmpfs are writable. The same in every mode; MODES-3 defined no full-access MCP posture. The host realm
has no OS boundary for any posture.
**Sandbox write set (SHELL-OVERLAY, owner 2026-09-29: the permanent C5 fix for the shell; `f906c31` + `57bdbf1`, merged with C5-MCP-RO in
`ee854a8`, tenth batch).** The write set is the `writeSet` variant of host-shell `unattendedWritePosture`, the one unattended derivation. A shell
call a full-auto relaxation let run (`ShellCallAuthority 'full-auto'`: an audited `permission-mode` event of mode full-auto; tier past the
narrow set) in a realm that can keep writes aside (`ShellRealmResolution.writeSets`: bubblewrap whose selected launcher has the overlay
options — `launcher.overlay` from the probe's version reading, ≥ 0.11.0; BWRAP-SELECT merge, eleventh batch) runs with the project as an overlay (`--overlay-src P --overlay <upper> <work>
P`; `.git`, the floor's existing paths and the deny masks are bound over it as before). The upper/work directories are Deckent's own (0700;
host-shell `sandboxWriteSetRoot`: the project data root's `fileEffects/sandbox-writes`, else the global state root's; the first whose real path
neither holds nor sits in the project — bubblewrap: overlay layers may not nest; none → the read-only posture with a result note). When the
command exits (any code), the native lister `shell-overlay-scan` (reads the kernel's `user.overlay.opaque`; Node has no xattr API) and
`scanSandboxWriteSet` produce the change set: `c 0:0` whiteouts and opaque directories are deletions (a rename is delete + create: `userxattr`
forces `redirect_dir=nofollow`, `metacopy=off`), symbolic links, special files, hard links and setuid/setgid files are refused per entry,
`redirect`/`metacopy`/whiteout-xattr metadata refuses the whole set, bounds (2 000 entries incl. subtree deletions, 64 MiB, 16 MiB per file,
depth 32) refuse the whole set, and a lower path whose ctime is not older than the call directory's own ctime (start mark, kernel clock) — or
a whiteout whose lower entry is gone — is a conflict: nothing is applied. Every entry is decided exactly like an edit of its path
(`decideAgentToolCall`: `run_shell` × `workspace.file.write`, cell `edit` / `edit-floor` / `edit-authority`; a relaxation is audited per entry
— `permission-mode` `edit-non-floor`, summary `{kind: 'edit', path}` — before its effect; the write floor and the configuration file are not
applied and the result tells the model to use the edit tools, which card; a deny keeps it out) and applied as its own C11 effect of
`workspace.file.write@1` on `workspace-file` (target-internal `writeSet` input: bytes read from the upper and digest-checked, mode applied;
removal journaled with `next: absent`, a removal left `prepared` is unknown). Deletions first, then emptied directories, then writes with
their missing parents; a changed precondition or an unknown outcome stops the rest. A stopped/timed-out run applies nothing; the directory is
removed after every call, and a crashed service's leftovers are swept (never applied late). Landlock and host refuse a write-set request.
Owner-approved, full-access, narrow-set and standart postures are unchanged. Cost (this machine): overlay mount +4 ms per call, native listing
6 ms / 200 entries, **≈ 85–95 ms per applied entry** (measured split: ≈ 79 ms the entry's C11 effect — ledger intent/settle at full
durability, journal and file fsyncs —, ≈ 16 ms its sealed audit event; 100 files ≈ 9 s; the same class as one edit per file) — open (O6/O7).
Production: **active** wherever the selected launcher has overlay — the bundled 0.13 (or a system ≥ 0.12); on this machine the system 0.9.0 is
rejected and the bundled copy is selected, so a full-auto relaxation's writes now go through the write set (measured end to end through the
production sandbox list and the service's own measurement, `runtime-shell-overlay.test.ts`; without a `workspace.file.write` grant every
entry is "not applied … (denied by policy)" and `.git` stays read-only inside the overlay view). MCP servers: same mechanism,
checkpoint = server stop at the end of a turn whose server wrote (design §10), later slice; until then C5-MCP stays open (read-only view above).
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
Landlock gives clean Git entries `w`; the inode floor's masks stay); the sandbox posture is the full-access bullet above. Host realm (explicit, or a fallback): the
shell hard floor stays name-based (a command naming product state is refused; an expanded name is not caught).
**FA-TRACKED-WARN (owner 2026-09-30, option A).** A full-access shell call keeps running without asking. What it measurably did to
the project's git-tracked files is shown and audited — never blocked, never a card.

- **Measurement.** Before the call, `git ls-files -z -s` lists the tracked files of the repository that holds the project. It runs
  from the project root with a fixed environment: no system/global config, `core.fsmonitor=false`, `core.hooksPath=/dev/null`,
  `GIT_OPTIONAL_LOCKS=0`. It reads the index only and hashes no content, so no filter or other repository-configured program runs.
  Each listed file is `lstat`ed before and after the call. Present before and gone after = deleted; inode, size, mtime or ctime
  changed = overwritten. No git process runs after the command, so a rewritten `.git` cannot hide anything or make Deckent run anything.
- **Output (protocol v18: result text only).** The result's first line starts with `[deckent] run_shell: tracked: deleted=N
  overwritten=M; …`, the first metadata after the tool prefix and before the realm marker, exit status and command, so neither the
  command's text nor its output can supply it. The finished tool line reads the counts only from there (`trackedChangesOfToolResult`)
  and shows the `terminal.render.toolTracked` suffix in the warning tone. The end of the result carries `[deckent] tracked files changed:
  deleted N (a, b, … +k more), overwritten M (…) — during this full-access call; nothing was blocked.` (at most 8 names per list, control
  characters shown as `?`), also streamed to stderr. A marker printed or written by the command produces no suffix (forgery tests).
- **Audit.** A sealed `tracked-files-changed` event (audit event schema 1, additive) is written after the effect with the call reference
  and policy revision of the call's `full-access-call` event, at most 50 paths per list plus the full count; paths are plain text (hashed
  paths for SIEM export are a follow-up). If it cannot be written, the line says so.
- **Coverage.** A stopped or timed-out run is measured too. Only `authority === 'full-access'` calls are measured; standart, full-auto
  and an owner-approved card call in a full-access turn are unchanged; `write_file`/`edit_file` keep their own audit.
- **Bounds.** At most 100,000 tracked files, otherwise the line says "not checked". The listing is capped at 64 MiB / 5 s, and the
  `lstat` passes yield to the event loop every 4,096 files. A non-git project is a no-op; a linked worktree and a project inside a
  repository resolve as git resolves them (paths relative to the project root); a nested repository's files are its own.
- **Limits.** A change another process makes during the call is attributed to it. A `chmod` or a new hard link reads as overwritten
  (ctime); a rename reads as a deletion. Submodule entries and files absent before the call are not measured. git is looked up on the
  fixed PATH `/usr/bin:/bin`.
- **v19.** The typed `tool.finished.trackedChanges` (hook: `agentToolOutcomeSchema`, turn event schema on a v19 envelope, loop,
  shell outcome, terminal-chat delta, `ToolDelta`, text reading kept as fallback) waits for the v19 bundle (Jev 34a8df5c).

**Open view (OPEN-SANDBOX, owner MODES-3 checkpoint 4; live findings 3/4 of session 1d428e9f).** A full-access call in a realm that
`opens` (bubblewrap) runs with `--unshare-all --share-net`, `--bind / /` then a fresh `/proc` and minimal `/dev` (PID namespace,
`--die-with-parent`, `--new-session` kept): host network, the real HOME readable and writable, the project and `.git` writable. The hard floor
is structural, from `ShellSandboxLayout.hardFloor` (`agentShellHardFloor`, `adapters/core/agent-workspace-floor`, full-access turns only): the
project's product root (`.deckent`), the data root, the bootstrap configuration's directory, the global state root of the service's
configuration and process environments, and an existing conventional `~/.deckent`. A root inside the project is bound read-only over it (its
product state still masked by the deny walk) — no name, existing or new, is created there (`.deckent/mcp.json` EROFS); a root outside it is an
empty tmpfs remounted read-only after the scratch bind (bubblewrap copy, user MCP registry/trust, secrets hidden; man page: `--remount-ro`
changes only that mount point). Owner Y (cef933a7, 2026-09-30): the sealed `.deckent` root takes no new name, but an EXISTING subdirectory
that is not Deckent's state (`hardFloor.product`: every registry resource under the turn's and the default layout, the data root, the
bootstrap configuration, the MCP registry, the Core floor's `.deckent/` heads; denied paths and protected anchors never) is bound writable
over it — a tracked `.deckent/docs` checks out clean. Commits e376f546 + 46148e4f + cef933a7. A missing root is created empty (0700) first
(bwrap would otherwise `mkdir` it on the host, measured 0.13). The Core credential patterns are masked in HOME over a bounded walk (depth 3,
20 000 entries — over it the call is refused; vendored trees and symbolic links not entered). Astra 2189 R7: a mount protects a path, not
its parent — every ancestor of a protective target (sealed/hidden root, read-only path, mask, scratch) up to `/` is self-bound
(`ancestorPins`), so renaming it fails EBUSY instead of carrying the mount away; the pins come right after `--bind / /`, before every
other mount (a later host bind would otherwise cover the floor); a non-canonical ancestor or more than `BUBBLEWRAP_ANCESTOR_PIN_MAX`
(1 024; measured 32, +1.8 ms) refuses the view. A closed view with a writable project (owner-approved; unattended narrow) pins the
in-project ancestors right after the project bind, before every protective mount (measured 0–10 pins, ≤ +1 ms); an overlay (a pin would
bypass the write set) or read-only project (EROFS) view pins nothing. An owner-approved call of that turn keeps the
existing configuration file writable (content only). Fail closed: an open request without the hard floor, a root that holds the project,
HOME or `/`, a read-only project. A realm that cannot open (`openShellRealm`): `prefer-sandbox` runs the call on the host with a visible
notice ("full access: no open sandbox (…); running on host … protected by name only"), `require-sandbox` keeps the closed view with a
notice; the explicit host mode and a host fallback are unchanged. MCP server views are unchanged (`longLivedWritePosture`). Cost (this
machine, empty project, wall clock with view resolution): open ≈ 55–63 ms, closed ≈ 11–13 ms. Open limits: HOME credential masking is by
pattern and depth-bounded (deeper, linked or hard-linked credential files open); credential stores outside the Core patterns
(`~/.config/gh/hosts.yml` — used by `git push` here —, `~/.codex/auth.json`, `~/.gnupg`, arbitrarily named `~/.ssh` keys) stay open (owner
2026-09-30: name patterns for now; follow-up card OPEN-SANDBOX-HIDDEN-PATHS: a policy-managed hidden-path list); other projects' state and a
missing `~/.deckent` under an override are not sealed; minimal `/dev`; Landlock has no open view; the view seals Deckent's state, not its
code (the service's node under HOME and a dogfood checkout's `dist/` are writable, so a full-access shell can change what the next restart
runs); non-product FILES at the `.deckent` root and NEW subdirectories stay read-only (a commit adding one fails to check out there).
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
After a written entry's own decision, each new parent directory it needs is decided like an edit of that directory (its own name and as a tree:
deny, write floor, configuration name), once per set and before any is made; a refused one keeps the entry, every entry beneath it and all its new
ancestors out (Astra 2183 R3, `dc57015`); `ensureWorkspaceParents` refuses a floor-named or undecided parent before the first `mkdir` (defense in
depth). Parent creation is not a C11 record of its own (decided and audited, reported as `new directories created`). The write floor's `.github/**`
is anchored at the project root (T-L4 §5): a nested `a/.github/workflows/x.yml` is an ordinary path (owner checkpoint in PLAN).

**`/mode` messages (MODE-UX G3, seventh batch).** On a v1 policy (`view.supported = false`) the surface never calls `set`; `/mode` shows
the current mode with a one-line effect, the other modes with theirs, and says when nothing in this scope can change it. Typed refusals:
`PERMISSION_MODE_DENIED` (`{mode}`; no allow grant on `permission-mode`/`set`, instead of the generic `POLICY_DENIED`; `require-approval`
stays `POLICY_APPROVAL_UNSUPPORTED`) and `PERMISSION_MODE_LOCKED` (the authority write lock is held; `CONFIG_WRITE_LOCKED`'s path/pid/age
carried, only on `setPermissionMode`). Protocol and view schema unchanged (v15). Open: which modes are actually settable (per-mode `set`
grant) is not in the view (checkpoint).

**Derived self-source floor (SELF-SOURCE-FLOOR A2, owner 2026-10-01 narrowing (a/b/c), implemented in the D4 night 2026-10-03).** The build identity v1 optionally records the
canonical Git common directory of the source checkout as `sourceCommonDir`; old/missing/unreadable identities remain valid negatives.
At each turn start the adapter compares that field with the project's canonical Git common directory. Linked worktrees match;
separate clones/customer repositories do not. No configuration field or default switch is added. In a non-full-access self-source
turn, one frozen table beside the static floor adds `src/**`, `dist/**`, `scripts/**`, `assets/**` as `edit-self-source`. Classification
precedence is denied → `edit-authority` → static `edit-floor` → `edit-self-source` → `edit`: static hard-floor paths stay `edit-floor`
even in the self-source repository, never session/standing approvable. Shell protected names stay on the static floor unchanged;
self-source applies only to write classification. No permission mode lowers `edit-self-source`. Edits, the host narrow
mutation classifier, both shell sandbox views and overlay settlement share this floor. An unapproved overlay floor entry is withheld
and directs the agent to the edit tools for an owner card. Full access keeps its prior authority-only sandbox floor and decisions.
The card summary names source/running code, path and mode in en/tr; the terminal derives its marker once at startup, even beside the
full-access marker. `--version` shows the optional common directory; the runtime descriptor protocol is unchanged.
Internal session patterns are distinct from ordinary standing keys, scope/principal/conversation bound, sealed before memory/use;
`standingPattern` refuses the new cell as `cell-not-standing`, and persisted grants never lower it. **Public session answers remain
unwired:** the stream has no standing offer and terminal decisions return `saved: false, reason: protocol`; the production turn does
not supply session memory. Adding those fields is outside this lane's pre-approved contracts. This is an implementation limit,
not S1 closure. Owner D4 (2026-10-03) admits DEV-RELEASE-SOURCE-ORIGIN option D: retain the separate clone, declare the
origin checkout common directory through `DECKENT_BUILD_SOURCE_COMMON_DIR` (absolute existing readable directory, canonicalized),
and record optional `sourceCommonDirOrigin: declared|derived` in identity v1. Invalid declarations fail the build without fallback.
Stage checks origin common directory and selected commit in the built and unpacked identity before installing; mismatches,
missing/malformed identities and stale cached provenance refuse with `DEV_RELEASE_IDENTITY_MISMATCH`. release.json records
`sourceCommonDir`; old identity readers accept the additive origin marker. The producer and host-kit candidate have targeted
author evidence (fake repository staging); delivered as one lane commit `03d8807a` (the lead applied the sandbox patch), Fable 5.1 bounded
PASS 2026-10-03. Landing and real deployed proof (a real stage + a live/N1 turn) remain open. Lead checkpoints: external
`proof/SELF-SOURCE-FLOOR-2026-10-03/review.md`, `revise-1/review.md` (Fable R1 PASS `08eb1d6c`) and `proof/DEV-RELEASE-SOURCE-ORIGIN-2026-10-03/review.md`.

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
the vocabulary gains `agent-tool-call`. Not yet: the card scopes + decision field on protocol v17 (introduced by MODES-3; MCP has no approval decision tool), the
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
  Owner reading 2026-10-01 (D6 A, Jev a83a35a5): the adapter-shipped `models.json`/`pricing.json` become dated seeds of
  the ledger v43 DB model catalog, which adapters read; the literal lint also scans `src/**/*.json` with the seed files
  allow-listed and closes the `claude-[0-9]` regex gap (today it walks `.ts` only; PLAN CATALOG-SEED, not yet implemented).
  `NATIVE_CLI_CHANNELS` (`claude`/`codex`/`cursor`) names native CLI protocol kinds, not model identities, and stays a code constant.
- HARDCODE-RATCHET (owner 2026-10-02): `scripts/lint-arch.mjs` owns G1 vendor/CLI slug comparisons,
  switch/array/Set membership and object keys; G2 operational numeric names and timer arguments;
  G3 direct emit/render/error text, render/label/format returns and JSX text; G4 numeric/string config
  defaults in the consumer units declared by the shared `collectConfigBindings` metadata projection; values of
  protocol version properties (`schemaVersion`, `encodingVersion`, through as/satisfies/parentheses) are versioned
  wire contracts, not default copies (batch-27 integration 2026-10-03; 15 such admitted G4 rows retired as stale).
  `arch.json.hardcodeRatchet` owns slug vocabulary, exact vendor-unit/reason exemptions, exact registry files
  and symbol/value/reason invariants. JSON assets are data; config-field and resolved registered schemas
  are declarations. Small arithmetic constants and array indexes are ignored. No runtime initialization is run.
  Existing debt is frozen in `scripts/hardcode-allowlist.json`: file + SHA-256 of class, enclosing symbols,
  normalized literal, parent kind, config field (G4), and duplicate occurrence ordinal; never a line number.
  Frozen membership hashes reject additions and equal-count swaps. Every list-changing version on HEAD's full
  first-parent history (including merge changes and list deletions) constrains the working list: per
  (fingerprint, rule) the current entry count may not exceed its count in any prior admitted version.
  AB-R1 (owner 2026-10-03; Sol 2259 bounded PASS on the delta; live in `dfb1b68f`): count-only history at `a82a89cb` loses removed
  claims when another admitted file shares the fingerprint/rule. History now also preserves
  each normalized admission identity `(origin ?? file, fingerprint, rule)` in EVERY prior list version;
  removal is final even if another claim in that group remains. Relocation keeps that identity.
  The fingerprint is file-independent; `file` records the current location.
  A moved entry updates `file` and names its admission file in `origin`; frozen membership is checked against
  that admission identity, each frozen identity claimable once, and `origin` must differ from `file`. A move
  keeps the count; a copy grows it (unlisted finding, duplicate claim or history count failure). Lineage is
  claimed in the list itself, so moves also verify in exports/shallow CI checkouts against frozen membership.
  Limit: without an intervening committed claim removal, a fix plus the same symbol/literal/ordinal
  elsewhere claiming the same origin is indistinguishable from a move; committed removals must be refused.
  Missing source occurrences fail as stale allowances; deletion prints the admission delta. Source exports,
  shallow repositories and unreadable history emit `[hardcode-history-unavailable]` warnings in both CLI modes:
  frozen membership remains enforced, but historical shrink is not proven (warning alone does not change exit status).
  Initial admission is exactly the detector inventory of base `19a6bb42`: 514 identities (G1 97 / G2 362 / G3 29 / G4 26).
  Lead Jev `5e061ec1` admits the two pre-existing shorthand names (`docker` profile, text `cursor`) exposed by HR-R2,
  with per-entry reasons; identity hashes exclude that reason metadata. This corrects the first list before the single
  introduction commit, not post-admission growth. With valid HEAD and no list versions, frozen/inventory checks apply
  without a prior membership constraint; one committed list version is admission and already constrains growth.
  The regression compares the FIRST list version (working list before introduction) to the archived base inventory
  produced by the admission commit's own detector, and requires the current detector's base inventory to be a subset
  (later narrowing only retires identities), not a later cleanup list; that historical assertion explicitly skips
  source exports/shallow checkouts (no proof).
  Unmerged/non-first-parent branch removals, rewritten history
  and renamed policy paths are outside this history proof. Changes to policy/frozen membership require review,
  not regeneration to hide debt. G1 climbs parenthesized/as/type-assertion/satisfies/non-null expression wrappers
  and recognizes shorthand object keys; typed registry property reads and type references remain outside slug use.
  `--hardcode-inventory` reports candidates without writing allowances; `--hardcode-only` runs the same scanner/gate
  for fixtures. Syntax heuristics are not full dataflow: transitive consumers, indirect rendered text, unnamed policy
  arithmetic and native C are documented gaps. Audit mapping and measured scope live in external
  `proof/HARDCODE-RATCHET-2026-10-02/`; cleanup remains HARDCODE-P1 and later work, not acceptance of debt.
- Markdown (owner 2026-10-01, D3 A, Jev b415a37c; confirms the 2026-09-16 decision): the product writes no host rule files —
  no `DECKENT.md` and no section in `CLAUDE.md`/`AGENTS.md`; product guidance reaches users through stdout and MCP, worker
  instructions through each CLI's native channel. The earlier target (one docs-authority writer `arch.json`
  `markdown.writerModule` for those files, W0-9) is withdrawn; that `arch.json` entry, the matching `lint-arch` exception and the
  leftover `sync.*` texts are still present until PLAN HOST-RULES-CLEANUP. lint-arch `md-write` enforces the rule, so today no
  product code writes markdown, and no README/CHANGELOG/vision/sprint-log writers exist.
- Platform order (owner 2026-09-29): Linux and Windows WSL2 today; macOS next (Seatbelt + getpeereid), then
  native Windows. Docker stays a worker execution target, not a host platform. A platform without proof reports
  a typed `UNSUPPORTED`/`DEGRADED`, never a silent fallback. Node.js: `engines >=24.15.0` (the first 24.x bundling
  SQLite 3.51.3, the WAL-reset corruption fix); 24 and 26 are supported (CI matrix [24, 26]; owner 2026-10-03 requires all six hosted cells;
  Node 26 is the planned default after LTS on 2026-10-28). Every `node:sqlite` open (the ledger connection, the read-only readers, the scope
  registry reader and the upgrade backup: 10 sites) first refuses an engine below 3.51.3 with the typed
  `ATTEMPT_STORE_SQLITE_UNSUPPORTED` (DEPS-P0, numeric comparison; an unparsable version is refused).
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
runtime service, the terminal start contract and native addon per supported Node. Terminal contract (PACK-SMOKE, 2026-09-30; texts from the shipped
catalogs): a TTY `deckent` opens the workline (banner, status `Ready`, composer placeholder, no line-mode prompt; Ctrl+C twice exits 0); piped
`deckent terminal` is refused with `TERMINAL_TTY_REQUIRED` (exit 2); `deckent terminal session` on a TTY shows the line-mode banner and prompt
(`deckent> ` / tr `deckent› `), piped it shows neither. A fast subset (build-dist into a temporary directory + pack-smoke `--root`
version/mcp/native/lazy/imports/terminal, `tests/contracts/tooling/pack-smoke-dist.test.ts`) runs inside `npm run verify` on Linux and fails on any
publish blocker except host bubblewrap staging and on an unused locked license text; the tarball install path, runtime/client checks and `--types`
stay release gates. Components whose installed copy ships no license text (today `yoga-layout@3.2.1`, `content-type@1.0.5`) take it only from
`packaging/licenses/licenses.lock.json`: byte copies of a named upstream artifact for that exact name@version and SPDX id, sha256-checked at build;
an altered, missing or escaping text is a blocker. Publication is gated by `summary.json publishable` (blockers empty at PACK-SMOKE `1cd52ad1` with
the staged bubblewrap); the remaining publication item is the owner's LICENSE addendum/NOTICE decision. Core is Apache-2.0 (DEPS-P0: the full
apache.org LICENSE-2.0 text at the root, `package.json` `license`); no NOTICE file yet.
Declarations (DEPS-TYPES, tenth batch): `scripts/dist-types.mjs` ships the declaration closure TypeScript loads from `dist/index.d.ts` under
NodeNext and under Bundler (a specifier resolving differently in the two, not resolving, a non-node `/// <reference types>`, or a
`declare module '…'` in vendored types fails the build). Own declarations keep the tsc layout; third-party declarations are copied to
`dist/vendor/types/<name>@<version>/<path>` with their package `type`, and bare specifiers are rewritten to relative paths with the
format-preserving extension (`.d.cts`→`.cjs`, `.d.mts`→`.mjs`). Only `node:` built-ins stay external (the consumer's `@types/node`). Release
gate: `smoke:dist --types` over TypeScript 5.9/6.0(/7.0) × NodeNext/Bundler with `skipLibCheck: false` and a consumer that uses values,
derived types (proved non-`any` with `@ts-expect-error`) and a hand-written Standard Schema. `pathApi` has an explicit `node:path` return type so
published declarations never name a bare `path` (PACK-SMOKE, after the BWRAP-SELECT regression).
**Bundled bubblewrap (BWRAP-SELECT, owner S4/S5 2026-09-29, eleventh batch).** The package ships the bundled bubblewrap of the lock's
`shipArches` (today x86_64) under `dist/adapters/core/shell-sandbox-bwrap/bundled/` with `NOTICE-bubblewrap.txt`, `licenses/` and `source/`
(the 0.13.0 tarball, `build.sh`, `bwrap.lock.json`: LGPL-2.1 §4 corresponding source, owner S4). `build-dist --bwrap <build-bwrap output>`
stages it; a bundle that is not exactly the locked build is a `publishable` blocker. The SBOM lists it as
`pkg:generic/bubblewrap@0.13.0?download_url=…&checksum=sha256:…` (application, binary SHA-256, source-distribution reference) with the
statically linked `pkg:apk/alpine/{musl,libcap,gcc}` nested; THIRD-PARTY-NOTICES carries its notice. The binary is built in CI
(`.github/workflows/bwrap-bundle.yml`, check mode), never committed, never downloaded at install (owner S5).
Hosted evidence at `76582f9f` (2026-10-01, [run 36884716254](https://github.com/Verhex/deckent-next/actions/runs/36884716254)):
x86_64/aarch64 build checks and the x86_64 launcher/realm job succeeded; the real arm64 realm job was skipped. This is not an
arm64 runtime or full-matrix PASS (main CI run 36884716187: Linux 24/26 success, macOS advisory cells failed). deps-watch reads
`containers/bubblewrap` GitHub security advisories against the bundled version and the minimum system version.
**SDK surface (DEPS-TYPES, owner 2026-09-29 DEPS-SCHEMA C2-b).** `src/index.ts` is an explicit export list; no layer barrel is re-exported
wholesale. The reviewed inventory `tests/contracts/composition/sdk-public-exports.json` (TypeScript checker over `src/index.ts`, names with
value/type kind) is the contract; a change needs `node scripts/sdk-exports.mjs --write` and, for a removal, a CHANGELOG BREAKING line. Live
schema-library objects are never SDK values: callers get derived data types and Standard Schema contracts, not zod objects. Open:
`registerConfigSection` still takes a zod object (C1) — in the zero-dependency package a consumer's own zod schema is refused both by the type
checker (vendored zod types are nominally distinct: private `_cached`) and at runtime (`instanceof` against the bundled zod), so third-party
config sections wait for C1.

## Testing policy

- `tests/contracts/<package>/` — public API and invariant tests only; no internal-function tests.
- `tests/e2e/` — real binary journeys (`doctor`, `run`, `start`, `do`, …) on fixture projects under `tests/fixtures/`.
  Current state 2026-10-01: `tests/e2e/` holds `cli-version`, `i18n-renderer`, `kernel-config`, `product-paths`; there is no
  `start` or `do` command yet and no `tests/golden/` directory.
- `tests/golden/` — normalized outputs of deterministic commands, captured from the legacy binary and
  diffed against the new one during the port.
- Budget: ≤ 8,000 test cases total, every test file ≤ 1,500 lines (lint; 800 design target). Legacy invariant titles are in
  `tests/contracts/HARVEST.json`; each port card lists which titles it honours.

## Documents

The Markdown gate admits the five product/roadmap documents `README.md`, `ARCHITECTURE.md`, `PLAN.md`,
`COMPLETED-PLAN.md`, `CHANGELOG.md`, plus owner-admitted repository standards (2026-10-03): `README.tr.md`,
`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/PULL_REQUEST_TEMPLATE.md`,
`.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`;
≤70-line permanent product-development contracts `CLAUDE.md`, `AGENTS.md`;
≤5-line pointer `.codex/AGENTS.md`; `.deckent/docs/core-memory/*.md`;
and the explicit refactor host-kit globs in `arch.json`: the remaining 20 `.agents/skills/<skill>`
directories/references plus `.claude/agents`, `.claude/rules`, `.codex/rules`.
The host kit is excluded from product distribution (`package.json files`: dist/native/assets/README/LICENSE).
Product code still writes no Markdown; owner-maintained host instructions are a development-only exception.
Repository standards are human/host-maintained files; Markdown admission does not extend product write authority.
The existing `markdown.writerModule` gate is unchanged. `.github/CODEOWNERS` and issue `config.yml` are
non-Markdown community configuration; GitHub settings, actual review and private reporting availability
remain separate proof. Node/pre-release badges read public main package metadata; npm badges stay commented
until the first verified publish. The alpha.4 status remains the recorded release, not a fresh live check.
Owner 2026-10-02: `deckent-next-refactor` retains its name as the shared entry guide for owner-admitted
Next development, fixes, refactoring, reviews and handoffs. Codex, Claude and Cursor resolve this skill
to the same `.agents/skills/deckent-next-refactor` source; specialist skills supply task-specific methods.
Jev details live in the skill's `jev-workflow.md`, read before case preparation or consultation.
Shared content does not prove identical host activation or grant work/runtime authority.
Owner 2026-10-02: `deckent-authority-bootstrap` remains a separate read-only Next authority/context
snapshot, refreshed on relevant changes. It checks scope and work ownership; runtime inspection is
task-dependent. A reported HOLD neither mutates product state nor blocks unrelated admitted work.
Owner 2026-10-02: `deckent-readonly-audit` remains a separate bounded Next investigation. It follows
actual wiring and distinguishes source evidence, retained execution proof and current observations.
Audit findings admit no work; tests, fixes and document/state changes are separate authorized actions.
Owner 2026-10-02: the standalone `deckent-outcome-ordering` skill is retired; owner-requested ordering
principles live in `deckent-next-refactor`. Accepted order and execution admission remain separate.
The original files are retained outside skill discovery; `.agents/refactor/migration.json` remains
historical migration evidence, not the current active skill catalog.
Owner-delegated 2026-10-02: the remaining 19 skills were individually compared with logged Jev;
17 specialist entries retain distinct responsibilities with corrected Next instructions. Session
handoff principles move into the common guide; the unsupported standalone versioned-handoff
protocol and out-of-scope generic design-system package leave active discovery, with originals
retained outside Git/npm. Planning, authorized parallel coordination, observation, recovery and
completion assessment remain separate roles over actual Next contracts. Design guidance preserves
accepted Desktop/Terminal direction and distinguishes target surfaces from implemented consumers;
critic self-review cannot claim independent PASS. Token guidance describes the actual Terminal map,
writing palette builder and output, without a nonexistent check mode or cross-surface generator.
These are host instruction decisions within delegated scope, not product authority or implementation.
Design reasoning goes into the decision log below, not arbitrary new documents.
Owner 2026-09-21: `follow-up-works/current-flow.md` is an optional, replaceable development tracker;
its exact path is admitted by the Markdown gate, excluded from product distribution, and may be deleted.
Owner 2026-10-03: it is a pointer only; who holds what and what comes next live on the host process board
(`.deckent/host/process-board.json`, outside Git/npm, written through `.agents/refactor/board.mjs`), and review
packages cite the board and PLAN as status source. The board is coordination data: no authority, PASS or liveness.
PLAN.md retains durable roadmap/decisions, remaining work and material open findings; owner 2026-09-24: completed work
and closed findings move to COMPLETED-PLAN.md (read only when history is needed), so PLAN stays short. Small work/history
lives in the external refactor proof area (kept until the batch lands and its review closes), not an append-only product plan.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-03 | REPO-STANDARDS: owner admits `README.tr.md` in `markdown.trackedAllow`; no product writer. | Turkish README mirrors current English product facts without widening runtime claims. |
| 2026-10-03 | REPO-STANDARDS: owner admits `CONTRIBUTING.md` in `markdown.trackedAllow`; no product writer. | Contributor entry, checks, attribution and human/host worker PR boundaries need a public guide. |
| 2026-10-03 | REPO-STANDARDS: owner admits `CODE_OF_CONDUCT.md` in `markdown.trackedAllow`; no product writer. | Owner-selected Contributor Covenant 2.1 supplies community behavior and enforcement guidance. |
| 2026-10-03 | REPO-STANDARDS: owner admits `SECURITY.md` in `markdown.trackedAllow`; no product writer. | Core security scope, current main/alpha support and conditional private reporting need a public policy. |
| 2026-10-03 | REPO-STANDARDS: owner admits `.github/PULL_REQUEST_TEMPLATE.md` in `markdown.trackedAllow`; no product writer. | Every human/worker PR needs card, exact checks, independent review, risks and DOGFOOD/live evidence. |
| 2026-10-03 | REPO-STANDARDS: owner admits `.github/ISSUE_TEMPLATE/bug_report.md` in `markdown.trackedAllow`; no product writer. | Reproducible Core bugs need structured version/surface/reproduction evidence and a security redirect. |
| 2026-10-03 | REPO-STANDARDS: owner admits `.github/ISSUE_TEMPLATE/feature_request.md` in `markdown.trackedAllow`; no product writer. | Feature proposals need user outcome, alternatives, proof and owner admission boundaries. |
| 2026-10-03 | WORKER-GIT-PR: delivered patch becomes `lane/<card>-<runId>` via lead host tooling; only host credentials push/open PR, template filled from the final report, existing `pull_request` CI, lead landing after independent review + targeted checks. Proposed `.agents/refactor/pr.mjs open <patch-dir> --card <id>` stays unimplemented in this lane. | Owner morning direction: human and worker PR workflow; owner test planned for 2026-10-04. Branch/PR publication requires its own authority; no Git credentials in worker containers and no change to product patch custody. |
| 2026-10-03 | SELF-SOURCE-FLOOR A2: owner 2026-10-01 narrowing (a/b/c), implemented in the D4 night 2026-10-03; R1 correction 2026-10-03: derive only from canonical Git common-directory equality; full-access remains unchanged; static hard floor stays `edit-floor` (never session/standing), shell protected names stay static unchanged; `edit-self-source` permits session answers internally but refuses persisted standing grants (`cell-not-standing`). Optional build identity field and cell/i18n vocabulary only; no configuration, ledger, policy schema or protocol change. A1 waits for U2-1. R1 implementation is Fable 5.1 bounded PASS on R1 `08eb1d6c` (2026-10-03). | A scoped source floor must not claim session support or S1 closure from injected-memory tests. New wire/provenance authority needs the lead's owner checkpoint. |
| 2026-10-03 | Development process order (owner; design by Astra PROCESS-SIMPLICITY, channel 2257; implemented as host tooling `.agents/refactor/board.mjs` + test, lead Jev 249e0d3b `bundle_design_literal` 0.98/0.76): one JSON process board in the host area, role rows (main, review, analysis, parallel-N); a session writes only its own row keyed by slot + its session id (unassigned rows claimable, mismatch refused, no lock stealing, stale revision refused with the current revision); main reconciles the role map, mirrors the owner's dogfood decision with its source and lists short-lived workers as a sub-list of its own row (same rule inside Deckent dogfood). Decisions: (1) HTML over localhost, Claude Artifact only on owner request; (2) workers as main sub-list; (3) external proof kept until the batch lands on main and its review closes, then pruned; (4) review packages use board + PLAN as status source, current-flow is a pointer; (5) main notifies the owner only when the owner must act, ≤2 lines, no interim/worker pings (Jev 120bf0ab 0.96/0.64 below threshold → owner chose); (6) these rules live in this log, core-memory law 4 and the shared skill, Astra's current-flow block merged and removed (Jev 58921655 0.98/0.72 → owner chose); (7) session map confirmed: main = Claude session (channel `opus`), Sol = GPT-6.1 on `astra`, analysis session closed, Fable sub-agents are not sessions, Codex exec workers are per-worktree. Owner output format: result/impact → evidence/open limit → decision if any → who holds it / next. Release rule: every live release bumps `1.0.0-alpha.N`, CHANGELOG one line per release (alpha.3 = `246b1056`). | Measured on 2026-10-02: six current-flow merge conflicts across batches; 51 commits touched current-flow since 2026-09-30, 30 of them docs-only; repeated reading/narration and archive growth. The board is coordination data only; speed/token gains are unmeasured until a batch runs on it. |
| 2026-10-03 | Morning decisions (owner, ~05:30Z): (1) batch 28 is pushed after the clean full verify and Sol PASS, and the lead prepares the 1.0.0-alpha.4 release commit + stage (the live switch stays the owner's command); (2) the owner launches the AOF-HANDOFF Codex lane himself (`proof/AOF-HANDOFF-2026-10-03/launch.sh`; the host classifier denied the lead's launch); (3) SELF-SOURCE-FLOOR S1-1 is admitted as a PERSISTENT-APPROVALS slice: the 'this session' answer for `edit-self-source` is wired terminal → service (new wire field + protocol bump allowed in that slice only); (4) MONITOR-HUMAN starts now as small dogfood cards (first: worker log/result/usage view). Process correction (owner): full verify is ONE run per batch on the final candidate — the night ran it on a premature candidate and once on a mislabeled dirty tree; owner output stays short in the owner format, long HTML only on request. | Owner review of the night run 2026-10-03. |
| 2026-10-03 | Dogfood mode (owner, after lead Jev add39bdc `d4_trials_parallel_gates` 0.98/0.75; speed_fit 0.53 unmeasured): development continues as bounded **D4 trials** in the isolated N1 installation through the K7 bridge — small real cards (first DEV-RELEASE-SAME-VERSION, then HARDCODE-P1 sub-groups), lead reviews every patch, host full verify + independent review stay the landing gate — while the S1 gate code (SELF-SOURCE-FLOOR, EXEC-RELEASE C1–C3, slice 3) is built in parallel lanes and the owner applies live grants when asked. DOGFOOD stays officially OFF; official S1 ON is a separate owner decision after the gates are live and the D4 measurements (worker time, lead time, acceptance rate per card) exist. | Owner asked "can we continue with dogfooding?"; packaged native worker proven in N1 (`probe-packaged-aa58`), D2/D3 cards adopted, but live grants, self-source floor, exclusion-free verify and written recovery are missing. |
| 2026-10-03 | Wave 6 owner decisions (logged Jev; `proof/WAVE6-2026-10-03/README.md` §10; WorkClass reasoning-policy source candidate in WORKER-EFFORT, other listed decisions not implemented): WorkClass is a separate versioned registry (small Core list + Enterprise overlay), `task.kind` stays the template key and kind → class is data; a worker's need for human input ends the attempt with a typed `needs-input`, which becomes a new reason of the A3 live human-decision wait (no live question channel; the answer starts a new attempt); latency targets now, regression gates after a measured baseline — **event → human surface 500 ms p95** (C18-O1); a live Run park gets an "operator hold" reason (`run resume` continues the same Run); acceptance with open criteria deferred (strict acceptance and Run `incomplete` stay); **Deckent has its own computer-use mechanism** (Cowork-like; owner override, a definite target; vendor CU only as an adapter; design card inside B1, hard floor and sandbox limits); no competitor/source-intelligence module and no doc-health capability (owner triggers such analyses manually); Gemini CLI channel, D_REF and memory projection deferred (Gemini CLI replaced by closed-source Antigravity CLI per secondary sources, verify officially when the card opens); Windows shell tool deferred but first when platform acceptance opens; Discord deferred and handled together with Slack. Lead wave-6 decisions (28, `lead-decisions.json`): seven at threshold (HOSTMCP print-and-detect, WIRING-GATE host reachability gate in `scripts/`, CI-REPORT, DEADLINE fixed in profile, MCP-PUSH snapshot tool then subscription, PATCH-BINARY on trigger, READONLY-TASK in the kind registry enforced by K6), 21 safest reversible, K-LATENCY-METRICS first. Thirteen verified Next defects persisting at `848c8050` are card inputs (PLAN NEXT-DEFECTS-W6). | Dev↔Next analysis waves 0–6 closed; owner: "no undocumented process remains". Decisions are accepted targets, not implementation. |
| 2026-10-03 | Hosted CI is a signal (owner, after lead Jev f8a860db `all6_required_plus_ruleset` 0.78 < 0.90 → owner chose it): every `ci.yml` cell (ubuntu/macOS/Windows × Node 24/26) is required — no `continue-on-error`, names `required verify (<os>, node <N>)`; after the CI-FIX landing and one hosted run on the exact SHA the owner adds a `main` branch ruleset requiring the six checks (deletion/force-push blocked; repository-admin bypass for the lead's reviewed pushes until WORKER-GIT-PR). A red badge means a real failing cell. Security and conduct reports go through GitHub private vulnerability reporting. Proof `proof/CI-REQUIRED-2026-10-03/`, `proof/CI-FIX-2026-10-03/` (Fable PASS c0a3f77e). | owner |
| 2026-10-03 | Parallel orchestration (owner; Jev D1 0.61, D2 0.78, D3 0.96, D4 0.76, sufficiency < 0.75 → owner chose): (D1) large plans enter as one Run with a task DAG and per-task `workInput` — not one Run per card; code-dependent edges need AOF-HANDOFF (code inheritance, G1); (D2) accepted patches land through a serialized landing train — rebase/3-way onto the current tip, re-verify, fenced adopt, typed conflict → repair task, reusing the integration/delivery/adoption owners (G2); (D3) isolation path Docker with 1 CPU per coding worker now → gVisor measured next → Firecracker only after kvm access and measured boot/restore/workspace cost, as an added adapter behind `ExecutionSupervisor` via an adapter registry (floor never loosened); (D4) one global human status projection queued/running/checking/held(always with waitingOn, reason, since, deadline, nextAction)/done/stopped (EN/TR) over existing domain states, verbs continue/hold/deliver/accept/cancel map to existing operations. Worker count on the local host (D5) is decided after the 8-way measurement; it is not a product ceiling. Proof `proof/ORCHESTRATION-2026-10-03/`. | owner |
| 2026-10-03 | D5 local worker count (owner, after measured waves W1–W5 on N1: 16 × 1 CPU accepted 16/16 in 2 min 48 s, host CPU peak 82 %, ~1 GB per worker): on this development host 8 parallel workers is already very good throughput and 16 × 1 CPU is proven; N1 keeps the 16-slot pool; going beyond 16 is a later measured test (needs WSL processors 32 / more memory and a planned `wsl --shutdown`). Local host bound only, not a product ceiling. Proof `proof/DOGFOOD-D4-2026-10-03/README.md`, `.deckent/host/measurements/2026-10-03.jsonl`. | owner |
| 2026-10-03 | TERMINAL-CLOSE O1–O7 (owner, Jev below thresholds; `proof/NEXT-WORK-DECISIONS-2026-10-03`): O1 canonical carry lives in a versioned structured session/turn context (intent/reference/summary separate, service-owned, replay-pinned), not a tagged message envelope; O2 project-instruction loading stays deferred — an interim terminal correctness delivery may be accepted, full TERMINAL-CLOSE stays open until it is reopened after MODEL-INGRESS+B8; O3 plan mode = read-only workload + versioned RunProposal, subagents through existing Task/Attempt (one authority/cancel path, no raw spawn engine); O4 inline default + optional fullscreen on the same state/typed ports, plain screen-reader adapter; O5 conversation fork first, selective rewind only for verified Deckent file-effect checkpoints (no claim to undo shell/network effects; restore is a new authorised effect, audit kept); O6 acceptance = local long session first, then native Anthropic + one OpenAI-compatible provider on the same scenarios; O7 terminal closes with the shared input/event/session/approval port + host test panel, the real Desktop panel is accepted in DESKTOP-ARCH. | owner |
| 2026-10-03 | DESKTOP-ARCH D1–D7 (owner; Electron direction reopened; `proof/DESKTOP-ARCH-2026-10-03/analysis.md`, `proof/NEXT-WORK-DECISIONS-2026-10-03`): Desktop is a full-scope Codex/Claude Code desktop-class application (chat, managed terminal, work/worker management, approvals, monitor), not a simple client; engine, ledger and all authority stay in the separate runtime service. D1 carrier not chosen: Electron 44 and Tauri 2 are measured on the same workload first; D2 first platform Windows UI + WSL connector (Linux identity is never presented as the Windows human); D3 transport re-proposed after current Codex app-server / Claude desktop architecture research (no renderer credentials stays an invariant); D4 first useful slice = managed terminal with monitor context; D5 connect-only first, governed autostart later, closing the UI never stops the service; D6 managed signed OS packages first (MSI/MSIX, notarised macOS, signed Linux repo), personal self-update later; D7 resource budgets only after the D1 measurement. | owner |
| 2026-10-03 | DESKTOP-ARCH-R2 D3/N1/N2 (owner, after research of current Codex app-server JSON-RPC stdio/unix socket and Claude Agent SDK CLI-subprocess stdio; `proof/DESKTOP-ARCH-R2-2026-10-03/analysis.md`): D3 Desktop uses the existing Deckent typed service protocol + a Windows↔WSL connector (one contract with terminal/MCP; the service grows session history, monitor, worker detail and a shared subscription); a JSON-RPC facade may later sit over the same contract, never as a second contract. N1 the Windows human binds to the WSL service through admitted enrollment + broker key challenge-response; Windows principal and Linux execution principal stay separate in audit, scoped by service policy and an attestation registry; a same-UID helper is never labelled the Windows human. N2 first slice keeps explicit cancel/unknown + durable session history when the UI closes or disconnects; service-owned detach/attach with cursor replay and one controller lease per session comes later; UI close never stops the service or Runs. | owner |
| 2026-10-03 | MONITOR-HUMAN design M1–M3 (owner; `proof/MONITOR-HUMAN-DESIGN-2026-10-03/design.md`, reader = human): M1 human title from existing task text (honest fallback) + optional short title on new work input; M2 per-worker start/end samples bound to the exact worker identity, profile/host/worker/usage kept separate, unknown never shown as zero; M3 monitor load measurement starts with real N1 small samples at 8/16 workers, large synthetic history later. First slice H1 (what the worker did / result / usage) as an N1 dogfood card. | owner |
| 2026-10-02 | Speed and security are both inviolable (owner): the control path advances in milliseconds; no human or agent ever enters a disconnected, ownerless or unbounded wait — every wait has an owner, a visible state, a timeout and a next action; the security floor is never relaxed for speed, and no asynchronous or precomputable step is made blocking for security; event or push is preferred over polling on the control path. Targets carry "target, unmeasured" until measured; measured legacy behaviour becomes a negative test. | Legacy was deterministic but slow (minute-scale waits, 10 s approval announcement, 2 s full scans); owner statement 2026-10-02, recorded in core-memory law 5. |
| 2026-10-02 | Worker resources for dogfood (owner): N1 pool 8 execution/in-flight slots; native card profiles capped at 2 GB memory (were 4 GB). Lead kept the sandbox verify profile at 3 GB because a full-suite verify was already killed (exit 137) at 3 GB. Values live in the N1 config (backed up); the durable installation ceiling is CONFIG-SURFACE `execution.docker` (profiles above it are refused, never clamped). | Owner: workers must not take 4 GB; more parallel workers. Measured: 35 GB host, 8 × 2 GB worst case 16 GB. |
| 2026-10-02 | A3 awaiting-decision exit (lead, Jev a8e582fe `typed_return_on_new_evidence` 0.98/0.76 after one revision): a task awaiting a human decision returns to evaluation only with NEW attempt-bound evidence (recovered output digest or a verified seal absent at park time); the park deadline is kept; evidence-less re-evaluation stays refused; triggered by `deckent task evaluate` / SDK, not automatically. | Fable review: the lane had made verified seals unusable and labelled verified work model-unverified, inverting the earlier HOLD-is-recoverable behaviour. |
| 2026-10-02 | Agent OS foundations order (owner, Jev e2b81339 `ratchet_first_then_foundations_parallel` 0.99/0.75): HARDCODE-RATCHET first (lint fails on new hardcoded mutable policy; existing findings in a shrink-only allowlist), HARDCODE-P1 after CONFIG-SURFACE S1–S2, then AOF-HANDOFF after A1/A3, AOF-REPAIR ∥ AOF-CROSS-VERIFY, AOF-DECISION-PORT in parallel now, AOF-WORKER-DECIDE last (worker Jev modes off/advisory/required as policy data; a Jev selection never grants authority). | Read-only audits: ~173 hardcode violation groups (19 P1) and legacy-vs-Next gaps (handoff, durable repair lineage, independent cross-verify, no worker Jev in legacy); `proof/HARDCODE-AUDIT-2026-10-02/`, `proof/AGENT-OS-FOUNDATIONS-2026-10-02/`. |
| 2026-10-02 | CONFIG-SURFACE (owner, Jev d4e2016d `registry_driven_surface_plus_binding_ratchet` 0.99/0.77): one registry-derived config application (inspect/explain/validate/set/unset with source layer, binding state, apply mode; validated atomic write, versioned backup, audit, policy-authorized), a binding ratchet (no new field without a consumer), `max_workers` and `execution.docker` as installation ceilings, grouped `deckent config`, terminal `/config`, monitor Config view; vLLM provider rename and Qwen catalog cleanup through product commands run by the owner. | Legacy config really controlled behaviour; Next had only raw `config get` and five fields with no consumer. |
| 2026-10-02 | Model catalog channel = client × billing/access path (owner, Jev f2481b8c 0.98): rows keyed (channelId, exact channel model id), linked across channels by vendorId + canonicalModelId, aliases only refused; `claude-cli-subscription` (opus/sonnet/fable recommended active, haiku not) and new `codex-cli-subscription` (gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol active; gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 passive; hidden models excluded). Implemented as CATALOG-V3. | Owner: a Bedrock opus must never be confused with the subscription opus; detailed standard metadata. |
| 2026-10-02 | LONG-LIVED-AGENTS is a card (owner): the target is continuously living agents without a time limit, but the current 20-minute worker deadline stays for now. MCP-NO-DECIDE (owner): MCP offers no approval decision at all (amendment at the top of this file). MONITOR (owner mandate): a human-centred live monitoring surface inside the main `deckent` (no side scripts); shipped and live. | Owner directions of the day. |
| 2026-10-01 | I18N-ORPHANS (owner ~20:20Z, harvest option B accepted; `proof/WAVE5-2026-10-01/OWNER-DECISIONS.md`, input `next-graph/deep-harvest/wave5/I18N-ORPHANS.md`): **amends the 2026-09-16 K2 row** "3,374 retained and 607 excluded" (that row stays as history, with a dated pointer). T0 — `tui.*` 347, `sync.*` + `mcp.sync.detail` 41, the D2 `DECKENT_E*` texts 397, three dead codes outside D2 (`INVALID_RUN_ID`, `INVALID_PHASE`, `CONFIG_ALIAS_CONFLICT`) and seven Next-origin company leftovers — leaves in the same batch as D2/D3 (PLAN LEGACY-CODES-RETIRE, HOST-RULES-CLEANUP). T1 (2,010 legacy entries with no PLAN target or rewritten under Next's own keys) and T2 (890 entries of future capabilities to be redesigned: memory, channel/gateway/API, Desktop/Dashboard, Mission, Nervous, cross-verify) move with their en+tr text to a `proof/<card>/i18n-retired-entries.json` archive and leave the catalog; the oracle hash of the protected keys does not change. Then an `i18n-unused`/`i18n-unused-stale` ratchet lint starts from an empty baseline with a six-key allow list, plus a slash-label coverage test. Order: the D2/D3 batch → before A04-3/locale packs → before the first publish. Accepted target; not implemented. | The 3,374 set was a migration reachability set from legacy `src`, not Next's need set; 3,299 of 4,660 keys have no static literal consumer (harvest measurement, not re-run by the lead). The archive keeps the text as translation memory for redesigned surfaces without shipping dead catalog entries. |
| 2026-10-01 | Wave 5 owner decisions (owner to the analysis session ~20:05Z; `proof/WAVE5-2026-10-01/OWNER-DECISIONS.md`, harvest `next-graph/deep-harvest/wave5/`): (1) **full TUI acceptance includes everything** — TC-0…TC-7 plus plan mode, subagents, fullscreen and rewind/fork (Jev `tc0_to_tc7_measured` 3fc3ce86 0.93/0.62 was widened, not narrowed); the TC order `correctness_first` is a lead record (eb0cadf6 0.98/0.72, below sufficiency → safest reversible), not an owner decision; (2) project instruction files (AGENTS.md/CLAUDE.md/DECKENT.md) entering the agent context are **deferred** (`defer_project_instructions`, the safe fallback; Jev `read_as_untrusted_context` 962aad39 0.79/0.69 was not accepted); (3) the S-API order A0 RUNTIME-WITNESS → S-API-LOCAL → S-STREAM-HTTP → DASHBOARD-READ is accepted, and a WebSocket path is to be considered for enterprise surfaces (a direction to evaluate, not a decision to add WS); (4) IFS-E2E is long-range, no decision; until access exists, Core gaps use the `test.erp` mock (harvest option A); (5) the existing Telegram channel is reconnected first, with the deckent-dev settings (bot, pairing) as a read-only source and the legacy runtime never run; (6) memory must learn and improve itself — learning is automatic but inside B1, the hard floor, provenance and reversibility; the design is settled with Jev. Accepted targets; none implemented. | Recorded findings that bind these targets: F1 — non-secret runtime Run/Task operations take the principal from the service process (`readLocalOsIdentity()`), not the peer (`composition/core/runtime-service/internal/server.ts:183-185` → `scoped-request/internal/context.ts:12-14` at `a2971850`); not exploitable today because the socket requires the same UID (`local-runtime-socket/internal/peer.ts:26`), but it becomes identity laundering on HTTP, so A0 closes it before any HTTP binding. G4 — the compaction contract below (Automatic compaction, T-L5b) does not hold in the second generation (note there). The gateway dependency on B1 (v19), W3 CHAN and the A7 outbox retention is the harvest's analysis, not owner text. |
| 2026-10-01 | DOGFOOD stages (owner accepted `staged_refresh_then_gates`, Jev 229b551c 1.00/0.78; audit `proof/DOGFOOD-READINESS-2026-10-01/audit.md`): S0 = isolated N1 + the K7 bridge, the lead reviews patches, host full verify + Sol gate, starting after N1's base and the bridge build are refreshed to the reviewed current release (N1-only ledger v43→v44); S1 = official DOGFOOD ON (the live installation opens Runs on a work target, owner in control) after B1 + A1/A3 + owner-approved live `execution`/`admission` config and grants + slice 3 + SELF-SOURCE-FLOOR (Jev `floor_for_s1` 0.53 keeps the floor's place in the S1 gate an open question); S2 = a more autonomous inner loop without the lead after MODEL-INGRESS-UNICODE + B7 + live B09-3 + B05/B07 independent review + a measured restore. DOGFOOD stays OFF until S1 is admitted. Implementation order `b1_then_wave1` is a lead record (Jev e775b172 0.89/0.64, below threshold → safest reversible; equal to the owner's stated preference). | The audit found the K7 bridge running a stale build (`30988c66`) while live runs `76582f9f`; staged gates keep the self-approval exposure (MCP `decide_approval`) and unsettled-Run handling closed before the live installation runs its own work. |
| 2026-10-01 | Wave 5 post-Jev decisions (`proof/WAVE5-2026-10-01/README.md`, `OWNER-DECISIONS-WAVE2` "Dalga 5 Jev sonrası"; none implemented). Owner: HTTPALLOW `read_and_deny_only` — an HTTP principal never approves, it only reads and denies; VECTOR `defer_vector_fts5_first`; READBACK `observed_class_shown_separately` — IFS read-back is shown as a separate "observed" class; MEMAUTO `k1_on_owner_install_off_customer_default` — K1 learning on for the owner installation, off by customer default, agent proposals never auto-accepted in any mode; deferred with safe fallbacks: REMOTEBIND, EGRESS, SKILLUNSIGNED (to A04-3), TRAINDATA. Lead: SAPI witness-first HTTP binding (WS as enterprise second binding), IFS core gaps then mock vertical, ROUTING `g31_is_routing_one_owner` (deterministic assignment, one owner; kind → template profile; model/effort from the router), GATEWAY in-service port Telegram first, MEMLEARN K0 automatic / K1 deterministic by policy / K2 human; below threshold → safest: MEMORY ledger memory journal, KPI no export, SKILL inline parts only. | Wave 5 closure (surfaces, MEMORY, LEARNING, IFS-E2E); card inputs, not implementation. |
| 2026-10-01 | Wave 4 owner decisions (logged Jev; `proof/WAVE4-2026-10-01/README.md`): all eight owner cases stayed below threshold after one revision and the owner chose every safe fallback — AUTORETRY `operator_only_default`, AZURE `defer_azure_admission`, BACKUPAGE `defer_backup_rule`, HOLDPURGE `defer_until_hold_card`, LEDGERV3 `defer_v3_until_paid_use`, LLMAUDITOR `defer_llm_auditor`, MISSIONAPPROVAL `defer_until_sources_enabled`, QUOTAUNKNOWN `defer_unknown_rule`; each is asked again with Jev when its card opens. Fourteen lead records are card inputs (twelve at threshold; RETRY `retry_as_new_run` and IDPROBE `per_call_identity_only` below threshold → safest reversible); METERING keeps v3 as a migration-free ceil and AUDITOR is the LLM-free A-1 baseline because of the owner deferrals (PLAN DALGA-4). Accepted deferrals; nothing implemented. | Azure correction (lead WebFetch 2026-10-01, narrowed 2026-10-02 after Sol 2243 B25-N1): whether a response names the underlying model depends on API and version — Microsoft's official Chat Completions structured-output example (v1, called with a deployment name) returns `object: chat.completion`, `model: gpt-4o-2024-08-06` (learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs, read 2026-10-02); per the 2026-10-01 reading the Responses API returns the deployment name and no version; neither is a guarantee for every API version or a provider attestation; an unset deployment upgrades only at retirement unless `OnceNewDefaultVersionAvailable` is chosen; ARM (`properties.model.{name,version}`) remains the installation-level model/version source; Azure admission stays deferred by the owner. |
| 2026-10-01 | Wave 3 owner decisions (logged Jev; `proof/WAVE3-2026-10-01/README.md`): all five owner cases stayed below sufficiency after one revision (0.59–0.72) and the owner chose every safe fallback — K1 `defer_until_a04_3` (the K1 row stays as written; D2 removal continues), LANG `defer_en_default` (default language stays EN), TRTEXT `defer_with_parity_default` (en+tr parity continues), EFFDETAIL `defer_until_erp_target`, OWNERROLE `defer_until_policy_choice`; each is asked again with new evidence when its card opens. Seven lead records are card inputs: I18N `manifest_messages_locale_pack` (at threshold); POLICY `operations_are_vocabulary`, TOOL `map_existing_fail_closed` (stage 1 only), ERR `defer_k1_as_is`, SLASH `derive_labels_only`, CHAN `manifest_channels_root_ids`, MODEL `defer_to_a04_3` below threshold → safest reversible (PLAN DALGA-3). Accepted deferrals; nothing implemented. | Enterprise registry/overlay questions mostly bind to the A04-3 loader card; deferring keeps Core unchanged until that card brings evidence. |
| 2026-10-01 | MODEL-INGRESS-UNICODE (owner, logged Jev ac5f1017 `note_audit_quarantine` 1.00/0.78; `proof/MODEL-INGRESS-UNICODE-2026-10-01/README.md`): model-bound text (tool results, MCP descriptors and schema descriptions, model invocation) replaces hidden Unicode runs with a fixed-schema `[hidden-unicode: …]` note through a third mode of the B8 classifier; a deterministic decoder runs only outside the model and sends the decoded payload to a redacted audit event and an owner security card, never into model context; a payload above a threshold or matching instruction/code heuristics quarantines the result or descriptor (the human decides in standart/full-auto; full-access does not pause but keeps note, card and audit); the MCP approval view equals the model view. Stored bytes and digests never change. Accepted target; not implemented. | Current practice (AWS 2025-09-30, MSRC 2025-07-29, OWASP LLM01:2025, UTR #36/UTS #55) and 2026 agent attacks: raw model APIs still follow tag-encoded instructions and decoding raises compliance (up to 95 percentage points in one model/encoding experiment, Graves arXiv:2603.00164; not a general or Deckent-measured effect); the human sees what was hidden, the model never reads it. |
| 2026-10-01 | Phase-3 wave 1 owner decisions (analysis session deckent-next-40, logged Jev; `proof/PHASE3-OWNER-DECISIONS-2026-10-01/README.md`): (1) wave order accepted — 0 D-cards → 1 EXECUTION hangs → 2 SECURITY (owner packages in parallel) → 3 Enterprise overlay → 4 contracts without cards + PROVIDERS → 5 surfaces/MEMORY/LEARNING; (2) A1 RUN-TERMINAL-OUTCOME: a stuck Run parks visibly for the operator (`close`/`resume`, same on CLI and MCP-free SDK; MCP has no decisions) with a versioned config timeout after which it becomes terminal with a visible reason (Jev J7 c99cc2f8 `skipped_phase_parked_run` 1.00/0.81: new `skipped` task phase with typed dependency reason, transitive closure, Run `parked {reason, since, deadline}`, one pure park/close helper); (3) A3 EVAL-UNKNOWN-RESOLUTION: the analysis proposal — unknown → operator decision with timeout (amends the 2026-09-21 "Unknown is not automatically re-evaluated" line above), shares A1's park+timeout mechanism; who decides = lead/Jev (proposal: existing `attempt:evaluate` by a human principal, four-eyes with B1); (4) A8 legal hold lives in Core; backup retention and purge obey it; (5) EXEC-RELEASE C4: `attempt:release` granted on the live policy (applied 2026-10-01, revision `a-530d0a9e…`). Items (2)–(4) were accepted code targets on that date. A1/A3 have a 2026-10-02 isolated source candidate (bounded lifecycle contract above), with review/integration/live acceptance open; A8 remains unimplemented. (1) is an accepted order; (5), the live C4 policy grant, was applied. | Legacy parked Runs and operator decisions are kept without unbounded waits; one owner per transition; retention stays Core so Enterprise only layers. |
| 2026-10-01 | Wave 2 security owner decisions (owner to the main session; logged Jev by the analysis session, each choice ≥ 0.90 and sufficiency ≥ 0.75; `proof/WAVE2-SECURITY-2026-10-01/README.md`, `proof/OWNER-DECISIONS-WAVE2-2026-10-01/README.md`): B1 `attested_assurance` (2d9eaad8 0.96/0.83) — MCP can never `allow`; the decision record carries a service-derived `assurance` (`peer-session`/`turn-bound`) the client cannot claim; hard-floor tool cards need `turn-bound`; Enterprise adds IdP step-up/WebAuthn via registry. B2 `invariant_now_metering_card` (2d72e3bb 0.96/0.77) — a zero tariff only on a literal loopback endpoint, any other host needs an explicit free declaration; PROVIDER-METERING is a separate wave-4 card with one owner `provider-spend`. B3 `keyring_port` (80a6bebd 0.98/0.79) — opaque keyId ring (active, retired-verifying, `compromised`) behind an `IntegrityKeyCustody` port, no silent re-key when sealed records exist, no re-sealing of history. B7 `single_redactor_two_modes` (33f40de0 0.98/0.78) — one redaction table, record mode redacts fully, decision mode labels only known values; a command carrying a secret never becomes a standing approval. B8 `mark_all_human_surfaces` (417c040b 0.96/0.76) — one pure classifier in `domain/core/text`, hidden/bidi characters are marked, never stripped. DOGFOOD `derived_self_source_floor` (c8664dae 0.94/0.79) narrowed by the owner: the self-source floor is **not** a product default (development repository only), is **not** enforced in full-access, offers a session approval, and approvals the owner gives in auto mode are remembered (bounded in the card: scope+principal, audited, revocable, never hard floor or secret-bearing targets). MODEL-INGRESS-UNICODE stays open. Accepted targets; none implemented. | The same-UID agent must not approve itself; spend, integrity and redaction stay Core contracts Enterprise layers on; the owner keeps full control of the development install. |
| 2026-10-01 | Owner decisions D1–D10 (the STALE-CLAIMS owner-level items O1–O8 plus K6 O1/O2; each prepared with logged Jev; `proof/OWNER-DECISIONS-2026-10-01/README.md`): (D1 A, Jev 948ec531) the typed task graph — graph v3 `workInput` — is `run`'s structured directive; free text enters only through `do` → RunProposal (D15b); the 2026-09-17 sentence stays and is annotated. (D2 A, Jev abaaa5c4) **amends the 2026-09-16 K1 row** "preserve the 81 legacy error codes": unused legacy `DECKENT_Exxx` codes with their catalog texts and the four dead SDK error factories (E076–E079) are retired before the first publish; the one used code, E004 (config invalid), gets a typed name — PLAN LEGACY-CODES-RETIRE. (D3 A, Jev b415a37c) **confirms the 2026-09-16 row** "no host rule files": the W0-9 target (`DECKENT.md` + a bounded `CLAUDE.md`/`AGENTS.md` section through a docs-authority writer) is withdrawn; guidance goes through stdout/MCP — PLAN HOST-RULES-CLEANUP. (D4 A, Jev ae7a999e) per-record MAC + per-scope sequence continuity + append-only triggers meet the audit decision's "HMAC chain"; tail truncation and external verification get a per-scope sealed checkpoint — PLAN AUDIT-CHECKPOINT. (D5 A, Jev dc3c1d0b) reasoning-text retention becomes a scoped setting, default not kept (digest, length, token count stay), company opt-in — PLAN REASONING-RETENTION. (D6 A, Jev a83a35a5) adapter `models.json`/`pricing.json` are dated seeds of the ledger v43 DB model catalog, the literal lint scans JSON, `NATIVE_CLI_CHANNELS` is a protocol constant, not a model identity — PLAN CATALOG-SEED. (D7 A, Jev 32945bab) memory authority/retrieval is tracked by the PLAN MEMORY workstream; the external MEMORY-AUTHORITY/RETRIEVAL cards are historical input. (D8 A, Jev d606add6) release of containers and attempt clones — PLAN EXEC-RELEASE, high priority. (D9 C, Jev abee3e49) K6 exact matching stays, plus a derived `dir/**` hint — PLAN K6-HINT. (D10 A, Jev f01a3d7d) unscoped work is refused in enforce, as shipped. | The Dev↔Next comparison (STALE-CLAIMS) left these as owner-level; the owner chose each option on 2026-10-01, equal to the logged Jev recommendation (all ten at choice ≥ 0.90 and context sufficiency ≥ 0.75; D2/D5/D6/D9/D10 after one evidence revision). Jev is advice, not acceptance. None of the named cards is implemented by this row. |
| 2026-10-01 | Correction of 2026-09-16 rows (STALE-CLAIMS; the rows stay as written, as history): (1) packages import downward `composition → adapters/surfaces → engine → capabilities → platform/domain` (domain pure; `arch.json` `packages`, FOUNDATION/B), not `kernel ← providers ← runtime ← orchestration ← surfaces`; (2) there is no `runtime` package and no `SpawnBackend` façade — the execution port is `engine/core/supervisor` (`ExecutionSupervisor`) with the Docker adapter in `adapters/core/docker-supervisor`; (3) `providers/core/registry/` does not exist — the rule now reads "concrete model/provider identifiers are forbidden in `src/**`" (`arch.json` `literals.forbidden`, Package contract); (4) memory: no FTS5 store and no `import-legacy-state` exist in `src/`, and `.brain/memory.db` is not imported verbatim — owner 2026-09-21 (PLAN legacy inventory: no raw copy, projection through the memory cards; legacy data is not migrated) supersedes the row; (5) there is no `runtime/custody/win32` and no Windows custody adapter — native Windows comes last in the platform order (owner 2026-09-29) and an unproven platform reports a typed `UNSUPPORTED`/`DEGRADED` (Package contract); (6) config is `schema_version: 3` (`CONFIG_SCHEMA_VERSION`, H34 S4) and unknown top-level keys are refused (`unrecognized_keys`, `platform/core/config/internal/validate/sections.ts`), not preserved with warnings; (7) there is no platform-global legacy fallback path and no config migration (owner 2026-09-17: no old-config conversion; `validate/version.ts` refuses another version) — the writer lock, private atomic writes and retained backups apply to config writes (`config/internal/lock.ts`, `write.ts`). | Dev↔Next comparison 2026-10-01 (LEAD-BULGULAR §E) found these rows read as current; each item is checked against the code at `01dd71ab`. Open, not decided here: the K1 "81 legacy error codes" row against Enterprise-first layering, and the "no host rule files" row against the Package-contract docs-authority target (decided 2026-10-01, D2/D3, row above). |
| 2026-09-30 | Seventeenth-batch tooling and provider fixes, no new contract: (1) CI-F8 — the package-metadata freshness check compares the generated JSON after CRLF→LF normalization only (a Windows checkout's line endings); any other difference (name, version, engine, content, format) is still stale; real Windows confirmation needs a hosted run. (2) SURROGATE-OPENROUTER — the OpenRouter request parser (`provider-openrouter-pricing` `quote.ts`) runs the domain `wellFormedModelJson` on the parsed request (lone surrogate → U+FFFD), same helper as the OpenAI-chat boundary; the request schema is **not** widened (assistant `tool_calls` and top-level `tools` stay refused `INVALID_REQUEST`), the tariff `bodyDigest` is the sha256 of the sent bytes, `arch.json` edge `provider-openrouter-pricing → agent-tool`. (3) CI-TERMINAL-CLI — the workline passes `interactive: true` to Ink when stdout is a TTY, because Ink 7.1.1 treats `CI` as non-interactive and defers frames (`workline.tsx`); non-TTY output stays on Ink's own detection. | Hosted run 36741640264 (30988c66): only the terminal-cli prefix test failed on Node 24; a user shell with `CI` set would see the same half-drawn terminal. |
| 2026-09-30 | Fourteenth batch (COMPOSITION-RELIEF) keeps `src/composition` within its 5500-line budget by moving five pure or I/O responsibilities to their owners, behavior-identical: the kept approval previews (`keepFullPreview`, `dropFullPreview`, `sweepFullPreviews`; managed-file I/O) to `adapters/core/approval-store`; the worker event-log sealing (verdict, `event-cap`, `byte-cap` markers) as `sealWorkerEventLog` to `adapters/core/worker-observation`; the scope budget lookup as `providerSpendingBudgetFor` beside `providerSpendingSchema` in `adapters/core/contract`; the `RUN_CAPACITY_OR_ORDER` parameters as `reservationDiagnosticParams` to `engine/core/scheduling`; and the runtime client's two hand-written copies of the bounded-result operation set replaced by the protocol's `isRuntimeServiceBoundedResultOperation` (`engine/core/runtime`). 5520 → 5454 lines. | FA-TRACKED-WARN, WORK-TARGETS, WORKER-CURRENCY-2 and D2 together passed the budget by 20 lines; FOUNDATION: move responsibility, never raise the budget. |
| 2026-09-30 | Thirteenth batch keeps `src/composition` within its 5500-line budget by moving the agent's workspace/product-state posture derivation to a new adapter unit `adapters/core/agent-workspace-floor`, byte-identical: `AGENT_READABLE_PRODUCT_RESOURCES`, `agentWorkspaceDeny`, `agentAuthorityPaths`, `agentShellHardFloor`, `agentProductStateDeny` (from agent-turn `turn.ts`) and `classifySandboxWritePath` (from `sandbox-writes.ts`); composition keeps the wiring. 5506 → 5423 lines. | OPEN-SANDBOX + LANG-CRASH passed the budget; pure path derivation over workspace-read/-write, host-shell, mcp-client and platform host symbols is not wiring (FOUNDATION: move responsibility, never raise the budget). |
| 2026-09-30 | OPEN-SANDBOX: a full-access shell call runs in an open bubblewrap view (host network, real HOME, project + `.git` writable) with a structural hard floor (Deckent state roots read-only/hidden, Core credential patterns masked in HOME); owner Y: existing non-product subdirectories of the sealed `.deckent` are writable; credentials stay name patterns for now (follow-up OPEN-SANDBOX-HIDDEN-PATHS, policy-managed hidden paths). | Owner MODES-3 checkpoint 4 ("full access is comprehensive") and live session 1d428e9f findings 3/4 (a hard-floor name created from a full-access sandbox; no network/HOME in full access). |
| 2026-09-29 | LANG-CRASH: system prompt v5 states the reply language (first and last) and the compaction summary is written in it; the MCP command boundary maps managed-file refusals to typed errors. Lead decision 2026-09-30: live `language: tr` at the next live restart (B); protocol v19 `chatTurn.language` with the next protocol bundle (A). | Owner 2026-09-29 "tamamen Türkçe iletişim"; live crash reports of `mcp add` in the sandbox. |
| 2026-09-29 | `ShellCapabilities` v1 → v2 (BWRAP-SELECT, owner S7): `bubblewrap` is the selected launcher's observation (`{ status, launcher, rejected, restriction, detail }`) instead of a PATH-scan status; `schemaVersion: 2`. In-process type, pushed at S5, so versioned (not amended in place); every caller moved in the same change. SHELL-OVERLAY reads `launcher.overlay`. | Launcher selection (system ≥ 0.12 → bundled 0.13) makes the observation richer than a status; overlay becomes active in production. |
| 2026-09-29 | MCP tool schemas are validated by Deckent's own bounded JSON Schema validator (`src/platform/core/validate`); the SDK's @cfworker/json-schema and ajv are neither used nor shipped (MCP-SCHEMA-VALIDATOR). | Owner "problematic dependencies are not accepted": cf-worker maintenance stagnation, ReDoS in `pattern`, fail-open `$dynamicRef` (Astra 2180 R2). |
| 2026-09-29 | Twelfth batch keeps `src/composition` within its 5500-line budget by moving two pure pieces to their owning adapter units: the `@file` index cache (`RuntimeWorkspaceFileHost`, `createRuntimeWorkspaceFileHost`, byte-identical) beside `indexWorkspaceFiles` in `adapters/core/workspace-read`, and `agentFileEffectCommandId` into `adapters/core/workspace-write` (as `agentShellEffectCommandId` in host-shell). 5501 → 5455 lines. | The SECRET-WRITE merge passed the budget by 1 line; FOUNDATION: pressure is answered by moving responsibility, not by raising the budget. |
| 2026-09-29 | SECRET-WRITE: `secret set|delete` through the runtime service (protocol v18; v17 was already pushed) under the policy resource `secret` (`set`/`delete`, id = name); every decision sealed as `secret-change` with `decision`; first-run template v2 grants the installer; CLI value from stdin or a no-echo prompt, never argv. | Owner 2026-09-29 SECRET-K1 §5 option A + S3 (service socket). |
| 2026-09-29 | DEPS-P0: Core license Apache-2.0; `engines.node >=24.15.0` with `@types/node` 24.x; `node:sqlite` below 3.51.3 refused at every open (`ATTEMPT_STORE_SQLITE_UNSUPPORTED`); react 19.2.8 + `@types/react` 19.2.18 (ink's react-reconciler 0.33 release train); CI Node [24, 26]; platform order Linux + WSL2, then macOS, then native Windows. | Owner decisions 1, 4, 9, 10 of the 2026-09-29 dependency audit (SQLite WAL-reset corruption fix in 3.51.3). |
| 2026-09-29 | Tenth batch keeps `src/composition` within its 5500-line budget by moving pure host-shell responsibilities to their owning adapter unit, byte-identical: `shellWritePosture` + `ShellCallAuthority` (beside `unattendedWritePosture`), `sandboxWriteSetRoot`, `agentShellEffectCommandId` and the shell result notes/effect-refusal text into `adapters/core/host-shell`; composition keeps the EffectApplication wiring. 5510 → 5432 lines. | FASTURI-OUT, DEPS-TYPES, SECRET-K1 and SHELL-OVERLAY together passed the budget by 10 lines; the 2026-09-28 FOUNDATION rule answers pressure by moving responsibility, not by raising the budget. |
| 2026-09-29 | SECRET-K1: `SecretStore` port + backend registry; env default, explicit installation-only file backend; one production resolver at every credential read site. | Owner keyring option B, S1/S2/S5; `secret set|delete` authority checkpoint open (PLAN). |
| 2026-09-29 | Seventh batch keeps `surfaces/core/terminal` within the 2000-line unit budget by moving two dependency-free presentation pieces: the approval-card key mapping (`decisionKey`, `scopedDecisionKey`, `StandingScope`) to `terminal-kit` and `ArrowPicker` to `terminal-render`; `terminal` re-exports the key mapping unchanged. | MODE-UX, PERSISTENT-APPROVALS, `/mcp` and TERM-UX-1 together passed 2000 (2020, then 2041). No budget raise; the next terminal feature splits the unit by responsibility (e.g. a session unit), as TERM-UX-1 noted. |
| 2026-09-28 | FOUNDATION: `budgets.packageLines.composition` 5000 → 5500 (owner-approved increase; earlier decision "raise to 5500 if the pressure returns"). | MCP client + policy administration wiring (seventh batch, measured 5067 lines after the SESSION-RESULT-LIMIT, POLICY-ADMIN and MCP-CLIENT merges). The next pressure is answered by moving responsibility out of composition, not by another raise. |
| 2026-09-22 | Operator **Terminal Contract v1**: regions, motor-agnostic events, colour tiers, Ink + line adapters; every chat turn is a governed model invocation in the caller's scope; chat ≠ run ledger. | One contract across Terminal/MCP/Desktop; Ink is the Node rich-TTY adapter, not product authority. Integration removed an unmanaged HTTP chat path and a global Run-capacity cap found in review. |
| 2026-09-16 | Clean-room port into this repository instead of in-place refactor of the legacy codebase (587k lines, 24.8k-line spawn backend, 40.9k tests, 5,535 path-keyed lint baselines). | Every in-place move broke 8+ gates and preserved dead code; the owner chose deletion over archive. |
| 2026-09-16 | File size is a mechanical gate (800 lines) in addition to cohesion-based boundaries. | Cohesion alone did not hold: one file tripled in two weeks. Supersedes legacy ADR-D-006 §2 wording. |
| 2026-09-16 | Layer direction `kernel ← providers ← runtime ← orchestration ← surfaces`, observability read-only, public-API-only imports. | Carries the legacy ADR-D-004 invariant (lower layers never import upward) into named packages; the legacy graph had only 138 violations out of ~3,400 edges, half of them caused by the i18n catalog living in cli. |
| 2026-09-16 | Spawn backends, exact-docker custody, effects and locks are `runtime`, not orchestration. | They were consumed only by orchestration but lived in core/orchestra with a 24.8k-line monolith; a runtime package with a `SpawnBackend` façade of 17 methods is the contract (legacy ADR-G-014). |
| 2026-09-16 | Zero hardcoded model/provider/flow identifiers outside `providers/core/registry/`. | Legacy ADR-G-036; original regex lint remains. Amended 2026-10-02: HARDCODE-RATCHET adds G1–G4 and frozen existing debt. |
| 2026-09-16 | Memory is DB-first (`.brain/memory.db`, FTS5) and the only legacy state imported verbatim; all other `.deckent` state is v2 with a one-shot `import-legacy-state`. | 80 schema constants and 7 SQLite files could not be kept byte-compatible through a rewrite (legacy ADR-G-035 kept; rest re-declared). |
| 2026-09-16 | The product no longer writes README/CHANGELOG/vision/release/sprint-log or host rule files. | Document sprawl was partly product-generated; the owner removed the feature. |
| 2026-09-16 | Windows native custody is ported and wired (`runtime/custody/win32`), reported `DEGRADED` until CI proof. | Legacy had an unreferenced 1.8k-line win32 adapter: support that only appeared to exist. |
| 2026-09-16 | K1: top-level `schema_version: 2`; kernel owns selection/identity/presentation fields and config IO. Package sections register strict Zod schemas and optional authored-layer validators before resolution. Provider limit policy is owned by `providers/core/contract` and registered by CLI ingress. | Prevents another god-config and keeps parent quota authority outside generic deep merge. Unknown top-level keys are preserved with warnings; registered sections reject unknown fields. |
| 2026-09-16 | K1: defaults → platform-global (legacy fallback) → project → env → exact `$DECK:` references; global writes target the platform path. Migration uses an exclusive writer lock, revision checks, private atomic writes and three retained backups. | IO failures never quarantine healthy files; dry-run performs no writes. Provider selections default to null until an authored selection or provider policy resolves them. |
| 2026-09-16 | K1: preserve the 81 legacy error codes and their gaps; freeze registry authority, validate it at CLI startup, localize messages/remedies and centralize exits 0/1/2/78 and emission. `doctor` reports `scope: kernel` in this card. | Config/host proof must not claim provider/native/runtime readiness before their cards. K1 shares the locale resolver with the upcoming K2 catalog port. |
| 2026-09-16 | ARCH tiers gate: every package uses data-driven `core ← base ← enterprise ← custom ← user` tiers and ≤4,000-line units with `index.ts` + `internal/`. Package indexes compose shipped core/base; future enterprise/custom/user units must load lazily through edition/policy ingress. `tiers.enforce=true`. | Unit imports and tier direction are checked without a baseline. Kernel config defaults register from base into a core extension seam. Provider credential env literals are confined to the provider registry. |
| 2026-09-16 | K1 review B1: runtime retains resolved secrets with RFC 6901 provenance; `config get` masks paths (including provider projections) and sensitive keys before selecting/formatting output, and filters string values through `redactSensitive`. | Human and JSON views must never expose resolved `.deck` credentials. |
| 2026-09-16 | K1 review B2: writer lock uses an exclusive directory plus private `owner.json` (pid/hostname/nonce/time); legacy file locks remain readable. Dead local owners and >10-minute malformed/unpublished local locks recover with a typed warning; live, permission-denied and foreign owners HOLD. Nonempty generation tombstones remain after atomic rename; empty unpublished directories use atomic `rmdir`. | Deterministic retained destinations fence delayed reclaimers from moving a newer live lock; age alone cannot prove a valid process on another host dead. Errors carry path/pid/age. Tombstones are recovery evidence, not ordinary-write artifacts. |
| 2026-09-16 | K2 mechanism: ten JSON families per locale, immutable validated registry, JSON-derived `MessageKey`, static manifest import for per-key floor defaults, and one locale resolver. No generated-file size exemption. | Preserves the 800-line rule and removes top-level await/Node dependencies from the renderer-facing translation unit. Legacy membership follows Fable's exact K2 list: 3,374 retained and 607 excluded; the 46 protected keys remain. K1's config.invalid moved to config.valueInvalid to preserve the legacy contract. (Amended 2026-10-01, owner I18N-ORPHANS option B, row above: the retained set narrows — T0 with D2/D3, T1/T2 archived out of the catalog, then an unused-key ratchet; not yet implemented.) |
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

ExecutionSupervisor v1 now has a real Docker adapter. Process exit is evidence, never Task acceptance. Containers remain until explicit release after durable application receipt. Trusted workspace allocation, dispatch fencing after release, durable output and aggregate scheduler quotas remain prerequisites for public execution. (Current state 2026-10-01: per-attempt Git workspaces, the durable fence kept after release, verified retained output and pool capacity exist — `adapters/core/git-workspace`, `engine/core/dispatch/internal/application.ts` `release`, `attempt-store/internal/pools.ts`; owner 2026-10-01 (D8 A, Jev d606add6): batch 22 (EXEC-RELEASE) wires release through one owner, `engine/core/workspace-patch` `AttemptCustodyReleaseApplication`, called only after `retainDispatchPatch` in patch preparation and by the runtime-service start sweep under ledger custody. Eligibility comes from the ledger only (terminal record, retained patch verified by digest, schema and exact attempt identity, and, when the profile had a worker connection, a sealed worker event stream verified by full attempt identity, receipt digest and event schema — the metadata row alone is not enough — because release removes the attempt directory that holds the live sidecars); live resource presence is a work filter, never eligibility. Container first by immutable Id with stdout confirmation and an absence observation (`SUPERVISOR_RELEASE_UNCONFIRMED` is retryable), then the clone by atomic rename to `.released-<attemptDirId>-<uuid>` and removal (checkout and sidecars first, lease last); lease records are fsync'd. An interrupted removal is finished only by that exact attempt's authorized release after its lease verifies; there is no scope-wide tombstone sweep, and foreign or unverifiable `.released-*` directories are kept and only counted (`detachedKept`). The outcome is typed `released`/`held` and never changes an execution, evaluation or preparation result; authority is the existing `attempt:release`. Config `execution.retention` (versioned, strict). Integration candidate clones are not covered (PLAN EXEC-RELEASE-INTEGRATIONS).)

Execution ledger identity is scope + local ID: attempts use (scope_id, attempt_id), command receipts use (scope_id, command_id); an ID alone carries no cross-scope authority. Fable1484 confirms the existing contract.

Local runtime service protocol is one current schema (2 at this card; 18 on 2026-10-01, `RUNTIME_SERVICE_SCHEMA_VERSION`). Client shutdown binds an exact per-start instance and a separately authorized service resource; admission is durable before response/disconnect handoff, and accepted does not mean stopped. Missing final audit outcome remains unknown. SQLite ledger schema10 stores canonical service admission and final outcome separately.
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
missing custody or Git. A `BAD` blob-size sentinel in an otherwise successful `ls-tree -l` (a blob Git cannot
size, for example one missing from a partial/promisor clone) is `PATCH_UNAVAILABLE` too, not a malformed-size
refusal (CI-FIX F5, sixteenth batch, Git 2.55 `show_tree_long`); path/type/mode validation and genuine
malformed-size refusals are unchanged. `execution.git.outputBytes` defaults to 4 MiB, sized for tens of thousands of tracked
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
not arbitrary legacy strings. Human heartbeat rows must show freshness only for available evidence;
missing, malformed and identity-mismatched states must remain distinct. Null files mean unavailable
observation (or diagnostic denied/released/ledger-only), never confirmed missing. Stopping watch stops only the view. CLI snapshots/JSON-lines and SDK are implemented; Desktop/MCP
and cross-host monitoring remain future consumers of the same semantics. Linux local files/Docker are
verified; no non-Linux or legacy runtime activation is claimed.

**AOF-HANDOFF (owner-admitted D4 candidate, 2026-10-03).** Worker final report schema 1 adds optional
`handoff: { toTask?, summary, artifacts: [{ name, digest }], openQuestions }` and `sharedNotes: string[]`.
Report and delivery budgets come from the versioned `worker-event/internal/report-limits.json` registry,
injected into native bootstrap; the existing redactor and retained dispatch output seal the bytes.
Evaluation records a separate `handoff` validity/digest or typed invalid refusal and shared-note count/digest
in the existing evaluation evidence. Neither note validity nor artifact existence changes the evaluator's verdict.
Delivery selects accepted, exact Run-bound attempts with recorded evaluation evidence, checks immutable output/artifact
receipts and read-output authority, and withholds failed/skipped/awaiting-decision sources. A valid direct predecessor
note is mounted read-only at `/deckent/inputs/_handoff/<encoded taskId>.json`; accepted Run-scoped notes use
`/deckent/inputs/_shared.json`. The bounded redacted prompt section is an untrusted context attachment on the existing
native prompt channel; its digest and the actual delivered task hash are recorded separately from the frozen profile.
Old profiles without that channel receive the mounts only; missing/unsupported structured reports add no handoff.

One engine owner records `handoff-received` and `workspace-started-from-patch` with full source Attempt identity/digest
in existing `attempt_receipts`, without changing supervisor observation sequence or acceptance. Run/Task inspect and
monitor reuse the engine's exact accepted-edge projection and en/tr catalogs. Graph v4 accepts string edges or
`{ taskId, startFrom?: 'accepted-patch' }`; v2/v3 read unchanged with fixed-base semantics. Only explicit accepted-patch
edges read retained predecessor patch custody and apply clean, exact-before changes to a fresh fixed-base clone before
any worker opens. The Run base and checkout HEAD stay fixed; the applied patch digest is separate Attempt evidence.
An applying/ready sidecar fences partial writes and verifies replay tree bytes; conflicts/partial starts refuse with
`HANDOFF_PATCH_UNAPPLICABLE`. Pre-start `handoff-refused` is a typed Attempt observation, projected to failed Task and
A1 skipped dependents/park by the existing lifecycle owner, without fabricating a process exit. No ledger migration,
new operator operation or service protocol bump is required. Overlapping predecessor patch paths are refused;
Enterprise access/retention overlay and real-provider/live acceptance remain outside this candidate.
Rebase2 onto batch-30 `1a5b3c4f` retains ledger v47 and service protocol 19. Authenticated Run inspection
uses the pool snapshot for both pool capacity/waits/drift and exact accepted handoff receipt projection;
the per-call read-only inventory exposes both evidence ports. Monitor retains pool waiting semantics alongside
handoff receipts. Joint inspection and targeted author proof: `proof/AOF-HANDOFF-2026-10-03/rebase2.md`;
independent review, socket/Docker host checks, hosted CI and live acceptance remain separate.
REVIEW 2300 (exact `362e391f`, base `9740baae`) is REVISE. The uncommitted R correction keeps the Linux
`PATCH_UNSAFE` descriptor-relative floor: portable empty/default, before-digest and source/receipt guards remain
active, while Linux apply/replay and host Docker variants report typed capability reasons through `verify-not-run`.
The real snapshot and full retained-lease port refusals are tested with explicit Linux platform-property simulation;
this proves the capability branch, not native macOS/Windows acceptance. At filename conversion, an unpaired UTF-16
source task ID throws `HandoffError(HANDOFF_INVALID)` before delivery artifact writes, checkout allocation or dispatch;
no replacement/normalization or identity/storage migration occurs. Valid Unicode, percent/slash encoding and the
255-byte encoded component limit remain. Existing refusal custody owns failed Task, dependent skip/park and immutable
replay/reopen receipts. Source-based author checks passed; three host socket/Docker test files remain environment-blocked.
Correction proof/limits: `proof/AOF-HANDOFF-2026-10-03/aof-r.md`; exact patch acceptance and hosted CI remain open.

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
replace execution policy or the pure launch reducer. Durable requests/decisions/receipts use the shared ledger (table since v31, rebuilt in v38 and v40), scoped MAC
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
records (claim/permit/outcome, cancel, purge), Run reservation and the installation journal (`init policy --apply`, Docker-gated
apply/resume); adapters keep their `now: () => number` port. Installation journal updates are also record-local monotonic
(`updatedAtMs = max(record.updatedAtMs, now)`), so a backward host step or a retry in a process whose clock is behind the persisted
`createdAtMs` keeps the journal's exact `TIME_ORDER` rule (SECRET-WRITE-CLOCK, batch 22).
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

**General Core audit port, first slice (AUDIT-PORT, ledger v41; owner 2026-09-27 q4/q5).** Silent decisions Core makes get a durable, sealed audit record through one port: `domain/core/audit` (event v1: `eventId`, `scopeId`, principal issuer/subject, policy revision, caller-supplied `atMs`, typed `subject` — first kind `permission-mode`: mode, cell, tool, turn/round/index/call, derived company and person grant ids, `require-approval → allow`, and a bounded summary: workspace-relative path or the first 200 characters of the shell head plus `argsDigest`; never the raw command or file content), `engine/core/audit` (`AuditStore` port, `sealAuditRecord`/`verifyAuditRecord` on the approval MAC line — `audit-record:1` over event + scope-local sequence + keyId — and `AuditApplication`: `record` returns only after the store wrote the sealed record, committed by the store or inside the caller's open transaction; any failure is typed `AUDIT_UNAVAILABLE`/`AUDIT_INVALID`/`AUDIT_CONFLICT` and the caller applies no effect — "no audit, no effect"; `list` verifies every seal, row identity and sequence continuity within one scope; `count`/`counters` are q5 summary totals) and `adapters/core/audit-store` on the shared ledger. Ledger v41 adds `audit_events` (PK scope+sequence, UNIQUE scope+event id; `BEFORE UPDATE`/`BEFORE DELETE` triggers abort with `AUDIT_APPEND_ONLY`, so append-only is a database guarantee) and `audit_counters` (mutable summaries, no seal). The service-start upgrade backs up v40 (0600) and migrates in one transaction; a v40 build refuses a v41 ledger (`ATTEMPT_STORE_VERSION`). Not yet: a SIEM/export adapter reading the port, sealed counters, retention. Clarification, owner 2026-10-01 (D4 A, Jev ae7a999e): the per-record MAC, per-scope sequence continuity and append-only triggers are the accepted form of the 2026-09-22 audit decision's "HMAC chain" (PLAN governance row, (3)); no previous-record digest is added. What they cannot show — truncation of the newest rows and verification outside the installation — is closed by a per-scope periodic sealed checkpoint (last sequence + range digest, chained to the previous checkpoint; CloudTrail digest-file model), PLAN AUDIT-CHECKPOINT, not yet implemented.

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
(`/policy`, `deckent policy`, protocol v17), refusal audit events, last-owner guard, external-change detection, a sealed archive. MCP approval decisions were removed by owner amendment 2026-10-02.

**Authority hardening (POLICY-HARDEN P3-R, seventh batch).** `ApprovalApplication` takes a `restriction { catalog, surface?, refused? }`:
an approval of an operation whose descriptor is `surface: 'authority'` is allowed only by the application built with `surface: 'authority'`;
every general surface (SDK, CLI through the runtime service, the terminal) gets `APPROVAL_SURFACE_RESTRICTED` (registered,
so the runtime client sees the code); a deny stays open on these decision surfaces. MCP exposes no approval decision tool (owner 2026-10-02). A claimed intent whose authority is gone at settle is
refused terminally (`POLICY_DENIED` → `refused/EFFECT_REJECTED`; no new refusal value). Audit event v1 gains `authority-refusal` (`stage
decide|submit|settle`, code, command/approval ids; no change content). The approval summary of an authority operation is a redacted,
human-readable diff (`describePolicyChange`, ≤ 2048 characters, cut by code point) through `OperationApprovalBroker`'s `describe`; no
protocol field. Remaining: P4 installation root, P5 authority surface, model tool M3, ledger v44+ archive
(v43 is the model catalog since WORKER-CURRENCY-1, sixteenth batch; see "Worker model currency, slice 1" below).

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

**Secret store (SECRET-K1, keyring option B, owner 2026-09-29 S1/S2/S5; tenth batch).** Config keeps only `$DECK:NAME` references; every
credential read — config interpolation (`layers.ts`), the model invocation credential and both MCP registry secret sites — goes through one
platform function, `configuredSecretResolver`: an explicit `secretResolver` (tests, SDK callers) wins, else the backend the installation
selected, else the environment. The backend is `SecretStore` port v1 (`src/engine/core/secret-store`: get/set/delete/listNames/inspect, `$DECK`
name grammar ≤128, typed `SECRET_*` refusals whose params/cause never carry a value or store content), chosen from a `SecretStoreRegistry` by
id `<namespace>.secret-store.<name>@<n>`: Core ships `core.secret-store.env@1` (default; read-only, not enumerable — exactly the previous
behaviour) and `core.secret-store.file@1` (`<global root>/secrets.json`, schemaVersion 1; directory owner-only, file owner-only, single-linked,
opened with `O_NOFOLLOW`, re-checked by `lstat`; unsafe → `SECRET_STORE_UNSAFE`, nothing read or repaired; writes under the config writer lock
of that path with atomic 0600 replace + fsync, admitted only when the whole new document (the exact UTF-8 text written, after JSON
escaping) fits `FILE_SECRET_STORE_MAX_BYTES` (1 MiB), the bound the reader enforces — over it `SECRET_STORE_FULL {backend, maxBytes}`, the old
file byte-identical (Astra 2185 R5); corrupt or over the bound on read → `SECRET_STORE_CORRUPT` without cause; POSIX only). A v18 secret change
whose known answer cannot fit the delivery budget is refused (`RUNTIME_SERVICE_RESPONSE_LIMIT`) before the policy decision, audit or write
(Astra 2185 R6). Enterprise/custom backends
(vaults, KMS) register through `registerSecretStoreBackend` before `registerProviderConfig()` seals the registry — no Core edit; `core.` is
reserved. Selection: config section `secrets.store`, installation (global) layer only (a project file carrying `secrets` is refused,
`SECRETS_PROJECT_LAYER_FORBIDDEN`), absent by default so a healed/default-filled project file never carries one, never a `$DECK` reference,
unknown id `SECRET_STORE_UNKNOWN` at load. An explicitly selected backend never falls back to the environment (owner S1: no silent
fallback). Interpolation keeps a backend's `SECRET_STORE_*` code (other resolver failures stay the content-free `SECRET_RESOLUTION_FAILED`).
Surfaces: `doctor` (`--json` `secretStore {schemaVersion, backend, writable, enumerable, status, code}` and a human `Secret store:` line; read
for the selection only, no reference resolved; an unsafe/corrupt/unavailable store is reported, not thrown); `deckent secret list [--json]`
(names only; env backend → `SECRET_STORE_UNSUPPORTED`). The `SECRET_*` catalog texts never contain "secret" followed by whitespace and a word:
the error redactor would mask the next word as a value (observed at integration). Governed changes (SECRET-WRITE, owner 2026-09-29 SECRET-K1
§5 option A + S3 = service socket, twelfth batch): the policy vocabulary (schema 1, additive) has resource kind `secret` with actions
`set`/`delete`; the resource id is the secret's name (`$DECK:NAME` grammar, `ids: 'all'` for every name). The runtime service owns the
change: protocol v18 (introduced for these two operations, see the versioning rule) `setSecret {schemaVersion 1, scopeId, name, value}` and `deleteSecret
{schemaVersion 1, scopeId, name}` (delivery required, current version only, no actor field — the socket peer is the principal; scope
admission `write`) → `{schemaVersion 1, scopeId, name, action, backend, removed}`. `SecretStoreAdministration`: input (name grammar, value 1
B–64 KiB, a writable backend — the env backend is `SECRET_STORE_READ_ONLY` before any decision) → `policySecretChangeAuthorization` (engine;
`evaluatePolicy` for the verified principal only; a request naming another principal is refused) → a sealed `secret-change` audit event for
**every** decision (`decision {effect, ruleId}`, required; never value, digest or length) in the installation's own ledger — the ledger of
the layout whose policy decided (the MCP user-trust precedent; no global-root ledger exists) → the store write only on `allow`. `deny`/no
grant → `SECRET_CHANGE_DENIED {action, name}` (text names the grant to add), `require-approval` → `POLICY_APPROVAL_UNSUPPORTED` (no approval
card for a value-carrying change); an unrecordable refusal is still a refusal; an allowed change whose record fails is not applied; an
allowed record followed by a failed write (e.g. the store's write lock held, `CONFIG_WRITE_LOCKED`) is an intent without effect. First-run
policy template v2 grants the installing principal `first-run-secret-store` (allow set/delete, ids all, installed scope); doctor recognizes
template versions 1..2; an existing installation gains the grant only by editing policy.json by hand until `/policy` (POLICY-ADMIN P5)
exists. CLI `deckent secret set <NAME> [--scope <id>] [--json]` reads the value from piped stdin (one trailing LF/CRLF dropped, ≤ 64 KiB) or
a no-echo raw-mode prompt on stderr (Enter ends, Backspace edits, Ctrl-C `SECRET_INPUT_CANCELLED`); a value on argv is `CLI_USAGE`; `deckent
secret delete <NAME>`; the scope is `--scope` or `terminal.scopeId`. No MCP tool, no SDK surface, no terminal `/secret` yet. A catalog test
renders every `error.*` template (en/tr) with sample parameters — a secret's `{name}` as `OPENAI_API_KEY` — and requires `redactSensitive`
to leave it unchanged. The approval/audit HMAC key stays in its 0600 file (S2). Not yet: OS keyring backend (K2, `@napi-rs/keyring`, S5),
per-scope namespace (S4), a grant-editing surface for existing installations (`/policy`, POLICY-ADMIN P5).
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
refuses without it; `host` explicit; Landlock is not offered for MCP servers). A launch-capable provider that wins after a preferred one
was passed over adds the same `… instead of …` line to the server's posture (tools card, per-call approval card); the host fallback and a
`require-sandbox` refusal name every reason with the same bound (REALM-NOTICE). With the shipped providers this path is not reachable
today (Landlock has no long-lived launch: a refused bubblewrap means host or refusal, both already named). Open: the pre-start launch
card (`mcpRealmPosture`) still says only what the realm means ("said at the start"); the actual selection and any fallback appear after
the start, on the tools card and every call card (options: pre-select with `usable()` on the launch card, or keep — lead/owner). A sandboxed start that fails is diagnosed in the same view
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
event kind, a later protocol version); the view's toolchain comes from the service environment's PATH while the server's PATH comes from the service process
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
The pool builds the SDK `Client` with `jsonSchemaValidator: new DeckentJsonSchemaValidator()` (Deckent's own validator,
`src/platform/core/validate`; MCP-SCHEMA-VALIDATOR, eleventh batch, owner 2026-09-29 "problematic dependencies are not accepted"): a server's
`outputSchema` is untrusted input and reaches neither the ajv 8.18 + fast-uri 3.1.0 copy bundled inside SDK 2.2.0 nor the SDK's
@cfworker/json-schema provider (MCP-VALIDATOR, seventh batch, had used cf-worker). The validator implements the SDK's synchronous
`jsonSchemaValidator` provider shape for JSON Schema 2020-12 (default, SEP-1613) and draft-07 (draft-06 read as draft-07): the whole reachable
schema compiles eagerly into closures (no code generation, the schema is never written); `$ref` resolves only inside the document; everything
not implemented exactly is a typed compile-time refusal (`JsonSchemaRefusal`: `$dynamicRef`/`$recursiveRef`/`$vocabulary`, embedded `$id`,
remote or relative `$ref`, unknown and cross-dialect keywords, 2019-09 and other dialects, in-place `$ref` cycles, backreference/lookaround
patterns, size limits) — the pool then refuses the call before sending (`invalid-output-schema`; Astra 2180 R2: a `$dynamicRef` schema that
cf-worker ignored and answered fail-open is now refused, `astra-2180-dynamic-ref.test.ts`; recursion through a plain `$ref` validates).
`pattern`/`patternProperties` run on a linear-time Thompson-NFA engine (single-code-point atoms keep V8's u-mode meaning), so a server
controlling both pattern and instance cannot block the service (27-char `^(a+)+$`: 0.4 ms vs 1.46 s on cf-worker). Validation is bounded by
a weighted step budget (5 000 000; historical ≈ 50 ms on the calibration machine, not a portable wall-time guarantee) and instance/evaluation depth; an exhausted bound is `valid: false`
(fail closed; CI-FIX-R3 tests retain the 50/500ms timing floors, scale only the test guards using
an independent 5-million-iteration CPU control against its measured 6ms lane reference, log calibration and
fail if the factor exceeds 10; deterministic NFA step-growth checks remain independent of host timing.
No production step/depth/pattern limit changes. The SDK reports -32602, `kind: 'output-schema'`, answered, never re-sent). `format` is an annotation unless a checker is
registered (none in Deckent's wiring) — a relaxation against cf-worker, which asserted formats; owner decision 2026-09-29 (Astra 2183 R4): keep the JSON Schema 2020-12 default (annotation only). The development tree still
installs the SDK's bundled ajv/fast-uri copy (not loaded by Deckent). Since FASTURI-OUT (tenth batch) the published package does not contain
that copy at all: `scripts/build-dist.mjs` loads the SDK's `_shims` and `validators/ajv` public subpaths with the one `ajvProvider` import
turned into a stub that throws `DeckentRemovedValidatorError` (`MCP_DEFAULT_VALIDATOR_REMOVED`); the build fails when the stub is not applied
or when ajv/ajv-formats/fast-uri/json-schema-traverse or @cfworker/json-schema appear in the metafile, the shipped packages or the embedded
components. Every SDK `Client` and `Server` is built with Deckent's validator (contract test
`tests/contracts/surfaces/mcp-json-schema-validator.test.ts`). Every `tools/call` carries the pinned
definition (MCP-PIN-DEF, eighth batch, Jev 12e80d38, 2026-09-29): the pool keeps, per listing, the frozen digest-covered projection of each tool
(name, title, description, input/output schema, annotations — nothing unpinned reaches the SDK) and passes a fresh copy as
`callTool(..., { toolDefinition })` (SDK ≥ 2.2). The SDK then neither consults its response cache nor re-lists, so a HEADER_MISMATCH
(-32020, SEP-2243) is answered as a typed error (`kind: 'header-mismatch'`) and never re-sent (C11; a deliberate deviation from spec
2026-07-28's "SHOULD re-list and retry" — a retry is a new call with a new decision; a changed definition is re-pinned with
`deckent mcp approve`). structuredContent is validated with Deckent's validator against the pinned outputSchema (MCP SHOULD): a result
that does not conform, or is missing where an outputSchema is declared, is an answered -32602 error (`kind: 'output-schema'`; the SDK raises
-32600 for "missing", normalized to -32602) — the server answered, so the effect may have happened: the C11 record settles as answered, the
call is never retried and the model is told the result was withheld. A pinned outputSchema the validator cannot compile is refused before
sending (`invalid-output-schema`; the SDK would otherwise throw its pre-send -32602, which would look answered). The classification of the
SDK's post-send checks relies on SDK 2.2.0's message texts (a changed text degrades to `kind: 'server'`, still answered, never resent;
tripwire: the `mcp-client.test.ts` -32602 cases). Not yet: a tool with an uncompilable pinned outputSchema is still offered (refused per
call, not marked `unmappable` at open); with `toolDefinition` the SDK also scans the pinned inputSchema for `x-mcp-header` on every
modern-era call (headers are ignored on stdio; untested path). The MCP server side validates schemas only in
`elicitInput`, which Deckent does not use. The MCP server is given the same validator (`createMcpServer`); every `tools/list` inputSchema
Deckent publishes compiles with it (contract test).
**Send authority (MCP-REVOKE, Astra 2174–2176, 2026-09-29).** A one-shot approval of a tool call never stands in for the server's trust.
`McpToolTarget` (the one dispatch owner) requires an `admit` authority that `pool.call` asks last — after the approval wait and every local
pre-send check, right before the request is handed to the SDK. `mcpSendAuthority` re-reads both registry files and the scope's trust record
(user trust in the global root, project/local in the data root) under that record's config write lock (the lock `reset`/`remove`/`approve`
take) and admits only while the server is still `trusted` as exactly the scope and definition digest the turn offered it under (`binding`,
carried by the registry view's launch settings, not part of the launch key) and the tool's pin is that digest. Otherwise nothing is sent:
`trust-revoked` | `definition-changed` | `pin-revoked` | `trust-unavailable` (fail closed), ledger `refused` (`EFFECT_REJECTED`). The lock is
not held across the RPC (a 120 s call must not make `reset` fail with `CONFIG_WRITE_LOCKED`): a trust change completed before the check is always
seen; a later change can race the actual send (the lock is released before `pool.call` → SDK `callTool` → send options → `stdin.write`); hand edits of
`mcp.json` and the registry half of `remove` are caught only by the re-read. A revoked or changed server's process is retired from the service
pool (at the refused call and at every turn start, `pool.retain`), so its next trusted use starts it after the cards. A sandboxed server sees the
project read-only (C5, above); a failed answer (`isError` or a server JSON-RPC error) of such a server carries `MCP_PROJECT_READ_ONLY_NOTE`,
decided from the typed `projectReadOnly` on `McpServerOpen`/`McpOfferedTool`, never from the answer text; the launch card carries a posture
line (`mcpRealmPosture`). Not yet: a typed diagnosis for a server that crashes at start while writing the project.
`runConfiguredMcpCommand` (the one host boundary of CLI `mcp *` and terminal `/mcp`) maps a `ManagedFileError` through `queryFailure`
(registry code + diagnosis params, caller's locale, exit 1, no crash report); any other error is unchanged (LANG-CRASH, live session 1d428e9f).
Open (LANG-CRASH finding): `mcp add`/`mcp remove` write the registry file before the trust audit; when the audit refuses, the registry has
already changed, and after `remove` the trust record stays (the same definition added again can look trusted without a card).


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
Pool occupancy counts only active/evaluating/uncertain tasks, so `cancelled` releases capacity. Still-pending tasks
that were never reserved close as `cancelled` in the same transition (`requestRunCancellation`, `domain/core/run/internal/reduce.ts`).

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
under `<workspaces>/toolchains/plans/`. WORKER-IMAGE-R5 (owner 2026-10-03; source candidate): the packaged lineage is reconciled
to r4-20260930 using the retained recipe/Dockerfile hashes in its build receipt. In `auto` mode or with explicit apply,
before writing a plan artifact or creating a build context, the installed builder runs its read-only `--check-version` mode
against the exact repository on the selected daemon. The shared `assertVersionAdvances` history guard refuses a counter
at or below any held r<N> tag with `WORKER_VERSION_COUNTER_TAKEN`; missing lineage must be reconciled rather than invented
from tags. A failed/unavailable/timed-out check creates no context. Propose-only stays recipe-based without Docker access.
The builder repeats that same guard before its actual build, retaining protection against intervening daemon changes;
preflight is an observation, not a lock or a promise of build success. Known builder failures are shared `DeckentError`
codes across SDK/MCP/CLI, localized EN/TR; CLI JSON carries a maximum 512-byte redacted `params.detail` excerpt, never raw
process buffers or a full stack. Unrecognized reasons retain typed build/check failure codes; timeout retains precedence.
After a successful preflight, the shipped builder files are copied into an
exclusive private context `<workspaces>/toolchains/builds/<version>/` with the edited Dockerfile/recipe, run through the bounded
process runner (environment allowlist, timeout, output cap), and the builder's receipt (`receipts/<version>.json`) yields a
profile-revision proposal (`proposals/<version>.json`): exact `cliVersion`/`imageId` changes per affected native profile, marked
`not-applied`. Installed config, policy and package bytes are never modified; the proposal is applied through a new installation
profile revision, so in-flight Runs keep their imageId and previous versions remain for rollback. No new layout resource is added
because the layout revision (part of attempt identity) hashes the resource registry; the toolchains custody lives beside integration
candidates under the workspaces resource. `atStartup` emits the read-only currency report after `runtime serve` is ready and never
builds. Codex workers now run with `-c check_for_update_on_startup=false`; Claude workers keep `DISABLE_AUTOUPDATER=1`; Cursor stays an
explicit unsupported exception.

### Worker model currency, slice 1 (WORKER-CURRENCY-1, ledger v43; owner 2026-09-30, sixteenth batch)

Models are pinned by exact API model id; aliases are refused, never resolved. The model catalog lives in the ledger (v43):
`model_catalog_channels(channel_id)` and `model_catalog_models(channel_id, model_id)` are installation-wide facts written from a
provider catalog **document** (schemaVersion 2: channel `{kind native-cli|http-api|local-server, cli, aliases}`, per model exact
`nativeId`, `lifecycle {state active|legacy|deprecated|retired, deprecatedOn, retireNotBefore, retiredOn, source{url, observedOn}}`,
`minCliVersion`, `efforts`, `aliases`); `model_catalog_activations(scope_id, channel_id, model_id)` is per-scope, hierarchical activation
(channel row = empty model id); `model_catalog_receipts(scope_id, command_id)`. One governed command (`register | activate | deactivate`,
SDK `applyModelCatalog`) with receipt; authority = the existing `model-activation` policy resource; `register` writes installation-wide facts and needs
installation-level authority: the scoped `activate` decision **and** the policy.administer delegation bound over `scopes: 'all'` for each
channel target on the same policy snapshot (a deny/restriction in any scope refuses; scopes registered later are covered — catalog
administrators need a `model-activation` grant with `scopes: "all"`); `activate`/`deactivate` are scope-level; receipts record
`level: installation|scope` (Astra 2197 WC-R1; target id = sha256 of `deckent.model-catalog-target.v1`). A pinned native profile's executed
argv is bound to its catalog pin by the native-coding adapter (`assertNativeWorkerBinding`: compiler shape only, one `<model flag> <exact
id>` immediately before `--`); Run admission refuses divergence with `WORKER_MODEL_BINDING_MISMATCH` before any write (WC-R2). `register`
validates the final merged channel (kept + written models): alias ≠ exact id, aliases unique (`MODEL_CATALOG_ALIAS_CONFLICT`, full
rollback; WC-R3). v43 is additive and shape-checked (IF NOT EXISTS
like v39/v41); the service-start upgrade backs up v42; a v42 build refuses v43 (`ATTEMPT_STORE_VERSION`). The chat catalog (config
`provider_catalog` v1) and chat activation are unchanged (golden binding digest test); chat moves onto the ledger copy in a later slice.
Native coding invocation v4 pins `{channelId, modelId, auxiliaryModelIds}`; `nativeSubscription` v2 carries it; argv carries only the
exact id (never a fallback model). `coding prepare` refuses CLI aliases (adapter data `commands.json#modelAliases`) and `-latest` names
(`WORKER_MODEL_ALIAS_REFUSED`). New Run admission (composition resolve hook, read-only ledger view, before any write) refuses native
tasks with typed codes: `WORKER_MODEL_UNPINNED` (v1 profile), `WORKER_MODEL_ALIAS_REFUSED`, `WORKER_CHANNEL_NOT_ACTIVE`,
`WORKER_CHANNEL_MISMATCH`, `WORKER_MODEL_UNKNOWN`, `WORKER_MODEL_RETIRED` (state retired or `retiredOn` day passed),
`WORKER_MODEL_NOT_CURRENT` (legacy/deprecated), `WORKER_MODEL_NOT_ACTIVE`, `WORKER_MODEL_CLI_TOO_OLD` (profile preflight CLI pin, which
the container preflight enforces equal to the image CLI, < catalog `minCliVersion`) — for the model and every declared helper model.
Admitted Runs are untouched (replay/inspect/reserve read the frozen snapshot). Post-run: Claude `session.ended.models` = `result.modelUsage`
keys; after the gateway closes the host seals one `model.verification` event (`verified` | `substituted` + unexpected ids | `unverified`
for Codex/Cursor, v1 profiles or missing usage); a worker-sent verdict is dropped. Slice 1 alone did not gate acceptance; slice 2 does (below). Landing
consequence: existing native profiles (`nativeSubscription` v1, alias models such as `--model sonnet`) are refused with
`WORKER_MODEL_UNPINNED` on their next new Run until re-prepared against the catalog (operational note, WORKER-IMAGE-R4 docs-delta).

### Worker model currency, slice 2 (WORKER-CURRENCY-2; owner 2026-09-30 rule A, seventeenth batch)

Owner rule A: a profile declares its main model and its helper (auxiliary) models; a declared helper is allowed, an undeclared model
makes the attempt not accepted, and model calls stay visible. The consequence lives in the existing acceptance owner, not a new flow.
`TaskEvaluationApplication` reads the host-sealed worker event log of an attempt whose frozen Run profile pins a model
(`nativeSubscription.model`) and records typed model evidence with the evaluation (`TaskEvaluation.model`: provider, requested pin, init =
`session.started.model`, usage = `session.ended.models`, verdict `verified|substituted|unverified`, unexpected ids, evidence
`sealed|absent`, evidence capability; additive optional field, tasks without a pin keep identical bytes). Domain conclusion (`taskModelConclusion`):
`substituted` → Task **failed**; a pinned **session-events capability** attempt (shipped Claude) without a sealed `verified` verdict (no log, log without verdict, sealed
`unverified`) → **held** (`evaluating`, re-evaluable after sealing; Jev 933e43f2, 58ffe1c9); Codex/Cursor → accepted by their
criteria, visibly `unverified`. A present but invalid sealed log refuses evaluation (`TASK_EVIDENCE_INVALID`, nothing written). The
engine transition, re-run by the ledger commit, requires model evidence exactly for pinned tasks and for the Run's own pin. The verdict
compares **worker-reported** usage received by the host with the pin; it is not provider attestation (withholding usage holds a Claude
attempt, it never passes it). A hold waits for an operator (`task evaluate` with a new command id once the log is sealed, or
`run cancel`); automatic progression evaluates once per attempt revision, so it never loops; a lost seal shows as `evidence absent`.

Visibility (one typed row, domain `viewWorkerModels`: requested → init → usage → verdict + evidence `sealed|invalid|live|none|denied`):
`workers list|watch` (sealed verdict, else live `pending`), `run inspect` (`models[]`; each attempt needs `read-output`, else `denied`),
the `task transcript` report view, SDK/MCP through the same composition. Catalog operator surface, one application
(`ModelCatalogApplication.apply|inspect`): CLI `models catalog list|register|activate|deactivate`, MCP `inspect_model_catalog`
(read-only) / `apply_model_catalog` (destructive, idempotent by the (scope, commandId) receipt), SDK `applyModelCatalog` /
`inspectModelCatalog`; listing needs the scoped `model-activation` `inspect` decision per channel (else `denied`); `register --seed
<name>` reads the packaged `assets/model-catalog/<name>.json`, `--file PATH|-` an operator document. Authority unchanged from WC-R1.
CATALOG-V3 adds `catalog` and both packaged seed names to en/tr help; CLI-HELP keeps them as a separate `models catalog --help`
line with both locale snapshots (i18n fixture reconciled in batch 27).
Open: terminal `/models` read-only view and the `/workers` verdict word; chat path
onto the ledger catalog; Codex/Cursor output-side model evidence (none documented); a real Claude run showing `verified` with a helper.

### Work targets, slice 1 (WORK-TARGETS; owner 2026-09-30 K1 = W2, K2 = A, K4 = A; Jev a2053c1c; seventeenth batch)

- **Registry.** `execution.workTargets` `{ schemaVersion: 1, targets: [{ id, kind: 'git', path, baseRef }] }`, optional, one target in
  slice 1 (`max(1)`), additive under config schema 3. Execution stays strict, so a build without this field refuses such a config
  instead of silently targeting the project root. `kind` is the extension seam; business systems (ERP) are not work targets — their
  effects stay on the C11 operation catalog / EffectTarget port. A future non-Git workspace kind is another adapter producing the same
  `WorkTargetObservation`.
- **One resolver.** `resolveGitWorkTarget(projectRoot, execution, layout)` (adapter `git-workspace`) is the only source of the Git source
  root for Run base capture, execution, patch preparation, integration, delivery, adoption, delivery-pinned Runs and
  `openConfiguredWorkspaceBroker`, and runs at service start. Absent config: returns the project root unchanged, no Git call.
- **Typed refusals** (engine `assertWorkTarget`, fixed order; service start before any custody/write and every acquisition):
  `WORK_TARGET_PATH_INVALID`, `WORK_TARGET_UNSAFE` (not owned by the service user, or group/other-writable), `WORK_TARGET_IN_DATA_ROOT`,
  `WORK_TARGET_IS_PROJECT`, `WORK_TARGET_NOT_WORKTREE`, `WORK_TARGET_SHARES_PROJECT_REPOSITORY` (same Git common dir as the running
  project: Deckent never targets its running source), `WORK_TARGET_ALTERNATES`, `WORK_TARGET_BASE_MISSING`. Git runs only inside a
  canonical, owned, not group/other-writable directory, with the shared local invocation (no network/hooks/fsmonitor/system+global
  config; now owned by `git-workspace`, re-exported by `git-patch`).
- **Named baseRef.** Run base = `baseRef` tip (not checkout HEAD); delivery `update-ref` verifies `baseRef`; the integration observation
  compares the `baseRef` tip and does not read the target checkout's index or files. A moved base branch is the typed
  `PATCH_BASE_ADVANCED` (observation and delivery) instead of `PATCH_CONFLICT`; recovery = a new Run on the current base. K4 = A: for a
  self/dogfood target `baseRef` is the adoption target branch and the target checkout HEAD is detached; the fenced adoption advances the
  base and the next Run starts from the adopted commit (proven).
- **Policy.** Vocabulary (schema 1, additive) `work-target {use, adopt}`, resource id = target id. `use` at Run admission and reservation
  next to `pool:use`; `adopt` for adoption and rollback at the engine's first check and the re-check before the effect. No target
  configured: no work-target check. Installed policies need a grant before a configured target can be used.
- **Versions.** Config schema 3, policy vocabulary schema 1 (additive kind), runtime protocol v18, ledger 43, Run snapshot unchanged;
  `WorkspacePatchError` +`PATCH_BASE_ADVANCED`; error registry +9 codes.
- **Open limits.** The Run does not record its target id (a config change between admission and first acquisition retargets a pending
  Run; re-authorized at reservation, custody fingerprint binds it from first acquisition) — next slice with more than one target.
  Adoption is local SDK/CLI only. `merge-tree` "update branch" is a later slice. The foreign-owner refusal is exercised through the
  group/other-writable branch only. Node 26 not measured.
- **U1 (owner 2026-09-30).** No `npm run build` / `npm run verify` in the live checkout `/home/alperen/deckent-next`; build and verify
  run in lane/integration worktrees, and the live checkout is built only in the governed switch (full verify + independent PASS + push +
  owner-approved restart). A rule, not a hook (a hook would also block the governed switch build). U2 (versioned side-by-side
  installation; owner option C, design `proof/U2-VERSIONED-INSTALL-DESIGN-2026-09-30`) replaces the rule by construction.
- **DEV-U2-0 versioned dev releases (2026-09-30; host tooling only, no `src/` change).** `.agents/refactor/dev-release.mjs`
  requires Linux `/proc` process custody and util-linux `flock`; its command entry refuses other platforms with
  `DEV_RELEASE_PLATFORM_UNSUPPORTED` before installation reads or writes (CI-FULL, 2026-10-01). Portable layout checks remain exercised.
  (`stage|switch|rollback|start|status|prune`) keeps `versions/<commit12>-<tree12>/` (unpacked build-dist package + `release.json` +
  per-file sha256 `manifest.json`), an atomic relative `current` symlink, `previous`, and `switches.jsonl` under
  `$DECKENT_NEXT_INSTALL_ROOT` (default `~/.local/share/deckent-next-dev`; inside the project it is refused). `next-entry.mjs` runs
  `realpath(current)` (a process loads lazily from its own version directory for life); an invalid `current` is the typed
  `NEXT_ENTRY_CURRENT_INVALID` refusal, never a silent fall-back to the checkout `dist`; cwd is the project root. `stage` clones the live repo
  with `git clone --local --no-hardlinks` (Jev 2b6f9f73; the live `.git` is not written), builds, runs `build-dist --pack --bwrap` and pack-smoke
  (tarball and `--root`) and installs atomically; unknown, dirty-symbolic, unpushed, unpublishable or smoke-failing sources are refused
  (`--waive-smoke <check>` is recorded in `release.json` and is an emergency option only: pack-smoke now passes the terminal check).
  `switch` stops the old service through its own CLI (governed shutdown), flips the pointer, starts the new service detached and verifies
  describe `build.sourceCommit`; a mismatch restores the pointer and the old service, or, when the ledger already advanced,
  `DEV_RELEASE_OPERATOR_REQUIRED`. `rollback` is pointer-only when the target opens the live ledger version; otherwise
  `rollback --restore-ledger` (Jev 39e921e3) stops the service, prints a loss report plus a token bound to the stopped ledger state, and
  `--confirm <token>` recomputes it under the native ledger lock (stale token refused; replaced ledger files are kept as `rolledback` backups,
  never deleted). U1 host guard: `build|verify|tsc` is refused while a process runs from the target's `dist/`. Open limits: typed drain is available from ledger v44 (K5 `pool hold` + `pool status` `drained`), `dev-release switch` does not
  use it yet (proposal `proof/K5-POOL-HOLD-2026-10-01/docs-delta.md` §3); G5/G6 are operating rules (after a switch reopen terminals and MCP host
  sessions; never `/service-restart` from an old terminal; old processes fail on a protocol bump); the manifest is checked only before `switch`,
  not at every start; the install root must join the sealed set in U2-1. Evidence `proof/DEV-U2-0-2026-09-30/`.

### Typed work input and coding templates (K3 = A; owner 2026-09-30, Jev 97e59d70; lane Jev 22ea0d2c; nineteenth batch)

- **Graph v4 (AOF-HANDOFF).** `TASK_GRAPH_SCHEMA_VERSION = 4`; the graph schema accepts 2, 3 and 4 side by side. v4 adds explicit accepted-patch dependency edges (see AOF-HANDOFF above). v3 adds optional
  `tasks[].workInput` `{ schemaVersion: 1, task, scope: { paths[1..64] }, acceptance, model: { channelId, modelId,
  auxiliaryModelIds[<=8] }, effort?, maxTurns? }` (domain `workInputSchema`; texts <=16 KiB; paths repository-relative POSIX/glob,
  no absolute/`..`/`.`/empty/control segment, unique; model ids use the catalog `exactModelIdSchema`; effort enum = catalog
  `REASONING_EFFORTS`). A v2 graph never carries a work input (`TASK_GRAPH_INVALID`). Every surface takes it through the one
  `runAdmissionSchema` (CLI `run create --graph`, SDK `createRun`, MCP `create_run`, runtime-service `createRun`).
- **Template.** A reusable coding template is an ordinary v1 registry profile with adapter `native-coding-template` v1:
  `parameters { schemaVersion: 1, docker: <docker v2 task params, no argv/nativeSubscription>, invocation: <native invocation
  without schemaVersion/model/prompt/composition task text; optional maxTurns and prompt parts core/persona/skills/context> }`.
  The Docker resolver refuses this adapter identity, so a template never runs by itself. Task text never enters the registry.
- **Admission (one owner).** Engine `resolveExecutionRegistry` decides the pairing before any validator: template kind without
  work input → `WORK_INPUT_REQUIRED`; work input on a non-template kind → `WORK_INPUT_TEMPLATE_REQUIRED`. The adapter
  (`compileNativeCodingWorkInput`) builds invocation v4 (exact pin, work input `maxTurns` else the template's, template parts +
  task/scope/acceptance with scope = one path per line) and reuses `compileNativeCodingDockerProfile`; the compiled profile keeps
  the template id/version and must pass the installed validators (WC-R2 `assertNativeWorkerBinding`, Docker) and
  `admitWorkerModels` (existing typed codes; plus the compiled pin must equal the requested one → `WORKER_MODEL_BINDING_MISMATCH`,
  and a requested effort must be declared by the catalog for the main model → `WORKER_EFFORT_UNSUPPORTED`). CLI aliases →
  `WORKER_MODEL_ALIAS_REFUSED`; a turn limit for a CLI without one → `WORK_INPUT_TURN_LIMIT_UNSUPPORTED`. All before any write.
- **Frozen.** The compiled profile is stored in the Run execution snapshot (v1, unchanged); admission replay returns before
  resolve, so replay/inspect/reserve use the frozen profile even after catalog changes. Provenance is derived: template = profile
  id/version; input = the stored Run graph + prompt-delivery segment hashes.
- **Effort.** WORKER-EFFORT dirty candidate now resolves catalog/CLI-capability and WorkClass policy once at admission,
  compiles the selected effort through command registry v3, freezes provenance in Run/Attempt and shows EN/TR inspect/monitor.
  See the WORKER-EFFORT contract above for exact-model Cursor semantics and acceptance limits.
- **Also.** Installation preview validates a template through its Docker base (image id); toolchain currency lists template CLI
  pins (`parameters.invocation`) next to prepared profiles.
- **Versions.** Task graph 2 → 3 (side by side); registry v1, Run execution snapshot v1, ledger 43, runtime protocol 18, config 3,
  prompt delivery v1 unchanged. An older build refuses a v3 graph (strict parse, observed as the generic inventory refusal) and
  refuses to execute a template. Error registry +4 codes.
- **Open.** RunProposal v1 (D15b) and `run retry` not in this slice; no `run create --card` convenience (would change CLI help
  templates / i18n parity snapshot); scope paths are classified at patch preparation and enforced per work target (K6); provider-effective effort remains unattested; the
  snapshot does not name the template/input digest explicitly (a later snapshot v2 if RunProposal/retry need it); toolchain
  update proposals list templates but applying a revision is still manual; template validity (installation preview) is not
  compilability — e.g. a Codex template without explicit `discovery` defaults to `disabled`, which the compiler refuses, so every
  admission refuses it with the generic `EXECUTION_PROFILE_INVALID` before any write (follow-up: dry-compile in template validation).

### Typed execution pool hold (K5 = A; owner 2026-09-30, Jev f01a710f; lane Jev 2e7be700; twentieth batch)

- **Semantics.** A held pool admits no new task reservation: the ledger refuses with `RUN_POOL_HELD` inside the reservation transaction
  (after replay, revision, cancel, wave and candidate checks; before capacity and before any write). Run admission is not gated; attempts
  reserved before the hold still pass dispatch admission, run, finish and are evaluated; an immediate stop stays `run cancel`. `resume`
  re-enables reservation. The runtime progression maps `RUN_POOL_HELD` to a quiet `waiting` through the one engine mapping
  `reservationRefusalOutcome` (no error, no back-off).
- **Granularity.** The pool is installation-wide (`execution_pools` has no scope column), so the hold is too. Per-scope holds are a later layer.
- **Authority.** Vocabulary `pool {use, hold, resume, inspect}` (schema 1, additive). `hold`/`resume` need the scoped decision **and** the
  delegation bound over `scopes: 'all'` on the same policy snapshot (WC-R1 pattern; a deny/restriction in any scope refuses); `inspect` the
  scoped decision. The first-run template grants none of these.
- **State and owner.** Ledger v44: `execution_pool_holds(pool_id → execution_pools, revision, state, record)` (no row = open) and
  `execution_pool_hold_receipts(scope_id, command_id, record)`. The hold never lives in `execution_pools.policy` (installer replay compares it
  byte for byte). Engine `decidePoolHold` is the pure transition; `SqlitePoolHoldJournal.applyPoolHold` the only writer (replay, pool
  requirement, transition, row, receipt and sealed audit in one `BEGIN IMMEDIATE`). Replay of a (scope, command) returns its receipt;
  a different body is `RUN_COMMAND_CONFLICT`; hold-while-held / resume-while-open are recorded no-ops (`changed: false`).
- **Audit.** Subject `pool-hold` (audit schema 1, additive): action, pool, command, decision `{effect, ruleId}`, `state {previous, next}`
  (null for a refusal). Every decision is sealed, refusals too; the operator's reason stays in the hold record, not the audit event.
- **Status.** `{ state, hold, occupancy {execution, inFlight}, drained }`; `drained` = held and no reserved, running, uncertain or
  evaluating task on the pool. One application (`ExecutionPoolHoldApplication`) behind CLI `pool status|hold|resume`, MCP
  `inspect_pool_hold` / `apply_pool_hold`, SDK `inspectPoolHold` / `applyPoolHold`; a local composition operation (model-catalog precedent),
  not a runtime-service operation: the service reads the hold from the ledger at every reservation.
- **Versions.** Ledger 43 → 44 (additive, shape-checked; v43 build refuses v44; service-start upgrade backs up v43); policy vocabulary 1,
  audit 1 (additive); runtime protocol 18, config 3, Run snapshot 1, graph 3 unchanged; error registry +1 (`RUN_POOL_HELD`).
- **Open.** First v44 switch cannot drain (the v43 build has no hold); `drained` never becomes true while a pinned Claude attempt waits for
  an operator evaluation (use `occupancy.execution === 0` to see "nothing running"); no per-scope hold; no terminal `/pause`, no
  dev-release drain integration not implemented. Pool wait inspection is added by the POOL-CAPACITY source candidate below. CLI-HELP exposes `pool` in the top-level work group.

### Execution pool capacity and waiting observation (POOL-CAPACITY; owner 2026-10-03, source candidate)

- **Operation and authority.** One `ExecutionPoolCapacityApplication` behind CLI `pool set-capacity --execution-slots <n> --in-flight-slots <n>`,
  MCP `apply_pool_capacity` / `inspect_pool_capacity`, SDK `applyPoolCapacity` / `inspectPoolCapacity`. Catalogs expose the same typed
  schema; `pool:set-capacity` is additive policy-vocabulary v1 data. Authenticate scope membership and require both the scoped decision
  and `scopes: all` delegation over the same pool/policy snapshot, exactly as hold/resume; persona grants nothing. No default control grant.
  Refused policy decisions use the existing sealed refusal-audit path. CLI offers en/tr human and JSON, status shows the latest change receipt.
- **Capacity and custody.** Positive safe integer execution/in-flight slots, bounded by the existing pool counter schema
  (`Number.MAX_SAFE_INTEGER`), no new product limit. Reject either dimension below the current installation-wide occupancy with
  `RUN_POOL_CAPACITY_OCCUPIED`; executing, evaluating, reconciling and uncertain effects retain their existing occupancy semantics.
  This avoids accepting an operator target already incompatible with retained work; retry after drainage is explicit. Equal values record
  `changed: false`; identical resolved (scope, command, actor, capacity) replay returns the original receipt, conflicting bodies refuse.
- **Ledger owner and receipt.** Additive forward-only v46 → v47: `execution_pool_capacities` (one effective override per pool) and
  `execution_pool_capacity_receipts` (immutable scope/command record). Preserve original `execution_pools.policy` bytes, so installer exact
  replay and original provisioning truth survive resizing. `SqlitePoolCapacityJournal` is the only writer: `BEGIN IMMEDIATE` covers replay,
  pool lookup, all-scope occupancy check, transition, override, receipt and sealed `pool-capacity` audit (actor, scope, time, policy decision,
  previous → next). No audit means rollback; lost commit acknowledgement is outcome-unknown and same-command replay resolves it.
  The existing service upgrade creates its versioned 0600 backup; clients never migrate. Migration checks exact CREATE shapes and rolls
  back a same-name incompatible table. Reservation, dispatch admission and monitor capacity readers use the effective override.
- **Read-only observation.** Additive optional `RunView v3.pool` carries raw/effective capacity (the `max_workers` ceiling stays explicit),
  occupancy, `POOL_ADMISSION_CAPACITY_DRIFT` for persisted per-Run limits above the raw pool capacity; current config admission limits contribute
  only when their `poolId` matches the observed Run pool (BATCH30-R / REVIEW2294 R3). It also carries every dependency-ready,
  automatically admitted pending task's `waiting-pool-slot` / `pool-held` reason. Run snapshot/state is unchanged. Run, policy, pool, hold and
  occupancy share a deferred read snapshot. Cancelled, parked, terminal, delayed, dependency-waiting and not-admitted work is not called a pool wait.
  Full-pool `sinceMs` is unknown/null; hold uses its recorded change time. These are current conditions, not historical refusal receipts.
  Monitor blocker and task data carry the same pool wait contract, with pool id, occupancy, raw and effective capacities. `doctor` uses the
  policy-checked pool inspection for configured `terminal.scopeId`; missing scope/policy/ledger stays explicitly unavailable. Drift is a degraded
  diagnostic, never an implicit clamp or configuration rewrite. No per-poll wait writes, retry/budget change or new blocking progression step.
- **Versions and limits.** Runtime protocol 19 unchanged: capacity controls remain local composition operations like hold/resume; RunView and
  monitor changes are additive observation fields. Config and Run storage versions unchanged. Author checks and temporary binary proof live in
  external `proof/POOL-CAPACITY-2026-10-03/review.md`; R1 Windows fixture/refusal and R3 identity correction evidence is in `batch30-r.md` in the same folder.
  Independent review of the corrected candidate, lead landing, hosted/live acceptance and ≥8 native-worker throughput remain open.

### Patch scope classification (K6 = A; owner 2026-09-30, Jev ddbcaacd; lane Jev c93ceea4 / 4c772497 / bc205c7c)

- **Classification.** Engine `classifyPatchScope` matches every changed path of the host-produced patch (both sides of a rename, deletions,
  mode-only changes) against `workInput.scope.paths` of the Run-bound task: `{ schemaVersion 1, matcher 1, mode, status: unscoped | in-scope |
  out-of-scope, declared, outOfScope }`. No work input (v2 graph, prepared profile) = `unscoped`, never in scope. Derived from the immutable patch
  artifact and the Run snapshot frozen at admission (port `RunBoundTaskStore.loadBoundTask`, exact binding); nothing persisted.
- **Matching (`matcher: 1`).** The platform deny grammar on the full path (`*`/`?` within a segment, `**` across segments, `**/` zero or more
  directories, brackets/braces literal); a literal is one file, a directory is `dir/**`. `createGlobMatcher` lives in `platform/core/common`
  (moved unchanged from `workspace-read`, which re-exports it): one grammar, one matcher for the deny language, sandbox anchors and K6.
  Any change of match semantics bumps `matcher`.
- **Switch.** `execution.workTargets` schemaVersion 2 `targets[].scope.mode` `warn | enforce` (optional; absent, v1 or no target = warn),
  re-read per operation. v1 is released (pushed `21110d09`, run live) and stays unchanged: a v1 target with `scope` is refused.
- **Gates.** Patch prepare/preview and integration check always succeed and show the classification. In enforce, integration prepare refuses
  before the intent claim and delivery before the delivery claim: `PATCH_SCOPE_VIOLATION` (count, first 16 paths, omitted) or
  `PATCH_SCOPE_UNDECLARED`. No bypass flag; override = a new Run whose work input declares the paths. Published deliveries still settle.
- **Versions.** Patch artifact v1, ledger 43, protocol 18, Run snapshot, task graph 3 unchanged; SDK/CLI results gain an additive `scope`;
  `execution.workTargets` schemaVersion 1 → 2 (v2 = v1 + optional `scope`; an older build refuses v2); error registry +2.
- **Decided (owner 2026-10-01).** O1 (D9 C, Jev abee3e49): exact matching stays (`matcher 1` unchanged, a directory is `dir/**`); an
  additive derived hint suggests `dir/**` when a declared literal is the parent directory of an out-of-scope path (PLAN K6-HINT, not yet
  implemented). O2 (D10 A, Jev f01a3d7d): unscoped work is refused in enforce (`PATCH_SCOPE_UNDECLARED`), as shipped.
- **Open.** Delivery/inspect/report surfaces do not repeat the
  classification; real template-worker path unproven in tests (stored-graph stand-in); gitignored files still enter patches (PATCH-IGNORE card).

### CATALOG-V3 (owner 2026-10-02; Sol 2247 bounded PASS on a8a7c9d7; batch 26, on main and live since `dfb1b68f`)

Channel identity is client × billing/access path. Row key stays (channelId, exact channel model id); aliases are refused, never resolved. Document v3 adds vendorId/canonicalModelId, channel billing/protocol/provenance, limits, reasoning, capabilities and pricing in record; v2 remains readable. Canonical identity links models across channels without resolving an invocation to another channel. No SQL migration is needed for this slice: there is no canonical lookup operation; readers already load records. v13 model_activations remains the chat/profile authority, v43 model_catalog_activations the scoped worker authority. Recommended activation sets are documentation data, never registration effects. Unknown limits remain null and capabilities unknown.

V3 retains the v2 admission names (`nativeId`, `minCliVersion`, `efforts`, channel `cli`/`aliases`) and strictly requires equality with `channelModelId`, `minClientVersion`, `reasoning.supportedEfforts`, `client`/`aliasesRefused`; divergent records are refused. The envelope record version stays 1 because it accepts either validated shape; document version is 3. Reasoning vocabulary includes `ultra`. Decimal USD-per-million prices are strings; subscription seeds contain no per-token estimates. Monitor includes vendor/billing (null for v2) and marks a model active only if both channel and model activations exist in the same scope. Its boolean summarizes activation, not lifecycle/client eligibility or live provider availability. CLI human list renders vendor/canonical/billing/context/efforts/lifecycle and scoped activation in en/tr.

Validation: 12 targeted files 106/106; additional bounded composition admission 11 passed, 3 runtime-socket tests excluded after two transport-unavailable failures in the initial run. Six real mutations killed and restored; typecheck/eslint/lint-arch/core-memory passed. No full verify/build/live action. External evidence: `proof/MODEL-CATALOG-2026-10-02/review.md`. Broader CATALOG-SEED adapter tariff migration, refresh/lint changes and activation unification remain separate work.
