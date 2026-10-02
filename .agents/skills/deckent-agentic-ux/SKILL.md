---
name: deckent-agentic-ux
description: Use for Deckent runs, agents, workers, tool or MCP calls, approvals, verification, autonomy, checkpoints, pause/resume/cancel, failure, recovery, or human intervention. Do not use for generic chat layout or static visual styling.
---


# Deckent Agentic UX

## Objective

Make autonomous work legible, controllable and recoverable without pretending deterministic
certainty. Load deckent-design-dna and, for journey structure, deckent-product-design.

## Start from runtime semantics

Inspect the actual typed application hierarchy and lifecycle before designing. Follow the
Run/Task/Attempt, operation/effect and settlement relationships relevant to the task; include
Mission only when used. `do` can propose/admit Runs independently. Each transition has one owner.
Label future or unsupported controls as design dependencies rather than working actions.

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
| Outcome | success, failure, cancelled, superseded, partial, unknown effect |

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
concurrent action. State what is safe to retry and what needs reconciliation. Unknown side effects stay unknown
until durable attribution is reconciled; an optimistic display cannot settle them.

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
