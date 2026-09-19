---
name: deckent-next-refactor
description: Plan, implement, review and hand off Deckent Next refactor cards from the legacy workspace, preserving accepted architecture, evidence and host coordination. Apply throughout Deckent Next development; not a command to run the legacy product.
---

# Deckent Next refactor

## Workspace and authority

Operator workspace: `/home/alperen/deckent-dev`; product destination: `/home/alperen/deckent-next`.
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

For uncertain development judgments, use the shared host tool from either repository:
`node .agents/refactor/jev.mjs check INPUT.json` (offline), then `ask INPUT.json` (external request).
Input: `{"schemaVersion":1,"state":{"facts":[],"alternatives":[]},"questions":{"supported":{"type":"noul","instructions":"Is the claim supported by the supplied evidence?"}}}`.
Use narrow independent questions; choice and score are also supported by the current TypeSafe API.
Prepare only necessary, sanitized facts: no automatic repository, channel, customer data or credential upload.
Read `.agents/refactor/jev.config.json` for endpoint/model/limits; optional third CLI argument selects another config.
Credential comes from TYPESAFE_API_KEY, TYPESAFE_API_KEY_FILE, or the configured credentialFile reference
(current host: ~/.config/typesafe/api-key; owner-private raw key file, mode 0600).
Never print/source the credential file or put keys in commands, git, evidence, channel or request state.
One bounded request, no automatic retry; failures mean unavailable advice, never approval or a fallback verdict.
Record the question/evidence reference and returned model, request digest, usage and uncertainty when using advice.
Jev is probabilistic decision support, not proof, test success, Fable PASS, policy, owner permission or acceptance.
Do not select a universal confidence threshold or execute returned content. Resolve conflicts using evidence/review.
This host integration is excluded from product distribution; a future product capability needs its own card.
