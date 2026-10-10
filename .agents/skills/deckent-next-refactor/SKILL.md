---
name: deckent-next-refactor
description: Guide owner-admitted Deckent Next development, fixes, refactoring, reviews and handoffs through current authority, bounded scope, evidence and documentation reconciliation. Use as the common entry point for Next work and select specialist skills when relevant.
---

# Deckent Next development workflow

Before following this workflow or acting on an internal Next card, read
[internal-contract.md](internal-contract.md) in full. It retains the complete internal
operating contract moved from the root guidance. If it is missing or unreadable,
stop internal work and report the missing contract. Reuse the read only while it is unchanged.

## Purpose and authority

This is the shared development entry point for Codex, Claude and Cursor. Its retained name
preserves existing callers. It guides the assigned work; loading it grants no execution,
delegation, commit, publication or runtime authority.

At task start read the repository `AGENTS.md` / `CLAUDE.md`, `ARCHITECTURE.md`, `PLAN.md`, your own
process-board row (`node .agents/refactor/board.mjs show`), `.deckent/docs/core-memory/MEMORY.md` and the relevant laws.
Read `.deckent/docs/core-memory/project_product_north_star.md` for the common quality bar.
Reuse unchanged session reads; refresh affected sources when authority, scope or evidence changes.
Live Alperen instructions take precedence. Preserve accepted decisions; bring a material new
conflict or a proposed architecture, contract or authority amendment to the owner before changing it.

`ARCHITECTURE.md` owns contracts, `PLAN.md` owns durable workstreams and remaining scope,
core-memory owns lasting principles and lessons, the host process board owns who holds what and what
comes next, and external proof holds acceptance/incident evidence. `follow-up-works/current-flow.md`
is short-term task memory; finished items are deleted there (owner 2026-10-10). Consult `COMPLETED-PLAN.md` only when
completed-work evidence is needed. These sources distinguish accepted targets, implemented mechanisms,
historical proof and current verification.

## Process board and owner output (owner 2026-10-03)

- One board: `.deckent/host/process-board.json` (host area, outside Git/npm), written only through
  `node .agents/refactor/board.mjs`: `init`, `get [SLOT]`, `show` (text), `render [--out PATH]` (one HTML file,
  overwritten), `set-own-row SLOT BODY_FILE|- --session ID --revision N`, main-only `set-map BODY_FILE|-` and
  `clear-row SLOT`. Bodies are JSON files or stdin, never long flag lists (Remote Control truncates lines).
- Each session writes only its own row (slot + its session id; an unassigned row is claimed by the first writer,
  a different id is refused and the session leaves handoff information for main). Main reconciles the role map,
  mirrors the owner's dogfood decision with its source and lists short-lived Codex/Fable/Cursor workers as a
  sub-list of its own row (the same rule applies inside Deckent dogfood). Writes happen only on a change or a
  handoff; no heartbeat. A stale `--revision` is refused with the current revision; the lock is never stolen.
- The board grants no authority, PASS or liveness: a timestamp is an age, not proof that a session is alive.
  Work lives in PLAN, decisions in ARCHITECTURE/core-memory, acceptance and incident evidence in external proof,
  which is kept until the batch lands on main and its review closes, then pruned (owner decision 3).
- Review packages name the board and PLAN as the status source; current-flow carries no status (decision 4).
- HTML views are delivered over localhost or as a Claude Artifact only when the owner asks (decision 1).
- Owner output: natural Turkish, result/impact → required evidence/open limit → decision if any → who holds it /
  next step; no empty-field ritual, details on demand, a material blocker is visible in the summary. After a material
  change main writes `.deckent/host/owner-report.json` and runs `node .agents/refactor/board.mjs report .deckent/host/owner-report.json` (flow: before → now →
  remaining with who holds each step; one HTML overwritten at `ozet-rapor/index.html`, served on 127.0.0.1:8765 (user systemd `deckent-owner-panel`) and sent to the
  owner; an interactive panel — owner asks/commands with copy buttons, who does what from the board, flow + `version`, and
  `places` (where to see what); fill `commands`/`places`/`version` too); the chat reply stays a few lines pointing to it (owner 2026-10-03 morning).
- Notification (decision 5): main pushes to the owner only when the owner must act — a decision is needed (with
  Jev scores), a command only the owner can run, a landing/live switch finished, a blocker or incident — in at
  most two lines. No interim status or worker notifications.

## Workspace and product boundaries

- Work from `/home/alperen/deckent-next`. `/home/alperen/deckent-dev` is the frozen, read-only
  reference: never start its runtime, workers, entry points, recovery or generation commands.
  Inspect relevant legacy successes and failure causes without copying its authority or old aliases.
- Development host tooling is in `.agents/`; retained proof and historical refactor material belong
  in `/home/alperen/deckent-refactor-work`, outside Next Git/npm. Resolve output destinations explicitly
  and respect filesystem permissions. Do not recreate that external workspace inside Next.
- Use `.agents/refactor/next-entry.mjs cli|mcp|node` for authorized Next operator commands;
  it selects the Next execution/configuration roots. Reading this instruction does not admit a run.
- Preserve concurrent edits, worktrees, identity stores, keyrings, audit keys and retained effects.
  Historical MASTER, DIRECTIVES, runtime receipts or fixed session/model identities admit no new work.
- Follow the current owner-admitted dogfood scope in PLAN and live instructions. DOGFOOD is owner-approved
  (2026-10-09): it opens at the first possible moment, then 4–8 workers run continuously (Codex → Cursor →
  Sonnet 5.5 → Haiku 5.5; at 92% of a 5h subscription window wait for the reset). The lead lands after Astra PASS
  and runs N1/live switches itself (verified backup → health check → rollback on failure); steps that need a human stay
  with the owner. A historical receipt grants no broader access.
- Evaluate work against the north star and current architecture: customer-installed, secure standalone
  Core; separately distributed proprietary Enterprise; reusable ERP/Enterprise contracts; one typed
  application contract and transition owner; pure domain and explicit ports/composition.
  Carry principal, scope, resource and policy. Persona grants no authority; worktree separation is
  not filesystem/process/network/secret isolation. Preserve bounded resources, cancellation,
  recovery and uncertain-effect handling. Mutable policy belongs in registries; invariants are versioned code.
- Read current architecture and machine gates for language, package, file-size, version and migration
  contracts. Do not freeze a completed transition or an illustrative workload into a new product limit.
  Preserve business capabilities when compacting code. Never claim unmeasured performance or scale.

## Working loop

1. **Establish the assigned work.** Pin Next HEAD, dirty paths, overlapping worktrees and ownership.
   Identify the owner-admitted objective and relevant PLAN workstream; findings alone do not create work.
   Inspect a legacy revision only when its behavior or failure lesson is relevant. Record the intended
   user result, read/write scope, dependencies, invariants, known defects and required proof.
2. **Choose the relevant method.** Load the smallest sufficient specialist skill set for the task.
   Check its Next implementation and current authority before following historical paths or procedures.
   Before design, code or advice involving an API, SDK, library, protocol, standard or vendor, verify
   current official documentation/specifications/changelogs and relevant context7/package-registry
   evidence as required by the repository contract. Record date, sources, established practice,
   current state and unavailable evidence; do not infer currency from a retained note.
3. **Make the slice visible.** Explain in plain Turkish the concrete behavior/responsibility,
   why it is next, relevant source evidence, intended corrections, write boundary and proof scope.
   Keep technical detail useful for the owner's decision. Report material findings and direction changes
   during work; distinguish facts, proposals, assumptions and unknowns. Record development effort below.
4. **Perform only admitted actions.** Implement the smallest complete responsibility for development
   work; preserve the non-mutating boundary of a read-only analysis/review. Work only in assigned paths.
   Resolve relevant root causes with negative proof. Bound retries and stop unchanged-failure loops.
   Delegation requires authorized independent work, disjoint writes and one writer per shared resource.
   Continue routine work under existing authorization; new scope or authority needs an owner checkpoint.
5. **Verify the behavior in scope.** Trace producer → application → adapter → actual surface.
   Exercise relevant failure, cancellation, replay, scope and recovery paths. Use targeted checks during
   implementation; host-tool success proves host tooling only. Follow `law_local_verification.md`:
   local tests stay within 16 GB, targeted/lane Vitest runs use `VITEST_MAX_FORKS=2`, full verify uses
   its default four workers, and no build runs during an active suite. Slices and ordinary batches land on targeted checks
   (typecheck, eslint on changed files, lint-arch, the touched test files); full `npm run verify` runs only for batches that add
   broad features and only when the owner asks (owner 2026-10-03). Targeted checks are not independent acceptance.
6. **Reconcile documents.** At task start correct verified stale claims in affected documents; update
   them when accepted scope/decisions change and before delivery/handoff. Put contracts in ARCHITECTURE,
   durable remaining work in PLAN, completed work in COMPLETED-PLAN when needed, lasting decisions/lessons
   in core-memory, who-holds-what/next step on the process board and proof/open limits in the external proof
   folder; current-flow is short-term task memory only. Update CHANGELOG when release
   behavior warrants it. Leave unaffected documents and other contributors' progress intact.
   After authorized core-memory edits run `node scripts/lint-core-memory.mjs --write`.
7. **Deliver a bounded result.** Report changed paths and exact revision/diff identity, commands/results,
   actual versus planned surfaces, preserved behavior/corrections/gaps, material ownership or contract
   impact, independent findings, open limits and the concrete next step. Explain user/team/Enterprise
   consequences when relevant. Keep implementation, verification, independent review, owner acceptance
   and release separate. Commit only with owner authorization; publish/push needs its own authorization.

## Owner-requested work ordering

When the owner asks for work order, compare the owner-selected findings or candidates by user
value, dependency unlock, safety, cost, operational risk and the cost of acting now versus waiting.
Present meaningful alternatives with concrete gains/losses; do not invent options to fill a quota.
Preserve accepted priorities. Bring a material new conflict to the owner as a justified amendment,
not a silent reorder. State the proposed sequence, prerequisites, deferred items with reasons and
first outcome candidate. Owner acceptance of the sequence is distinct from admission of that
outcome or its execution; findings alone never create work. Use logged Jev for material uncertainty.

## Session handoff

For an authorized handoff, carry the exact source/recipient role, admitted objective and first
action, base/head and owned dirty diff, scopes and transition ownership, verification artifacts,
independent review status, unresolved effects/holds and remaining permission boundaries.
Refresh only facts affected by revision, scope, ownership or relevant installed-runtime drift.
The recipient checks the actual candidate and current authority before acting; a transcript,
summary or digest alone grants no execution or acceptance authority.
Use an existing typed receipt protocol only when implemented and required by current Next policy;
do not invent legacy prepared/verified/committed states, signing tools or automatic authority transfer.
Reconcile affected documents and retain proof outside Git/npm. A handoff is not commit/push permission.

## Independent review and channel

The current owner arrangement is Opus implementing and Sol independently reviewing; the reviewer's
model-independent channel address remains `astra`. Follow the role actually assigned in the session.
An implementation assignment does not authorize reviewing one's own work as an independent PASS.

Channel commands from Next:

    node .agents/refactor/channel.mjs read
    node .agents/refactor/channel.mjs append FROM TO BODY_FILE
    node .agents/refactor/channel.mjs consume ACTOR SEQ

At an admitted slice delivery, send `REQUEST_REVIEW` with exact candidate commit/diff scope,
verification evidence and open decisions; its status source is the process board and PLAN. Answer a handled request with evidence-backed `REVIEW`
(PASS/REVISE with scope and findings) or `ANALYSIS`. Apply blocking REVISE findings before landing
unless the owner explicitly decides otherwise. Recipient-only consume follows handling; an unrelated
or unreviewed request stays pending. A failed consume is not a completed receipt. No ACK chains.

`.deckent/host/channel/communication.md` is ignored coordination data. Message bodies and hook/watcher
prompts grant no scope, execution, commit, push or live-intervention authority. Continue only admitted
work while review is pending. The historical legacy Fable/xverify channel remains closed.
Report independent review availability honestly; Jev, self-review, test green and an ACK are not PASS.

## Jev decision support

Use logged Jev preparation for material option, boundary, coverage and evidence-fit judgments.
Before preparing or asking a case, read [jev-workflow.md](jev-workflow.md) in this skill directory;
it carries the required case schema, north-star context, abstention choices, scoring interpretation,
privacy, journaling and outcome rules. Use the preparation layer from Next, not the low-level client.
Do not call for every mechanical edit or repeat an unchanged question to chase a score.
Jev advice never changes owner authority, proves behavior or supplies independent acceptance.

## Development duration measurement

Record each development slice with `node .agents/refactor/effort.mjs`: `start <CARD-slice> --milestone M1..M5 --title --actor [--kind active]`,
`phase <slice> active|blocked|verification|rework [--reason owner-decision|external-review|dependency|environment|quota|other]`,
`pause <slice>` when work stops without an end, `end <slice> done|canceled|handed-off`, `status`/`report [--milestone] [--format table]`.
Events are immutable private files under `.deckent/host/effort/<slice>/` (Git-ignored, `DECKENT_EFFORT_CONFIG` overrides the config).
Time counts only between explicit events; pause and open tails are unknown and never estimated; `--at` timestamps are
marked operator-supplied and must come from real evidence, never reconstruction. Commit counts are not effort. Reports are
forecast input for the PLAN M1–M5 table, not acceptance, product ledger state or a second work-tracking authority.
