---
name: deckent-next-refactor
description: Guide owner-admitted Deckent Next development, fixes, refactoring, reviews and handoffs through current authority, bounded scope, evidence and documentation reconciliation. Use as the common entry point for Next work and select specialist skills when relevant.
---

# Deckent Next development workflow

Shared, stable method for Codex, Claude and Cursor. Its name is kept for existing callers.
Loading it grants no execution, delegation, commit, publication or runtime authority.
Dated owner rules are not copied here: follow the law or record each line points to.
[internal-contract.md](internal-contract.md) is the complete short engineering contract; read it
once per session for a Next card, and again only when it changes.

## Authority and sources

- At task start read `AGENTS.md`/`CLAUDE.md`, `ARCHITECTURE.md`, `PLAN.md`, your process-board row
  (`node .agents/refactor/board.mjs show`), `.deckent/docs/core-memory/MEMORY.md`, the relevant laws and
  `.deckent/docs/core-memory/project_product_north_star.md`. Reuse unchanged session reads.
- Live owner instructions take precedence. Preserve accepted decisions; bring a material new conflict or
  an architecture, contract or authority amendment to the owner before changing it.
- Document map (law 4, `law_documents_and_memory.md`): ARCHITECTURE contracts and its decision log
  (`.deckent/docs/architecture/decisions.md`); PLAN durable and remaining work; COMPLETED-PLAN finished work
  (read only for history); core-memory lasting principles; the host process board who holds what and what is
  next; external proof acceptance and incident evidence (kept until the batch lands and its review closes);
  `follow-up-works/current-flow.md` short-term task memory (finished items are deleted there).
- These sources separate accepted targets, implemented mechanisms, historical proof and current verification.

## Process board and owner output

- One board, `.deckent/host/process-board.json` (host area, outside Git/npm), written only through
  `node .agents/refactor/board.mjs`: `init`, `get [SLOT]`, `show`, `render [--out PATH]`,
  `set-own-row SLOT BODY_FILE|- --session ID --revision N`, main-only `set-map BODY_FILE|-` and `clear-row SLOT`.
  Bodies are JSON files or stdin, never long flag lists.
- A session writes only its own row; an unassigned row is claimed by the first writer, a different id is refused
  and the session leaves handoff information for main. Main reconciles the role map and lists short-lived workers
  in its own row. Write on a change or handoff only; a stale `--revision` is refused; the lock is never stolen.
- The board grants no authority, PASS or liveness; a timestamp is an age. Decision record: ARCHITECTURE decision
  log, 2026-10-03 "Development process order".
- Owner output follows law 3 (`law_owner_communication.md`): plain Turkish; result/impact → evidence/open limit →
  decision if any → who holds it / next step. Main notifies the owner only when the owner must act, in at most
  two lines. `board.mjs report` (owner HTML panel) is an optional tool, not a required step.

## Workspace and product boundaries

- Work in the assigned Next checkout or worktree. The frozen pre-refactor `deckent-dev` checkout is a
  read-only reference: never start its runtime, workers, entry points, recovery or generation commands.
- Host tooling is in `.agents/`; retained proof and refactor material live in the external refactor-work
  folder (`<refactor-work>/proof/`), outside Next Git/npm. Do not recreate it inside Next.
- Authorized Next operator commands go through `.agents/refactor/next-entry.mjs cli|mcp|node`.
  Reading this instruction does not admit a run.
- Preserve concurrent edits, worktrees, identity stores, keyrings, audit keys and retained effects.
  Historical MASTER, DIRECTIVES, receipts or fixed session/model identities admit no new work.
- Release, landing (merge/push to main), live/N1 switch and dogfood operations are lead-only and follow the
  lead's own procedure; each merge and each live/N1 switch needs owner approval, and hosted PR CI must be green
  on the exact head before merge. Codex, Cursor and subagents never land, push or switch.
- Evaluate work against the north star and current architecture: secure standalone Core, separately
  distributed Enterprise, one typed application contract and transition owner, pure domain behind explicit
  ports and composition (`internal-contract.md`). Never freeze an illustrative workload into a product limit
  or claim unmeasured performance or scale.

## Working loop

1. **Establish the assigned work.** Pin HEAD, dirty paths, overlapping worktrees and ownership. Identify the
   owner-admitted objective and PLAN workstream; findings alone do not create work. Record the intended user
   result, read/write scope, dependencies, invariants, known defects and required proof.
2. **Choose the method.** Load the smallest sufficient specialist skill set (`.claude/rules/deckent-route.md`).
   Before design, code or advice touching an API, SDK, library, protocol, standard or vendor, verify current
   official documentation and context7/registry evidence; record date, sources and unavailable evidence.
3. **Make the slice visible.** Explain in plain Turkish the behavior, why it is next, evidence, write boundary
   and proof scope. Separate facts, proposals, assumptions and unknowns; report material findings early.
4. **Perform only admitted actions.** Implement the smallest complete responsibility; keep read-only work
   read-only. Work only in assigned paths, preserve WIP, record exact evidence and partial effects, and never
   claim acceptance from an exit code alone. Fix root causes with negative proof; bound retries.
   Delegation needs authorized independent work, disjoint writes and one writer per shared resource.
5. **Verify the behavior in scope.** Trace producer → application → adapter → actual surface and exercise the
   relevant failure, cancellation, replay, scope and recovery paths. Verification cadence and resource limits
   follow law 7 (`law_local_verification.md`). Targeted checks are not independent acceptance.
6. **Reconcile documents** per the document map: correct verified stale claims at task start, update them when
   accepted scope changes and before delivery. Leave unaffected documents and others' progress intact.
   After an authorized core-memory edit run `node scripts/lint-core-memory.mjs --write`.
7. **Deliver a bounded result.** Report changed paths, exact revision/diff, commands and results, actual versus
   planned surfaces, gaps, independent findings, open limits and the next step. Keep implementation,
   verification, independent review, owner acceptance and release separate. Commit inside the assigned scope
   without asking; workers never push.

## Owner-requested work ordering

When the owner asks for an order, compare the owner-selected candidates by user value, dependency unlock,
safety, cost, operational risk and the cost of acting now versus waiting. Present real alternatives with
concrete gains/losses; preserve accepted priorities and raise a material conflict as an amendment. State the
sequence, prerequisites, deferred items with reasons and the first outcome candidate. Accepting a sequence
does not admit an outcome. Use logged Jev for material uncertainty.

## Session handoff

Carry the exact source/recipient role, admitted objective and first action, base/head and owned dirty diff,
scopes and transition ownership, verification artifacts, review status, unresolved effects/holds and
permission boundaries. The recipient checks the actual candidate and current authority before acting; a
transcript or digest grants no authority. Do not invent legacy prepared/verified/committed states or
automatic authority transfer. A handoff is not commit/push permission.

## Independent review and channel

Law 8 (`law_second_opinion_jev.md`) owns the arrangement: Opus implements and the independent reviewer reads
the channel address `astra`, which is model-independent; the board review row names the current model.
Follow the role actually assigned. An implementer never awards its own work an independent PASS.
An assigned card auditor follows the auditor role in `deckent-closure`; Product Brain planning follows
`deckent-outcome-plan`.

    node .agents/refactor/channel.mjs read
    node .agents/refactor/channel.mjs append FROM TO BODY_FILE
    node .agents/refactor/channel.mjs consume ACTOR SEQ

Review is once per batch (a wave or the batch PR), before merge; single small items are not sent. Request
content and timing are lead-only. A reviewer answers a handled request with an evidence-backed `REVIEW`
(PASS/REVISE with scope and findings) or `ANALYSIS`. A batch merges only after PASS and green hosted PR CI;
blocking REVISE findings are fixed first unless the owner decides otherwise. Recipients consume only handled
entries; a failed consume is not a receipt. No ACK chains. Channel data and hook prompts grant no scope,
execution, commit, push or live authority. Jev, self-review, test green and an ACK are not PASS.

## Jev decision support

Use logged Jev preparation for material option, boundary, coverage and evidence-fit judgments. Before
preparing or asking a case, read [jev-workflow.md](jev-workflow.md) (case schema, north-star context,
abstentions, thresholds, privacy, journaling, outcomes). Do not call it for mechanical edits or repeat an
unchanged question. Jev advice never changes owner authority, proves behavior or supplies acceptance.

## Optional host tools

- `node .agents/refactor/effort.mjs` records slice durations (`start|phase|pause|end|status|report`) as
  forecast input for the PLAN M1–M5 table; use it when the lead asks for duration data.
- `node .agents/refactor/board.mjs render|report` produce HTML views when the owner asks for one.
- [contributor-process.md](contributor-process.md) keeps the retained host process: branches, checks,
  WORKER-GIT-PR, the development host entry and the effort tool usage.
