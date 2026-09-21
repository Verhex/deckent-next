---
name: deckent-product-design
description: Use for Deckent product philosophy, personas, jobs, journeys, capability model, information architecture, progressive disclosure, or solo-to-enterprise complexity. Do not use for visual styling without a product-model question.
---

## Next refactor scope — 2026-09-17

For current Deckent Next work, first apply `deckent-next-refactor` from the host skill directory.
Product writes target `/home/alperen/deckent-next`; legacy `/home/alperen/deckent-dev` is a read-only
reference except the owner-authorized host tooling/channel setup. Next ARCHITECTURE.md and PLAN.md
carry accepted refactor decisions. Relative legacy `docs/`, `.deckent/workspace/`, `src/` and
`scripts/` references below resolve in the legacy repository for reading only; inspect target
implementation separately. Do not run legacy generation, recovery, MCP or dogfood commands for Next.


# Deckent Product Design

## Objective

Turn real Deckent capabilities into a coherent product model before arranging screens. The result
must work for a first solo run and for expert multi-project operation without becoming two
different products.

Load deckent-design-dna first.

Apply the current owner decision ratchet loaded by deckent-design-dna. Refine accepted product
semantics; do not restart direction exploration with rejected shells, modes or surface roles.

## Evidence to inspect

- Current identity and primary-surface authority
- The exact application service, protocol and state model in scope
- Existing Desktop and Terminal paths for the same user job
- Current terminology and i18n keys
- Relevant M0–M2 foundation dependencies in the reconciliation

Do not infer a capability from a mockup, stale roadmap prose or an attractive component.

## Population matrix

Cover the relevant combinations:

| Dimension | Required range |
|---|---|
| Agency | guided, assisted, autonomous, supervised |
| Experience | first-run, occasional, expert operator |
| Organization | solo, team, regulated enterprise |
| Scale | one project/run, many projects, very large run history |
| Environment | local, remote, degraded, offline or reconnecting |
| Platform | macOS, Linux, Windows native, WSL |
| Language | English default, Turkish parity, expansion-safe layout |

Progressive disclosure may change density and available shortcuts. It must not hide authority,
cost, risk or irreversible consequences.

## Product modeling workflow

1. Define the user job and the decision the interface must support.
2. Identify the authoritative objects and their relationships.
3. Map entry, success, failure, interruption, recovery and return paths.
4. Model the Golden Workflow first: conversation or command through run creation, execution,
   inspection, evidence and settlement.
5. Separate control, inspection, explanation and configuration.
6. Decide what belongs in Desktop, Terminal and Dashboard observability.
7. Define progressive complexity without duplicating the product model.
8. Validate nouns and actions against production code and i18n.

## Information architecture rules

- Organize around user intent and system state, not repository module names.
- A command and its result remain traceable as one causal chain.
- Current state, desired state and historical evidence are visually and verbally distinct.
- The primary action is unambiguous; dangerous actions expose scope and consequence.
- Empty states teach a valid next action without inventing sample activity.
- Dense enterprise lists provide search, filter, grouping, saved views and stable deep links when
  the underlying product supports them.
- Dashboard may summarize and link; it may not create a second command path.

## Required output

Produce a concise product contract containing:

- users and jobs;
- object and relationship model;
- Golden Workflow and critical variants;
- surface allocation;
- navigation and progressive-disclosure logic;
- permission, empty, stale, loading, failure and recovery states;
- unresolved product authority questions;
- acceptance evidence tied to real capabilities.

Do not proceed to visual polish while the product model contains contradictory ownership or
invented states.
