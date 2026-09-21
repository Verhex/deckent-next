---
name: deckent-observe
description: Observe active Deckent Goals, Flows, Runs, workers, effects, and settlements through non-mutating evidence. Do not use it to decide recovery, retry, or terminal truth.
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


# Deckent Observe

## Outcome

Provide a current, read-only view of an active or recently terminal lifecycle without changing it.
Start from `$deckent-authority-bootstrap`; when observation reveals a decision, report it to the
appropriate execution, recovery, or closure authority rather than acting.

## Follow the lifecycle

Trace Goal → Mission → Flow → Run → WorkItem → Attempt → Operation → Effect → Receipt. For each
object record initiator/principal, scope, operation/invocation/causation identity, responsible
worker/provider, state and state age, heartbeat/freshness, budget/usage when available, evidence,
side effects, intervention authority, and settlement/archive state.

Inspect safe process/container listings, execution locks, task and heartbeat files, durable
receipts, append-only events, provider observations, disk diff, accepted result identity,
brain evaluation, finalizer, and settlement. Use only commands or projections proven read-only;
do not assume `status` is safe because of its name.

## State semantics

Keep lifecycle, freshness, authority, evidence, and outcome separate. Never collapse `stale`,
`unknown`, `unavailable`, `blocked`, `failed`, `aborted`, and `terminal` into one state. A terminal
archive receipt that conflicts with a live event head is a contradiction/HOLD, not a cleanup cue.

## Hard boundaries

Observation cannot retry, FIX, pause, resume, cancel, recover, force-finalize, settle, archive,
cleanup, restart, build, mutate auth, sign, or edit MASTER. Never read credentials or raw
`.brain/memory.db`, and never delete `.tasks` content.

## Output

Report timestamp, freshness, lifecycle map, exact identities, disk/runtime evidence, contradictions,
and the next authority that must decide. Use typed HOLD when evidence is incomplete or unsafe.
