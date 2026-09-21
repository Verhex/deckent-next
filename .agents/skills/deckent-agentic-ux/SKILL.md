---
name: deckent-agentic-ux
description: Use for Deckent runs, agents, workers, tool or MCP calls, approvals, verification, autonomy, checkpoints, pause/resume/cancel, failure, recovery, or human intervention. Do not use for generic chat layout or static visual styling.
---

## Next refactor scope — 2026-09-17

For current Deckent Next work, first apply `deckent-next-refactor` from the host skill directory.
Product writes target `/home/alperen/deckent-next`; legacy `/home/alperen/deckent-dev` is a read-only
reference except the owner-authorized host tooling/channel setup. Next ARCHITECTURE.md and PLAN.md
carry accepted refactor decisions. Relative legacy `docs/`, `.deckent/workspace/`, `src/` and
`scripts/` references below resolve in the legacy repository for reading only; inspect target
implementation separately. Do not run legacy generation, recovery, MCP or dogfood commands for Next.


# Deckent Agentic UX

## Objective

Make autonomous work legible, controllable and recoverable without pretending deterministic
certainty. Load deckent-design-dna and, for journey structure, deckent-product-design.

## Start from runtime semantics

Inspect the actual product hierarchy and lifecycle before designing. Use the current repository
names and states; do not freeze this illustrative hierarchy when code differs:

    Goal → Mission → Flow → Run → WorkItem → Attempt → Operation

For every displayed object, determine:

- who or what initiated it;
- which principal, policy and scope authorized it;
- current state and state age;
- provider, agent or worker responsible;
- input, output and side effects;
- cost, usage and limits when available;
- evidence and verification status;
- available intervention and its consequence;
- recovery path and durable history.

## State contract

Create a state matrix before a component:

| Axis | Examples to resolve from code |
|---|---|
| Lifecycle | queued, admitted, active, paused, blocked, settling, terminal |
| Freshness | live, delayed, stale, disconnected, unknown |
| Authority | allowed, approval required, denied, expired, unavailable |
| Evidence | pending, partial, verified, contradicted, unavailable |
| Outcome | success, failure, cancelled, superseded, partial |

Never collapse unknown, stale, unavailable and failed into one warning state.

## Trust rules

- Show causality: user intent → plan → action → side effect → evidence.
- Distinguish model proposal, policy decision, tool execution and verified result.
- Never imply that stopping a view stops a process.
- Pause, resume, cancel, retry and rollback expose exact scope and race conditions.
- Approval shows requestor, action, resource, scope, expiry, risk and downstream consequence.
- A denied or expired approval has a recovery path; it does not vanish.
- Streaming output remains navigable while preserving a stable final record.
- Optimistic UI never fabricates terminal success.
- Background work exposes freshness and last-known state.

## Human intervention

Design at least:

- observe only;
- guide or revise;
- approve a bounded action;
- pause at a safe boundary;
- cancel with explicit partial side effects;
- retry from a defined checkpoint;
- take manual control where the product truly supports it.

Intervention must preserve attribution and audit evidence.

## Failure and recovery

For each critical action include timeout, lost connection, provider unavailability, insufficient
authority, budget/limit exhaustion, partial side effect, verification failure and conflicting
concurrent action. State what is safe to retry and what needs reconciliation.

## Required output

Provide:

- object/lifecycle model grounded in code;
- state and transition matrix;
- approval and intervention contract;
- evidence and attribution model;
- failure/recovery matrix;
- Desktop and Terminal semantic mapping;
- accessibility announcements for live changes;
- gaps where backend authority or protocol prevents honest UX.

A beautiful timeline with invented state transitions is NO-GO.
