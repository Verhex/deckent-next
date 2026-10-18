---
name: deckent-closure
description: Assess completion of one admitted Deckent Next outcome against its exact proof contract, production wiring, real surfaces and durable effect settlement.
---

# Deckent Next Closure

## Admission and role

Apply `deckent-next-refactor`. Require the exact outcome/candidate revision or owned diff,
accepted proof contract, intended user result and relevant current bootstrap facts.
This is a completion assessment; it grants no product transition, live intervention, signing,
commit or push authority. Follow the assigned role, not a self-declared reviewer identity.

## Auditor review role

When assigned the card auditor role (former auditor rule, owner 2026-10-18): Fable independently reviews
the current card read-only. Verify real wiring, invariants, failure evidence and diff identity.
Report PASS/REVISE; ACK is not review. Within the first ~10 tool calls write a provisional findings
table (severity | file:line | issue | failure scenario | fix) to the card's proof review file; verify
and update it, and end with PASS/REVISE plus surfaces checked, so an interrupted review still leaves a record.

## Verify applicable proof links

1. Trace canonical producer → application contract → adapter → entrypoint/consumer, including
   effective policy/config enablement. Source reachability is distinct from execution proof.
2. Pin actual binary/revision, immutable inputs and Run/Task/Attempt/operation/invocation/effect
   identity where execution is claimed. Checkout HEAD is not automatically the installed build.
3. Inspect attributable result/partial-result, timeout/log evidence, acceptance and durable
   settlement. Include archive, restart/adoption and recovery only when the outcome claims them.
4. Attribute the owned disk diff, durable side effects and receipts to the exact accepted attempt.
   Ambiguous recovery/receipt evidence remains unknown until reconciled.
5. Observe the actual CLI/Terminal/API/MCP/worker or other real surface named by the proof contract.
   An absent or planned Desktop/Dashboard cannot be claimed as shipped from a prototype.
6. Check relevant denial, company/scope isolation, secret boundary, cancellation, idempotency/replay,
   partial-effect and recovery cases. Platform/accessibility/performance/HA claims require their
   own bounded measurements and environments; do not manufacture a universal proof checklist.
7. Identify independent review by actual reviewer, exact revision/scope and fresh evidence.
   Implementer checks, a second self-review and Jev are not independent PASS.

Tests, typechecks, lint and CI support these claims within their measured scope. Test green cannot
replace a missing producer, real consumer or settlement link. Verification cadence follows law 7
(`.deckent/docs/core-memory/law_local_verification.md`); a batch merges only after independent PASS and green
hosted PR CI on the exact head. Local checks, hosted CI and live proof remain separately identified. Unavailable evidence is blocking
when the accepted proof contract requires it, rather than by an invented legacy ritual.

## Assessment and delivery

Report `GO` when the exact claimed result and all required evidence links are satisfied;
`HOLD` when required evidence/authority is missing or contradictory; `NO_GO` for a disproven or
unsafe claim. Report an actual aborted outcome only from its canonical evidence.
These are review dispositions, not new product state values or commands.
State implemented behavior, checked versus unproven links, exact commands/results, contradictions,
independent review status, open limits, reconciled documents and next authorized step.
Worker/model self-report or force-finalize cannot establish success or death.
Keep owner acceptance, canonical state mutation, commit, release and push separate from GO.
