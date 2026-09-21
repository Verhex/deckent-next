---
name: deckent-outcome-plan
description: Plan one exact owner-admitted Deckent outcome as a bounded dependency DAG and proof contract. Do not use for vague mega-outcomes or to start execution.
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


# Deckent Outcome Plan

## Admission gate

Require a final owner-approved order, a fresh `$deckent-authority-bootstrap` snapshot, and one exact
outcome identity admitted against canonical MASTER authority. A retained `DIRECTIVES.md`, capsule,
old sprint, generated plan, or transcript cannot satisfy this gate.

## Plan the full closure path

- Define the user/product result and the dogfood/orchestration result together.
- Map the dependency DAG, exact read/write/negative scopes, one-writer collision boundaries, hot
  files, durable state, entrypoints, effective config, platform/tenant matrix, and rollback or
  reconciliation path.
- Define Goal → Mission → Flow → Run/Autonomous/Do relationships without forcing provider, model,
  worker count, or concurrency. Those resolve from effective config and live capacity.
- Preserve exact operation, invocation, causation, attempt, result, effect, receipt, evaluation,
  finalizer, settlement, archive, restart, and recovery identities relevant to the outcome.
- Set finite retry/FIX ceilings, changed-evidence fingerprints, time/cost bounds, stop conditions,
  and escalation points. An unchanged failure cannot create an unbounded FIX chain.
- Write a verification manifest that names real production surfaces and consumers. Tests are only
  supporting checks; they are never the closure claim.

## Required gates

Identify owner-only approval separately for kill/cleanup, build or adapter restart during runtime,
auth mutation, destructive action, XVerify, authenticated closure/MASTER mutation, commit, and
push. Keep out-of-scope findings classified but unimplemented.

## Output

Return an execution-ready capsule: exact outcome, DAG, scopes, authority sources, config-resolved
admission inputs, proof manifest, budgets, stop/HOLD rules, and next command surface. Planning alone
does not create or start a Goal, Flow, Run, task, or settlement.
