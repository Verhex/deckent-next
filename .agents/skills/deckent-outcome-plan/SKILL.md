---
name: deckent-outcome-plan
description: Plan one owner-admitted Deckent Next outcome as a bounded dependency DAG, ownership map and proof contract before implementation or execution.
---

# Deckent Next Outcome Plan

## Scope and authority

Use `deckent-next-refactor` for the common development contract. Plan one exact owner-admitted
result using current ARCHITECTURE, PLAN, relevant core-memory and a current authority snapshot.
Reuse unchanged `deckent-authority-bootstrap` evidence; refresh only affected facts.
An accepted priority, audit, transcript or historical receipt cannot admit execution by itself.
This skill creates a plan, not a product Run, worker, state transition or new authority gate.

## Bound the result

- State the observable user/product result, current defect or gap, and acceptance boundary.
- Distinguish existing mechanisms from accepted future targets. Do not require dogfood or every
  product surface when the exact outcome does not claim them.
- Record exact read/write and negative scopes, concurrent ownership, protected paths, durable
  state, entrypoints, policy/config inputs, contract versions and migration dependencies.
- Map the actual application objects and transition owners. Inspect the Run/Task/Attempt and
  operation/effect chain in scope; do not impose an illustrative legacy hierarchy.
- Preserve installation/company/resource/principal boundaries and the standalone Core contract;
  Enterprise/ERP adapters extend registries and ports rather than introducing a second flow.

## Dependency and ownership DAG

For each node record its responsibility, prerequisites, exact inputs/outputs, sole writer,
write conflicts, verification and stop condition. A join accepts evidence from its own nodes.
Identify the critical path and genuinely independent lanes; do not create parallel agents
without authorization or when coordination costs outweigh the task.
Name shared hot files and assign one writer. Include affected document reconciliation.
Resolve runtime provider/model/capacity from current typed config and policy only when runtime
execution is admitted; a host plan must not invent a worker or resource limit.

## Proof and bounded execution

Define producer → application → adapter → actual consumer proof, exact revision/input custody,
and relevant negative paths: denial, cancellation, replay, partial effect, timeout and recovery.
Separate source checks, author tests, retained execution, current surface evidence and independent
review. Mark unavailable platforms or consumers explicitly; tests alone cannot prove live behavior.
Set finite time/cost/retry bounds from the actual task and current policy, changed-evidence
requirements, rollback or reconciliation path, stop conditions and escalation points.
For uncertain effects preserve `unknown` until reconciliation rather than promising a safe retry.

## Actions and output

Carry existing authorization forward. Identify only genuinely missing authority for destructive,
auth, live-intervention, commit or publish actions; planning does not grant it.
Use logged Jev for material tradeoffs, with realistic gains/losses and both abstention choices.
Return the outcome, DAG, ownership/scopes, contract/config dependencies, proof manifest,
budgets and stop rules, unresolved decisions and first admitted next step.
Do not start implementation or runtime merely because the plan is ready.
