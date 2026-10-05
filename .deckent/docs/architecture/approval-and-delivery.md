# Task approval, live sessions and isolated delivery

Full contracts (moved from ARCHITECTURE.md 2026-10-05; the short contract summary stays in ARCHITECTURE.md).
Kaynak/Source: ARCHITECTURE.md @58537c7f lines 2566–3344; text below is verbatim.


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

CI-FIX-R5 source candidate (`lane/ci-fix-r5`, 2026-10-04): nonempty stale config-lock recovery retains the
existing generation tombstone, verifies that the observed generation moved and is no longer named at the lock,
then exclusively creates a sibling `.reclaimed` receipt before emitting the typed warning. Two successful Windows
rename returns therefore cannot elect two warning claimants; a same-generation no-op remains bounded contention.
The receipt cannot block a new lock owner. A receipt IO failure propagates after movement, retaining the tombstone;
a later caller can acquire the free lock. A crash between movement/receipt and warning can omit the warning;
this is not an exactly-once notification guarantee across crashes. Live, foreign and unreadable owners remain holds.
Receipts and tombstones remain retained without automatic pruning. Evidence and exact candidate identity:
external `proof/CI-FIX-R5-2026-10-04/README.md`; exact ff871b73 source/evidence review passed (assigned2331 plus supplementary review), while hosted platform acceptance and landing remain open. Owner published PR1. Hosted run37227979617 finished5/6 with a WindowsNode26 migration fixture30s timeout. CI-R6 ac431a26 has bounded independent three-file source/docs/evidencePASS and owner publication to PR1; it separates three unchanged corruption checks into independent fixtures under the existing30s budget. PR body was repaired through REST with exact readback after the old CLI failed. Luna final report for hosted37229533893 records all six required jobs SUCCESS; every artifact pins tested PR merge e9ad0f0d28549ed0bf370e1cc9b146c2af53b21b, distinct from headac431a26. PR1 was squash-merged on2026-10-04 to remote main99edf8f50ae2ea1b18e3b305a48c2992d7c7749b; its tree is identical to reviewed R6ac431a26. New-main push run37233301305 on exact99edf8f5 concluded2/6 required jobs successful: Ubuntu24/26 SUCCESS, macOS24/26 and Windows24/26 FAILURE; all six artifacts bind that commit/run. PR green evidence is not a new-main result. Four isolated CI diagnostic/fix lanes preserve validation/security/disposal invariants. Live remains owner-only. Protected dirty local main was not switched. No config-lock/product authority changed.

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

### ACCEPT-EVIDENCE source candidate (2026-10-03; lane/accept-evidence, base 9740baae)

Coding `workInput` adds optional `noChangeAllowed`; only explicit `true` allows an empty verified workspace patch.
This is task policy frozen in the existing graph contract; registry-selected process-exit criteria remain pure and unchanged.
The TaskEvaluation owner composes those criteria with `workspaceChange` v1 (`patchDigest`, `changedFiles`), read from the
same bounded, exact-identity retained patch used for delivery, never from a worker report. Empty patch without the exception
means task `failed` with `notAcceptedReason: no-change-produced`; absent evidence parks as evaluation-not-ready; corrupt
or foreign evidence refuses evaluation. The existing patch owner prepares missing evidence with read-output/recover-output
and work-target policy, without custody release; replay returns the receipt without recapture. Patch digest is a third bounded
recovery token alongside output/model seal, enabling one return after patch preparation. Inspect and monitor render EN/TR.
Graph v2 and tasks without workInput keep their existing criteria; analysis-type policy and migration of fixed native profiles
are not inferred. Legacy evaluation receipts replay unchanged. New fields are additive to current strict schemas; older builds
refuse records carrying these fields, so downgrades across new evidence require the existing governed backup/restore path.

Docker terminal observations add `container` v1 to the existing dispatch terminal: immutable container Id, image digest,
nullable daemon start/end timestamps (nanoseconds preserved), and the frozen CPU/memory/pids/tmp resource profile.
The labelled exact-request observation is carried by execute/cancel/reconcile into the same attempt-bound dispatch record.
A conflicting later descriptor is refused; missing historical evidence is not fabricated. Container/workspace release never
removes that dispatch record. Inspect workers/inventory and monitor lastAttempt expose it after release/reopen. The record
contains no argv, mounts, environment, endpoint or secrets; one bounded descriptor per dispatch, no new history table or
sampling loop. Existing ledger storage has no attempt-row age/count prune; existing custody sweep/page/monitor limits stay
unchanged. This adds constant bytes to already retained rows, not a claim of globally bounded ledger growth. It enables
joining externally sampled metrics, but does not itself measure CPU/memory or prove engine attribution.

Author evidence and open checks: external `proof/ACCEPT-EVIDENCE-2026-10-03/review.md`. Independent review, lead landing,
hosted OS coverage and real Docker producer/custody checks remain distinct from deterministic adapter tests. No N1 command
or live service mutation is admitted by this source change.

BATCH32-ACCEPT-R (2026-10-03; dirty candidate on `54849915`): the retained lead cancel failure has a root-level
container-schema chronology rejection. Optional evidence validation must not throw through a known terminal observation.
Docker projection validates only the whitelist; invalid or reversed daemon times fall back to both timestamps unknown
(`null`), retaining valid immutable ids and the frozen resource profile. Invalid ids/profile omit the optional descriptor;
exit/unknown truth remains independently observed. The strict shared schema and whole-descriptor monotonic merge stay
unchanged; no timestamp clamping, invented duration or later descriptor overwrite. Exact failing host time strings are
not present in the retained log; sandbox Docker socket EPERM prevents capture. Regression/check evidence and remaining
lead real-Docker rerun are tracked in `proof/BATCH32-2026-10-03/accept-r.md`; independent acceptance remains open.

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
- **Effort.** Validated and recorded in the Run graph only; no CLI adapter passes it (Claude Code documents `--effort
  low|medium|high|xhigh|max`, Codex `-c model_reasoning_effort=…`; a mapping changes argv, the WC-R2 binding and preflight
  flags — separate slice).
- **Also.** Installation preview validates a template through its Docker base (image id); toolchain currency lists template CLI
  pins (`parameters.invocation`) next to prepared profiles.
- **Versions.** Task graph 2 → 3 (side by side); registry v1, Run execution snapshot v1, ledger 43, runtime protocol 18, config 3,
  prompt delivery v1 unchanged. An older build refuses a v3 graph (strict parse, observed as the generic inventory refusal) and
  refuses to execute a template. Error registry +4 codes.
- **Open.** RunProposal v1 (D15b) and `run retry` not in this slice; no `run create --card` convenience (would change CLI help
  templates / i18n parity snapshot); scope paths are classified at patch preparation and enforced per work target (K6); effort has no execution effect; the
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
- **Versions and limits (historical slice).** Runtime protocol 19 unchanged at this slice (20 since S02-W2): capacity controls remain local composition operations like hold/resume; RunView and
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
