---
name: deckent-outcome-ordering
description: Turn an owner-accepted Deckent audit into an outcome sequence through dependency and user-impact decisions. Do not use it to mutate MASTER or start execution.
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


# Deckent Outcome Ordering

## Preconditions

Require an accepted audit, a fresh `$deckent-authority-bootstrap` snapshot, and an owner request to
decide work order. Preserve choices the owner already accepted unless new disk evidence invalidates
them.

## Build the decision

- Reconcile findings with the canonical `docs/MASTER-PLAN.md` dependency DAG and actual code
  blockers. Generated plans and old sprint order are not authority.
- Keep one ACTIVE product outcome at a time. Separate foundation, enabling work, terminal closure,
  and post-product programs.
- Compare two or three materially different paths by end-user gain, orchestration gain, dependency
  unlock, safety, cost, operational risk, and reason to act now or wait.
- Preserve 4030 operation identity/invocation/effect-attribution scope separately from 4040
  permission/enforcement and 4050 approval authority unless canonical evidence changes the DAG.
- Do not turn findings into automatic MASTER rows, and do not reopen an accepted decision merely
  to repeat analysis.

## Owner dialogue

State a recommendation and its tradeoff in plain Turkish. Ask only one short question per turn,
phrased by result and user impact rather than implementation jargon. Update the proposed sequence
from each answer. The order is not final until the owner explicitly says it is complete.

## Boundary and output

This skill produces the accepted sequence, dependencies, decision record, deferred findings, and
the first outcome candidate. It does not edit MASTER, create a Goal/Run, sign closure, or grant the
next skill authority.
