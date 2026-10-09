# Architecture


**W3-AUTHORITY (owner 2026-10-09; candidate, no live acceptance):** `deckent-mcp` uses the same verified OS UID with a distinct actor
(`issuer = <host>/mcp`, actor id suffixed `/mcp`). All handlers, including direct model-connect/activation writes, enter that code-only context;
service-bound calls carry `channel: mcp` on local protocol v26, lifecycle window `[26,25]`, current-only mutations. This metadata delegates no
other OS identity; same-account direct socket access remains an OS trust boundary. Owner grants and `principals: all` allow rules cannot grant
MCP authority; an explicit rule or role binding must name the MCP actor. Denies/restrictions still apply. Template v9 and add-only upgrades add
named observation rules only. Budget creation/revision/unfreeze/reconciliation, activation and invocation require an explicit MCP-specific grant;
these paths have no new approval broker, and `require-approval` keeps its typed unsupported refusal. MCP still exposes no decision tool.
Human approval decisions (allow and deny, CLI/SDK/terminal) require service-attested interactive stdin/stdout on the peer's controlling terminal,
rechecked with process birth/UID/connection evidence. Noninteractive decisions return `APPROVAL_INTERACTIVE_REQUIRED` before settlement;
no automation exception is added. Hard-floor allow additionally retains its turn-bound capability. A same-UID process can manufacture a PTY:
TTY attestation is an interaction requirement, not proof of human presence or account isolation. Ledger/approval formats and package version stay
unchanged. Contract/design evidence: `proof/W3-AUTHORITY-2026-10-09/`, [decision log](.deckent/docs/architecture/decisions.md).

**Owner amendment 2026-10-02 — MCP-NO-DECIDE:** MCP exposes no approval decision tool: neither `allow` nor `deny`; `list_approvals` and `inspect_approval` remain observation. CLI `approval decide`, SDK and terminal decisions retain their existing authority checks. This supersedes B1's MCP-deny exception; protocol and ledger contracts stay unchanged. Implementation `57c49ac6` (batch 25; on main and live since `aa58f559`); evidence `proof/LIVE-SWITCH-BATCH25-2026-10-02/`.

Ortak ürün/geliştirme ölçütü: [.deckent/docs/core-memory/project_product_north_star.md](.deckent/docs/core-memory/project_product_north_star.md).
Owner 2026-09-21: dar dilimler ürün hedefini küçültmez; mevcut kararlar yeni kanıt olmadan yeniden açılmaz.

**Owner 2026-10-05 — rol uzlaştırması:** Main Opus (`opus`), bağımsız inceleyen Astra (`gpt-6-astra`, `01a10b4c-23ad-7730-b492-9c81e1eeab98`, `astra`); Sol yalnız analiz, Codex lane’leri `gpt-6-astra`. 2026-10-04 Sol-main devri tarihseldir (COMPLETED-PLAN 2026-10-05); pano kaydı tek başına yetki/liveness kanıtı değildir. Uygulayıcı kendi değişikliğine bağımsız PASS vermez; commit, push ve canlı geçiş ayrı yetki sınırlarıdır.


## Spend settlement — owner 2026-10-08, landed in alpha.16 (PRs #47/#48) and alpha.17 (PR #49)

Accepted: `measured-tariff` records provider usage × a pinned published/operator tariff with exact bigint arithmetic, usage dimensions, tier and tariff digest; it never means provider-reported money. Reservation v3 / ledger49 migration follows the existing service-start backup contract. Unknown/cancelled calls settle only from the final event's own usage (Anthropic final `message_delta` carrying its own `output_tokens`; OpenAI-compatible usage on the finish chunk or a later usage-only chunk); an interim count is never promoted by a later finish marker, so the held reservation remains reconcilable, and a completed stream without its own final usage is an invalid response (Astra 2459 R1, 2462 R1). Governed, policy-checked `spend reconcile` records a settle/release/write-off receipt, preserves original hold evidence and cannot alter settled charges except the owner-admitted, explicitly labelled DeepSeek upper-bound reduction with retained evidence. Governed budget revision preserves history, increments the scope budget revision, permits lowering below outstanding spending (new sends refuse), and explicitly unfreezes. Paid OpenAI-compatible endpoints require verified vendor or declared versioned tariffs; legacy zero applies only to loopback. Account folds exact charges once; a correction above the reserved maximum freezes admission. Management receipts are immutable and capacity is checked before their transaction commits. CLI `models reconcile-spending` / `models revise-budget`, SDK `manageProviderSpend`, MCP `manage_provider_spending` share one command and policy cells `provider-spend-account/reconcile|budget-revision`; template v7 upgrades the installing owner only. PRICING (owner 2026-10-08, `lane/pricing`; landed in alpha.17, `8cc60c2d`, PR #49, Astra 2469): DeepSeek peak/off-peak rows reserve peak and settle missing-tier usage at peak as measured-tariff, tier `upper-bound`, never provider-reported money; governed reconciliation may lower once while preserving the original measurement. OpenAI published tariff v2 prices exact seeded `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna` with exclusive input/cached/write/output classes, Standard/Flex/Fast and the official 272000-input-token context boundary. Reservation bounds every applicable published Chat class/tier conservatively; settlement uses returned usage/service tier (a stream reports both only with its final usage; a conflicting tier is an invalid response, and any contradiction detected after the final usage withdraws it, so even a retention-capped refusal stays held — Astra 2467), and a missing or null cache split/tier remains held. Old v1 rows remain supported. Z.ai global `glm-5.3` and verified vendor-zero `glm-4.7-flash` rows connect (`glm-4.7` unchanged); Zhipu China remains locked because CNY prices cannot settle USD budgets. Evidence: `proof/PRICING-2026-10-08/`. T4-B consumes `lookupOpenAiCompatibleTariff(endpoint, modelId)` from `provider-openai-chat`. **Stage 1 (owner 2026-10-08, Jev 459611ed, `wave/stage1`):** `budget-create` writes a scope's first ledger account at revision 1 (one shared USD limit across every API provider; CLI/terminal use budget id `scope-budget`) under the same policy cell `provider-spend-account/budget-revision`; its receipt has no prior checkpoint and the account carries the command digest/id. A second create, or one beside a configured `provider_spending` budget, is `PROVIDER_SPEND_BUDGET_EXISTS` (next: revise). Admission resolves the budget ledger-first: the scope's account wins, a configured budget alone still opens the first account, neither is `PROVIDER_SPEND_UNAVAILABLE`. The account query's `current` form returns the scope's account whatever id/revision it holds (none: `scope-budget`/1 without checkpoint); MCP `inspect_provider_spending` keeps the exact form. CLI `models create-budget|revise-budget --scope --usd [--unfreeze]` and the `/model`·`/provider` budget window (presets 5/10/25/50/100, bounded stepper 1–1000, confirm, one system line; data `cli-models/internal/budget-choices.json`) build the same command. Landed in alpha.16 (PRs #47/#48, Astra 2463/2465); proof: `proof/SPEND-SETTLEMENT-2026-10-08/`, `proof/STAGE1-2026-10-08/`. OpenRouter v5 (OPENROUTER-TERMINAL, W2, alpha.21 `4afa7c81`, PR #60) reuses the common tools/stream transport with a metadata-priced quote and raw final `usage.cost` provider-reported settlement; the v2 OpenRouter gate bounds provider variants and conditional prices (details under provider-connect below; account-enforced plugin authority, independent batch review and live acceptance remain open).

## Document map (2026-10-05 simplification)

This file keeps the current contracts only. Detail moved verbatim (owner request 2026-10-05; `scripts/check-doc-preservation.mjs` proves no line was lost):
[Packages detail](#packages-current-implementation) → `.deckent/docs/architecture/modules/`; decision log → [decisions.md](.deckent/docs/architecture/decisions.md); approval/delivery contracts → [approval-and-delivery.md](.deckent/docs/architecture/approval-and-delivery.md); landed candidates (MONITOR-H1, AOF-DECISION-PORT, RUN-PROGRESSION-CONCURRENT, WORKER-EFFORT) and the landing cadence → [COMPLETED-PLAN 2026-10-05](COMPLETED-PLAN.md#2026-10-05--ssot-sadeleştirmesinde-taşınanlar); owner decisions history → [owner-decisions.md](.deckent/docs/decisions/owner-decisions.md).

## Northstar — owner 2026-09-17

Deckent, müşterinin kendi altyapısına kurulan bir Agent Control & Execution Plane'dir (owner 2026-10-07; önceki adı "Agent OS"): insan ve AI ajanlarının her eylemini yetkilendirir, yalıtır, çalıştırır ve kanıtlar; niyeti güvenli, paralel ve doğrulanmış işe dönüştürür. Alt etiketler: policy-driven agent runtime, governed execution, self-hosted agent control plane.
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
Owner 2026-10-01 Sol-review ataması tarihseldir; 2026-10-05 bağımsız inceleyen Astra, modelden bağımsız kanal adresi `astra`. A host-only user-systemd
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
- **Attempt kapanışı: launch-refused (RUN-YAŞAM, 2026-10-06, `wave/2`; Astra 2382/2384 sonrası):** dispatch claim'inden önce kalıcı ret (`EXECUTION_NOT_CONFIGURED|EXECUTION_HOST_UNSUPPORTED|EXECUTION_PROFILE_INVALID|DISPATCH_ARTIFACT_REQUIRED`, engine `classifyLaunchRefusal`) tipli `launch-refused {code}` gözlemi olarak bir kez kaydedilir (geçici retler kayıt yazmaz); görev `failed`, bağımlılar aynı projeksiyonda kapanır. Başlatılmış (granted) deneme için kapanış türü yoktur (`abandoned`/`failed` yolu kaldırıldı). Çalışanı kaybolan başlatılmış deneme main davranışında kalır: sessizce `active`, slotunu tutar, başarısız sayılmaz. `mark-lost` takip kartına ertelendi (owner 2026-10-06: atomik mark-lost — `unknown` gözlemi ile Run hold'u tek işlemde — + KARAR 12 slot bırakma kararı; Astra 2384). Ortak kaydedici `recordAttemptClosure`; ledger 47 değişmedi. Ayrıntı [approval-and-delivery](.deckent/docs/architecture/approval-and-delivery.md).
- **Monitor teslim görünümü (M2/M3, `wave/2`):** worker anlatısı yalnız kanıtlı alanlardan; `MonitorRun.deliveryOutlook` (`none|patch-not-prepared|awaiting-delivery`, makbuz her zaman öncelikli); `ResultBrief` opsiyonel `failedTests`/`deliveryOutlook`; düşen testler `verify-failed-test:` satırlarından read-output kapısı altında. Kaydedilmemiş PATCH_LIMIT sebebi uydurulmaz.


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

- **Kalıcı kimlik (ID-1/1B/1C/1D, batch 36):** `installation-files` adapter’ı `installationId` ve `projectId` kayıtlarını mevcut layout kaynaklarında kilit + atomik dosya yazımıyla yayımlar; ledger migration’ı değildir. `read`/inspect/follow kimlik, dizin veya kilit yaratmaz; kayıp/bozuk tutulmuş kayıt yeni kimlikle iyileştirilmez. Etkileşimli terminal `ensureConfiguredTerminalIdentity` üzerinden mevcut principal/scope/policy write-admission yolunu kullanır; kimlik yetki vermez. Taşıma/kopya uyuşmazlığı açık `deckent init identity --keep/--new` seçimine gider. CLI dağıtıcısı bu durdurmayı kuruluma bağlı her komuttan önce uygular; kurulumu kendisi yükleyen/kurtaran ve kimliği kendisi denetleyen komutlar (`init`, `config`: katalogda `installation: 'owned'`) ile kurulum gerektirmeyen komutlar (`policy vocabulary`: `independent`) bunu komut kataloğunda bildirir; `init` apply/resume/policy her etkiden önce yapılandırılmış layout’taki (özel `installationIdentity` kaynağı dahil) kurulum kimliğini ön kontrolün aynı denetimiyle okur; config yayımlayan bekleyen bir işlemde (apply/resume) yapılandırma yerleşmemiştir, bu yüzden recovery hedef layout’un kimliğini journal callback’i içinde yayından önce okur; config yayımlamayan bekleyen işlem (policy şablonu) yapılandırmayı yerleşik bırakır ve yapılandırılmış kimlik `loadConfig` `pendingBootstrap: 'config-settled'` ile yalnız gözlemle (heal, yazma, kilit yok) okunur, diğer journal çitleri değişmez; apply/resume’da geçersiz mevcut config layout çözmez ve üzerine yayın yapılamaz (tipli `INSTALLATION_PUBLICATION_CONFLICT`); ret tipli `INSTALLATION_IDENTITY_RELOCATED` kalır. O7 panel bağlamı bu güvenilir üreticiyi tüketir; kullanıcıdan gelen etiket kimlik kanıtı değildir.
- **Makine bağı yeteneği (VERIFY-ENV, 2026-10-06):** Makine bağı yeteneği yoksa (Linux'ta geçerli `/etc/machine-id` yok, örn. Docker konteyneri) kimlik bağsız v1 yazılır ve taşınma/kopya tespiti kapalıdır; bu düşüş `deckent doctor` çıktısında ve `--json` `installationBinding.capability` alanında görünür (kimlik/yetki davranışı değişmez). Yetenek denetimi proje dizinine karşı yapılır.
- **Kurulum bağı v2 (IDENTITY-BINDING-V2, owner 2026-10-06, `wave/2`):** kaynak sırası yapılandırılmış `installation.machineIdentity.source` (mutlak yol, bozuksa tipli `INSTALLATION_IDENTITY_SOURCE_INVALID`, daha zayıfa düşülmez) → platform (`/etc/machine-id`, IOPlatformUUID) → zayıf bağ (canonicalRoot + device + inode). Platform makine bağı alpha.6 v1 şekliyle yazılır (rollback güvenli); v2 (`binding.schemaVersion: 2`, `strength` machine|weak, `source` configured|platform|location) yalnız configured ve weak bağlar içindir. Karşılaştırmanın tek sahibi engine `assessInstallationBinding`: makine kaydı + yalnız zayıf yakalama = RELOCATED; `installation.requireMachineBinding` (varsayılan false) true iken makine kanıtı yoksa kuruluma bağlı yazmalar tipli `INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED` ile reddedilir. Kimlik yazma kabulü (Astra 2382 P1-3): `init policy --apply` ve `init apply/resume`, kimlik yazma kurallarını (configured kaynak, relocation, `requireMachineBinding`) `InstallationIdentityStore.admitWrite()` ile ilk kalıcı etkiden (journal, policy, bindings, config, ledger) önce salt okuma olarak uygular; apply/resume journal kilidi altında hedeflerden önce yeniden uygular; ret durumunda dosya veya journal yazılmaz. ID-1D korunur: read yolu yalnız gözler (`pendingWrite`), yükseltme yazma yolunda kilit altında olur. Yukarıdaki VERIFY-ENV "bağsız v1" düşüşü artık zayıf bağa yükselir. Rollback: weak/configured kayıtlar alpha.6'da INVALID okunur ([owner-decisions](.deckent/docs/decisions/owner-decisions.md) canlı geçiş notu); ayrıntı [platform-and-layers](.deckent/docs/architecture/modules/platform-and-layers.md).

### Product backup and restore — BACKUP-COMMAND (alpha.18 `94a8d089`, fixes in alpha.20 `cfe6d2e4`)

- `BackupApplication` owns one v1 typed create/verify/restore contract (`BackupCommand`, `BackupResult`), shared by the CLI and SDK;
  adapters implement storage, online SQLite backup, encryption and portable audit. Passphrases are a separate credential argument,
  absent from commands, policy decisions, receipts and errors. No MCP/model passphrase input is exposed.
- Sets contain a read-only-source SQLite online snapshot, `ledger.fingerprint.json` (integrity, schema version, ordered table counts/digests),
  a bounded gzip JSON archive of logical config/installation/project identity/policy/bindings/audit/artifact resources, encrypted
  `authority.key.enc` and `MANIFEST.sha256`. State v2 (S1 D1, 2026-10-09) archives the authored project and global configuration layers
  apart, without resolving secret references; v1 (alpha.18, one merged document) stays readable and its project-forbidden sections (those a
  registered `validateLayers` refuses in a project layer, e.g. `secrets`) move to the global layer. Restore publishes the project layer as
  the project config and only fills archived global sections the per-user global config lacks (present ones are kept and reported as
  `globalConfig.kept`; an unreadable file is kept as `.damaged-<uuid>`). Astra 2475: before any write restore computes the target's effective
  config (that global layer under the restored project layer); a pair the loader would refuse is `BACKUP_TARGET_CONFIG_CONFLICT {path, section}`,
  and when it names another `approvals.keyFile` the project layer pins the set's key name (`/approvals/keyFile` in `changedPaths`); the hold
  is removed only after the key that name opens has the set's key id. The ledger snapshot uses the rollback journal and every set ledger
  read is immutable, so no `-wal/-shm` appears in a set. Worker clones, provider login caches and secret-store credentials are excluded.
  Files are 0600 and created directories 0700; an existing directory restore writes into must be this user's and not group/other-writable
  (the policy/artifact/installation-file rule), checked before staging as `BACKUP_DIRECTORY_UNSAFE {path}` with `chmod 700`; links refused.
- Envelope v1 uses async scrypt (N=65536,r=8,p=1) + AES-256-GCM with fresh salt/nonce; AAD binds all payload hashes. Verification checks
  manifest, authenticated key, ledger fingerprint and archive bounds. Regenerating SHA hashes alone cannot authenticate modified contents.
- Whole-installation `backup/create|verify|restore` requires an all-scopes policy grant for the verified principal. Template v8 adds the
  installing owner's grant; `init policy --upgrade` uses the existing add-only plan/conflict rules. Existing denies remain effective.
- Each admitted operation first persists a sealed, immutable `backup-operation` audit receipt (principal/scope/policy, resource/path digests,
  operation id/phase); successful outcomes bind the ledger digest. These portable one-record streams reuse the existing audit seal and
  live under `audit/backup-operations`; restore receipts stay beside the set in `.deckent-backup-audit`, outside replaced state.
  They are separate from ledger audit pagination. Missing outcome means unknown; failed intent persistence admits no effect.
  Pre-authority parsing or total-loss authentication failures cannot produce a sealed policy receipt without a usable key/policy; they
  fail closed before storage effects. This bootstrap audit limit is explicit, not an accepted exception to the product audit target.
- Restore authenticates the entire set before publishing target state, requires an empty target or exact target confirmation, rejects a
  present service socket and acquires the service's same kernel ledger custody until publication finishes. Old resources/ledger sidecars
  are preserved as `.damaged-<uuid>`; the ledger lock inode stays. Relocation rewrites internal config paths, preserves installationId,
  reports the existing identity check and leaves `init identity --keep` to the operator. Scheduling resets to off. Publication spans
  several files: `BACKUP_RESTORE_INCOMPLETE` records uncertainty and retains the stage (`<target>/.deckent/.backup-restore-<uuid>`, 0700,
  never the decrypted key: it is decrypted at publication next to its final name) and damaged copies after partial
  publication. A confirmed target with a different retained installationId is refused. No cross-file atomicity claim. Astra 2471:
  a durable, fsync'd `.deckent/restore-hold.json` precedes the first replacement and is removed only after the last; config admission
  (`inspectInstallationBootstrap`, before the config cache) refuses it as `BACKUP_RESTORE_HOLD`, so service start and every configured
  command stay closed after a failure or process loss; only restore (`restoreHold: 'admit'`) proceeds and, while held, may fall back to
  the authenticated set's policy. Same-root restore keeps the current resource map: config and publication use one target layout (R2).
  A damaged existing policy is `BACKUP_POLICY_UNREADABLE {path, reason}` (move it aside, rerun restore); it never falls back silently.
  A successful restore removes earlier interrupted stages (also alpha.18's project-root location) and pending hold/key files; doctor lists
  them and shows an installation directory mode open to group/other. Evidence: external `proof/BACKUP-FIXES-2026-10-09/`.
- Config `backup.schedule` selects off/daily/before-upgrade; retention selects 3/7/14/30 sets. The service uses its configured scope and
  its verified hosting OS principal, the same policy and `BACKUP_PASSPHRASE` from the selected secret store. Daily due state survives
  restart in authenticated set timestamps; before-upgrade runs under service custody before schema migration. Stop waits in-flight work.
  The shared schedule event reaches SDK observers and `runtime serve` (localized text/JSON, sanitized failure codes).
  Only authenticated scheduled sets are pruned after a new complete set exists; other names are kept. Missing pre-upgrade credential
  blocks migration. KMS remains future adapter work. Linux native custody is the verified restore platform; other hosts refuse unsupported custody.
- Evidence: external `proof/BACKUP-COMMAND-2026-10-08/`; author checks, independent review, packaged acceptance and DOGFOOD admission remain separate.

### Deterministic storage and customer data access

- Product-state operations (Run, Attempt, Approval, reservations, receipts) are typed domain operations.
  LLMs neither generate their queries nor choose transactions, credentials, database routing or retry policy.
- Keep execution state, memory records, vector search, audit/events and artifact storage as separate ports.
  An index may be rebuilt from canonical records; it is not an independent approval or Run-state authority.
- **Artifact yayını (ARTIFACT-RACE, PR #7):** içerik-adresli dosya `link` ile yerine koymadan yayımlanır; `EEXIST` mevcut digest inode’unu korur ve kazanan içerik doğrulanır. Read/put, yalnız aynı dizindeki `.staging.` önekli regular adın aynı `dev`/`ino` olduğunu denetleyip linki kaldırabilir; ardından sıkı `nlink=1`, uid, mode 0600, no-follow, uzunluk/digest kontrolleri sürer. Yayıncının link→unlink arasında ölümü sonraki read/put ile uzlaştırılır. **Read fiziksel olarak salt okunur değildir:** staging temizliği yan etkidir; read cleanup için dizin fsync garantisi yoktur, gerçek read-only filesystem’de ret yayılır. Önek sahiplik kanıtı değildir; yönetilen dizin/aynı uid trusted-host sınırı sürer, saldırgan aynı uid izolasyonu veya tarama kapasitesi iddia edilmez.
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
- bwrap: yalnız ürün durumu tutan dizin boş salt-okunur tmpfs olur (`BubblewrapView.emptiedDirectories`), içerik ve giriş adları görünmez; karma dizin giriş-başı maskede kalır, layout kökü hiç emptied olmaz; ayrıntı [shell-realms](.deckent/docs/architecture/modules/shell-realms.md).
- W3-SANDBOX (owner 2026-10-09): sandbox hard floor is independent of call approval. Product authority/configuration stays read-only in both providers; Landlock seccomp also refuses chmod/chown families. Full-access shell requires an open sandbox and refuses host fallback/explicit host. The shared credential registry and host runtime/socket masks apply before execution; details and remaining mask bounds in [shell-realms](.deckent/docs/architecture/modules/shell-realms.md).
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
  unchanged. v17 was pushed with `7fbe476c` (released; further changes bump). v21 (T2 wave/tui-2, 2026-10-07; released with alpha.10): the strict permission-mode view
  gains `fullAuto` (a v20 client would reject it), so the single v21 package bumps once; lifecycle window [21,20]; later T2 items add to it until pushed
  (T2-FOLLOWUP: `setPermissionMode` `session` for session-only full access with audit kind `permission-mode-session`; `decideApproval`
  `approverNote: true`, sealed as decision `schemaVersion: 3` (other decisions stay v2; an earlier build refuses only v3 with `APPROVAL_INTEGRITY`), the turn gives that reason to the model; `approval.requested` `undo`, shell `posture`, the card fields `call` and the cut facts `previewCut` — Astra 2431).
  v21 was pushed with alpha.10 (released). v22 (T3 `wave/tui-3`, 2026-10-07; released with alpha.11, PR #42): approval records whose subject is `config-change` reach
  clients (list/inspect/decide); a v21 client still has them hidden (`approvalSubjectsHiddenFromProtocol`). Lifecycle window [22,21]. No other T3
  wire field (MCP trust and proposal windows reuse `approval.requested`; read-tool `diagnostic` stays in the service).
  v23 (T4 MODEL-SWITCH) was pushed with alpha.14. v24 (SECRET-STORE-SWITCH, owner 2026-10-08, alpha.15): one operation `switchSecretStore`;
  lifecycle window [24,23] (a v22 service is outside; a v23 client cannot reach the switch). W2-SECRETS adds optional `confirmEnvMissing` to the switch command. When leaving env, config `$DECK:` names that resolve from env but are absent from target name metadata require this explicit confirmation; the check runs inside custody, before audit/publication, and never reads values. CLI asks yes/no on a TTY (also with `--to`); scripts use `--confirm-env-missing`; doctor exposes the same per-target names and explicit probe failures. A non-enumerable target cannot prove presence and is refused when env references exist. Secret set/delete and the switch share one installation-wide custody section (Astra 2456 P1-1); a contended change is `SECRET_STORE_BUSY`, a change prepared on a store that a switch replaced is `SECRET_STORE_CHANGED` (no wire field changes). v25 (SPEND-SETTLEMENT, released with alpha.16, PRs #47/#48, 2026-10-08): bounded `manageProviderSpend` (reconcile, budget revision, stage 1 `budget-create`); lifecycle window [25,24]. T4-B adds no operation (`models.connect` runs in the CLI/SDK/MCP/terminal process). Stage 1 widened one input inside the unreleased 25: the account query also takes `{scopeId, current: true}`. Live since alpha.16 (window [25,24]); alpha.17 (PRICING) adds no protocol change.
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
  Current state (2026-10-07, wave 4): the package entry `deckent/extensions` registers provider/config units before one
  composition root seals the registries (late registration is a typed refusal; the SDK root exports no `register*`).
  EXT-SERVICE-ENTRY (2026-10-08, W2): a distribution registers its modules, then calls
  `runCli(argv, { serviceEntry? })` or lazy `runMcp(argv)` from `deckent/extensions`. `runCli` carries the
  distribution executable (`serviceEntry`, default `process.argv[1]`) through automatic service start and managed
  restart, replaying registrations in the new process; direct `runtime serve` retains the same-process registry.
  `runMcp` accepts the Core `--project` contract, resolves catalog hints from its registered modules and delegates
  execution to the governed service. Both processes must use the same distribution; bare Core bins discover no
  modules. SDK root exports no new entry or registration. Public entry imports no heavy package until called.
  EXT-SERVICE-ENTRY landed in alpha.20 (`cfe6d2e4`); proof is
  `proof/EXT-SERVICE-ENTRY-2026-10-08/` (17 targeted tests; offline tarball service/MCP, unregistered refusal,
  detached restart, lazy graph and zero-dependency NodeNext/Bundler consumer types). These are author checks,
  not independent acceptance; the fixture seeds its ledger via existing storage composition before public requests.
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


### TERMINAL-UX T3 contracts (2026-10-07, on main via PR #42; owner decisions in owner-decisions "Owner kararları — 2026-10-07")

- **Config change approval (L2, Jev f0214347/9181d2be):** a config write is allowed by the policy `config`/`write` rule for that layer and scope;
  a `require-approval` rule turns `set`/`unset` into a pending approval with subject `config-change` (command, layer, key, redacted before/after,
  previewed layer digest, value digest, `ruleId`; ledger v48 widens the `approvals` CHECK). The same command resubmitted after `allow` applies
  once under the layer lock after re-checking the digest (`CONFIG_APPROVAL_STALE`), the policy and the accept window; the audit `config-change`
  record names the consumed `approvalId`. `ConfigApplication.permissions` is a read-only per-layer view for the `/config` window; `set`/`unset`
  stay allow-only for other callers. Policy `approvalAssurance` may name `subject: config-change`. Model-originated calls (agent tools) have no route to this write;
  an external MCP client (e.g. `connect_model`) reaches it only as the separate `<host>/mcp` actor with a named MCP policy grant plus the same policy/approval checks.
- **Config selection (CS-1, owner 2026-10-08; alpha.15 `4d6f1582`):** `platform/core/config-fields` owns explicit value-choice declarations, numeric presets/units/steps and the small allowed-entry registry. Zod supplies bounds; nullable fields offer None/Never, `max_workers` includes auto, and single-value literals are hidden. One read-only surface `ConfigChoiceSourcePort.list(source, keyPath)` is composed with actual principal scopes, active scoped model catalog (one whole `terminal.chat.reference` choice), policy company, inspected pools, task kinds, layout key filenames, Git branches, PATH executables, probed local images, identity profiles and serving profiles. Discovery bounds (Astra 2456): Git/Docker processes have a timeout, output ceiling and entry limit; the PATH probe checks at most `CONFIG_DISCOVERY_BOUNDS.pathDirectories` (256) directories under one deadline; a directory listing reads at most `maxEntries × 16` entries (every entry seen counts) and stops at the timeout; symlinks are never candidates. Directory names, generated IDs and service environment names replace ordinary free text. Only masked secrets and explicitly new URL/host entries can open a validated preview; structured documents initially remain read-only; the W2 author candidate below adds bounded record editors/import. TTY config arguments open the picker and cannot reach the typed write parser, including its text fallback; script/CLI parsing stays unchanged. Every selected write retains the same governed `ConfigApplication` policy, approval, digest and audit path. Author tests and source proof are in external `proof/SLASH-WINDOWS-2026-10-08/CS1-WORKER.md`; independent review, packaged/native platforms and live acceptance remain separate.
- **Config record editors (W2, owner 2026-10-08; alpha.20 `cfe6d2e4`, PR #57):** `/config` adds selection-only add/edit/remove for `provider_spending.budgets`, `inspection.workers.sources`, `execution.adoption.targets`, `execution.workTargets.targets` and `layout.resources`. Budgets reuse stage-1 USD choices and declare config only; an existing ledger account still wins. Source ids are generated; work targets select branches from the chosen repository, retain the one-target/versioned contract, and removal unsets the optional parent to restore fallback. Layout selects registry resources and locations, refusing fixed resources, escapes and exact path collisions. `ConfigApplication.inspectValue` refuses secret-bearing records; `preview` uses the existing planner/layer validation/policy without publication. Confirmation uses the same `submit`/approval/audit path with the target-layer preview digest; it creates no other state owner. Large provider/profile/operation catalogs use bounded regular-file selection, schema/layer validation and redacted before/after preview; complete section imports support required siblings. Imports retain the selected bytes through confirmation. New-definition selection sources for `admission.registry` and `identity.packages` remain an owner decision in `proof/CONFIG-RECORD-EDITORS-2026-10-08/DECISIONS.md`; no new registry authority is inferred. Native platforms/live acceptance remain unperformed.
- **MCP servers (L1 + owner MCP decisions):** registry entries are stdio or Streamable HTTP (`type: http`, `url`, `headers`; SSE refused; https
  only, plain http only to loopback; `$DECK:` secret references in headers/env only in local/user files). The policy kind `mcp-server`
  (id = registry name, action `invoke`, Jev 04f75210) authorizes an MCP tool call instead of its `agent-tool` wire name (an explicit
  `agent-tool` deny of the wire name still denies), together with the `mcp.tool.call` operation. A trust approval writes the approver's own
  `mcp-server` grant for that server through `policy.administer@1` inside I2, `require-approval` + `modeEligible` (Jev 71eeb4ab: standart asks,
  full-auto lowers with an audited relaxation, full access runs; `mcp-floor` always asks); revoke/remove/reset/decline remove it; pin drift
  needs no policy change (a drifted tool is not offered). The default realm of a stdio entry is `sandbox-net` (K4, Jev 68a10d1a: bubblewrap with
  network, a private persistent HOME per server, project read-only, user HOME/project secrets/Deckent state hidden, resolver files bound; no
  sandbox → no start); `host` is explicit and warned. The client pool is keyed by scope view (scope id + project root) and launch identity
  and bounded by `mcp.maxServers`. `propose_mcp_server` (read tool) opens a human window in every mode, carries no secret or reference
  (Jev 30efcb91) and adds the server untrusted; `deckent mcp import` brings Claude Code/Desktop entries untrusted.
- **Fresh installer secret default (W2-SECRETS, 2026-10-08):** Docker `init apply` also runs the existing encrypted-store default after successful fresh publication on Linux/WSL/macOS. It keeps existing selections, leaves Windows on env, and reports policy/env-guard refusals without undoing installation. A supplied policy must authorize `secret`/`switch`; the installer adds no grant. Replay does not change the store.
- **First-run policy template v9 (v5 MCP decisions: Jev 04f75210, d3d1817d; K1 option A Jev 3e7c5b38):** the installing owner holds `mcp-server` for every server in
  every scope, the `mcp.tool.call` operation, the read tool `propose_mcp_server`, and in the installed scope the `policy.administer` operation
  and approval inspect/decide (every change still passes card, audit and I2). Existing installations: `deckent init policy --scope <id> --upgrade
  --preview|--apply [--expect <revision>]` (installer authority: only the installation owner — the caller's uid owns both authority documents —
  and only when the first-run read rule names the caller explicitly; anyone else uses the governed path) adds the current template rules that person lacks, removes
  or replaces nothing (same-id rules with other content are kept and named as conflicts; hand-added MCP wire-name rules are named), writes on the
  previewed revision through the archived authority writer and the configured layout; a second run is `current`; an older policy receives
  only missing rules (an untouched v4 becomes exactly v9: v6 secret-store switch, v7 model activation/invocation and provider spend accounts,
  v8 installation-wide backup, v9 six `inspect`-only observation rules for the person's separate `<host>/mcp` actor — W3-AUTHORITY, owner 2026-10-09). `deckent policy upgrade --template current [--apply|--rollback]` applies the same plan through `policy.administer@1` (I2) where the
  person already holds that authority. The deprecated `--template v5` selector uses the same current add-only plan and emits an EN/TR warning.
  A hand-built policy (no first-run read rule; POLICY-UPGRADE-HANDBUILT, lead 2026-10-08, Jev b6dba079) takes the installer plan only with
  `--person <issuer>/<subject>`: the same owner gate, and the person must already be named explicitly (never `all`) on an allow rule listing the
  scope; added rules are in that scope (`mcp-server` and installation-wide `backup` stay every scope) and name that person alone. Without `--person` the refusal names
  `--person` and the people the policy names there; on a template policy `--person` must be the person the read rule names. The installer
  path records a sealed `authority-change` before publication and keeps the archive. Its strict installer variant carries the OS caller,
  target person, template/basis, deterministic change key, input digest, before/after revisions and counts; it has no approval/decider fields.
  Preview, refusal, conflict and current do not record a change. No audit, no policy write; an event alone does not prove publication.
- **Terminal units:** `cli-terminal` (L0: the interactive launch, ledger ports and handler types moved out of `cli` behind ports; lazy
  `launchTerminal`); `terminal-picker` gains the pure `pickerReduce` core and `ListPicker` (L3); `terminal-panels` (L4: `/mode`, `/config`,
  `/mcp` bounded windows, presentation only, ports and words from `cli-terminal`); `/monitor`, `/watch-workers`, `/watch-runs`, `/tasks` are
  bounded modal live windows (L5: `MonitorBody` loaded through a host port; one visible window at a time). Full access shows a standing
  warning line above the composer. Detail: [terminal-surface](.deckent/docs/architecture/modules/terminal-surface.md).
- **Slash windows and system summary line (SLASH-WINDOWS, owner 2026-10-08; alpha.15 `4d6f1582`, PR #46):** in the TTY terminal every
  informing slash command answers in a bounded `Window` (Esc closes), never in the chat stream; `/clear` erases the screen and the terminal's
  scrollback (ED 2 + ED 3, TTY only, also with NO_COLOR; nothing on TERM=dumb or a non-TTY) and starts a new conversation (saved history stays for
  `/resume`), `/exit` exits. A closed window leaves at most ONE system line: `systemSummaryEntry` (terminal-work) is the only factory, a
  `notice` with `SYSTEM_SUMMARY_ENTRY_ID`; `LedgerEntryRow` is the only render point, through `SystemSummaryLine` (terminal-window: own rail,
  `◆ Deckent system` label, tone from the level, secret-projected). The `/mode` change (window and Shift+Tab), settings window results (`/model`
  pin, `/config`, `/mcp`, `/provider`), a feed access refusal and the opening line for running work (I-5; nothing when idle) use it too. Hosts: the panel controller (job, approval, resume, settings windows) and one local window slot (`useWindowSlot`: information and list
  windows); all are `Window`s in one stack, which owns focus, and an approval card hides the slot until answered. **Typed arguments (owner I-1):**
  with window words a slash command typed with an argument runs bare in every host and its window says once (`WindowNoteContext`, never on an
  approval card) that the terminal takes no typed argument; the typed text is never shown, queued or kept in the input history
  (only `/command`, Astra 2456). Information and list windows project every visible word through the known-secret / human-text projection,
  whole, before layout (Astra 2456 P1-2). Line mode and the CLI keep arguments.
- **Shell and identity (L6):** the shell scanner reads a redirection operator whole (`2>&1`, `N>&M`, `&>`); stream silencing/merging to
  `/dev/null` or a descriptor keeps a read a read, a file target stays a write; a sandboxed write to a protected path explains itself in the
  tool result (EN/TR); a registry directory that is its own tmpfs mount inside a sandbox is `*_IDENTITY_MASKED`, not a lost identity;
  read tools record `diagnostic` (`step`, `errno`) on `not-found`/`path-changed` (B4 root cause still open).

### TERMINAL-UX T4-A contracts (2026-10-08, `wave/tui-4`, released with alpha.14, PR #45; owner decisions 2026-10-07/08, Jev a172b1ad)

- **ORPRIVACY-STATUS identity (owner 2026-10-09, W6 author candidate):** the status line, `/model` rows, switch notice and `/usage` show
  `model (provider display name)`; provider words resolve through the provider-connect registry, with exact custom ids as fallback. Session
  labels follow the conversation's existing pin; usage captures the turn's model/provider before streaming, so later switches do not rename
  earlier token reports. Semantic `model` blue and `provider` purple tokens are generated from `design/tokens/terminal.map.json` for dark/light
  and daltonized themes. Truecolor and ANSI256 meet 4.5:1 on the declared reference backgrounds; ANSI16 uses host blue/magenta and cannot
  attest a custom host palette. NO_COLOR keeps both names without styles; a narrow status drops the identity pair together. Styling consumes
  only already projected text, preserving whole-label secret masking. Proof and platform/live limits: `proof/ORPRIVACY-STATUS-2026-10-09/`.
- **`/model` (MODEL-SWITCH):** lists the declared catalog models by exact reference (provider id@version / model id@version) with the first
  missing precondition as a locked row's reason (invocation profile in the scope, its `credentialRef` in the secret store, chat activation, with
  the exact `deckent models activate` command); discovered models are never added or activated. A pick pins the model for this session: the
  next and later turns carry it as `chatTurn.reference` (protocol v23, lifecycle [23, 22]); the service uses exactly it for binding, profile,
  prompt, digest and rounds, or refuses typed — the configured `terminal.chat.reference` never answers in its place (S19). "Also make default"
  writes `terminal.defaultModel` (T4-B below). Rows show human words; the exact
  reference and the fixing command appear dimmed for the focused row only.
- **W6 MODEL-SWITCH (owner 2026-10-09, lane author candidate):** selection has one scope/context confirmation. Before pinning, the same scoped
  `ModelInvocationApplication.preview` checks current invocation policy, binding, active record, profile, native preparation, verified quote and
  read-only account capacity; policy/profile are rechecked after preparation. No invocation claim, spend reservation or model send occurs. Known
  protocol/price/budget failures lock the row with an EN/TR next step; confirmation rechecks them. Only an already-active identical binding whose
  catalog revision is stale can be refreshed, using the existing governed `activate` command and its exact revision compare-and-set. Inactive or
  changed bindings refuse; invocation admission stays exact. Cache-only profile migration changes version/cache, not binding/catalog/activation;
  every turn resolves the current profile. Session pins remain keyed by conversation; a switch discards its old context measurement. Esc closes
  preparation and a late completion cannot pin. Unknown future prompts, remote availability and catalog capability errors remain invocation gates.
  Turn closure/restart prose comes from EN/TR catalogs (old English restart receipts are localized on replay without rewriting evidence).
  Context counts stay numeric for admission and use locale-aware compact units for display; model windows come from the selected profile and
  provider count, taking the smaller known window. Local author proof and unperformed HTTP/TLS fixture gate: external `proof/MODEL-SWITCH-2026-10-09/`.
- **`/provider` (PROVIDER-CONNECT):** kinds and endpoints are adapter data (`adapters/core/provider-connect`, registry v1; ChatGPT sign-in listed
  unavailable). Connect: the address, where the kind takes one, is chosen from a list (owner 2026-10-08 D3: the configured `inference_serving`
  server, the registry's known local servers, the provider default; a typed "new address…" is the last row only, checked by the endpoint rule —
  https, plain http only to loopback — and previewed) → masked key (the one permitted typed value) under the custody note → one free
  GET that needs the key (models list / key record, no redirect, bounded), mapped by `classifyProviderRejection` (an unknown 429 is
  `limit-reached`) → only on success the key goes to `setSecret` (runtime service, policy cell `secret`, audited by name). The key is never in
  env, files, rows, scrollback, audit or model text; workers never get it. The check runs in the terminal process. Results stay in the window
  (owner 2026-10-08: slash output only in a window). Binding models to the key is T4-B (`models.connect` operation, owner 2026-10-08; landed in alpha.16).

### TERMINAL-UX T4-B contracts (2026-10-08, `wave/stage1`, released with alpha.16, PRs #47/#48; owner D1/D2 2026-10-08, Jev d84b248d, da5312fb)

- **`terminal.defaultModel` (D1):** an additive optional key (exact catalog reference only; no config version bump, the `readResultMaxBytes`
  precedent); the project layer is refused (`TERMINAL_DEFAULT_MODEL_PROJECT_LAYER`). One pure precedence, `resolveTerminalModel` over the two
  authored layer documents (never the merged config): session pin > project-authored `terminal.chat.reference` > user `terminal.defaultModel` >
  user `terminal.chat.reference`. The service turn, the line-mode command, the plan (`source`) and the preflight use it; `terminal.chat` stays
  required (its `maxCompletionTokens`). `/model` "also make default" writes the key on the global layer through the governed `/config` writer
  (policy, approval card, audit; the user file is created when missing) and the window names the setting in effect (a project's own model wins).
- **`models.connect` (D2):** one operation, one contract (`modelConnectCommandSchema` → `ModelConnectResult`) on CLI `deckent models connect`,
  MCP `connect_model`, SDK `connectModel` and the terminal (`/provider` → "Connect a model"). Engine `ModelConnectApplication` over ports,
  composition unit `model-connect`: the provider-connect registry (v2) names each kind's adapter, chat path and packaged seed
  (`assets/model-catalog/<seed>.json`, v3, exact vendor ids). Steps, each on its owner's governed path: ledger catalog register when the
  channel/model is missing → declaration in `provider_catalog` on the layer that authors it (a new content-named revision) → this scope's
  activations still valid under the new revision are re-admitted (a catalog revision change otherwise breaks every activation) → the invocation
  profile on every layer that authors profiles (user first: a project snapshot stays a subset) with endpoint preset, the connection's secret NAME
  as `credentialRef` (https only; plain-http local servers get none), published tariff (Anthropic) or, for the OpenAI chat adapter (stage 1), the
  exact verified row of `lookupOpenAiCompatibleTariff(endpoint, nativeId)` (`published`); a remote model without one is refused before any
  catalog/config write (`MODEL_CONNECT_TARIFF_UNVERIFIED`; the adapter step runs first), only loopback keeps the zero tariff (`unmetered`), registry limits with the response limit narrowed to what the installation's result frames deliver → chat activation →
  one `model-connect` audit subject. A config approval stops the run (`approval-pending`); the same command id continues. No key value is taken.
- **Prompt cache, first slice (CACHE-SLICE1, owner 2026-10-09):** the provider-connect row's `cacheDefault` (Anthropic only, `none|5m`; shipped
  `anthropic-api` = `5m`) is written into a NEW profile's definition (`cache: '5m'` → the adapter's existing top-level automatic `cache_control`).
  An existing profile keeps its own value on every re-run (absent stays absent, `none` stays `none`; the adapter port receives the written
  definition). Existing profiles without a cache field are offered a governed one-step migration in `/model` and `/provider` (engine
  `planProfileCache` + adapter `providerProfileCacheOffer`: `cache: '5m'`, version + 1, one `/config` writer call per authored layer with policy,
  approval and audit; a profile authored in both layers is named, not changed, because a project profile must equal a user-layer one). Each call
  reads its own profile (model switch, pin and worker paths carry no override); the reservation prices every input token at the dearest enabled
  class (miss + write) plus the full output. No paid keep-alive or prewarm; TTL 5m only; breakpoints/1h/allocator are slice 2.
- **OpenAI Responses (OPENAI-RESPONSES, owner 2026-10-09; W6 author implementation):** `openai-chat-http@6` speaks `/v1/responses` while
  preserving the typed `openai-chat-completions@v1` facade and binding digest. Sourced per-model registry routes select Responses for Astra,
  Sol and Luna; effort support/defaults are route data. Flat function tools/results, typed refusals and bounded SSE reuse the existing transport,
  egress, cancellation, reservation and spend owner. `store:false` is mandatory; no server conversation. Opaque encrypted reasoning for tool
  continuations stays process-local, bounded and tied to scope/profile/tools/message prefix; restart/expiry drops it. Reservation bounds actual
  wire bytes and additionally each replayed opaque block's originating output-token ceiling; ciphertext size is not a token count. Reasoning is a subset of
  output, split for audit at the output rate; cached reads/writes use the pinned tariff and reported actual tier. Only validated completed/incomplete
  terminal-event usage measures spend; later contradictions (including a truncated tail) withdraw it. Missing cache-write count or unknown
  published tier stays unmeasured. Existing v4/v5 exact verified profiles migrate only through `/model` "Güncel protokole geç": route preview,
  fresh snapshot/digest, governed config write with policy, approval and audit; keys, binding, activation, allocation and scope stay attached.
  Shared-layer profiles are named and held under the same subset rule as cache migration. HTTP400 vendor details require the existing content
  inspection policy and localized next step; the common failure wrapper's translation belongs to W6-MODEL-SWITCH. Synthetic parser/SQLite/config
  author evidence is separate from independent review and live acceptance; sources/proof: `proof/OPENAI-RESPONSES-2026-10-09/`.
- **Provider rows (Jev da5312fb):** OpenAI, DeepSeek, Z.ai GLM (global) and Zhipu GLM (China) each keep their own secret name; the generic
  OpenAI-compatible row derives `DECKENT_OAICOMPAT_<HOST[_PORT]>` from the chosen address and shows it before saving. Z.ai documents no free
  read: its rows have no probe (the key is kept unverified). Owner 2026-10-08: no paid call to a remote endpoint without a verified price — the
  generic row's remote address is refused (`MODEL_CONNECT_PRICE_REQUIRED`, its window row locked) until a declared-price picker exists (the
  operator tariff v2 data path is in SPEND-SETTLEMENT); vendor rows take the verified price at one point (`connectionAdapter`, provider-connect)
  and the `/provider` model list locks an unpriced seed model ("Price not verified — paid calls are refused"). Snapshot 2026-10-08: among the
  OpenAI-compatible seeds only DeepSeek `deepseek-flash`/`deepseek-v4-pro` are priced (their peak/off-peak rows settle held until reconciled).
  Seeds exist for Anthropic, OpenAI, DeepSeek, Z.ai global, Zhipu China and OpenRouter (verified exact ids/tags;
  China remains locked on unsupported currency; OpenRouter call admission still checks fresh metadata). Open decisions (DeepSeek/Z.ai wire parameters, metered OpenAI-chat tariff) are in external
  `proof/T4B-2026-10-08/DECISIONS.md`.

- **Round 2 (owner K1–K5, 2026-10-08):** OpenAI chat adapter **v5** carries the provider's documented request dialect on the definition (registry
  data per row: `tokenLimitField` max_tokens | max_completion_tokens, `streamUsage` include | omit, allowed `tool_choice`; DeepSeek max_tokens with
  stream_options, Z.ai/Zhipu max_tokens without stream_options and tool_choice auto only); v4 profiles keep the OpenAI wire and are still served;
  the evidence records the served version (Jev d69089cf). First-run policy template **v7** adds `model-activation` activate/inspect (every scope)
  and `model-invocation` invoke/inspect/inspect-content/cancel-invocation (installed scope), and (combined with SPEND-SETTLEMENT in the same v7)
  `provider-spend-account` inspect/audit/reconcile/budget-revision (installed scope); `init policy --upgrade [--person]` adds only the
  missing rules (Jev 125e4435). Seeds `zai-cn-api` (docs.bigmodel.cn) and `openrouter-api` (exact ids + first-party endpoint tags; W2 now connects through openai-chat v5;
  the legacy OpenRouter adapter remains text-only) (Jev bca0e8c6). The connect
  result lists kept (`carriedModels`) and not-carried models; the summary line only counts (Jev e3dcf2eb). `terminal.chat.reference` is
  optional: a shadowing project model gets two governed answers in `/model` (remove it / make it this one; project layer, reference only)
  (Jev 77898686). `/model` and `/provider` lock on a missing scope budget (`PROVIDER_SPEND_UNAVAILABLE`; stage 1: a ledger account counts, and the lock offers
  "Create budget"); an old shared key name
  (`legacyKeys`) is warned and removable.

**OPENROUTER-TERMINAL (owner 2026-10-08, Jev 7e0348c4; alpha.21 `4afa7c81`, PR #60):** the `openrouter` provider-connect row binds `openrouter-api` models to openai-chat v5. The registry pins the seed's verified first-party tags and endpoint-supported token field (current rows: `max_tokens`), automatic usage without stream_options and the repeated-finish accounting-frame dialect. New seed entries also declare openai-chat; the legacy OpenRouter protocol remains available. Terminal and worker share the existing tools/stream transport and configured spend authority. The OpenRouter quote covers the entire published prompt bound, including tool definitions/history, plus requested completion/reasoning and request rates; streaming framing never reduces that reservation. Only the final event's own raw numeric `usage.cost` settles as `provider-reported`, preserving exact decimal credits. Interim usage stays held; a contradiction after final usage withdraws it even in a retention-capped refusal. A clean cut after trustworthy final usage can settle; a cut before it stays held. HTTP 402, including `error.metadata.limit_source`, reaches the existing `spend-limit` typed refusal. **OPENROUTER-GATE (owner 2026-10-09, Jev f6b91327, dearest_bound_extension; W4 author candidate):** tariff/reservation evidence v2 accepts bare provider slugs by bounding every captured matching endpoint/variant/region (including currently unavailable and opt-in tier variants as a conservative superset). Each priced dimension takes the exact decimal maximum across base and every conditional override; no discount lowers the bound. Reservation uses the maximum published prompt/context bound × max(prompt, cache-read), plus that bound × max(cache-write, cache-write-1h), requested output × completion and any independently priced reasoning, plus maximum per-request fee, with per-dimension upward cents rounding. The versioned closed-text inclusion rule records omitted optional published SKUs separately from explicit null/unknown reachable pricing; the latter is a typed pre-POST refusal. Both the legacy and common v5 path send text-only modalities, provider.only, allow_fallbacks:false, require_parameters:true, maximum routing prices and explicit enabled:false for the eight plugins whose current OpenAPI exposes that flag. Caller plugins/media/server-tool types and :online are refused by the closed request path; local function tools retain their execution owner. Quote/reserve adds no network beyond governed metadata acquisition. **ORPRIVACY-STATUS (owner 2026-10-09, W6 author candidate):** acquisition also reads the public same-origin `/api/v1/endpoints/zdr` under the original deadline, TLS/no-redirect/no-auth boundary and a versioned 16 MiB ceiling; it binds the source URL/raw-body digest into reservation evidence. Admit only exact model/tag ZDR membership or explicit endpoint `training:false` + `retainsPrompts:false`; explicit contrary endpoint metadata excludes the route, missing policy is never guessed from provider names. Prefer the configured tag’s compliant variants if an available one exists, otherwise choose compliant hosted alternatives. `provider.only` lists exact compliant tags, with `data_collection:"deny"` and `zdr:true`; dearest bounds include every selected compliant variant, even unavailable ones. An empty compliant set raises typed localized `OPENROUTER_PRIVACY_UNAVAILABLE`, names the OpenRouter privacy settings and stops before claim/reservation/POST; account guardrails may still refuse later. Official sources and Context7 availability are recorded in `proof/ORPRIVACY-STATUS-2026-10-09/SOURCES.md`. Final usage.cost settlement and contradiction/cut holds remain unchanged. Retained real JSON and local TLS producer-to-settlement tests are author evidence, not paid/live acceptance. Current official documentation permits account-enforced plugins to override request disable flags; lead decision 2026-10-09 (Jev fe16e844 0.92/0.78) lands the gate with an owner precondition: before the first paid OpenRouter call the owner checks https://openrouter.ai/settings/plugins that no plugin is enabled with "Prevent overrides" and sets an OpenRouter credit limit no higher than the Deckent budget. Deckent cannot verify either account setting, so unconditional paid-call safety is not claimed. Sources, checks and open limits: `proof/OPENROUTER-GATE-2026-10-09/`; prior transport proof: `proof/OPENROUTER-TERMINAL-2026-10-08/`.

**CONVO-PARSERS W8 (owner 2026-10-09, lane author candidate):** canonical assistant history has an optional bounded continuation envelope v1
(`scopeId`, exact model reference, served profile digest, immutable native JSON). DeepSeek `reasoning_content` and OpenRouter's complete ordered
`reasoning_details` are preserved unchanged, separately from preview text, and returned only to that scoped profile, including after terminal
snapshot reload. Empty/whitespace assistants without tools are omitted from emitted, persisted and outgoing history; tool-only assistants and
usage/receipts remain. Z.ai's verified response dialect accepts an absent `object`, preserving identity, model, tool and usage checks. Its
`sensitive`, `model_context_window_exceeded`, `network_error` and DeepSeek's `insufficient_system_resource`, `aborted` map to typed EN/TR turn
closures without automatic retry; valid final usage settles separately, missing or contradictory usage stays held. Anthropic withdraws a cached
final measurement on later contradiction/malformed events, including retention pressure; a clean cut after trustworthy final usage keeps it.
Picker readiness and confirmation use invoke's exact binding/catalog checks. A direct invocation can repair only an already-active identical
binding in its own scope through the existing authorized `activate` CAS, never by rewriting other scopes or accepting stale revision evidence;
deactivation, changed binding or denied activation refuses before sending. `/reasoning` offers off only for the selected model's supported
thinking-switch capability. The current preference reaches switch preparation; an unsupported target refuses with EN/TR words before activation
or pinning. Proof: `proof/CONVO-PARSERS-2026-10-09/WORKER.md` (free in-process socket-boundary fixtures, actual parsers/invocation/SQLite;
HTTP/TLS, provider live acceptance and independent review remain separate). Responses, spend-hold redesign and OpenRouter privacy stay in their lanes.

## Packages (current implementation)

Layers: `platform` (config, errors/i18n, identity, paths) → `domain` (pure versioned contracts) → `capabilities` → `engine` (transitions, ports) → `adapters` (SQLite, Git/Docker, sockets, MCP) → `composition` (explicit wiring) → `surfaces` (SDK, CLI, MCP, terminal). Gates: `arch.json` + `scripts/lint-arch.mjs`. Full per-area text:

| Module note | Scope |
|---|---|
| [platform-and-layers](.deckent/docs/architecture/modules/platform-and-layers.md) | Layer map (`src/platform … composition`), startup cost, compiled entries, CI preparation, hardcode ratchet (HARDCODE-P1-B). |
| [config-and-cli-help](.deckent/docs/architecture/modules/config-and-cli-help.md) | Typed `ConfigApplication`, CONFIG-SURFACE write/overlay contract, CLI config view, CLI help catalog. |
| [terminal-surface](.deckent/docs/architecture/modules/terminal-surface.md) | Operator terminal contract v1, turn phases, tool lines/read limits, `@` index, `/resume`, `/context`, TC-M harness. |
| [agent-turn-engine](.deckent/docs/architecture/modules/agent-turn-engine.md) | Agent turn loop, durable turns, `chatTurn` runtime (protocol v12+), context measurement, compaction, history lifecycle, system prompt, reasoning control. |
| [agent-tools](.deckent/docs/architecture/modules/agent-tools.md) | Composer `@file`, file edits as C11 effects, scratch area, `run_shell`, `terminal.fetch`/`network.fetch@1`, tool calls over openai-chat, terminal direction. |
| [shell-realms](.deckent/docs/architecture/modules/shell-realms.md) | Shell realm, bubblewrap and Landlock providers, doctor realm report, sandbox scan speed. |
| [ci-and-verification](.deckent/docs/architecture/modules/ci-and-verification.md) | CI-FULL, CI-FIX, CI-SPEED (one build/Node, complete shard collection), SOCKET-PUBLICATION, platform verification tooling. |
| [permission-modes](.deckent/docs/architecture/modules/permission-modes.md) | MODES-3 (standart/full-auto/full-access), decision and audit, write postures, FA-TRACKED-WARN, `/mode`. |
| [record-redaction-and-safe-approval](.deckent/docs/architecture/modules/record-redaction-and-safe-approval.md) | Canonical record redactor, terminal S06, SAFE-APPROVAL-A1 custody (former "Current closure"). |
| [host-qwen-decision-pilot](.deckent/docs/architecture/modules/host-qwen-decision-pilot.md) | Canceled development-host Qwen decision research (owner2026-10-06; historical host tool outside customer src/native). |

## Package contract

- Public API is `index.ts`; everything else is internal.
- Every configured text source file ≤ 1,500 lines (eslint + lint-arch; 800 design target), functions ≤ 150 lines (warning).
- Package line budgets and the total budget live in `arch.json` (`budgets`); growth past a budget is a
  design decision, not a lint fix.
- lint-arch geliştirme kapıları (ARCH-GUARDS, 2026-10-06): src-boundary, test-host-import, host-word, slug-cap, tier-direction, tier-budget, effect-flow; `arch.json guards`, `budgets.tierLines`, `literals.allowUnits`; ayrıntı [platform-and-layers](.deckent/docs/architecture/modules/platform-and-layers.md).
- Model-ingress P2 (`wave/2`): modele giden ham alanlar (mesaj, araç sonucu, onay önizlemesi, MCP açıklaması pini) `projectModelIngressField` ile gizli/bidi/tag Unicode için işaretlenir, aynı not onay kartında ve terminalde EN/TR görünür; audit subject `model-ingress` yalnız özet taşır; `AgentTurnPorts.recordIngress`, `AgentTurnInput.fullAccess`; sıra mesaj → projeksiyon → carry. Ayrıntı [agent-turn-engine](.deckent/docs/architecture/modules/agent-turn-engine.md).
- Hata kataloğu (KATALOG-TEMİZLİK, `wave/2`): registry'de numaralı `DECKENT_Exxx` kodu yoktur; `ERROR_CODES` içinde src'de başvurulmayan kod sözleşme testiyle yasak; 5 `LAYOUT_*` kodu `config` kategorisinde (çıkış 78) ve `ConfigValidationError` kayıtlı reason'ı `KOD: yerelleştirilmiş cümle` render eder; DispatchError kodları registry'de olmadan `INVENTORY_UNAVAILABLE`'a düşmez; SDK export envanteri 4 fabrika azaldı. `surfaces/core/doctor` birimi doctor insan render'ını taşır (`surfaces/core/cli` bütçeyi 2000'de tutmak için bölündü).
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
  SQLite 3.51.3, the WAL-reset corruption fix); 24 and 26 are supported (CI matrix [24, 26]; owner 2026-10-06 requires Ubuntu 24/26 for merging; macOS/Windows remain separately visible platform verification;
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
- `tests/perf/` — ayrı `tests/perf/vitest.config.ts` serisi (`*.perf.ts`): üç yolda gecikme kapısı (p95 ≤ 500 ms, taban JSON); varsayılan paketi etkilemez; eşik ölçüm girdisidir, ürün config'i değildir.

## Documents

The Markdown gate admits the five product/roadmap documents `README.md`, `ARCHITECTURE.md`, `PLAN.md`,
`COMPLETED-PLAN.md`, `CHANGELOG.md`, plus owner-admitted repository standards (2026-10-03): `README.tr.md`,
`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/PULL_REQUEST_TEMPLATE.md`,
`.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`;
public reader guides `docs/glossary{,.tr}.md` and `docs/architecture-overview{,.tr}.md` (owner-approved pre-beta DOC-03/DOC-04 fixes, 2026-10-09);
≤70-line permanent product-development contracts `CLAUDE.md`, `AGENTS.md`;
≤5-line pointer `.codex/AGENTS.md`; `.deckent/docs/core-memory/*.md`;
and the explicit refactor host-kit globs in `arch.json`: the remaining 20 `.agents/skills/<skill>`
directories/references plus `.claude/agents`, `.claude/rules`, `.codex/rules`.
The host kit is excluded from product distribution (`package.json files`: dist/native/assets/README/LICENSE).
Product Markdown generation is limited to owner-admitted `deckent init` project instructions (DECKENT-MD, 2026-10-08): detected project facts, preview and explicit consent, plus selected append-only bridges. Owner-maintained host instructions remain a development-only exception.
Repository standards are human/host-maintained files; Markdown admission does not extend product write authority.
The existing `markdown.writerModule` gate is unchanged. `.github/CODEOWNERS` and issue `config.yml` are
non-Markdown community configuration; GitHub settings, actual review and private reporting availability
remain separate proof. Node/pre-release badges read public main package metadata; npm badges stay commented
until the first verified publish. README and SECURITY name the recorded release (alpha.17, 2026-10-08), not a fresh live check.
Owner 2026-10-02: `deckent-next-refactor` retains its name as the shared entry guide for owner-admitted
Next development, fixes, refactoring, reviews and handoffs. Codex, Claude and Cursor resolve this skill
to the same `.agents/skills/deckent-next-refactor` source; specialist skills supply task-specific methods.
Jev details live in the skill's `jev-workflow.md`, read before case preparation or consultation.
Owner 2026-10-06 host amendment: checks remain Noul, with local advisory non-binary/multi-question diagnostics;
report v3 orders recorded requests by time within a bounded scan and exposes missing decision/outcome and label coverage.
Undated/truncated recency and absent outcomes remain unknown; agreement is not correctness. Provider thresholds,
full curated charter, both abstentions, immutable receipts and product authority stay unchanged. Evaluation freezes
claim/state/labels and model version; context compaction requires measured quality retention, not automatic promotion.
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


Owner 2026-10-05 (SSOT simplification): detail documents under `.deckent/docs/decisions/`, `.deckent/docs/architecture/` (including `modules/`) and `.deckent/docs/plan/` are tracked, admitted by `arch.json` `markdown.trackedAllowGlobs` and written by humans/hosts only. `scripts/lint-docs.mjs` bounds PLAN.md (≤ 60 KB, no line > 800 chars) and this file (≤ 1200 lines); it also binds the first CHANGELOG release and the highest README/README.tr/SECURITY alpha claim to package.json, requires commit-SHA + PR receipts for landed releases (alpha.1–4 predate PR-based landing, PR #1 opened 2026-10-04, and carry the SHA only), and rejects stale landing phrases in architecture documents (only a line prefixed `historical:` is exempt). A top release explicitly marked `Unreleased` alone may omit its landing receipt; `scripts/check-doc-preservation.mjs` proves that text moved out of PLAN/ARCHITECTURE still exists verbatim.
Design reasoning goes into [decisions.md](.deckent/docs/architecture/decisions.md).

## Decision log

Full table: [decisions.md](.deckent/docs/architecture/decisions.md). Accepted decisions are preserved; reopen only for owner direction or material new evidence. New lasting decisions: add a row there and update the contract above.

## Task approval, live sessions and isolated delivery

Contract summary (full text: [approval-and-delivery.md](.deckent/docs/architecture/approval-and-delivery.md)):
- Task admission approval is an additional restriction before capacity-limited selection and is rechecked in the reservation transaction; absence of a rule is not an execution grant.
- Requests, decisions and receipts live in the shared ledger with scoped MAC custody, explicit expiry renewal and one application across SDK/CLI/MCP; old receipts never expand.
- A verified principal and a live session are different contracts: privileged decisions bind OS process/TTY/session evidence and the runtime socket lifetime; MCP never decides (MCP-NO-DECIDE).
- Core components read the platform `SystemTrustedClock`; wall skew is bounded by `MAX_WALL_SKEW_MS` and orders records only; expiry and elapsed limits use exact/monotonic rules.
- Operation approval (C12), roles/bindings/four-eyes (H34), company scope registry, operation target registry and the unified catalog are registry-driven; Enterprise/ERP layer on without editing Core.
- Secrets (SecretStore), MCP client send authority, delivery-pinned Runs and adoption verification binding keep one owner per state transition.
- MCP istemci kayıt dosyası ancak denetlenmiş güven kararından sonra yazılır (add/remove audit reddi kayıt ve güveni değiştirmez; karar sonrası yazım hatası audit'li revoke ile geri alınır); worker imajı otonom yenilemesi (K2) `toolchains.update` policy verisidir (`mode` varsayılan `auto`, `atStartup` `true`, `intervalMs` 24 sa; registry yalnız proje katmanından CAS ile yazılır, global katkıda tipli hold; kapı her dizin yazımından önce, stop yenilemeyi bekler); ayrıntı [approval-and-delivery](.deckent/docs/architecture/approval-and-delivery.md).
- Toolchain/model currency, work targets, typed work input, pool hold/capacity and patch scope classification are specified in the full document.

CI-SPEED author candidate (owner-approved CI stability, 2026-10-06): local integrity custody write-mode opens reuse the existing bounded per-path config lock through creation/flush/close; read mode stays read-only. Strict owner/mode/link/inode/32-byte validation is unchanged; an existing partial key is not repaired. The real first-creation race and exact author proof/open limits live in the ci-and-verification module note and external `proof/CI-SPEED-2026-10-06/`; this is not independent or hosted acceptance.

### Project instructions (DECKENT-MD, owner 2026-10-08)

The v1 reader loads workspace-root `DECKENT.md`, falling back to `AGENTS.md` only on absence; Deckent never loads `CLAUDE.md` as model context. Context grants no authority. The adapter registry bounds raw and masked content to 32 KiB; canonical secret masking precedes the trust preview and model delivery. Special files, symlinks and hardlinks fail closed; an invalid primary never falls back. The terminal re-reads before each turn, opens a bounded Ink trust window for an unseen digest, and Escape continues with the file withheld. Line mode requires `--trust-instructions <sha256>` for an unseen digest. `/context` reports the loaded source path, original byte size and SHA-256.

Consent is bound to canonical workspace root + device/inode + content digest in the owner-private user-global `instructionTrust` resource, outside the workspace. Project `DECKENT_HOME` cannot relocate this cache; an explicit global root inside the workspace is not trusted. A cloned/replaced root cannot inherit consent. Unsupported or unsafe persistent storage uses session-only consent and asks again after restart; native Windows persistence remains open. `DECKENT.md` joins the workspace write approval floor.

Bare `deckent init` selects detected/chosen bridge rows, previews the derived project name/npm script names, then confirms. `init --preview` is read-only. Existing DECKENT content is preserved; selected bridges append `@DECKENT.md` to `CLAUDE.md` or `Read DECKENT.md` to `AGENTS.md`. No unselected file is created, no script is executed and raced/forged previews are refused. Application uses the configured `terminal.scopeId`, local OS principal, fresh policy, required operation approval and existing `workspace.file.write@1` target/C11 settlement. Missing scope/policy refuses writing; this slice creates no policy grant. Changes settle per file; a later failure can leave earlier files settled and their durable receipts retained.

Worker context is deferred under the owner's terminal-first allowance: `compileNativeCodingWorkInput` consumes explicit template `composition.context`, then `composeNativePrompt` delivers it through the existing native prompt channel. Its 16 KiB part/32 KiB total bounds and missing digest-trust custody need an admitted snapshot before worker dispatch. Terminal author verification is in external `proof/DECKENT-MD-2026-10-08/WORKER.md`; independent batch review, packaged/native platforms and live acceptance remain separate.
