---
name: deckent-parallel-execution
description: Execute an admitted Deckent outcome through independent DAG lanes with exact authority, custody, and fan-in. Do not use for audits, vague work, or arbitrary agent multiplication.
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


# Deckent Parallel Execution

## Preconditions

Require an active owner-admitted outcome and an accepted `$deckent-outcome-plan`. Re-run
`$deckent-authority-bootstrap` if HEAD, worktree, runtime, config, or capacity changed. Use the
official Goal/Mission/Flow/Run/Autonomous/Do surface required by live policy.

## Admission and decomposition

- Resolve providers, models, effort, worker pool, concurrency, budgets, and capability from
  effective config, registry, auth/reachability evidence, resource policy, and the dependency DAG.
  Never force them from instruction prose.
- Split only genuinely independent work. Assign exact disjoint write scopes, negative scopes, and
  one writer per hot file. A single small task does not justify parallel agents.
- Give each lane the exact outcome, task, operation, invocation, causation, and attempt identities,
  along with its accepted proof manifest and stop conditions.
- Preserve immutable task snapshots and attempt-private result, partial-result, timeout, log, and
  IPC custody. Never accept a sibling, prior, unrun, replayed, or unattributed result.

## Supervision and fan-in

Use `$deckent-observe` throughout the active lifecycle. The supervising Brain must compare
heartbeats, receipts, disk diff, effective run policy, result evidence, evaluation, finalizer,
settlement, and archive; worker self-report is not sufficient.

Fan in only at declared DAG joins. Recheck scope collisions and exact attempt identity before
acceptance. Fail closed on missing, stale, ambiguous, tampered, or mismatched custody. Apply the
finite FIX budget; require a changed evidence fingerprint before retrying.

## Boundaries

Do not broaden the active outcome, silently recover, clean `.tasks`, mutate `.brain/memory.db`, run
a build during an active sprint, change auth, or cross an owner-only gate. Return typed HOLD or
ABORTED truth when execution cannot safely continue.
