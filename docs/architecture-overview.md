# Architecture overview

[Türkçe](architecture-overview.tr.md) · [Glossary](glossary.md) · [Contributing](../CONTRIBUTING.md)

Deckent is a customer-installed Agent Control & Execution Plane. It combines authorization
and execution: a person, model or tool proposes work; policy determines whether it may run;
a configured execution environment performs it; durable records describe the outcome.
The open Core is Apache-2.0 and can operate independently. Proprietary Enterprise packages
are designed to extend its public contracts and remain separately distributed.

This is a reading guide to the source architecture, last checked against source on 2026-10-24, package
`1.0.0-alpha.55`. It describes mechanisms and boundaries, not installed/live acceptance, a security certification or
capacity benchmark. [ARCHITECTURE.md](../ARCHITECTURE.md) contains the detailed contracts,
implementation notes and accepted future direction; some of that material is in Turkish.

## Layers and dependency direction

The source tree separates decisions from I/O and presentation. Each unit has a public entry;
callers use that entry rather than another unit's internal files. The composition root is
where implementations are selected and connected.

| Layer | Responsibility | Example |
|---|---|---|
| Platform | Shared infrastructure contracts and utilities | Configuration schemas, layout resolution, clocks and translations |
| Domain | Pure types, validation and state-transition rules | Task states, policy decisions and effect records |
| Capabilities | Reusable capability contracts | Model/provider capability descriptions |
| Engine | Applications that own transitions and declare I/O ports | Admission, scheduling, approval, model calls and delivery |
| Adapters | Implementations of those ports | SQLite storage, Git workspaces, Docker, shell sandboxes and provider transports |
| Surfaces | Human and tool interfaces to applications | CLI, terminal and MCP |
| Composition | Explicit wiring and executable entry points | Core runtime service, CLI and MCP entries |

Domain code does not open files, send requests or select database drivers. Applications own
the sequence and state change; adapters perform the required I/O. Architecture checks enforce
the declared import graph, public unit boundaries and additional dependency constraints.
A surface presents results; it does not introduce an alternative scheduler or policy engine.

```mermaid
flowchart TB
  S["Terminal · CLI · MCP · SDK"] --> A["Typed applications<br/>principal · scope · resource · policy"]
  A --> D["Pure domain rules"]
  A --> P["Ports"]
  P --> IO["Adapters<br/>SQLite · Git · sandboxes · providers"]
  C["Composition root"] -. selects and wires .-> A
  C -. selects and wires .-> IO
```

This diagram shows responsibilities, rather than granting every layer unrestricted imports.
The exact allowed dependency graph is declared in [arch.json](../arch.json).

## One application contract, several surfaces

The SDK, CLI, terminal and MCP share versioned commands, queries, results and errors. An
operation carries a verified principal, scope and resource; policy is checked at the application
boundary. The runtime service owns operations that need persistent execution and coordination.
Installation, observation and some patch operations compose locally through the same contracts.

Shared semantics do not mean identical authority on every surface. MCP can inspect pending
approvals but has no approval-decision tool. Decisions made through permitted human/SDK paths
still require the applicable identity, policy and live-session checks. A persona, a model's
recommendation or a timeout cannot turn a denied action into an allowed one.
AI decision steps need explicit named-actor/action cells; authority-changing actions remain
non-delegable even with an allow. A terminal witness is an interaction requirement, not proof of human presence.

Client/service protocol versions, ledger schema versions and package versions are independent.
Normal operations require compatible clients and services; the limited lifecycle window can
permit inspection or stopping across adjacent versions without permitting normal execution.
Storage upgrades use explicit migrations and backup requirements. A newer executable does not
make an older database or running service automatically compatible.

Policy details: [human and AI authority, delegation and compliance evidence](policy-and-ai.md).

## Work lifecycle and durable effects

A **Run** admits a graph of **Tasks**. Each **Attempt** records one execution try, including its
worker, workspace and evidence. Applications reserve capacity, respect dependencies and policy,
record execution observations and evaluate outputs. Acceptance, patch integration and delivery
are distinct from process exit. A failed prerequisite can close dependent tasks as skipped;
that is not work that ran successfully. `deckent do` (`/do` in the terminal) asks one connected, active model
(Brain) to plan an intent into a Run proposal; the plan passes the existing admission and approval gates and
grants no authority itself. Delivery to a registered Git integration target goes through that target's queue:
publish and adopt each show their frozen batch and need a separate confirmation, and rollback is its own
confirmed operation.

The transactional SQLite ledger stores work, reservations, approvals, effect records and
receipts. Sealed audit records bind decisions to their context. Resource limits, cancellation,
expiry and crash recovery preserve evidence instead of silently discarding uncertain work.
A Run can park for a decision or missing evidence. A missing worker result is not success.
The current lost-worker closure path still has limitations: a granted attempt can remain active
and retain its slot until custody is resolved.

For external effects, the generic operation contract records intent before sending, carries an
idempotency key and checks the observed target precondition. Where a target can prove settlement,
the receipt records that evidence; otherwise the result remains unknown for reconciliation.
Compensation is a new authorized operation, not an invisible undo. Git patch workflows retain
outputs, test integration against a pinned base and protect delivery from changed targets.
Some older execution/delivery paths still have their own settlement mechanisms; migration to
the generic effect port is incomplete. An extension should reuse the generic contract.

Paid model calls reserve against the scope's shared USD budget. Final usage and a pinned tariff
produce the measured charge using exact arithmetic. This is Deckent's calculation, not the
provider's invoice. Missing final usage keeps funds held; reconciliation records an explicit
settle, release or write-off. Per-provider budgets are still planned.

## Security and isolation

Installation is the hosting/trust boundary. Company is a scoped data boundary, not a directory
sandbox. The intended scope hierarchy is installation → company → optional site/unit → project
→ session; not every organizational administration surface is implemented. Scope membership
and permission to act are checked separately. Policy may allow, deny or require approval;
mandatory restrictions cannot be relaxed by a user setting.

Approval requests bind the action and context, expiry and authorized decision. Permission
modes automate only eligible actions. **Full access** needs a company grant, re-checked at every launch
and call; it can be switched on for one terminal session or stored as the person's start mode. It deliberately broadens host filesystem, home, network and Git access. Denies and
the hard floor remain effective, with effect calls audited. Full access should be understood
as a different exposure level from closed sandbox execution.

Shell execution uses registered backends such as bubblewrap and Landlock; coding workers use
Docker. Git worktrees separate outputs but do not isolate processes, networks or secrets.
Docker shares the host kernel. A `require-sandbox` shell posture refuses unavailable confinement;
`prefer-sandbox` can fall back to the host and reports that posture. Inspect `deckent doctor`
on the actual machine before relying on a sandbox.

Provider API keys are resolved through the configured secret-store port and are masked from
agent-facing content. Native subscription workers can receive bounded credential projections;
that path is distinct from a provider API key. File and encrypted-file stores do not protect
against every program running as the same OS user; the encrypted store's unlock key is local.
A compromised host, broad container mounts or incorrectly granted full access remain meaningful
risks. Check filesystem, process, network and secret boundaries together.

## Extension points and current limits

Public SDK exports are explicit. `deckent/extensions` currently exposes operation-adapter,
secret-store, approval-assurance-producer, MCP-capability-group and provider no-charge-certification
registration, a secret-helper factory, and CLI (`runCli`) and MCP (`runMcp`) entries for a distribution
that adds those registrations.
Registration must happen before composition seals the registries; late registration is refused.
Configuration selects registered implementations and policy authorizes their use. Registering
an adapter gives it no execution grant.

A trusted distribution may register an optional [secret helper](secret-helpers.md) through
the same SecretStore port. Its command and bounds are fixed at registration; config selects
only its id. Each lookup needs an application authorization decision, with bounded time/output
and sanitized errors. The helper is read-only, has no external-name enumeration and is not a
sandbox. Existing store-migration restrictions and platform limits still apply.

The extension model lets a separate package supply a target adapter through the existing effect
contract, or a secret store through its port, without editing Core. It does not promise that
every internal registry is public. Service and MCP startup replay of a distribution's registrations is
wired (`runCli`, `runMcp`) and exercised by the manual `npm run smoke:dist`; it is not part of CI. ERP integrations and customer identity/SIEM adapters are architectural extension
boundaries, not verified available connectors.

The supported execution path today is Linux and Windows WSL2. macOS and native Windows have
separate platform verification and incomplete execution/security support. The locked bubblewrap
bundle currently ships x86_64; an arm64 build check alone is not arm64 runtime proof. Source
builds stage the locked bubblewrap (the build ends with `bubblewrap=present` or `bubblewrap=staged from …`); on Linux a build that cannot
stage it stops with `BUBBLEWRAP_BUILD_REQUIRED`, and only off Linux does it print `bubblewrap=absent (not Linux)`.
See the [contributor quickstart](../CONTRIBUTING.md#a-30-minute-quickstart).

Package `1.0.0-alpha.55` adds the core layers: system assignment of worker models and one model role registry, a scoped memory
journal with independent verification, sealed Auditor records, Nervous detection with lost-worker recovery, the headless subscription
Brain in a bubblewrap realm, and versioned agents with statistics, suggestions and signer keys. They are code, not accepted behaviour yet. Every switch
(memory, Nervous, recovery, agent statistics) starts off until a person turns it on; its `shadow` mode applies nothing, but
memory-verification and recovery shadow still call their model. The headless Brain has no switch and works only after the
person's own login, connect and consent. alpha.55 has no command that promotes a Nervous rule, so Nervous executes no stop step
and automatic recovery cannot start yet; see [core layers](../.deckent/docs/architecture/modules/core-layers.md).

Mission-level coordination of multi-step business processes, a remote HTTP API,
Desktop, Dashboard, Enterprise SSO/fleet management and microVM isolation remain future work.
Local checks do not establish fleet-scale performance or a supported production deployment on
an untested platform. Evaluate a selected provider, operation and isolation configuration with
its actual success, refusal, cancellation and recovery paths before adopting it. [Known limits](known-limits.md) lists in plain
words what is untried, not built or still open.

## Audit integrity and pull witnesses

`deckent audit verify --scope <id> --json` verifies all retained event seals, sequence continuity, checkpoint chaining and checkpoint audit heads in a consistent read snapshot. SDK `verifyAudit(root, {schemaVersion: 1, scopeId}, options)` and read-only MCP `verify_audit` use the same policy-authorized read. The scoped approval `inspect` grant is required. Doctor and service `audit-integrity` reports expose degradation; anything not verified (nothing recorded yet, a throwing or unavailable verifier, a service that has not verified any scope) shows unknown/degraded with its reason and is never healthy, and `audit verify` exits 1. Checkpointing cannot be disabled by configuration. This detects tampering relative to retained evidence; it does not prevent an agent using the same OS account from changing local files.

Export with `deckent audit verify --scope <id> --export-checkpoint` (JSON on stdout, or `null` if no checkpoint exists). A separate device must retain that original export independently. Compare it later with `--checkpoint <file>` or `--checkpoint -` for stdin; SDK/MCP take the same object in `witness`. No output path or witness network address is sent to the service.

The version-1 export is `{schemaVersion: 1, kind: "deckent-audit-checkpoint", checkpoint, digest}`. Its strict checkpoint contains `schemaVersion`, `installationId`, `scopeId`, `sequence`, `atMs`, `head: {sequence, digest}`, `policyDigest`, `producersDigest`, `previousDigest`, `keyId` and `mac`. Digests/MACs are lowercase SHA-256 hex; the export digest hashes the canonical sealed checkpoint. The head hashes canonical complete sealed audit records in sequence, starting from a scope-bound empty head. The checkpoint HMAC covers its unsigned canonical projection; the predecessor digest binds the previous sealed checkpoint. The existing installation key must remain available; no secret or policy content is exported.

Results distinguish `match`, `truncated`, `possible-wipe`, `policy-changed`, `producers-changed`, `chain-broken` and `unknown`; `deckent audit verify` exits 1 for anything but `match`. A missing original key, foreign witness or configured verification limit remains unknown; old ledgers say `no-checkpoint-yet`. Each checkpoint is announced by a sealed `audit-checkpoint` audit event written in the same transaction, and that event is the checkpoint's head. A marker whose checkpoint is gone (deleted rows, a removed tail) reports `possible-wipe` / `checkpoints-missing`; a dropped checkpoint table on a current ledger is `chain-broken`. Neither is ever replaced by a fresh baseline; only a scope with no checkpoint and no marker gets its first one. `deckent audit rebaseline --scope <id> --reason <text>` is the one explicit way back: it needs the scoped approval `decide` grant on `audit-rebaseline` (refused for AI actors), a witnessed interactive terminal and a y/N on the shown state; it accepts only a policy/producer drift or a possible wipe, and seals the reason in the new marker. Witnesses exported earlier no longer match. Deleting the markers too means truncating the audit log back past them; that removal of both local histories, or a complete wipe, requires a retained external witness to detect. The time between checkpoints is an unanchored tail; complete rollback/removal of local evidence cannot be ruled out by local evidence alone. Policy changes are detected even when the revision label stays the same; a governed policy change (`policy.administer`, `/mode`, the installer template upgrade) seals the digests of the policy it changed and of the policy it produced in its audit event; verification accepts only an unbroken chain of such writes from the last checkpoint, so it stays `match` and the next checkpoint adopts it, while an out-of-band file edit — even one followed by a governed change — reads `policy-changed` until a person re-baselines. The re-baseline card shows the audit head and digests, and the write is refused and asked again if any of them changed after the answer.

The service owns checkpoint publication on startup and its configured interval. Scans are bounded by `audit.pageSize`, `audit.maxRecords` (events and checkpoints) and `audit.maxScopes`; they do not report a complete verification after reaching a limit. Readers do not write, migrate, heal or create missing keys/identities. The separate pull-device application is post-beta, as is the FIDO2-signed policy bundle (first post-beta item). Source tests do not establish live or independent acceptance.

## Signed Hub packages

Hub sources and signed packages share one operation contract across CLI, terminal,
MCP and the SDK. Installing a package grants no tools, policy or standing.

Run `deckent hub` to list the scope's sources. The terminal's `/hub` window lists
operations and security notices. Mutations open a person card with the exact scope,
source, trust settings, manifest, signature envelope and decoded package text.
Cancelling before confirmation applies nothing. Closing after submission does not undo a committed change. Security notices include withdrawal,
restoration, revocation and yank. A yank blocks new installs while existing use
continues; revocation excludes the content from new agent selection.

Inspect an operation's JSON input contract before preparing its file:

```sh
deckent hub sources add --schema
deckent hub install --schema
deckent hub cards --scope company-scope --json
```

For commands needing input, use `--input <file>` with that schema. `--scope` must
match any scope in the file. Package bundles are base64 of canonical `.deckentpkg`
bytes. Install and update take the exact dependency bundles, signed revocation feed
and local WorkClass mapping. `hub refresh` applies a supplied signed feed;
`hub verify` rechecks installed cached bytes offline. `hub inspect` defaults to
installed state; `location: "source"` requests the source's package. The latter
requires an exact version. `hub export` returns an object with `encoding: "base64"`
and `bundle`, suitable for air-gapped transfer. It does not write a host file.

Person writes require an interactive terminal; `--json`, pipes and AI environments
cannot approve their cards. The SDK exports `executeHub(root, request, options)`;
`request` contains `operation` (for example `hub.verify`) and its typed `input`.
An explicit scope policy grant for resource kind `hub` is required. No grant is
created by using a surface. An AI write also requires its own active signing key;
the Hub server independently checks the publisher signature and authority.
MCP omits source trust changes and person security cards. Publisher-key management
continues to use the existing person-only signer cards.

No source, host or connection is seeded. Adding a source does not approve its first
network connection. Search, source inspection and publication require the configured
Hub connection: registry extension identity, durable first-use person decision,
source-scoped authentication and the governed network effect path. Missing wiring
returns `HUB_CONNECTION_UNAVAILABLE`; it never falls back to raw HTTP. Before
publication the local application scans the manifest and every decoded file for
known secrets. AI publication of lesson-derived material is refused.

The current author slice supplies the connection port and governed transport bridge.
The installing composition must bind its first-use, authentication and signed trust
evidence services before network operations are available. Binary, multi-installation
and native-platform acceptance remain separate from source or unit-test verification.

The Hub public opening is a separate release gate. No default source or production connection is shipped by this composition.
