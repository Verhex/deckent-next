---
name: deckent-recovery
description: Perform one explicitly authorized, typed ADR-D-007 recovery package when Deckent dogfood health is degraded. Never use it as a normal feature or refactor path.
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


# Deckent Recovery

## Recovery gate

Proceed only when live policy keeps `DOGFOOD_MODE=ON`, evidence declares
`DOGFOOD_HEALTH=DEGRADED`, normal execution cannot safely progress, and the owner has authorized an
exact typed ADR-D-007 package. Run `$deckent-authority-bootstrap` first. Recovery selection itself
does not satisfy these conditions.

## Bound the package

- Name the blocked outcome, engine defect, exact root-cause evidence, recovery identity, read/write
  and negative scopes, protected paths, budget, finite attempts, proof manifest, and return-to-
  dogfood boundary.
- Keep one package and one writer per hot file. Do not absorb normal feature work, unrelated
  findings, broad cleanup, or a second workflow engine.
- Preserve canonical ABORTED, HOLD, receipt, archive, task, and memory truth. Never manually mutate
  `.brain/memory.db` or delete `.tasks`.
- Require exact task/attempt/result/effect/receipt attribution. Fail closed on stale, sibling,
  replayed, unrun, partial, missing, or tampered evidence.
- Stop when the budget is exhausted or the failure fingerprint is unchanged; do not create an
  unlimited FIX/retry chain.

## Separate owner gates

Kill/cleanup, destructive actions, build or host-adapter restart during runtime, auth changes,
XVerify, authenticated closure/MASTER mutation, commit, and push each require their current exact
authority. Do not infer one permission from another.

## Exit

Verify the repaired production wiring and the engine path needed to resume dogfood. Tests may help
diagnose but cannot close recovery. Return to the official Goal/Mission/Flow/Run/Do path at the
earliest safe boundary, then invoke `$deckent-closure`. If that return cannot be proven, report
DEGRADED/HOLD rather than declaring completion.
