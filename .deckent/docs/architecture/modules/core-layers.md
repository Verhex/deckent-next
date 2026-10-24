# Core layers (alpha.55) — module note

This note describes the seven core layers that alpha.55 adds before the beta (owner 2026-10-23): system assignment and model roles,
memory, the Auditor's sealed decisions, Nervous detection, lost-worker recovery, the headless subscription Brain and the agent
catalog with its statistics and signer keys. It states what the code does today, which switch turns each part on, and what stays
open. Owner decisions: [core layers](../../decisions/owner-decisions.md#cekirdek-katmanlar-2026-10-23),
[S6R recovery](../../decisions/owner-decisions.md#s6r-kayip-calisan-2026-10-23) and
[S4B memory](../../decisions/owner-decisions.md#s4b-hafiza-dolsun-2026-10-23). Designs and acceptance packs are external
(`proof/ORCHESTRATION-2026-10-23/`, `proof/ALPHA54-2026-10-23/S6R-ACCEPTANCE.md`, `S4B-ACCEPTANCE.md`).

## One rule for every switched layer: off until a person turns it on

Every switched behaviour ships shadow first and off. A shadow mode computes and seals what it would do and changes nothing. The
headless Brain has no switch: S3-5 retired its preview key, so its connect kind is offered once the realm exists and is used only after
the person's own login, connect and consent (see Headless subscription Brain). The switches
are protected configuration: no AI principal and no MCP actor may write them (`PROTECTED_CONFIG_PATHS`,
`src/domain/core/policy/internal/ai-floor.ts:71`). Bounds and thresholds are versioned registry data marked `provisional` until they
are measured on N1; no number is a literal in logic.

| Switch | Modes (default first) | What turns on |
|---|---|---|
| `memoryAutomation.extraction.mode` | off, shadow, on | memory candidates written from accepted work |
| `memoryAutomation.verification.mode` | off, shadow, on | the independent evaluator verifies candidates |
| `memoryAutomation.context.mode` | off, shadow, on | verified memory reaches the worker prompt and the Brain context |
| `runRuntime.nervous.mode` | off, shadow, live | Nervous detection; `live` runs a measured rule's stop step |
| `runRuntime.recovery.mode` | off, shadow, live | the recovery decision for a lost worker |
| `catalogEvolution.mode` | off, shadow, on | the agent statistics pass |

The memory switches are declared in `src/platform/core/config-fields/internal/fields.ts` (`MEMORY_AUTOMATION_MODES`), and a newly set
memory phase 3 or 4 is refused with `MEMORY_ROLLOUT_CRITERIA_UNMET` until its measured criteria hold (see Memory). The policy template
that grants the new identities their exact rights is first-run template v15 (`FIRST_RUN_POLICY_TEMPLATE_VERSION`,
`src/domain/core/policy/internal/first-run-template.ts:68`); an installation gets it only through the owner's
`deckent policy upgrade --template current --scope <id> --preview`, then `--apply`.

## System assignment and model roles (S0, S1, S2, M2–M5)

The Brain plans tasks and names each task's WorkClass; it no longer chooses the worker model. A reply that names a model or an effort
is refused with `BRAIN_ASSIGNMENT_REFUSED` before any proposal exists (Brain template v3 and later; the selected template is
`run-proposal` v4, `src/capabilities/core/run-planner/internal/templates.json:8`). At Run admission the system walks the WorkClass's
ordered candidate list (Core seed `assets/native-coding/work-classes.json`, registry v5) and takes the first candidate that passes the
same admission check a pinned model gets; none is `WORKER_ASSIGNMENT_NONE`, which names every skipped candidate with its reason. No
other model is ever substituted. The choice (channel, exact model, effort, list position, catalog and WorkClass revisions) is sealed
per task, and metrics v2 rows carry it. A candidate entry may be a role selector (role, tier bounds, maker and channel filters, effort)
instead of an exact id; it expands through the model role registry when reached, and every candidate, exact or selected, must hold the
`worker` role.

Tier and role live in one versioned registry, `assets/model-roles/model-roles.json` (roles `brain`, `worker`, `recovery-decision`,
`memory-evaluator`; tiers `worker` and `frontier`). Tier is eligibility and the scope's activation is permission; the Brain needs both,
and a worker-tier, unknown or role-less Brain model is refused with `BRAIN_TIER_REFUSED` before any budget read or model call. A model
the catalog lists without a role row is shown as pending ("new model: role pending") in `deckent doctor`, the monitor and the terminal
`/roles` window, and every role refuses it until a person runs `deckent models roles set` on their own terminal card; the write is one
compare-and-set row in the global `model_roles` overlay, audited like other governed config writes. API-channel models connect from a
registered catalog row (`connect.tariff`, `connect.route`): a model the release does not list needs no source change, and a row
without usable terms is refused, never priced by guess. A model-family word in a source string literal fails the architecture check
(rule G5).

Metrics v2 (ledger v60) records effort, the reported model with its evidence label, duration, evidence kinds, human-decision and
quota-park rows, the sealed assignment, and (S8-1b) the agent and the failure cause. Standing admission of proposals stays off for
every WorkClass until the A8 consistency measurement on N1.

## Memory (S4, S4B-1…S4B-7)

The journal (ledger v61) keeps facts and lessons per scope with one writer, a full-text index behind a search port, and the life cycle
candidate → verified → retired; nothing is deleted except by purge. A read failure after authorization is a typed hold, never an empty
memory. "Verified" needs a person or an independent evaluation record; the AI that wrote an entry never verifies it, and memory
verify, retire and purge are on the AI hard floor except for the evaluator's own verify and contest.

- **Write.** The `<owner>/memory-distiller` identity reads accepted work's sealed evidence off the hot path and writes candidates. Only
  WorkClasses with a declared retention and "no personal data" produce candidates; the Core registry (`assets/memory/automation.json`)
  declares only `small`, with a provisional 90-day retention. Workers may add a bounded `lessons` claim to their report; it is
  candidate input only and is never shown to a worker or the Brain. Text that looks like a secret or hidden characters is screened out.
- **Verify.** The `<owner>/memory-evaluator` identity asks one model whose catalog maker differs from the maker of every model that did
  the source work (re-derived from the sealed Runs). The model comes only from active `memory-evaluator` role rows; with none, nothing is
  evaluated and entries stay candidates. Calls, spend and contests per scope per day are registry bounds; a subscription row needs the
  owner's delegated-use consent. `deckent memory` shows which evaluator would serve and what its answers can cost a day.
- **Review and purge.** `deckent memory review`, `verify`, `retire`, `purge` and contest resolution are person-only terminal cards.
  Purge writes a sealed journal first, tombstones every revision and the search row, deletes the evaluator calls' content, and is
  replayed after a backup restore; reads hold with `MEMORY_PURGE_REPLAY_HELD` until it is. The card says what purge does not delete.
- **Read.** At Run admission verified entries of the Run's scope, WorkClass family and target, readable by the admitting person, are
  frozen as a labelled data part of the worker prompt (`MEMORY_CONTEXT_HELD` on a failed read; a part without room is withheld with a
  warning). The Brain's planning context gets the same selection (`BRAIN_MEMORY_CONTEXT_HELD`). Auto-verified entries are used only for
  low-risk WorkClasses.
- **Rollout.** `deckent memory rollout` shows the phase, every criterion with its numbers and the exact next command. Phases follow
  `assets/memory/rollout.json` (provisional): extraction on, verification shadow, context shadow, then context on (phase 3, after 20 fitting
  shadow admissions and clean overflow, integrity, secret and purge checks) and verification on (phase 4, after evaluator agreement of at
  least 90 % over 20 blind decisions, 30 decisions since the last false pass, the injection corpus passed, zero independence violations
  and a contest rate of at most 10 %).

## Auditor and safety holds (S5, S5b)

Every refused agent tool decision and every plain allow that ran is sealed in one `policy-turn` audit record per turn. AuditFollow reads
verified events after a sequence and reports gaps; it has no runtime operation yet (that waits for the next protocol step). The
`<issuer>/auditor` identity may only inspect, list and verify. A hold now carries its source: an operator hold, or a Nervous or Auditor
safety hold that only a person at an interactive terminal lifts (`RUN_HOLD_PERSON_REQUIRED`); every resume is a sealed decision.

## Nervous and lost-worker recovery (S6, S6R-1…S6R-6)

Nervous (`src/engine/core/nervous/`) evaluates deterministic rules (`rules.json`, revision `core-2026-10-23`) over existing signals:
container gone, dead launcher with or without its container, Docker unavailable, crash loop, policy-refusal flood. Each case gives one
sealed `recovery-detection` proposal from the owner's standing list (fence the Attempt or hold the Run, stop an orphan container,
restart a service component, alert the Brain, hand to a person); Nervous itself writes no state and calls no model. In `live` mode the
broker runs a proposal only when its rule is marked `live`, the owner holds a standing policy grant (`recovery-action`/`apply`, never
grantable to an AI) and an executor exists (`src/engine/core/nervous/internal/broker.ts:43`). Every rule in the Core seed is
`provisional`, so `live` seals proposals and executes nothing until the owner promotes a measured rule by its exact id and version.

When a fence and stop do run, the slot is released only with termination proof bound to the same worker (the container id stored at
create and the incarnation seen at the first running observation); without proof the Run gets a Nervous safety hold. Recovery then
decides the case (`recovery_cases`, ledger v66): an effect gate checks that every effect of the lost Attempt is settled, a
`recovery-decision` role model (frontier tier) reads the sealed evidence and chooses between a continuation in a new Attempt and a
person, and `continueLostTask` opens the new Attempt only with the owner's grant `recovery-action`/`apply` `continue-new-attempt`.
Recovery reads only cases whose Nervous stop step was executed (`src/composition/core/runs/internal/recovery.ts:59`), so no automatic
continuation happens before a Nervous rule is live. Bounds (`src/domain/core/recovery/internal/policy.json`, provisional): one automatic
continuation per lost task, three Attempts per task across stall, loss and retry, four recovery actions per Run. An uncertain effect is
never sent to a model; it goes to a person. A circuit breaker counted from sealed decisions survives a restart, and a case already
decided in shadow is not asked again after the switch to live. Every escalation and Nervous hold code is shown in words (EN/TR) on
`run inspect`, `/runs`, the monitor and the hold card; `deckent doctor` names both modes and the grant state.

## Headless subscription Brain and quota (S3-1…S3-5, S9, F3, F4)

The connect kind `claude-cli-subscription` runs the official `claude -p` as the person's own OS user with their own login (default
`~/.claude`): one turn, no tools, no MCP, `--safe-mode --restricted`, `HOME` set to an emptied run directory and the login directory as
`CLAUDE_CONFIG_DIR`, the system prompt in a 0600 file and the message on stdin, never in argv. A preflight without a model call checks
the binary, its version range, required flags (help-hidden flags proven by a parser refusal in an empty temporary config directory) and
the login fields. Guards stop the process group when the CLI reports an API key source, a tool, an MCP server, a plugin outside the
registry allow-list or a model other than the pinned one; every refusal is typed and nothing falls back to an API. Every spawn runs
inside a bubblewrap realm: system prefixes read-only, the login directory the only writable host directory, an empty network
namespace whose one way out is a relay to the provider's allow-listed gateway, and file-size, descriptor and core-dump limits. Without a
usable realm the kind is refused with `HEADLESS_ISOLATION_UNAVAILABLE`; there is no unisolated path, so the kind is available to
customers wherever the realm works. One call is in flight per connection. An AI/MCP actor or a background role (recovery decision,
memory evaluator) uses the subscription only after the owner's consent on the connection (`--delegate ai,system`); otherwise
`HEADLESS_DELEGATION_REFUSED`.
Inside the realm the registry's limiter (util-linux `prlimit`) sets per-process CPU time (soft limit SIGXCPU, hard limit SIGKILL), data
size (`RLIMIT_DATA`, which covers `mmap` since Linux 4.7) and the realm's task count (`RLIMIT_NPROC`, counted per user namespace since
Linux 5.14) before the relay starts; the relay checks those bounds on itself, samples the realm, and names a bound that stopped the CLI by
a reserved exit code. A named bound becomes a rejected receipt (`resource-limit`, field `cpu-time`, `processes` or `memory`; Brain:
`HEADLESS_LIMIT_REACHED`); an interrupted turn is never named a bound, and data and task attribution is sampled, not kernel-reported.
The gateway keeps its refusals as counts and DNS host names (bounded by `providers.json`): each call's record carries them (the responded
`headless.egress` block or the rejected body; shown by `deckent models invocation` when content is retained), and a 0600 `egress.json`
beside the preflight record feeds the doctor Brain-login line. The CLI's OAuth refresh lock is a name beside its login in the login
directory (registry `refreshLock.names`; none exists at rest and none appeared during in-realm `--version`, `--help` and `auth status`); the
realm binds that directory itself, so file exclusion is shared with the person's own sessions, but a process-id staleness check would see
across PID namespaces wrongly, and Deckent cannot serialize sessions it does not start. Deckent therefore starts no spawn while such a name
exists and serializes its own spawns per login directory with a 0600 lock in the global headless root; past the registry wait it refuses
with `HEADLESS_LOGIN_BUSY`. The S3-3 switch `models.headless.preview` is retired: the key still parses and is no longer offered.

When a subscription quota is exhausted, the Brain waits visibly and cancellably if the known reset is within
`brain_planner.quotaWait.maxWaitMs` (15 minutes, provisional, at most two attempts) and then plans once more under a new derived command
id; otherwise it returns `HEADLESS_QUOTA_EXHAUSTED` with the reset time. The wait appears in the standalone monitor and MCP
`inspect_monitor` before a Run exists. A worker Run parked on a quota waits at most `runRuntime.quotaRecovery.maxWaitMs` (default 5 hours)
and then asks the person (`quota-ask`: keep waiting or use the next candidate); it is never cancelled on its own, and an AI cannot answer.

## Agents, standing, statistics, suggestions and signer keys (S7, S8-1a…S8-5)

An agent definition (ledger v64) is versioned data: persona text, WorkClass bindings, skills pinned by id, revision and digest, and an
optional manager that forms an org tree (cycles and depth over the registry bound refused). The tier field stays empty (owner A4).
Agents and local skills are defined on the person's terminal card; an imported skill needs its declared pin to match the received bytes
and a valid signature (hard floor in versioned code, no AI can relax it). The system, never the Brain or a model, selects each task's
agent from its WorkClass binding and standing (ledger v67: candidate, active, redesign-required, retired), seals the agent, revision and
skill-set digest, and a candidate agent always needs the Run card. `deckent agents stats` and MCP `inspect_agent_stats` show acceptance
with integer Wilson bounds over non-overlapping windows; only failures attributable to the worker or the evaluator count, and every line
says "association, not causation". Signer keys (ledger v68) give each AI or system principal its own Ed25519 key, which only a person
enrols, adds or revokes; every AI or system catalog write carries a `catalog-action:1` signature verified inside the write transaction,
and the HMAC-chained `revocations.log` re-applies revocations at start-up. Private keys stay in the non-backed-up `signers` resource.

The `<owner>/catalog-aggregator` pass (incremental, off the hot path) applies registry rules to those statistics and seals suggestions
(ledger v70: promote, redesign, revise, a new agent, a new skill) signed by its own key; a suggestion changes nothing by itself, and an
overlay of `catalogEvolution.overlay.suggestions` may only lower its bounds. A person decides on terminal cards: `deckent agents
promote|demote|restore|retire <agent-id> --work-class <id>`, `dismiss <suggestion-id>`, `standing reset --work-class <id>` and
`define|define-skill --from-suggestion <id>`, whose draft is rendered at card time through that person's memory read filter and is
never stored or returned over MCP (a skill drafted from lessons is marked as AI output). An AI principal with its own active key and a
scoped grant may do the same through the signed MCP tools `define_agent`, `define_skill`, `import_skill`, `change_agent_standing` and
`dismiss_agent_suggestion`; the transition table in versioned code refuses a suggestion's producer deciding it and an AI promoting or
restoring a revision it authored (`src/domain/core/agent-catalog/internal/standing.ts:71`). A person-authored revision with the same
skill set inherits its promotion ("carried over"); an AI-authored revision starts as a candidate. Automatic narrowing happens only for
a `calibrated` rule in mode `on` (`src/engine/core/catalog-evolution/internal/pass.ts:110`); every Core rule is provisional. The
monitor shows open suggestions, a revoked signer whose promotions are still in effect, an aggregator without a signing key and an
unavailable registry; the revoke card demotes a revoked key's promotions in one step.

## Ledger steps and read compatibility

alpha.55 moves the ledger from v59 to v70 (`CURRENT_LEDGER_VERSION`, `src/adapters/core/sqlite-ledger/internal/schema.ts:18`; the lead
renumbers at landing if needed). Every step is additive; no earlier row is read or rewritten. The local runtime protocol stays v29.

| Step | Adds |
|---|---|
| v60 | metrics v2 rows |
| v61 | memory journal and its search index |
| v62 | version step for system assignment (work input v2, sealed assignment) |
| v63 | effect-producer index |
| v64 | agent and skill catalog |
| v65 | memory automation tables (support, extraction, evaluations, contests, purges) |
| v66 | recovery cases |
| v67 | agent standings |
| v68 | signer keys |
| v69 | agent statistics pass position |
| v70 | catalog suggestions, their state history and the aggregator's window cache |

An older build refuses a newer ledger, so going back to alpha.54 means restoring the backup taken before the switch; the switch and
rollback notes are in [known limits](../../../../docs/known-limits.md#core-layers).
