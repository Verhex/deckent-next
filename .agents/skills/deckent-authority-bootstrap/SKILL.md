---
name: deckent-authority-bootstrap
description: Establish Deckent-dev authority, mode, repository, runtime, and evidence truth at the start of an operator session. Do not use it by itself to admit or execute work.
---

## Next refactor scope — 2026-09-17

For current Deckent Next work, first apply `deckent-next-refactor` from the host skill directory.
Product writes target `/home/alperen/deckent-next`; legacy `/home/alperen/deckent-dev` is a read-only
reference except the owner-authorized host tooling/channel setup. Next ARCHITECTURE.md and PLAN.md
carry accepted refactor decisions. Relative legacy `docs/`, `.deckent/workspace/`, `src/` and
`scripts/` references below resolve in the legacy repository for reading only; inspect target
implementation separately. Do not run legacy generation, recovery, MCP or dogfood commands for Next.

For refactor planning/execution/review, use the per-card loop and proof requirements in
`deckent-next-refactor`, then stop here. The historical runtime protocol below applies only
when the user explicitly requests that legacy runtime operation; it is not a Next admission gate.

## Historical legacy runtime procedure


# Deckent Authority Bootstrap

## Outcome

Produce a fresh, read-only authority snapshot before planning, execution, observation, recovery,
closure, or handoff. Loading this skill never grants permission to mutate anything.

## Read authority in order

Use the active repository and read only authority relevant to the requested work:

1. Resolve `AGENTS.md` and its live control block. Reuse instructions already supplied in this
   session when the on-disk content is unchanged; recheck changed authority before relying on it.
2. Consult `DECKENT.md` for the relevant workflow or capability; do not load the entire catalog
   just to initialize an unrelated task.
3. Read `docs/governance/deckent-dev-operating-policy.md` before run-touching work.
4. Read `.deckent/docs/core-memory/MEMORY.md` for Deckent development authority and only its
   directly relevant references. Reuse unchanged content within the same session.
5. Read `.deckent/workspace/IDENTITY.md` and the applicable vision sections when product
   direction or identity is relevant.
6. Search `docs/MASTER-PLAN.md` for the exact outcome/task and read its surrounding scope,
   dependencies and gates. Read the full ledger only for an explicitly comprehensive ledger
   audit or when the evidence shows the scope requires it.

Reuse is session-local: retain source paths and content digests, refresh changed sources, and
never substitute a previous transcript for authority after handoff. Widen the read when a
reference, dependency or contradiction requires it; selective reading never waives a gate.

Read `DIRECTIVES.md` and the applicable `.codex/rules/*.md` only when touching an active run or
their owned paths. Treat generated files, exports, retained directives, old sprint state, capsules,
and transcripts as evidence, never as policy or new authority.

## Measure without mutation

- Resolve the live control block, branch, HEAD, upstream relation, staged/unstaged/untracked state,
  and overlapping worktrees.
- When making ledger, closure or execution-admission claims, measure the canonical MASTER
  validator and Closure OS head with documented read-only checks. Do not trust copied counts.
- For runtime-related work, inspect the relevant process, container, lock, heartbeat, task and
  receipt state; inspect archives only when a reference or historical question requires them. Use
  commands or projections proven not to write. Do not assume a command named `status` is read-only.
- Separate repository source, durable product state, runtime projection, and generated evidence.
- Do not read raw `.brain/memory.db`, credentials, tokens, private keys, or secret-bearing files.

## Resolve contradictions

Apply the repository precedence chain. Prefer canonical persisted state and producer receipts over
derived views. Record a contradiction as typed `HOLD` when authority, freshness, or attribution
cannot be proven; never silently choose the convenient source.

## Required output

Return the timestamped snapshot, authority/mode, dirty-state ownership, active outcome and runtime,
MASTER/Closure heads when measured (otherwise explicitly not inspected), open HOLDs, owner-only gates, and the exact next authorized action.
Do not start that action unless its own skill and admission requirements are satisfied.
