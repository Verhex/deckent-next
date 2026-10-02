---
name: deckent-parallel-execution
description: Coordinate explicitly authorized independent Deckent Next implementation or execution lanes with disjoint ownership, exact evidence custody and fan-in.
---

# Deckent Next Parallel Execution

## Preconditions

Apply `deckent-next-refactor`. Require explicit authorization for delegation/parallel agent work,
an admitted result and a bounded dependency/ownership plan (`deckent-outcome-plan` when needed).
Skill invocation alone is not delegation permission. For a small or coupled slice use one writer.
Refresh affected bootstrap facts if revision, ownership, policy or relevant runtime changes.
Distinguish host development lanes from product workers; they have different execution authority.

## Lane contracts

- Split only independent responsibilities with a real dependency join and useful parallel gain.
- Assign exact input revision/diff, task, role, read/write/negative scopes, sole writer, output
  artifacts, proof, time/resource bounds and stop conditions to every lane.
- Preserve shared-file ownership; use isolated worktrees when helpful, without claiming process,
  filesystem, network or secret isolation from a worktree alone.
- Resolve product providers, models, realms, capability and concurrency from admitted current
  config/policy/capacity. Host instructions do not force a runtime provider or extra workers.
- For product execution retain task/attempt/operation/invocation/effect identities and immutable
  inputs, attempt-private results, partial outputs, timeout evidence and logs.
- For host development retain the lane revision, owned diff and check artifacts. Do not fabricate
  product receipts or independent acceptance for a host tool result.

## Supervision and fan-in

Inspect each lane's artifacts and diff, not just its self-report. Observe admitted live work with
`deckent-observe`; use safe read-only evidence without broad host access.
At declared joins recheck base/head, write collisions, custody and dependency results. Reject
sibling, prior, replayed, unattributed or ambiguous results. Integrate only admitted owned changes.
Keep implementation checks, independent review and owner acceptance separate. The implementer
cannot independently PASS its own lane; spawning a reviewer also requires delegation authority.
Bound retries; an unchanged failure or unknown side effect cannot justify another automatic attempt.

## Stop and delivery

Pause the affected lane on missing authority, conflict, unsafe custody or exhausted budget;
continue unrelated admitted work. Report a lane hold/cancellation without pretending the product
state has transitioned. Do not clean runtime data, force-settle, change auth or restart services
under a coordination instruction. Route recovery or terminal assessment to their admitted methods.
Deliver lane inputs/outputs, exact integrated diff, join evidence, checks and failures, unresolved
limits, document reconciliation and next action. Run full verify before landing; commit/push
still require their current owner authority.
