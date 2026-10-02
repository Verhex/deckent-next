---
name: deckent-recovery
description: Plan or perform one explicitly authorized Deckent Next recovery through existing typed ports, with exact affected identities, bounded effects and reconciliation proof.
---

# Deckent Next Recovery

## Authority and evidence

Apply `deckent-next-refactor` and relevant `deckent-authority-bootstrap` facts. Require an exact
authorized recovery target/action, observed failure, scope and safety boundary before mutation.
Reading this skill, an unavailable observation or a legacy receipt grants no recovery authority.
Current owner dogfood/live limits remain in force; recovery does not enable DOGFOOD or legacy runtime.
Read-only diagnosis uses `deckent-readonly-audit` or `deckent-observe`.

## Select the existing recovery seam

Inspect the current command/query contract and composition for the affected operation.
Next Run cancellation recovery is exported through `src/engine/core/runs/index.ts`; output,
reconciliation and cancellation recovery wiring live under `src/composition/core/runs/internal/`.
Verify the exact available handler and admission policy for this target; these paths do not imply
that every failure has the same recovery command. Historical ADR-D-007 packages are reference
evidence, not a verified Next package schema or a mandatory legacy environment gate.
Do not invent a second workflow engine, manipulate raw ledgers or synthesize accepted receipts.

## Bound one package

- Record executable/revision/data roots, target Run/Task/Attempt/operation/effect/receipt identities,
  failure cause and contrary evidence, read/write/negative scope and sole writer.
- Preserve existing inputs, partial effects, logs and uncertainty before acting. An ambiguous
  write or failed durable transition remains unknown; neither success nor cancellation is inferred.
- Choose the existing typed action with its principal/company/resource/policy and current state
  prerequisites. Carry already-granted permission; missing destructive/auth/live authority blocks
  only the dependent action. Never treat emergency wording as host/ERP/secret permission.
- Define finite time/cost/attempt bounds, changed-evidence fingerprint, protected state, rollback
  or reconciliation limits and the safe return boundary.
- Separate an implementation fix from an operator action. A code fix still needs owned diff,
  negative proof and normal verification; it is not permission to restart a live service.

## Execute and reconcile

Perform only the authorized typed action, preserving idempotency and effect attribution.
Use fresh scoped observation to compare the before/after transition, durable receipt/settlement
and actual consumer behavior. A lost response is not a safe automatic retry; reconcile first.
Stop on exhausted budget, unchanged failure, identity drift or unsafe/ambiguous custody.
Keep unrelated features, broad cleanup, manual database changes and legacy commands out of scope.

## Exit

Report the exact recovery action and evidence, resolved versus unknown effects, actual health,
remaining failure paths and next authorized step. Prove the restored production path when recovery
completion is claimed; tests alone are diagnostic support. Use `deckent-closure` for the required
completion assessment. If the return boundary cannot be proven, report recovery incomplete/HOLD
without overwriting canonical product truth or silently enabling normal execution.
