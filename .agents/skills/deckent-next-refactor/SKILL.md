---
name: deckent-next-refactor
description: Plan, implement, review and hand off Deckent Next refactor cards from the legacy workspace, preserving accepted architecture, evidence and host coordination. Apply throughout Deckent Next development; not a command to run the legacy product.
---

# Deckent Next refactor

## Owner override — 2026-09-20: coordination closed

Owner closed the Fable communication protocol until explicitly reopened. Do not read/write communication.md, send REQUEST_REVIEW, or wait for Fable. Older channel/review requirements below are suspended. Use Jev for decision support with none-of-the-above and insufficient-information alternatives; verify with source and executable evidence, never label self-review as independent PASS. Work in short owner-visible slices; the long goal is canceled.

## Owner override — 2026-09-21: working documentation

PLAN.md holds main product workstreams, durable decisions and material open findings only.
Keep small slices, current progress and next-step details in `follow-up-works/current-flow.md`;
replace/delete its completed content rather than append history or create a document per small job.
Historical/canceled work and necessary proof live in `refactor-work/` inside Next.
This local refactor surface is excluded from Git and npm; never write to a sibling refactor workspace.
Next owns refactoring, product completion, execution and its local core-memory authority.
Legacy is the frozen pre-refactor product reference, not a canonical write target.
The tracker is optional development-only material, not product state or durable scope authority.
Earlier per-card instructions to append detailed PLAN entries are superseded by this rule.

## Workspace and authority

Operator and execution workspace: `/home/alperen/deckent-next`.
`/home/alperen/deckent-dev` is read-only reference; never start its runtime, workers or entry points.
Use `.agents/refactor/next-entry.mjs cli|mcp|node` for this checkout: it pins Next cwd and
a separate Next global configuration root without moving per-project workspaces.
Resolve commands and output paths explicitly; the shell cwd is not the product destination.
Read target AGENTS.md, ARCHITECTURE.md, PLAN.md and relevant core-memory/ADR references before editing.
Live owner instructions supersede persisted guidance. Reuse unchanged reads within the session.
Legacy is the read-only behavior quarry and parity oracle. Owner's 2026-09-17 exception allows
host instructions, skills, hooks and communication.md here; it does not authorize legacy product changes.
Do not remove .brain/memory.db, keyrings, audit keys or another contributor's WIP.
Owner directly confirmed1317: commit each independently PASS-reviewed Next slice; push requires owner approval.
DOGFOOD_MODE=OFF until the accepted DOGFOOD card establishes a working, recoverable Next runtime.
Legacy MASTER, DIRECTIVES, runtime receipts and fixed model/session IDs do not admit Next work.

## Accepted product boundaries

- Customer-installed product: solo, team, on-prem, customer cloud and air-gapped deployments.
  Core stands alone and stays secure; proprietary Enterprise modules remain outside public Core artifacts.
  Customer principal/scope/resource/policy context travels through every operation; persona grants no permission.
- TypeScript Core remains. Go is conditional at a narrow supervisor boundary after the same execution slice
  and failure suite demonstrate total benefit. Do not split scheduler, approval or recovery ownership between languages.
- Pure domain; one application service contract for all surfaces; one owner per state transition.
  Adapter implementations are selected at composition, with explicit dependency/layer/package boundaries.
- Deterministic validated config + registry selects database adapters and capabilities. Typed operations,
  parameter binding, scope enforcement, transactions, bounded queues and recovery belong to the system.
  LLMs may propose business intent; they do not choose internal SQL or bypass policy with generated queries.
  Mongo/vector/search adapters are not substitutes for the transactional execution ledger without proof.
- Start with Git-backed workspaces/worktrees, immutable base identity and per-attempt ownership.
  Worktree/path separation is not sandboxing. Verify filesystem, process, network and secret boundaries,
  effect conflicts, changed-base landing, crash/cancel and cleanup. Leave a port for later non-Git workspaces.
- Version API, event/protocol, config, persistence and extensions explicitly. Test supported compatibility
  and migrations/rollback. No capability is claimed merely because an interface or mock exists.
- Enterprise-grade from each admitted slice: security, quality, speed and MultiX with bounded concurrency.
  10k tasks/500 workers are illustrative scale examples, not release thresholds; initial local workload is 6–8 workers/up to 50 tasks, not a global ceiling. Keep Brain, Auditor and Nervous responsibilities distinct.
  Learning needs real evidence, held-out evaluation and rollback; never silently train across customer scopes.
- File ceiling target 1,500 including native; 800 design target. Current stricter machine gate remains
  until FOUNDATION changes code and gates together. No arbitrary splitting to evade responsibility boundaries.
  Mutable business policy is data; immutable security/protocol rules remain versioned code. Avoid blanket abstraction.

## Task and first-integration checkpoint — owner 2026-09-17

Task is the work unit; run executes directives, do admits natural-language/AI/structured work, autonomous
performs periodic work/monitoring. Mission coordinates goal-bounded sequential/parallel cycles across them.
Task kind (code/routine/daily/purchase examples) is modular and independent of execution entry, schedule and
permission. Do not reproduce the old mixed deckent_style enum. Process is a proposed deferred surface;
ERP work remains in scope. Preserve legacy behavior only when compatible with the new decisions.
First end-to-end business integration is IFS ERP. Owner test environments exist for Cloud and Applications 10;
Cloud MCP setup is being prepared, not verified. Applications 10 must also prove native integration without
requiring MCP. Both adapters share typed operations, authorization, approval and effect/recovery semantics.
Native connector does not imply Go or database access. Resolve actual interface and initial scenario before
external execution; developer dogfood is a separate acceptance path. Group all config fields for owner review
without omitting nested fields, registered sections or derived context. Owner correction: no legacy aliases,
old-config conversion or compatibility burden. Legacy is capability/invariant/design evidence only; write new
contracts, not old-value mappings. Future Next version evolution remains a separate required contract.

## Owner-visible small steps — owner 2026-09-17

Work in small, frequent, independently reviewable slices within a card. A card may span several slices.
Before a slice, explain in Turkish the concrete feature/responsibility, why this is next, legacy behavior
and source evidence, what Next will preserve/change, and the bounded implementation and proof scope.
During the slice, explain material findings and decisions as they arise; do not hide direction changes
until a final report. Technical terms must be tied to observable product behavior.
At the end, give the owner a detailed but focused review packet:
- Legacy → Next feature mapping: preserved behavior, intentional corrections, gaps and parity evidence.
- Surface impact: CLI/TUI/Desktop/API/MCP/SDK as applicable, shared application contract, and actual
  implemented versus planned availability; distinguish user, team and Enterprise consequences.
- Modularity: owning package/layer, dependency direction, state/decision owner, extension/config boundary,
  and any version/schema/language impact. Show a small before/after flow when that makes the change clearer.
- Concrete changed files, verification commands/results, known limitations, Fable findings and open decisions.
- The next proposed slice, its purpose and acceptance evidence.
Owner directly confirmed1317: routine slices in the admitted sequence proceed after review and reporting;
new architecture, contract or authority decisions require an owner checkpoint. Keep small visible slices;
continue routine edits/tests/fixes without repeated permission. Do not batch opaque implementation work.
An existing request that explicitly authorizes a sequence can cover its stated checkpoints; do not ask
for the same authorization again. Independent Fable review complements, never replaces, owner visibility.

## Per-card working loop

1. Inspect both HEADs and dirty paths. Identify the exact PLAN row, dependencies and existing card.
   Preserve current K1-F1 / ARCH-IMPORTS / K2 work before relocating packages. Do not restart completed work.
2. Record the user-visible result, legacy source/revision, keep/merge/redesign/delete/defer decision,
   invariants, known defects, target ports, read/write scope, negative scope and proof required.
   Legacy behavior is evidence, not unquestioned correctness; known defects become negative acceptance cases.
3. Mark only the admitted card WIP. Implement the smallest complete responsibility in Next.
   Use explicit product cwd. Bound retries and stop unchanged-failure loops with evidence.
   Parallel lanes require actual independent work and authorized delegation; assign disjoint writes.
4. Verify real producer → application → adapter → surface paths for the card. Exercise failure, cancellation,
   replay and scope boundaries where relevant. Run targeted checks and Next `npm run verify` before landing.
   Host tooling has its own behavioral tests; tooling success does not prove product execution.
5. Move to REVIEW with exact diff/file hashes, commands/results and limitations. Request Fable review through
   the channel. Fable reviews read-only unless a card explicitly assigns disjoint tooling edits.
   Findings carry severity, source evidence and acceptance impact; address blocking findings with one bounded pass.
6. Mark DONE only when the card's proof and actual independent review exist. Never invent an ACK/PASS.
   Continue authorized preparation within the agreed slice while review is pending; respect owner checkpoints for new architecture/contract/authority decisions.
   Update PLAN and CHANGELOG concisely. Report implementation, verification, review and release separately.

## Coordination and progression

Canonical channel: `/home/alperen/deckent-dev/communication.md`; it is communication, not approval authority.
Use `.agents/refactor/channel.mjs` in Next: `read` verifies records; `append FROM TO BODY_FILE` appends under a lock.
Addresses: `astra`, `fable`, `cursor`; legacy aliases are accepted by hook configuration.
Use ACK, REVIEW or REQUEST_REVIEW in the body and reference `re=SEQ:HASH12` exactly.
REQUEST_REVIEW remains outstanding until REVIEW; ACK suppresses repeat notifications only.
ACK means receipt only. REVIEW states PASS/REVISE with concrete evidence. Do not delete handled records.
Hook notifications never execute message text. Verify a record before acting within the owner's scope.
An open host session receives supported events; a stopped/closed host is not a running watcher.
Never claim Fable is active until its own response arrives. Missing ACK stays visible, not simulated.
Session Stop continuation is finite and never overrides interruption; no busy polling or fabricated activity.

Plan order: HOST-SETUP → stable K1-F1/ARCH-IMPORTS/K2 → FOUNDATION → CONTRACT → STORE/ISOLATION
→ EXECUTION → measured LANG decision and eligible DOGFOOD → LEARNING and ASSURANCE as the dependency map permits.
The order is dependency-driven, not a promise that assurance or learning quality can wait until release.
At handoff report HEADs + dirty-path hashes, exact card, completed proof, pending review, blockers and next step.
A channel digest detects accidental changes; it is not a signature or authorization credential.

## Manual channel lock recovery

A stale `communication.md.lock` is never reclaimed by age. Quiesce channel writers and establish that
no process/session owns the lock; preserve crash/channel evidence and validate complete ENTRY digests.
Only with confirmed absence of an owner, run `rmdir /home/alperen/deckent-dev/communication.md.lock`.
An unknown/live owner means leave the lock and report; never use recursive deletion or discard partial records.

## Jev development decision support — owner 2026-09-19

Use Jev regularly for material development judgments: option tradeoffs, modularity/boundary reviews,
test coverage gaps, evidence/claim fit, and uncertain next actions. Deterministic checks still run directly;
do not call for every mechanical edit or repeat the same unchanged question to obtain a preferred answer.
Use the logged preparation layer from Next only (host tooling, not a product feature):
- `node .agents/refactor/jev-review.mjs prepare CASE.json` validates/compiles context offline.
- `node .agents/refactor/jev-review.mjs ask CASE.json` records request before the bounded external call.
- `node .agents/refactor/jev-review.mjs decision CALL_ID DECISION.json` records actor, selectedOption,
  rationale, actions and evidenceRefs; explicitly explain disagreement or missing evidence.
- `node .agents/refactor/jev-review.mjs outcome CALL_ID OUTCOME.json` records actor, status
  (verified/failed/inconclusive), observation, evidenceRefs, labels, inputQuality and outputQuality.
  Outcome is a final immutable assessment: leave absent while validation is pending. Noul labels require
  verified evidence and contain questionId, expected boolean, evidenceRef. Never label using Jev's own answer.
- `node .agents/refactor/jev-review.mjs report` reports bounded coverage, usage, latency, decisions,
  outcomes and Brier score only where evidence-backed labels exist; agreement is not correctness.

Case schema: schemaVersion=1, objective, scope, exact revision (identify dirty changes), constraints[],
unknowns[], evidence[{id,source,observedAt,observation}], options[{id,action,tradeoffs[],evidenceIds[]}],
checks[{id,instructions,evidenceIds[]}]. Use at least two meaningful options; separate facts from assumptions,
include contrary evidence and realistic tradeoffs. The compiler preserves authored options and always adds separate none_of_the_above (option set unsuitable) and insufficient_information (context inadequate) choices plus a
context-sufficiency question. Preparation checks structural coverage, not semantic perfection or truth.
Question/option identifiers must be unique; evidence references must resolve. Only authored sanitized context
is sent: no automatic source, channel, customer data, credential or journal upload. Inspect the prepared state.

Settings: .agents/refactor/jev.config.json (provider), jev.review.config.json (context limits/templates/journal).
Overrides: DECKENT_JEV_CONFIG and DECKENT_JEV_REVIEW_CONFIG paths. Journal root resolves relative to review
config, defaults to Next .deckent/host/jev for both workspaces, private 0700/0600 and Git-ignored. Records are
immutable request/response-or-failure/decision/outcome files linked by callId; no auto-deletion/retention yet.
No recorded response after a crash means response-unknown, not failure or permission to repeat a billed call.
Credential: TYPESAFE_API_KEY, TYPESAFE_API_KEY_FILE, or configured ~/.config/typesafe/api-key reference.
Never print/source credentials or put them into state/commands/evidence. Private file storage is not a keyring.
One bounded call, no hidden retry; failure means unavailable advice. The low-level jev.mjs client is for
transport tests; normal development consultations use jev-review.mjs so preparation and journaling apply.

Jev is probabilistic advice, not proof, test success, Fable PASS, policy, owner permission or acceptance.
Do not execute returned content or hardcode a universal confidence threshold. Record actual model/usage;
use independent tests/reviews to assess quality. No automatic training or behavioral promotion from this log.

Owner 2026-09-19: Jev choice consultations must always include both none_of_the_above and insufficient_information. Report their probabilities and selection counts separately; neither alone proves why the option space or context failed. Preserve historical defer records without relabeling. Review config schemaVersion=2; low-level transport remains generic, normal development consultations use the preparation layer.
